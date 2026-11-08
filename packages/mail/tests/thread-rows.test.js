import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { createFetchMock, jsonResponse } from "./helpers.js";

const { MailClient } = await import("../dist/mail-client.js");
const { MAX_TEXT_LENGTH } = await import("../dist/output.js");

describe("thread rows and thread reading", () => {
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

    const thread = {
        uid: "t1",
        subject: "S",
        to: [{ name: "", email: "to@x.ch" }],
        messages: [
            { uid: 17, folder_id: "inbox", resource: "/api/mail/mb/draft/dd" },
            { uid: "18", folder_id: null },
        ],
    };

    it("list and search rows share one shape, accept numeric UIDs, and drop messages with no folder", async () => {
        fetchMock.enqueue(jsonResponse({ result: "success", data: { threads: [thread] } }));
        const [listed] = await new MailClient("t").listEmails("mb", "inbox");
        fetchMock.enqueue(jsonResponse({ result: "success", data: { threads: [thread] } }));
        const [found] = await new MailClient("t").searchEmails("mb", { query: "x", folderId: "inbox" });
        assert.deepStrictEqual(listed, found);
        assert.strictEqual(listed.first_message_uid, "17");
        assert.strictEqual(listed.to, "to@x.ch");
        assert.strictEqual(found.draft_uuid, "dd");
        assert.deepStrictEqual(listed.messages.map((m) => m.ref), ["17@inbox"]);
    });

    it("searchAllMailboxes throws when no mailbox could be searched", async () => {
        const mailboxes = jsonResponse({ result: "success", data: [{ uuid: "m1", email: "a@x.ch", mailbox: "a", hosting_id: 1 }, { uuid: "m2", email: "b@x.ch", mailbox: "b", hosting_id: 2 }] });
        fetchMock.enqueue(mailboxes, ...Array.from({ length: 2 }, () => jsonResponse({ result: "error", error: { code: "nope", description: "denied" } }, { status: 403 })));
        await assert.rejects(new MailClient("t").searchAllMailboxes({ query: "x" }), /No mailbox could be searched: .*denied/);
    });

    const message = (uid, body, extra = {}) => jsonResponse({ result: "success", data: {
        uid, date: `2026-03-0${uid}T00:00:00Z`, subject: `S${uid}`, headers: {}, body: { value: body, type: "text/plain" }, ...extra,
    } });

    it("readThread returns the readable messages and names the failed ones", async () => {
        global.fetch = async (url) => {
            const uid = new URL(String(url)).pathname.split("/").pop();
            return uid === "2"
                ? jsonResponse({ result: "error", error: { code: "object_not_found", description: "gone" } }, { status: 404 })
                : message(uid, "text " + uid);
        };
        const result = await new MailClient("t").readThread("mb", [1, 2, 3].map((n) => ({ folder_id: "f", uid: String(n) })));
        assert.deepStrictEqual(result.items.map((m) => m.uid), ["1", "3"]);
        assert.strictEqual(result.warnings.length, 1);
        assert.match(result.warnings[0], /2@f could not be read: 404 object_not_found/);
    });

    it("readThread fails when no message can be read", async () => {
        fetchMock.enqueue(jsonResponse({ result: "error", error: { code: "object_not_found", description: "gone" } }, { status: 404 }));
        await assert.rejects(new MailClient("t").readThread("mb", [{ folder_id: "f", uid: "1" }]), /No message of the thread could be read/);
    });

    it("readThread gives a short message's unused share to the long ones and flags truncation per message", async () => {
        global.fetch = async (url) => {
            const uid = new URL(String(url)).pathname.split("/").pop();
            return message(uid, uid === "1" ? "short" : "x".repeat(10_000));
        };
        const result = await new MailClient("t").readThread("mb", [1, 2, 3].map((n) => ({ folder_id: "f", uid: String(n) })), { maxLength: 9000 });
        const [short, long1, long2] = result.items;
        assert.strictEqual(short.untrusted_content, "short");
        assert.strictEqual(short.truncated, false);
        assert.strictEqual(long1.untrusted_content.length, 4497);
        assert.strictEqual(long2.untrusted_content.length, 4498);
        assert.ok(long1.truncated && long2.truncated);
    });

    it("readThread budgets message metadata so no message is cut by the size cap", async () => {
        const attachments = Array.from({ length: 60 }, (_, i) => ({ name: `file-${i}.pdf`, part_id: i, size: 1, mime_type: "application/pdf" }));
        global.fetch = async (url) => {
            const uid = new URL(String(url)).pathname.split("/").pop();
            return message(uid, "y".repeat(20_000), { attachments, subject: "subject-" + uid });
        };
        const messages = Array.from({ length: 6 }, (_, i) => ({ folder_id: "f", uid: String(i + 1) }));
        const result = await new MailClient("t").readThread("mb", messages, { maxLength: 100_000 });
        const size = JSON.stringify({ items: result.items, has_more: false }).length;
        assert.ok(size <= MAX_TEXT_LENGTH, `result is ${size} characters`);
        assert.ok(result.items.every((m) => m.subject.startsWith("subject-") && m.attachments.length === 60), "metadata is not cut");
        assert.ok(result.items.every((m) => m.truncated === (m.untrusted_content.length < 20_000)));
    });
});
