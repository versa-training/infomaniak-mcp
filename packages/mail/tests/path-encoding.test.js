import { describe, it } from "node:test";
import assert from "node:assert";
import { createFetchMock, jsonResponse, connectTools } from "./helpers.js";

const { MailClient, buildPath } = await import("../dist/mail-client.js");

describe("path encoding", () => {
    it("buildPath encodes every segment", () => {
        assert.strictEqual(buildPath("mail", "a/b", "c?d#e", 7), "/mail/a%2Fb/c%3Fd%23e/7");
        assert.strictEqual(buildPath("mail", "%2e%2e"), "/mail/%252e%252e");
    });

    it("buildPath rejects empty and dot segments", () => {
        for (const bad of ["", ".", ".."]) {
            assert.throws(() => buildPath("mail", bad), /Invalid path segment/);
        }
    });

    it("client requests keep an identifier inside its path segment", async () => {
        const original = global.fetch;
        const fetchMock = createFetchMock();
        global.fetch = fetchMock;
        try {
            fetchMock.enqueue(
                jsonResponse({ result: "success", data: [] }),
                jsonResponse({ result: "success", data: {} }),
            );
            await new MailClient("t").deleteFolder("mb", "x/../../../y?z=1");
            const url = new URL(fetchMock.calls()[1].url);
            assert.strictEqual(url.pathname, "/api/mail/mb/folder/x%2F..%2F..%2F..%2Fy%3Fz%3D1");
            assert.strictEqual(url.search, "");
            fetchMock.enqueue(jsonResponse({ result: "success", data: [] }));
            await assert.rejects(new MailClient("t").deleteFolder("mb", ".."), /Invalid path segment/);
            assert.strictEqual(fetchMock.calls().length, 3);
        } finally {
            global.fetch = original;
        }
    });

    it("tool schemas reject path traversal identifiers", async () => {
        const original = global.fetch;
        const fetchMock = createFetchMock();
        global.fetch = fetchMock;
        const { mcp, close } = await connectTools();
        try {
            for (const args of [
                { folder_id: "../../x" },
                { folder_id: "a/b" },
                { folder_id: "ok", mailbox_uuid: "../1" },
            ]) {
                const result = await mcp.callTool({ name: "mail_delete_folder", arguments: args }).catch((e) => ({ isError: true, e }));
                assert.ok(result.isError, JSON.stringify(args));
            }
            assert.strictEqual(fetchMock.calls().length, 0);
        } finally {
            await close();
            global.fetch = original;
        }
    });
});
