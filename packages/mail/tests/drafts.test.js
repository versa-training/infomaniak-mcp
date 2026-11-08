import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { createFetchMock, jsonResponse, MAILBOXES } from "./helpers.js";

const { MailClient } = await import("../dist/mail-client.js");
const { DraftCache } = await import("../dist/draft-cache.js");

const apiDraft = {
    uuid: "d1",
    uid: 5,
    subject: "From kMail",
    body: "<div>Hi</div>",
    from: { id: null, name: "Me", email: "me@x.ch" },
    to: [{ name: "Ann", email: "ann@x.ch" }],
    cc: null,
    bcc: null,
    attachments: [{ uuid: "old-att", name: "a.txt" }],
    unknown_field: "must not be sent back",
};

describe("DraftCache", () => {
    it("evicts the least recently used entry beyond the limit", () => {
        const cache = new DraftCache(2, 1000, () => 0);
        cache.set("a", { payload: 1, mailboxUuid: "m", plain: {} });
        cache.set("b", { payload: 2, mailboxUuid: "m", plain: {} });
        cache.get("a");
        cache.set("c", { payload: 3, mailboxUuid: "m", plain: {} });
        assert.ok(cache.get("a"));
        assert.strictEqual(cache.get("b"), undefined);
        assert.ok(cache.get("c"));
        assert.strictEqual(cache.size, 2);
    });

    it("drops entries older than the TTL", () => {
        let now = 0;
        const cache = new DraftCache(10, 1000, () => now);
        cache.set("a", { payload: 1, mailboxUuid: "m", plain: {} });
        now = 1000;
        assert.ok(cache.get("a"));
        now = 1001;
        assert.strictEqual(cache.get("a"), undefined);
        assert.strictEqual(cache.size, 0);
    });
});

