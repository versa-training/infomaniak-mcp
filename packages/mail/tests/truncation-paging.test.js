import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { jsonResponse, connectTools } from "./helpers.js";

const { toTextResult, MAX_TEXT_LENGTH } = await import("../dist/output.js");
const { MailClient } = await import("../dist/mail-client.js");

describe("truncation keeps paging correct", () => {
    it("resumes right after the last kept item", () => {
        const items = Array.from({ length: 50 }, (_, i) => ({ i, pad: "x".repeat(3000) }));
        const result = toTextResult({ items, has_more: false }, { structured: true, offset: 20 });
        const page = JSON.parse(result.content[0].text);
        assert.ok(result.content[0].text.length <= MAX_TEXT_LENGTH);
        assert.ok(page.items.length > 0 && page.items.length < 50);
        assert.strictEqual(page.next_offset, 20 + page.items.length);
        assert.strictEqual(page.has_more, true);
        assert.strictEqual(page.truncated, true);
        assert.deepStrictEqual(page.items.map((i) => i.i), page.items.map((_, n) => n));
    });

    it("never returns an empty page: one oversized item keeps its shortened text", () => {
        const items = [
            { id: "1", untrusted_content: "y".repeat(300_000) },
            { id: "2", untrusted_content: "z" },
        ];
        const result = toTextResult({ items, has_more: false }, { offset: 0 });
        const page = JSON.parse(result.content[0].text);
        assert.ok(result.content[0].text.length <= MAX_TEXT_LENGTH);
        assert.strictEqual(page.items.length, 1);
        assert.ok(page.items[0].untrusted_content.length > 1000);
        assert.strictEqual(page.next_offset, 1);
        assert.strictEqual(page.has_more, true);
    });

    it("measures the cap after escaping", () => {
        const result = toTextResult({ untrusted_content: '"\\\n'.repeat(120_000), id: "a" });
        const parsed = JSON.parse(result.content[0].text);
        assert.ok(result.content[0].text.length <= MAX_TEXT_LENGTH);
        assert.strictEqual(parsed.id, "a");
        assert.ok(parsed.untrusted_content.length > 0);
        assert.strictEqual(parsed.truncated, true);
    });

    it("trims long arrays and objects of small values and reports the count", () => {
        const big = { rows: Array.from({ length: 60_000 }, (_, i) => [i, "a"]), keep: "k" };
        const result = toTextResult(big);
        const parsed = JSON.parse(result.content[0].text);
        assert.ok(result.content[0].text.length <= MAX_TEXT_LENGTH);
        assert.ok(parsed.rows.length > 0 && parsed.rows.length < 60_000);
        assert.strictEqual(parsed.rows_omitted, 60_000 - parsed.rows.length);
        assert.strictEqual(parsed.keep, "k");
    });
});

describe("mail_read_email stays under the cap with max_length 100000", () => {
    let originalFetch;
    beforeEach(() => { originalFetch = global.fetch; });
    afterEach(() => { global.fetch = originalFetch; });

    it("keeps attachments and headers and cuts only the body", async () => {
        global.fetch = async (url) => {
            const path = new URL(String(url)).pathname;
            if (path.endsWith("/mailbox")) return jsonResponse({ result: "success", data: [{ uuid: "mb1", email: "me@x.ch", is_primary: true }] });
            return jsonResponse({ result: "success", data: {
                uid: "1", msg_id: "<m@x.ch>", subject: "S", from: [{ email: "a@x.ch" }],
                body: { value: 'q"\n'.repeat(60_000), type: "text/plain" },
                attachments: [{ part_id: 2, name: "a.pdf", size: 5, mime_type: "application/pdf", resource: "/api/x/y/att1" }],
                headers: { "Message-ID": "<m@x.ch>" },
            } });
        };
        const { mcp, close } = await connectTools();
        try {
            const result = await mcp.callTool({ name: "mail_read_email", arguments: { folder_id: "f", message_uid: "1", max_length: 100000 } });
            const text = result.content[0].text;
            assert.ok(text.length <= MAX_TEXT_LENGTH, `length ${text.length}`);
            const email = JSON.parse(text);
            assert.strictEqual(email.truncated, true);
            assert.strictEqual(email.attachments[0].id, "att1");
            assert.strictEqual(email.headers["message-id"], "<m@x.ch>");
            assert.ok(email.untrusted_content.length > 10_000);
        } finally {
            await close();
        }
    });
});

