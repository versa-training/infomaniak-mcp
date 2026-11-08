import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { createFetchMock, jsonResponse, connectTools, MAILBOXES } from "./helpers.js";

const { MailClient } = await import("../dist/mail-client.js");

describe("mail usability", () => {
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

    const callTool = async (name, args) => {
        const { mcp, close } = await connectTools();
        try {
            return await mcp.callTool({ name, arguments: args });
        } finally {
            await close();
        }
    };

    it("mail_list_mailboxes returns the aliases", async () => {
        fetchMock.enqueue(jsonResponse({ result: "success", data: [{ uuid: "mb1", email: "me@x.ch", mailbox: "me", hosting_id: 7, is_primary: true, aliases: ["a@x.ch", "b@x.ch"] }] }));
        const result = await callTool("mail_list_mailboxes", {});
        assert.deepStrictEqual(result.structuredContent.items[0].aliases, ["a@x.ch", "b@x.ch"]);
    });

    it("mail_list_identities returns id, sender, full_name, and default flag from the signatures endpoint", async () => {
        fetchMock.enqueue(
            jsonResponse(MAILBOXES),
            jsonResponse({ result: "success", data: { signatures: [
                { id: 3, sender: "me@x.ch", full_name: "Me Myself", is_default: true, content: "<p>private signature</p>" },
                { id: 4, sender: "alias@x.ch", full_name: "", is_default: false },
            ] } }),
        );
        const result = await callTool("mail_list_identities", {});
        assert.notStrictEqual(result.isError, true, JSON.stringify(result.content));
        assert.deepStrictEqual(result.structuredContent.items, [
            { id: 3, sender: "me@x.ch", full_name: "Me Myself", is_default: true },
            { id: 4, sender: "alias@x.ch", full_name: "", is_default: false },
        ]);
        assert.strictEqual(new URL(fetchMock.calls()[1].url).pathname, "/1/mail_hostings/7/mailboxes/me/signatures");
    });

    it("mail_list_forwarding reads the documented forwarding endpoint and accepts unexpected field types", async () => {
        fetchMock.enqueue(
            jsonResponse(MAILBOXES),
            jsonResponse({ result: "success", data: {
                is_enabled: "1", has_dont_deliver: 0, has_forward_spam: false,
                redirect_adresses: [{ email: "out@evil.example", email_idn: "out@evil.example", extra: 1 }],
            } }),
        );
        const result = await callTool("mail_list_forwarding", {});
        assert.notStrictEqual(result.isError, true, JSON.stringify(result.content));
        assert.deepStrictEqual(result.structuredContent.addresses, [{ email: "out@evil.example", email_idn: "out@evil.example" }]);
        assert.strictEqual(result.structuredContent.is_enabled, "1");
        assert.strictEqual(new URL(fetchMock.calls()[1].url).pathname, "/1/mail_hostings/7/mailboxes/me/forwarding_addresses");
        assert.strictEqual(fetchMock.calls()[1].options.method ?? "GET", "GET");
    });

    it("new mail accepts display names for recipients", async () => {
        fetchMock.enqueue(
            jsonResponse(MAILBOXES),
            jsonResponse({ result: "error" }, { status: 403 }),
            jsonResponse({ result: "success", data: { uuid: "d1", uid: 1 } }),
        );
        const result = await callTool("mail_create_draft", {
            to: [{ email: "alice@x.ch", name: "Alice, A." }, "bob@x.ch"],
            cc: [{ email: "carol@x.ch", name: "Carol" }],
            subject: "s",
            body: "b",
        });
        assert.notStrictEqual(result.isError, true, JSON.stringify(result.content));
        const draft = JSON.parse(fetchMock.calls().at(-1).options.body);
        assert.deepStrictEqual(draft.to, [{ name: "Alice, A.", email: "alice@x.ch" }, { name: "", email: "bob@x.ch" }]);
        assert.deepStrictEqual(draft.cc, [{ name: "Carol", email: "carol@x.ch" }]);
    });

    it("auto reply dates in ISO 8601 are sent as Unix seconds", async () => {
        fetchMock.enqueue(jsonResponse(MAILBOXES), jsonResponse({ result: "success", data: true }));
        const result = await callTool("mail_update_auto_reply", {
            model_id: 5, is_active: true, started_at: "2026-12-24T18:00:00+01:00", ended_at: 1798761600,
        });
        assert.notStrictEqual(result.isError, true, JSON.stringify(result.content));
        const patch = JSON.parse(fetchMock.calls().at(-1).options.body);
        assert.strictEqual(patch.started_at, Date.parse("2026-12-24T17:00:00Z") / 1000);
        assert.strictEqual(patch.ended_at, 1798761600);
        const { mcp, close } = await connectTools();
        try {
            const tool = (await mcp.listTools()).tools.find((t) => t.name === "mail_update_auto_reply");
            assert.match(tool.inputSchema.properties.is_active.description, /current is_active/);
        } finally {
            await close();
        }
    });

    it("readEmail leaves out the preview and does not ask for thread_context", async () => {
        fetchMock.enqueue(jsonResponse({ result: "success", data: { uid: "1", subject: "S", preview: "third-party preview", body: { value: "hi", type: "text/plain" } } }));
        const email = await new MailClient("t").readEmail("mb", "f", "1");
        assert.strictEqual("preview" in email, false);
        assert.ok(!fetchMock.calls()[0].url.includes("thread_context"));
    });

    it("readThread reads four messages at a time and orders by instant, not by date text", async () => {
        let running = 0;
        let peak = 0;
        const dates = {
            1: "2026-03-01T23:30:00-05:00", // 04:30 UTC on 03-02
            2: "2026-03-02T01:00:00+00:00",
            3: "2026-03-02T10:00:00+05:00", // 05:00 UTC
            4: "2026-03-01T12:00:00Z",
            5: "2026-03-02T00:00:00Z",
            6: "2026-03-02T00:00:00Z",
        };
        global.fetch = async (url) => {
            running++;
            peak = Math.max(peak, running);
            await new Promise((resolve) => setTimeout(resolve, 5));
            running--;
            const uid = new URL(String(url)).pathname.split("/").pop();
            return jsonResponse({ result: "success", data: { uid, date: dates[uid], body: { value: "x", type: "text/plain" } } });
        };
        const messages = [1, 2, 3, 4, 5, 6].map((n) => ({ folder_id: "f", uid: String(n) }));
        const thread = await new MailClient("t").readThread("mb", messages);
        assert.deepStrictEqual(thread.items.map((m) => m.uid), ["4", "5", "6", "2", "1", "3"]);
        assert.strictEqual(peak, 4);
    });

    it("list tools accept API fields of unexpected types", async () => {
        fetchMock.enqueue(
            jsonResponse({ result: "success", data: [{ uuid: "mb1", email: "me@x.ch", mailbox: "me", hosting_id: "7", is_primary: "yes", aliases: ["a@x.ch", 5] }] }),
            jsonResponse({ result: "success", data: [{ id: 12, name: "INBOX", separator: "/", role: null, unread_count: "3", total_count: null, children: [] }] }),
        );
        const { mcp, close } = await connectTools();
        try {
            const boxes = await mcp.callTool({ name: "mail_list_mailboxes", arguments: {} });
            assert.notStrictEqual(boxes.isError, true, JSON.stringify(boxes.content));
            const folders = await mcp.callTool({ name: "mail_list_folders", arguments: { mailbox_uuid: "mb1" } });
            assert.notStrictEqual(folders.isError, true, JSON.stringify(folders.content));
            assert.strictEqual(folders.structuredContent.items[0].unread_count, "3");
        } finally {
            await close();
        }
    });
});