describe("drafts from the API", () => {
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

    it("updateDraft loads a draft that is not cached and keeps its fields", async () => {
        const client = new MailClient("t");
        fetchMock.enqueue(
            jsonResponse(MAILBOXES),
            jsonResponse({ result: "success", data: apiDraft }),
            jsonResponse({ result: "success", data: { uid: 6 } }),
        );
        const result = await client.updateDraft("d1", { subject: "Changed" });
        const [, get, put] = fetchMock.calls();
        assert.strictEqual(get.url, "https://mail.infomaniak.com/api/mail/mb1/draft/d1");
        assert.strictEqual(put.options.method, "PUT");
        const sent = JSON.parse(put.options.body);
        assert.strictEqual(sent.subject, "Changed");
        assert.strictEqual(sent.body, "<div>Hi</div>");
        assert.deepStrictEqual(sent.to, [{ name: "Ann", email: "ann@x.ch" }]);
        assert.deepStrictEqual(sent.attachments, ["old-att"]);
        assert.strictEqual(sent.unknown_field, undefined);
        assert.strictEqual(result.to, "ann@x.ch");
    });

    it("sendDraft loads an uncached draft and sends it", async () => {
        const client = new MailClient("t");
        fetchMock.enqueue(
            jsonResponse(MAILBOXES),
            jsonResponse({ result: "success", data: apiDraft }),
            jsonResponse({ result: "success", data: { sent: true } }),
        );
        const sentResult = await client.sendDraft("d1", 0);
        assert.strictEqual(sentResult.sent, true);
        assert.deepStrictEqual(sentResult.sent_to, { to: "ann@x.ch", cc: "", bcc: "" });
        const sent = JSON.parse(fetchMock.calls()[2].options.body);
        assert.strictEqual(sent.action, "send");
    });

    it("uses the mailbox the draft was created in", async () => {
        const client = new MailClient("t");
        fetchMock.enqueue(
            jsonResponse({ result: "success", data: [
                { uuid: "mb1", email: "me@x.ch", mailbox: "me", hosting_id: 7, is_primary: true },
                { uuid: "mb2", email: "two@x.ch", mailbox: "two", hosting_id: 8 },
            ] }),
            jsonResponse({ result: "error" }, { status: 403 }),
            jsonResponse({ result: "success", data: { uuid: "d2", uid: 1 } }),
            jsonResponse({ result: "success", data: { ...apiDraft, uuid: "d2" } }),
            jsonResponse({ result: "success", data: {} }),
        );
        await client.init();
        await client.createDraft(["a@x.ch"], "s", "b", undefined, undefined, "mb2");
        await client.sendDraft("d2");
        const put = fetchMock.calls().at(-1);
        assert.ok(put.url.includes("/mail/mb2/draft/d2"), put.url);
    });

    it("loads the draft before every update, so edits made in kMail survive", async () => {
        const client = new MailClient("t");
        fetchMock.enqueue(
            jsonResponse(MAILBOXES),
            jsonResponse({ result: "error" }, { status: 403 }),
            jsonResponse({ result: "success", data: { uuid: "d3", uid: 1 } }),
            jsonResponse({ result: "success", data: { ...apiDraft, uuid: "d3", subject: "Edited in kMail", body: "<div>Human text</div>" } }),
            jsonResponse({ result: "success", data: { uid: 2 } }),
        );
        await client.createDraft(["a@x.ch"], "s", "b");
        await client.updateDraft("d3", { to: ["c@x.ch"] });
        const put = JSON.parse(fetchMock.calls().at(-1).options.body);
        assert.strictEqual(put.subject, "Edited in kMail");
        assert.strictEqual(put.body, "<div>Human text</div>");
        assert.deepStrictEqual(put.to, [{ name: "", email: "c@x.ch" }]);
    });

    it("sends the version in kMail, not the cached one", async () => {
        const client = new MailClient("t");
        fetchMock.enqueue(
            jsonResponse(MAILBOXES),
            jsonResponse({ result: "error" }, { status: 403 }),
            jsonResponse({ result: "success", data: { uuid: "d3", uid: 1 } }),
            jsonResponse({ result: "success", data: { ...apiDraft, uuid: "d3", body: "<div>Human text</div>" } }),
            jsonResponse({ result: "success", data: { sent: true } }),
        );
        await client.createDraft(["a@x.ch"], "s", "b");
        await client.sendDraft("d3");
        const put = JSON.parse(fetchMock.calls().at(-1).options.body);
        assert.strictEqual(put.action, "send");
        assert.strictEqual(put.body, "<div>Human text</div>");
    });

    it("falls back to the cache when the load fails with a network error", async () => {
        const client = new MailClient("t", { retryDelayMs: 1 });
        fetchMock.enqueue(
            jsonResponse(MAILBOXES),
            jsonResponse({ result: "error" }, { status: 403 }),
            jsonResponse({ result: "success", data: { uuid: "d3", uid: 1 } }),
            new TypeError("fetch failed"),
            new TypeError("fetch failed"),
            jsonResponse({ result: "success", data: { uid: 2 } }),
        );
        await client.createDraft(["a@x.ch"], "s", "b");
        const result = await client.updateDraft("d3", { subject: "x" });
        assert.strictEqual(result.subject, "x");
    });

    it("does not fall back to the cache when the draft is gone", async () => {
        const client = new MailClient("t");
        fetchMock.enqueue(
            jsonResponse(MAILBOXES),
            jsonResponse({ result: "error" }, { status: 403 }),
            jsonResponse({ result: "success", data: { uuid: "d3", uid: 1 } }),
            jsonResponse({ result: "error", error: { code: "object_not_found", description: "gone" } }, { status: 404 }),
        );
        await client.createDraft(["a@x.ch"], "s", "b");
        await assert.rejects(client.sendDraft("d3"), /404 object_not_found/);
    });

    it("keeps the quoted original of a reply when the body changes", async () => {
        const client = new MailClient("t");
        fetchMock.enqueue(
            jsonResponse({ result: "success", data: { uid: "42", msg_id: "<s@x.ch>", subject: "Plan", date: "2026-03-01", from: [{ name: "Al", email: "al@y.ch" }], headers: {}, body: { value: "Original text", type: "text/plain" } } }),
            jsonResponse(MAILBOXES),
            jsonResponse({ result: "error" }, { status: 403 }),
            jsonResponse({ result: "success", data: { uuid: "d4", uid: 1 } }),
        );
        const draft = await client.replyToEmail("mb1", "inbox", "42", "First", { quote: true });
        const created = JSON.parse(fetchMock.calls().at(-1).options.body);
        assert.match(created.body, /Original text/);
        fetchMock.enqueue(
            jsonResponse({ result: "success", data: { ...apiDraft, uuid: "d4", body: created.body } }),
            jsonResponse({ result: "success", data: { uid: 2 } }),
        );
        await client.updateDraft("d4", { body: "Second" });
        const put = JSON.parse(fetchMock.calls().at(-1).options.body);
        assert.match(put.body, /Second/);
        assert.match(put.body, /Original text/);
        assert.doesNotMatch(put.body, /First/);
        assert.strictEqual(draft.body, "First");
    });

    const QUOTED = '<html><body><div>Hello<br><br><blockquote data-mcp-quote="1" style="margin: 0;">Original &lt;b&gt; text</blockquote></div></body></html>';

    it("finds the quote in a draft this process did not create, and returns the loaded body as untrusted_content", async () => {
        const client = new MailClient("t");
        fetchMock.enqueue(
            jsonResponse(MAILBOXES),
            jsonResponse({ result: "success", data: { ...apiDraft, uuid: "dq", body: QUOTED } }),
            jsonResponse({ result: "success", data: { uid: 9 } }),
            jsonResponse({ result: "success", data: { ...apiDraft, uuid: "dq", body: QUOTED } }),
            jsonResponse({ result: "success", data: { uid: 10 } }),
        );
        const subjectOnly = await client.updateDraft("dq", { subject: "New" });
        assert.strictEqual(subjectOnly.body, undefined);
        assert.strictEqual(subjectOnly.untrusted_content, "Hello");
        const updated = await client.updateDraft("dq", { body: "Fresh" });
        const put = JSON.parse(fetchMock.calls().at(-1).options.body);
        assert.match(put.body, /Fresh/);
        assert.match(put.body, /Original &lt;b&gt; text/, "the quoted original stays");
        assert.doesNotMatch(put.body, /Hello/);
        assert.strictEqual(updated.body, "Fresh", "text written in this call is the caller's own");
        assert.strictEqual(updated.untrusted_content, undefined);
    });

    it("keeps the quote after kMail normalizes the saved HTML", async () => {
        const client = new MailClient("t");
        fetchMock.enqueue(
            jsonResponse({ result: "success", data: { uid: "42", msg_id: "<s@x.ch>", subject: "Plan", date: "2026-03-01", from: [{ name: "Al", email: "al@y.ch" }], headers: {}, body: { value: "Original text", type: "text/plain" } } }),
            jsonResponse(MAILBOXES),
            jsonResponse({ result: "error" }, { status: 403 }),
            jsonResponse({ result: "success", data: { uuid: "d5", uid: 1 } }),
        );
        await client.replyToEmail("mb1", "inbox", "42", "First", { quote: true });
        const created = JSON.parse(fetchMock.calls().at(-1).options.body);
        fetchMock.enqueue(
            jsonResponse({ result: "success", data: { ...apiDraft, uuid: "d5", body: created.body.replace("<html><body>", "<html><body>\n") + "<div>-- signature</div>" } }),
            jsonResponse({ result: "success", data: { uid: 2 } }),
        );
        await client.updateDraft("d5", { body: "Second" });
        const put = JSON.parse(fetchMock.calls().at(-1).options.body);
        assert.match(put.body, /Second/);
        assert.match(put.body, /Original text/);
    });

    it("reports recipients from the loaded draft, not from the cache", async () => {
        const client = new MailClient("t");
        fetchMock.enqueue(
            jsonResponse(MAILBOXES),
            jsonResponse({ result: "error" }, { status: 403 }),
            jsonResponse({ result: "success", data: { uuid: "d6", uid: 1 } }),
        );
        await client.createDraft(["old@x.ch"], "s", "b");
        const created = JSON.parse(fetchMock.calls().at(-1).options.body);
        fetchMock.enqueue(
            jsonResponse({ result: "success", data: { ...apiDraft, uuid: "d6", body: created.body, to: [{ name: "", email: "new@x.ch" }], cc: [{ name: "", email: "c@x.ch" }] } }),
            jsonResponse({ result: "success", data: { uid: 2 } }),
        );
        const result = await client.updateDraft("d6", { subject: "Only subject" });
        assert.strictEqual(result.to, "new@x.ch");
        assert.strictEqual(result.cc, "c@x.ch");
        assert.strictEqual(result.body, "b", "the body is still the text written here");
    });

    it("refuses to send when the draft cannot be loaded, even with a cached copy", async () => {
        const client = new MailClient("t", { retryDelayMs: 1 });
        fetchMock.enqueue(
            jsonResponse(MAILBOXES),
            jsonResponse({ result: "error" }, { status: 403 }),
            jsonResponse({ result: "success", data: { uuid: "d7", uid: 1 } }),
            jsonResponse({ result: "error", error: { code: "x", description: "down" } }, { status: 500 }),
        );
        await client.createDraft(["a@x.ch"], "s", "b");
        await assert.rejects(client.sendDraft("d7"), /could not be loaded, so nothing was sent: 500 x: down/);
        assert.ok(fetchMock.calls().every((c) => !(c.options.method === "PUT")), "no send request");
    });

    it("reports a missing draft", async () => {
        const client = new MailClient("t");
        fetchMock.enqueue(
            jsonResponse(MAILBOXES),
            jsonResponse({ result: "error", error: { code: "object_not_found", description: "Draft not found" } }, { status: 404 }),
        );
        await assert.rejects(client.updateDraft("nope", { subject: "x" }), /404 object_not_found/);
    });

    it("appends attachments and clears them with an empty array", async () => {
        const client = new MailClient("t");
        fetchMock.enqueue(
            jsonResponse(MAILBOXES),
            jsonResponse({ result: "success", data: apiDraft }),
            jsonResponse({ result: "success", data: { uuid: "new-att" } }),
            jsonResponse({ result: "success", data: { uid: 6 } }),
            jsonResponse({ result: "success", data: apiDraft }),
            jsonResponse({ result: "success", data: { uid: 7 } }),
        );
        await client.updateDraft("d1", { attachments: [{ filename: "b.txt", base64_content: "aGk=" }] });
        const first = JSON.parse(fetchMock.calls()[3].options.body);
        assert.deepStrictEqual(first.attachments, ["old-att", "new-att"]);
        await client.updateDraft("d1", { attachments: [] });
        const second = JSON.parse(fetchMock.calls()[5].options.body);
        assert.deepStrictEqual(second.attachments, []);
    });

    it("listDrafts returns the draft uuid, limit, and offset", async () => {
        const client = new MailClient("t");
        fetchMock.enqueue(
            jsonResponse(MAILBOXES),
            jsonResponse({ result: "success", data: [{ id: "drafts", name: "Drafts", role: "DRAFT", separator: "/" }] }),
            jsonResponse({ result: "success", data: { threads: [
                { uid: "t1", subject: "S", messages: [{ uid: "9@drafts", folder_id: "drafts", resource: "/api/mail/mb1/draft/d9" }] },
            ] } }),
        );
        const drafts = await client.listDrafts(undefined, 10, 20);
        assert.strictEqual(drafts[0].draft_uuid, "d9");
        const url = new URL(fetchMock.calls()[2].url);
        assert.strictEqual(url.searchParams.get("limit"), "10");
        assert.strictEqual(url.searchParams.get("offset"), "20");
    });
});
