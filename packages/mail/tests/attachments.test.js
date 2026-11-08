import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFetchMock, jsonResponse, connectTools, MAILBOXES } from "./helpers.js";

const { readLocalAttachment, decodeBase64Attachment } = await import("../dist/attachments.js");

const b64 = (text) => Buffer.from(text).toString("base64");

describe("attachments", () => {
    let fetchMock;
    let originalFetch;
    let tmp;

    beforeEach(() => {
        fetchMock = createFetchMock();
        originalFetch = global.fetch;
        global.fetch = fetchMock;
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mail-att-"));
    });

    afterEach(() => {
        global.fetch = originalFetch;
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it("decodeBase64Attachment rejects invalid base64", () => {
        assert.strictEqual(decodeBase64Attachment(b64("hello")).toString(), "hello");
        assert.throws(() => decodeBase64Attachment("not base64!!"), /not valid base64/);
        assert.throws(() => decodeBase64Attachment("abc"), /not valid base64/);
    });

    it("hosted schema accepts objects only and never reads local paths", async () => {
        const secret = path.join(tmp, "secret.txt");
        fs.writeFileSync(secret, "TOP SECRET");
        const { mcp, close } = await connectTools();
        try {
            const result = await mcp.callTool({
                name: "mail_send_email",
                arguments: { to: ["a@x.ch"], subject: "s", body: "b", attachments: [secret] },
            }).catch((e) => ({ isError: true, e }));
            assert.strictEqual(result.isError, true);
            assert.strictEqual(fetchMock.calls().length, 0);
            const { tools } = await mcp.listTools();
            const schema = tools.find((t) => t.name === "mail_send_email").inputSchema.properties.attachments;
            assert.strictEqual(schema.items.anyOf, undefined);
            assert.strictEqual(schema.items.type, "object");
            assert.ok(!JSON.stringify(schema).includes('"type":"string","minLength"'), "no path branch");
        } finally {
            await close();
        }
    });

    it("sends base64 attachments with filename and MIME type headers", async () => {
        fetchMock.enqueue(
            jsonResponse(MAILBOXES),
            jsonResponse({ result: "error" }, { status: 403 }),
            jsonResponse({ result: "success", data: { uuid: "att-1" } }),
            jsonResponse({ result: "success", data: { uuid: "d1", uid: 1 } }),
            jsonResponse({ result: "success", data: { uid: 2 } }),
            jsonResponse({ result: "success", data: { sent: true } }),
        );
        const { mcp, close } = await connectTools();
        try {
            const result = await mcp.callTool({
                name: "mail_send_email",
                arguments: {
                    to: ["a@x.ch"],
                    subject: "s",
                    body: "b",
                    attachments: [{ filename: "note.txt", mime_type: "text/plain", base64_content: b64("hi") }],
                },
            });
            assert.notStrictEqual(result.isError, true, JSON.stringify(result.content));
            const upload = fetchMock.calls().find((c) => c.url.endsWith("/draft/attachment"));
            assert.strictEqual(upload.options.headers["x-ws-attachment-filename"], "note.txt");
            assert.strictEqual(upload.options.headers["x-ws-attachment-mime-type"], "text/plain");
            assert.strictEqual(Buffer.from(upload.options.body).toString(), "hi");
            const put = fetchMock.calls().filter((c) => c.options.method === "PUT");
            assert.deepStrictEqual(JSON.parse(put[0].options.body).attachments, ["att-1"]);
        } finally {
            await close();
        }
    });

    it("creates no draft when an attachment is invalid", async () => {
        fetchMock.enqueue(jsonResponse(MAILBOXES));
        const { mcp, close } = await connectTools();
        try {
            const result = await mcp.callTool({
                name: "mail_send_email",
                arguments: {
                    to: ["a@x.ch"],
                    subject: "s",
                    body: "b",
                    attachments: [{ filename: "a.txt", base64_content: "###" }],
                },
            });
            assert.strictEqual(result.isError, true);
            assert.ok(!fetchMock.calls().some((c) => c.url.endsWith("/draft") && c.options.method === "POST"));
        } finally {
            await close();
        }
    });

    it("deletes the draft when attaching fails after creation", async () => {
        fetchMock.enqueue(
            jsonResponse(MAILBOXES),
            jsonResponse({ result: "error" }, { status: 403 }),
            jsonResponse({ result: "success", data: { uuid: "att-1" } }),
            jsonResponse({ result: "success", data: { uuid: "d1", uid: 1 } }),
            jsonResponse({ result: "error", error: { code: "boom", description: "no" } }, { status: 500 }),
            jsonResponse({ result: "success", data: {} }),
        );
        const { mcp, close } = await connectTools();
        try {
            const result = await mcp.callTool({
                name: "mail_send_email",
                arguments: {
                    to: ["a@x.ch"], subject: "s", body: "b",
                    attachments: [{ filename: "a.txt", base64_content: b64("x") }],
                },
            });
            assert.strictEqual(result.isError, true);
            const last = fetchMock.calls().at(-1);
            assert.strictEqual(last.options.method, "DELETE");
            assert.ok(last.url.endsWith("/draft/d1"));
        } finally {
            await close();
        }
    });

    describe("local files", () => {
        it("readLocalAttachment reads a file without a directory restriction", () => {
            const file = path.join(tmp, "a.txt");
            fs.writeFileSync(file, "data");
            const attachment = readLocalAttachment(file);
            assert.strictEqual(attachment.filename, "a.txt");
            assert.strictEqual(Buffer.from(attachment.base64_content, "base64").toString(), "data");
        });

        it("confines paths to attachmentDir, including .. and symlinks", () => {
            const dir = path.join(tmp, "allowed");
            fs.mkdirSync(dir);
            const outside = path.join(tmp, "outside.txt");
            fs.writeFileSync(outside, "secret");
            fs.writeFileSync(path.join(dir, "ok.txt"), "fine");
            fs.symlinkSync(outside, path.join(dir, "link.txt"));

            assert.strictEqual(readLocalAttachment("ok.txt", dir).filename, "ok.txt");
            assert.throws(() => readLocalAttachment(outside, dir), /outside the allowed/);
            assert.throws(() => readLocalAttachment("../outside.txt", dir), /outside the allowed/);
            assert.throws(() => readLocalAttachment("link.txt", dir), /outside the allowed/);
            assert.throws(() => readLocalAttachment("missing.txt", dir), /not found/);
        });

        it("accepts a path through the tool only when allowLocalFiles is true", async () => {
            const file = path.join(tmp, "a.txt");
            fs.writeFileSync(file, "data");
            fetchMock.enqueue(
                jsonResponse(MAILBOXES),
                jsonResponse({ result: "error" }, { status: 403 }),
                jsonResponse({ result: "success", data: { uuid: "att-1" } }),
                jsonResponse({ result: "success", data: { uuid: "d1", uid: 1 } }),
                jsonResponse({ result: "success", data: { uid: 2 } }),
                jsonResponse({ result: "success", data: {} }),
            );
            const { mcp, close } = await connectTools({ allowLocalFiles: true, attachmentDir: tmp });
            try {
                const result = await mcp.callTool({
                    name: "mail_send_email",
                    arguments: { to: ["a@x.ch"], subject: "s", body: "b", attachments: [file] },
                });
                assert.notStrictEqual(result.isError, true, JSON.stringify(result.content));
                const upload = fetchMock.calls().find((c) => c.url.endsWith("/draft/attachment"));
                assert.strictEqual(upload.options.headers["x-ws-attachment-filename"], "a.txt");
            } finally {
                await close();
            }
        });
    });
});
