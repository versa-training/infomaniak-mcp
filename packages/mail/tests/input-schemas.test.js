import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { createFetchMock, jsonResponse, connectTools, MAILBOXES } from "./helpers.js";

describe("input schemas", () => {
    let fetchMock;
    let originalFetch;
    let tools;

    beforeEach(async () => {
        fetchMock = createFetchMock();
        originalFetch = global.fetch;
        global.fetch = fetchMock;
        tools = await connectTools();
    });

    afterEach(async () => {
        await tools.close();
        global.fetch = originalFetch;
    });

    async function rejected(name, args) {
        const result = await tools.mcp.callTool({ name, arguments: args }).catch((e) => ({ isError: true, e }));
        assert.strictEqual(result.isError, true, `${name} ${JSON.stringify(args)} should be rejected`);
        assert.strictEqual(fetchMock.calls().length, 0, "no request for invalid input");
    }

    it("rejects non-integer and out-of-range limit, offset, and delay", async () => {
        const base = { folder_id: "f1", mailbox_uuid: "mb1" };
        await rejected("mail_list_emails", { ...base, limit: -5.5 });
        await rejected("mail_list_emails", { ...base, limit: 0 });
        await rejected("mail_list_emails", { ...base, limit: 101 });
        await rejected("mail_list_emails", { ...base, offset: -1 });
        await rejected("mail_search_emails", { query: "x", limit: 1.5 });
        await rejected("mail_send_draft", { draft_uuid: "d1", delay: -1 });
    });

    it("rejects invalid recipients and sender addresses", async () => {
        await rejected("mail_send_email", { to: ["not-an-address"], subject: "s", body: "b" });
        await rejected("mail_send_email", { to: [], subject: "s", body: "b" });
        await rejected("mail_send_email", { to: "a@x.ch, b@x.ch", subject: "s", body: "b" });
        await rejected("mail_create_draft", { to: ["a@x.ch"], cc: ["bad"], subject: "s", body: "b" });
        await rejected("mail_create_draft", { subject: "s", body: "b", from_email: "nope" });
        await rejected("mail_update_draft", { draft_uuid: "d1", bcc: ["bad"] });
    });

    it("rejects malformed dates and oversized strings", async () => {
        await rejected("mail_search_emails", { since: "2026-13-40" });
        await rejected("mail_search_emails", { before: "yesterday" });
        await rejected("mail_send_email", { to: ["a@x.ch"], subject: "s".repeat(999), body: "b" });
        await rejected("mail_create_folder", { name: "" });
        await rejected("mail_mark_email", { folder_id: "f", message_uids: [], read: true });
    });

    it("accepts a valid call and sends recipients as separate addresses", async () => {
        fetchMock.enqueue(
            jsonResponse(MAILBOXES),
            jsonResponse({ result: "error" }, { status: 403 }),
            jsonResponse({ result: "success", data: { uuid: "d1", uid: 1 } }),
        );
        const result = await tools.mcp.callTool({
            name: "mail_create_draft",
            arguments: { to: ["a@x.ch", "b@x.ch"], subject: "s", body: "b" },
        });
        assert.notStrictEqual(result.isError, true, JSON.stringify(result.content));
        const draftCall = fetchMock.calls().find((c) => c.options.method === "POST");
        assert.deepStrictEqual(JSON.parse(draftCall.options.body).to.map((r) => r.email), ["a@x.ch", "b@x.ch"]);
    });

    it("creates a draft without recipients", async () => {
        fetchMock.enqueue(
            jsonResponse(MAILBOXES),
            jsonResponse({ result: "error" }, { status: 403 }),
            jsonResponse({ result: "success", data: { uuid: "d1", uid: 1 } }),
        );
        const result = await tools.mcp.callTool({
            name: "mail_create_draft",
            arguments: { subject: "s", body: "b" },
        });
        assert.notStrictEqual(result.isError, true, JSON.stringify(result.content));
        const draftCall = fetchMock.calls().find((c) => c.options.method === "POST");
        assert.strictEqual(JSON.parse(draftCall.options.body).to, null);
    });
});
