import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { createFetchMock, jsonResponse, MAILBOXES } from "./helpers.js";

const { MailClient, parseAddress, formatAddress } = await import("../dist/mail-client.js");

function sourceMessage(headers, extra = {}) {
    return jsonResponse({
        result: "success",
        data: {
            uid: "42",
            msg_id: "<src@x.ch>",
            subject: "Hello",
            from: [{ name: "", email: "alice@x.ch" }],
            reply_to: [{ name: "List", email: "list@x.ch" }],
            to: [{ name: "Me", email: "me@x.ch" }],
            headers,
            ...extra,
        },
    });
}

describe("recipient parsing and threading", () => {
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

    it("parseAddress handles bare, named, and quoted-comma forms", () => {
        assert.deepStrictEqual(parseAddress("a@x.ch"), { name: "", email: "a@x.ch" });
        assert.deepStrictEqual(parseAddress("Alice <a@x.ch>"), { name: "Alice", email: "a@x.ch" });
        assert.deepStrictEqual(parseAddress('"Doe, John" <j@x.ch>'), { name: "Doe, John", email: "j@x.ch" });
        assert.throws(() => parseAddress("not an address"), /Invalid email address/);
        assert.throws(() => parseAddress("a@x"), /Invalid email address/);
    });

    it("formatAddress prints the bare address when the name is empty or missing", () => {
        assert.strictEqual(formatAddress({ name: "", email: "a@x.ch" }), "a@x.ch");
        assert.strictEqual(formatAddress({ email: "a@x.ch" }), "a@x.ch");
        assert.strictEqual(formatAddress({ name: "Al", email: "a@x.ch" }), "Al <a@x.ch>");
    });

    it("createDraft splits a recipient string without breaking quoted commas", async () => {
        fetchMock.enqueue(
            jsonResponse(MAILBOXES),
            jsonResponse({ result: "error" }, { status: 403 }),
            jsonResponse({ result: "success", data: { uuid: "d1", uid: 1 } }),
        );
        const client = new MailClient("t");
        await client.createDraft('Alice <a@x.ch>, "Doe, John" <j@x.ch>', "s", "b");
        const body = JSON.parse(fetchMock.calls()[2].options.body);
        assert.deepStrictEqual(body.to, [
            { name: "Alice", email: "a@x.ch" },
            { name: "Doe, John", email: "j@x.ch" },
        ]);
        assert.strictEqual(body.reply_to, null);
    });

    it("createDraft rejects an invalid recipient before any draft exists", async () => {
        fetchMock.enqueue(
            jsonResponse(MAILBOXES),
            jsonResponse({ result: "error" }, { status: 403 }),
        );
        const client = new MailClient("t");
        await assert.rejects(client.createDraft("nobody", "s", "b"), /Invalid email address/);
        assert.strictEqual(fetchMock.calls().length, 2);
    });

    it("createDraft defaults references to in_reply_to", async () => {
        fetchMock.enqueue(
            jsonResponse(MAILBOXES),
            jsonResponse({ result: "error" }, { status: 403 }),
            jsonResponse({ result: "success", data: { uuid: "d1", uid: 1 } }),
        );
        const client = new MailClient("t");
        await client.createDraft("a@x.ch", "s", "b", undefined, undefined, undefined, "<p@x.ch>");
        const body = JSON.parse(fetchMock.calls()[2].options.body);
        assert.strictEqual(body.in_reply_to, "<p@x.ch>");
        assert.strictEqual(body.references, "<p@x.ch>");
    });

    it("threading falls back to the parent's In-Reply-To when it has no References", async () => {
        fetchMock.enqueue(
            jsonResponse(MAILBOXES),
            sourceMessage({ "In-Reply-To": "<grand@x.ch>" }),
            jsonResponse({ result: "error" }, { status: 403 }),
            jsonResponse({ result: "success", data: { uuid: "d1", uid: 1 } }),
        );
        const client = new MailClient("t");
        await client.createDraft("a@x.ch", "s", "b", undefined, undefined, undefined, undefined, "42@fid");
        const body = JSON.parse(fetchMock.calls()[3].options.body);
        assert.strictEqual(body.in_reply_to, "<src@x.ch>");
        assert.strictEqual(body.references, "<grand@x.ch> <src@x.ch>");
    });

    it("readEmail returns reply_to and prints bare addresses without a name", async () => {
        fetchMock.enqueue(sourceMessage({}));
        const client = new MailClient("t");
        const email = await client.readEmail("mb1", "fid", "42");
        assert.strictEqual(email.reply_to, "List <list@x.ch>");
        assert.strictEqual(email.from, "alice@x.ch");
    });
});
