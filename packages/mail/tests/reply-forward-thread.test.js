import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { createFetchMock, jsonResponse } from "./helpers.js";

const { MailClient } = await import("../dist/mail-client.js");

const MAILBOXES = {
    result: "success",
    data: [{
        uuid: "mb1", email: "me@x.ch", mailbox: "me", hosting_id: 7, is_primary: true, aliases: ["alias@x.ch"],
    }],
};

const SOURCE = {
    uid: "42",
    msg_id: "<src@x.ch>",
    subject: "Plan",
    date: "2026-03-01T10:00:00+00:00",
    from: [{ name: "Alice", email: "alice@x.ch" }],
    reply_to: [],
    to: [{ name: "Me", email: "me@x.ch" }, { name: "Bob", email: "bob@x.ch" }],
    cc: [{ name: "", email: "alias@x.ch" }, { name: "Doe, Carl", email: "carl@x.ch" }],
    headers: { References: "<old@x.ch>" },
    body: { value: "<p>Original <b>text</b></p>", type: "text/html" },
    attachments: [],
};

describe("reply, forward, thread, auto reply", () => {
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

    const message = (overrides = {}) => jsonResponse({ result: "success", data: { ...SOURCE, ...overrides } });
    const draftCreated = () => jsonResponse({ result: "success", data: { uuid: "d1", uid: 9 } });
    const noIdentities = () => jsonResponse({ result: "error" }, { status: 403 });

    function draftBody(index) {
        return JSON.parse(fetchMock.calls()[index].options.body);
    }

    it("reply and forward keep a localized subject prefix instead of adding another", async () => {
        const cases = [
            ["reply", "AW: Plan", "AW: Plan"], ["reply", "RE : Plan", "RE : Plan"], ["reply", "Antw: Plan", "Antw: Plan"],
            ["reply", "SV: Plan", "SV: Plan"], ["reply", "Plan", "Re: Plan"],
            ["forward", "WG: Plan", "WG: Plan"], ["forward", "TR : Plan", "TR : Plan"], ["forward", "ENC: Plan", "ENC: Plan"],
            ["forward", "Fwd: Plan", "Fwd: Plan"], ["forward", "Plan", "Fwd: Plan"],
        ];
        for (const [kind, subject, expected] of cases) {
            fetchMock.enqueue(message({ subject }), jsonResponse(MAILBOXES), noIdentities(), draftCreated());
            const client = new MailClient("t");
            if (kind === "reply") await client.replyToEmail("mb1", "inbox", "42", "x");
            else await client.forwardEmail("mb1", "inbox", "42", ["z@x.ch"], "x");
            assert.strictEqual(JSON.parse(fetchMock.calls().at(-1).options.body).subject, expected, `${kind}: ${subject}`);
        }
    });

    it("reply answers the sender with threading headers and saves a draft", async () => {
        fetchMock.enqueue(jsonResponse(MAILBOXES), message(), noIdentities(), draftCreated());
        const client = new MailClient("t");
        await client.init();
        const result = await client.replyToEmail("mb1", "inbox", "42", "Thanks");
        const body = draftBody(3);
        assert.deepStrictEqual(body.to, [{ name: "Alice", email: "alice@x.ch" }]);
        assert.strictEqual(body.cc, null);
        assert.strictEqual(body.subject, "Re: Plan");
        assert.strictEqual(body.in_reply_to, "<src@x.ch>");
        assert.strictEqual(body.references, "<old@x.ch> <src@x.ch>");
        assert.strictEqual(body.in_reply_to_uid, "42@inbox");
        assert.strictEqual(result.sent, false);
        assert.strictEqual(fetchMock.calls().length, 4, "no send request");
    });

    it("reply_all adds the other recipients as Cc without the mailbox's own addresses", async () => {
        fetchMock.enqueue(jsonResponse(MAILBOXES), message({ subject: "Re: Plan", reply_to: [{ name: "List", email: "list@x.ch" }] }), noIdentities(), draftCreated());
        const client = new MailClient("t");
        await client.init();
        await client.replyToEmail("mb1", "inbox", "42", "Thanks", { replyAll: true });
        const body = draftBody(3);
        assert.deepStrictEqual(body.to, [{ name: "List", email: "list@x.ch" }]);
        assert.deepStrictEqual(body.cc.map((r) => r.email), ["bob@x.ch", "carl@x.ch"]);
        assert.strictEqual(body.cc[1].name, "Doe, Carl");
        assert.strictEqual(body.subject, "Re: Plan", "no second Re:");
    });

    it("reply with send true saves the draft and then sends it", async () => {
        fetchMock.enqueue(
            jsonResponse(MAILBOXES), message(), noIdentities(), draftCreated(),
            jsonResponse({ result: "success", data: { sent: true } }),
        );
        const client = new MailClient("t");
        await client.init();
        const result = await client.replyToEmail("mb1", "inbox", "42", "Thanks", { send: true });
        assert.strictEqual(result.sent, true);
        assert.strictEqual(result.sent_to.to, "alice@x.ch");
        assert.strictEqual(draftBody(4).action, "send");
    });

    it("reply to a message the mailbox sent answers its recipients", async () => {
        fetchMock.enqueue(jsonResponse(MAILBOXES), message({ from: [{ name: "Me", email: "me@x.ch" }] }), noIdentities(), draftCreated());
        const client = new MailClient("t");
        await client.init();
        await client.replyToEmail("mb1", "sent", "42", "Ping");
        assert.deepStrictEqual(draftBody(3).to.map((r) => r.email), ["bob@x.ch"]);
    });

    it("forward sets forwarded_uid, quotes the original text, and prefixes Fwd:", async () => {
        fetchMock.enqueue(jsonResponse(MAILBOXES), message(), noIdentities(), draftCreated());
        const client = new MailClient("t");
        await client.init();
        await client.forwardEmail("mb1", "inbox", "42", ["z@x.ch"], "FYI");
        const body = draftBody(3);
        assert.strictEqual(body.forwarded_uid, "42@inbox");
        assert.strictEqual(body.subject, "Fwd: Plan");
        assert.deepStrictEqual(body.to, [{ name: "", email: "z@x.ch" }]);
        assert.match(body.body, /FYI/);
        assert.match(body.body, /Forwarded message/);
        assert.match(body.body, /Alice &lt;alice@x\.ch&gt;/);
        assert.match(body.body, /Original text/);
        assert.strictEqual(body.in_reply_to, null);
    });

    it("readThread reads each message and returns them oldest first", async () => {
        fetchMock.enqueue(
            message({ uid: "9", date: "2026-03-02T00:00:00+00:00" }),
            message({ uid: "7", date: "2026-03-01T00:00:00+00:00" }),
        );
        const thread = await new MailClient("t").readThread("mb1", [
            { folder_id: "inbox", uid: "9" },
            { folder_id: "sent", uid: "7" },
        ]);
        assert.deepStrictEqual(thread.items.map((m) => m.uid), ["7", "9"]);
        assert.deepStrictEqual(
            fetchMock.calls().map((c) => new URL(c.url).pathname),
            ["/api/mail/mb1/folder/inbox/message/9", "/api/mail/mb1/folder/sent/message/7"],
        );
    });

    it("auto reply calls use the documented mail_hostings endpoints", async () => {
        fetchMock.enqueue(
            jsonResponse(MAILBOXES),
            jsonResponse({ result: "success", data: [{ id: 5, name: "Holiday", is_active: false }] }),
            jsonResponse({ result: "success", data: { id: 6 } }),
            jsonResponse({ result: "success", data: true }),
            jsonResponse({ result: "success", data: true }),
        );
        const client = new MailClient("t");
        const list = await client.listAutoReplies("mb1");
        assert.strictEqual(list[0].id, 5);
        await client.createAutoReply("mb1", { name: "H", message: "m", reply_from_id: 3, is_recurrent: false });
        await client.updateAutoReply("mb1", 5, { is_active: true });
        const deleted = await client.deleteAutoReply("mb1", 5);
        assert.deepStrictEqual(deleted, { id: 5, deleted: true });

        const calls = fetchMock.calls().slice(1);
        const base = "https://api.infomaniak.com/1/mail_hostings/7/mailboxes/me/auto_reply/model";
        assert.deepStrictEqual(
            calls.map((c) => [c.options.method ?? "GET", c.url]),
            [["GET", base], ["POST", base], ["PATCH", `${base}/5`], ["DELETE", `${base}/5`]],
        );
        assert.deepStrictEqual(JSON.parse(calls[2].options.body), { is_active: true });
    });
});