describe("searchAllMailboxes", () => {
    let originalFetch;
    beforeEach(() => { originalFetch = global.fetch; });
    afterEach(() => { global.fetch = originalFetch; });

    const FOLDERS = { result: "success", data: [{ id: "inbox", name: "INBOX", separator: "/", role: "INBOX", children: [] }] };
    const thread = (uid, date) => ({ uid, subject: uid, date, messages: [{ uid: `${uid}@inbox`, folder_id: "inbox" }] });

    function serve(rowsByMailbox, failing = []) {
        const seen = [];
        global.fetch = async (url) => {
            const u = new URL(String(url));
            if (u.pathname.endsWith("/mailbox")) {
                return jsonResponse({ result: "success", data: Object.keys(rowsByMailbox).map((uuid, i) => ({ uuid, email: `${uuid}@x.ch`, is_primary: i === 0 })) });
            }
            const uuid = u.pathname.split("/")[3];
            if (u.pathname.endsWith("/folder")) return jsonResponse(FOLDERS);
            if (failing.includes(uuid)) return jsonResponse({ result: "error", error: { code: "forbidden", description: "no" } }, { status: 403 });
            seen.push({ uuid, offset: u.searchParams.get("offset"), limit: u.searchParams.get("limit") });
            const offset = Number(u.searchParams.get("offset"));
            const limit = Number(u.searchParams.get("limit"));
            return jsonResponse({ result: "success", data: { threads: rowsByMailbox[uuid].slice(offset, offset + limit) } });
        };
        return seen;
    }

    it("merges newest first, limits the page, and resumes from per-mailbox offsets", async () => {
        const seen = serve({
            mbA: [thread("a1", "2026-03-05T10:00:00Z"), thread("a2", "2026-03-01T10:00:00Z")],
            mbB: [thread("b1", "2026-03-04T10:00:00Z"), thread("b2", "2026-03-03T10:00:00Z")],
        });
        const client = new MailClient("t");
        const first = await client.searchAllMailboxes({ query: "x", limit: 2 });
        assert.deepStrictEqual(first.items.map((i) => i.thread_uid), ["a1", "b1"]);
        assert.strictEqual(first.has_more, true);
        assert.deepStrictEqual(first.next_mailbox_offsets, { mbA: 1, mbB: 1 });
        const second = await client.searchAllMailboxes({ query: "x", limit: 2 }, first.next_mailbox_offsets);
        assert.deepStrictEqual(second.items.map((i) => i.thread_uid), ["b2", "a2"]);
        assert.deepStrictEqual(seen.slice(-2).map((s) => s.offset).sort(), ["1", "1"]);
    });

    it("reports a failing mailbox in warnings and still returns the others", async () => {
        serve({ mbA: [thread("a1", "2026-03-05T10:00:00Z")], mbB: [] }, ["mbB"]);
        const found = await new MailClient("t").searchAllMailboxes({ query: "x", limit: 5 });
        assert.deepStrictEqual(found.items.map((i) => i.thread_uid), ["a1"]);
        assert.strictEqual(found.has_more, false);
        assert.match(found.warnings[0], /mbB/);
        assert.match(found.warnings[0], /403/);
    });

    it("rejects offset with all_mailboxes", async () => {
        serve({ mbA: [] });
        const { mcp, close } = await connectTools();
        try {
            const result = await mcp.callTool({ name: "mail_search_emails", arguments: { query: "x", all_mailboxes: true, offset: 5 } });
            assert.strictEqual(result.isError, true);
            assert.match(result.content[0].text, /mailbox_offsets/);
        } finally {
            await close();
        }
    });
});
