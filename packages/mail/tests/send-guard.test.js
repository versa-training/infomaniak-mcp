import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { createFetchMock, jsonResponse, connectTools, MAILBOXES } from "./helpers.js";

describe("send guard", () => {
    let fetchMock;
    let originalFetch;

    beforeEach(() => {
        fetchMock = createFetchMock();
        originalFetch = global.fetch;
        global.fetch = fetchMock;
    });

    afterEach(() => {
        global.fetch = originalFetch;
    });

    it("registers the send tools by default", async () => {
        const { mcp, close } = await connectTools();
        try {
            const names = (await mcp.listTools()).tools.map((t) => t.name);
            assert.ok(names.includes("mail_send_email"));
            assert.ok(names.includes("mail_send_draft"));
        } finally {
            await close();
        }
    });

    it("omits the send tools when allowSend is false and says the human sends", async () => {
        const { mcp, close } = await connectTools({ allowSend: false });
        try {
            const { tools } = await mcp.listTools();
            const names = tools.map((t) => t.name);
            assert.ok(!names.includes("mail_send_email"));
            assert.ok(!names.includes("mail_send_draft"));
            assert.ok(names.includes("mail_create_draft"));
            assert.match(tools.find((t) => t.name === "mail_create_draft").description, /human .* sends? .*kMail/);
            const result = await mcp.callTool({
                name: "mail_send_email",
                arguments: { to: ["a@x.ch"], subject: "s", body: "b" },
            }).catch((e) => ({ isError: true, e }));
            assert.strictEqual(result.isError, true);
            assert.strictEqual(fetchMock.calls().length, 0);
        } finally {
            await close();
        }
    });

    it("echoes the final recipients after sending", async () => {
        fetchMock.enqueue(
            jsonResponse(MAILBOXES),
            jsonResponse({ result: "error" }, { status: 403 }),
            jsonResponse({ result: "success", data: { uuid: "d1", uid: 1 } }),
            jsonResponse({ result: "success", data: { sent: true } }),
        );
        const { mcp, close } = await connectTools();
        try {
            const result = await mcp.callTool({
                name: "mail_send_email",
                arguments: { to: ["a@x.ch"], cc: ["c@x.ch"], bcc: ["b@x.ch"], subject: "s", body: "b" },
            });
            assert.notStrictEqual(result.isError, true, JSON.stringify(result.content));
            assert.deepStrictEqual(JSON.parse(result.content[0].text).sent_to, {
                to: "a@x.ch",
                cc: "c@x.ch",
                bcc: "b@x.ch",
            });
        } finally {
            await close();
        }
    });

    it("draft-only mode also drops the send flag and the auto-reply writers", async () => {
        const { mcp, close } = await connectTools({ allowSend: false });
        try {
            const { tools } = await mcp.listTools();
            const names = tools.map((t) => t.name);
            assert.ok(names.includes("mail_reply"));
            assert.ok(names.includes("mail_forward"));
            assert.ok(names.includes("mail_list_auto_replies"));
            for (const hidden of ["mail_create_auto_reply", "mail_update_auto_reply", "mail_delete_auto_reply"]) {
                assert.ok(!names.includes(hidden), hidden);
            }
            for (const name of ["mail_reply", "mail_forward"]) {
                const tool = tools.find((t) => t.name === name);
                assert.strictEqual(tool.inputSchema.properties.send, undefined, name);
                assert.strictEqual(tool.annotations.openWorldHint, false, name);
            }
        } finally {
            await close();
        }
    });
});
