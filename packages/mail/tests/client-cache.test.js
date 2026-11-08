import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { createFetchMock, jsonResponse } from "./helpers.js";

const { MailClient, headerFilename } = await import("../dist/mail-client.js");

const mailbox = (aliases = []) => ({ uuid: "mb1", email: "me@x.ch", mailbox: "me", hosting_id: 7, is_primary: true, aliases });
const mailboxes = (aliases) => jsonResponse({ result: "success", data: [mailbox(aliases)] });
const signatures = (list) => jsonResponse({ result: "success", data: { signatures: list } });
const identity = (id, sender) => ({ id, sender, full_name: "Me", is_default: id === 1 });

describe("account caches, Retry-After dates, and header filenames", () => {
    let fetchMock;
    let originalFetch;
    let originalNow;

    beforeEach(() => {
        fetchMock = createFetchMock();
        originalFetch = global.fetch;
        originalNow = Date.now;
        global.fetch = fetchMock;
    });

    afterEach(() => {
        global.fetch = originalFetch;
        Date.now = originalNow;
    });

    it("waits for an HTTP-date Retry-After on 429 before the GET retry", async () => {
        const date = new Date(Date.now() + 1500).toUTCString();
        fetchMock.enqueue(
            jsonResponse({ result: "error" }, { status: 429, headers: { "retry-after": date } }),
            mailboxes(),
        );
        const start = performance.now();
        await new MailClient("t", { retryDelayMs: 1 }).init();
        assert.ok(performance.now() - start >= 300, "slept for the date, not the base delay");
        assert.strictEqual(fetchMock.calls().length, 2);
    });

    it("uses the base delay for an unparsable or past Retry-After", async () => {
        fetchMock.enqueue(
            jsonResponse({ result: "error" }, { status: 503, headers: { "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT" } }),
            mailboxes(),
        );
        const start = performance.now();
        await new MailClient("t", { retryDelayMs: 1 }).init();
        assert.ok(performance.now() - start < 300);
    });

    it("reloads the mailbox list once when a from_email alias is not known yet", async () => {
        fetchMock.enqueue(
            mailboxes(),
            mailboxes(["new@x.ch"]),
            signatures([identity(1, "me@x.ch"), identity(2, "new@x.ch")]),
            jsonResponse({ result: "success", data: { uuid: "d1", uid: 1 } }),
        );
        const client = new MailClient("t");
        await client.init();
        const draft = await client.createDraft(["a@x.ch"], "s", "b", undefined, undefined, "mb1", undefined, undefined, undefined, "new@x.ch");
        assert.strictEqual(draft.resolved_from.email, "new@x.ch");
        assert.strictEqual(draft.resolved_from.identity_id, "2");
    });

    it("still rejects an alias the reloaded list does not hold", async () => {
        fetchMock.enqueue(mailboxes(), mailboxes());
        const client = new MailClient("t");
        await client.init();
        await assert.rejects(
            client.createDraft(["a@x.ch"], "s", "b", undefined, undefined, "mb1", undefined, undefined, undefined, "ghost@x.ch"),
            /not allowed/,
        );
    });

    it("loads the identities again once when the alias has none, so a new identity works at once", async () => {
        fetchMock.enqueue(
            mailboxes(["new@x.ch"]),
            signatures([identity(1, "me@x.ch")]),
            signatures([identity(1, "me@x.ch"), identity(2, "new@x.ch")]),
            jsonResponse({ result: "success", data: { uuid: "d1", uid: 1 } }),
        );
        const client = new MailClient("t");
        await client.init();
        const draft = await client.createDraft(["a@x.ch"], "s", "b", undefined, undefined, "mb1", undefined, undefined, undefined, "new@x.ch");
        assert.strictEqual(draft.resolved_from.identity_id, "2");
        assert.strictEqual(draft.warnings, undefined);
    });

    it("refreshes the mailbox list and the identities after the cache time", async () => {
        let now = 1_000_000;
        Date.now = () => now;
        fetchMock.enqueue(mailboxes(), signatures([identity(1, "me@x.ch")]));
        const client = new MailClient("t");
        assert.strictEqual((await client.listIdentities("mb1")).length, 1);
        assert.strictEqual((await client.listIdentities("mb1")).length, 1);
        assert.strictEqual(fetchMock.calls().length, 2, "served from the caches");

        now += 61_000;
        fetchMock.enqueue(mailboxes(), signatures([identity(1, "me@x.ch"), identity(2, "me2@x.ch")]));
        assert.strictEqual((await client.listIdentities("mb1")).length, 2);
        assert.strictEqual(fetchMock.calls().length, 4);
    });

    it("percent-encodes non-ASCII names and names that hold a percent sign", () => {
        assert.strictEqual(headerFilename("report.pdf"), "report.pdf");
        assert.strictEqual(headerFilename("my file (1).pdf"), "my file (1).pdf");
        assert.strictEqual(headerFilename("100%25 done.pdf"), "100%2525%20done.pdf");
        assert.strictEqual(headerFilename("März.pdf"), "M%C3%A4rz.pdf");
    });
});
