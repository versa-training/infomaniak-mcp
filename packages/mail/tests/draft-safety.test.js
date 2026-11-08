import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { createFetchMock, jsonResponse, connectTools, MAILBOXES } from "./helpers.js";

const { MailClient } = await import("../dist/mail-client.js");

const noIdentities = () => jsonResponse({ result: "error" }, { status: 403 });
const created = () => jsonResponse({ result: "success", data: { uuid: "d1", uid: 1 } });

describe("reply, forward, and send safety", () => {
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

    const message = (extra) => jsonResponse({ result: "success", data: {
        uid: "42", msg_id: "<s@x.ch>", subject: "Plan", date: "2026-03-01", headers: {},
        body: { value: "plain", type: "text/plain" }, ...extra,
    } });
    const posted = () => JSON.parse(fetchMock.calls().filter((c) => c.options.method === "POST").at(-1).options.body);

    it("forward escapes the original and its header lines even for an HTML note", async () => {
        fetchMock.enqueue(
            message({
                from: [{ name: "Eve", email: "eve@evil.com" }],
                to: [{ name: "", email: "me@x.ch" }],
                body: { value: "<p>&lt;a href=&quot;https://evil.example/login&quot;&gt;Log in&lt;/a&gt;</p><p>second line</p>", type: "text/html" },
            }),
            jsonResponse(MAILBOXES), noIdentities(), created(),
        );
        const result = await new MailClient("t").forwardEmail("mb1", "inbox", "42", ["b@x.ch"], "<b>FYI</b>", { bodyFormat: "html" });
        const html = posted().body;
        assert.match(html, /<b>FYI<\/b>/);
        assert.doesNotMatch(html, /<a href="https:\/\/evil/);
        assert.match(html, /&lt;a href=&quot;https:\/\/evil\.example\/login&quot;&gt;/);
        assert.match(html, /From: Eve &lt;eve@evil\.com&gt;<br>/);
        assert.match(html, /Log in[^]*<br>/);
        assert.strictEqual(result.body, "<b>FYI</b>", "the result carries the caller's note only");
        assert.doesNotMatch(JSON.stringify(result), /evil/);
    });

    it("reply-all to a message the mailbox sent does not repeat To recipients in Cc", async () => {
        fetchMock.enqueue(
            message({
                from: [{ name: "", email: "me@x.ch" }],
                to: [{ name: "", email: "a@x.ch" }, { name: "", email: "b@x.ch" }],
                cc: [{ name: "", email: "c@x.ch" }],
            }),
            jsonResponse(MAILBOXES), noIdentities(), created(),
        );
        await new MailClient("t").replyToEmail("mb1", "sent", "42", "Hi", { replyAll: true });
        const draft = posted();
        assert.deepStrictEqual(draft.to.map((r) => r.email), ["a@x.ch", "b@x.ch"]);
        assert.deepStrictEqual(draft.cc.map((r) => r.email), ["c@x.ch"]);
    });

    const failSend = async (failure) => {
        fetchMock.enqueue(jsonResponse(MAILBOXES), noIdentities(), created(), failure);
        return new MailClient("t").sendEmail(["a@x.ch"], "s", "b").then(() => assert.fail("should reject"), (error) => error.message);
    };

    it("a rejected send (4xx) names the draft and advises a retry", async () => {
        const message = await failSend(jsonResponse({ result: "error", error: { code: "invalid_recipient", description: "bad" } }, { status: 422 }));
        assert.match(message, /422 invalid_recipient: bad \(the draft d1 stays in Drafts: retry with mail_send_draft/);
    });

    it("a 5xx on send says the mail may have been sent and gives no retry advice", async () => {
        const message = await failSend(jsonResponse({ result: "error", error: { code: "send_failed", description: "quota" } }, { status: 500 }));
        assert.match(message, /500 send_failed: quota \(the mail may already have been sent: check the Sent folder before retrying/);
        assert.doesNotMatch(message, /retry with mail_send_draft/);
    });

    it("a timeout or network error on send says the mail may have been sent", async () => {
        const timeout = await failSend(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
        assert.match(timeout, /timed out after 30 s \(the mail may already have been sent: check the Sent folder/);
        assert.doesNotMatch(timeout, /retry with mail_send_draft/);
        const network = await failSend(new TypeError("fetch failed"));
        assert.match(network, /Request failed: .*\(the mail may already have been sent/);
    });

    it("mail_update_draft is not idempotent because attachments are appended", async () => {
        const { mcp, close } = await connectTools();
        try {
            const { tools } = await mcp.listTools();
            assert.strictEqual(tools.find((t) => t.name === "mail_update_draft").annotations.idempotentHint, false);
        } finally {
            await close();
        }
    });
});
