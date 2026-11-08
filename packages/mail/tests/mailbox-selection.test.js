import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { createFetchMock, jsonResponse } from "./helpers.js";

const { MailClient } = await import("../dist/mail-client.js");

const TWO_MAILBOXES = {
    result: "success",
    data: [
        { uuid: "mb-shared", email: "team@x.ch", mailbox: "team", hosting_id: 7, is_primary: false },
        { uuid: "mb-main", email: "me@x.ch", mailbox: "me", hosting_id: 7, is_primary: true, aliases: ["alias@x.ch"] },
    ],
};

describe("mailbox selection", () => {
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

    it("picks the mailbox flagged is_primary, not the first one", async () => {
        fetchMock.enqueue(jsonResponse(TWO_MAILBOXES));
        const client = new MailClient("t");
        assert.strictEqual(await client.getMailboxUuid(), "mb-main");
    });

    it("falls back to the first mailbox when none is primary", async () => {
        fetchMock.enqueue(jsonResponse({ result: "success", data: [TWO_MAILBOXES.data[0]] }));
        const client = new MailClient("t");
        assert.strictEqual(await client.getMailboxUuid(), "mb-shared");
    });

    it("loads the mailbox list when createDraft gets an explicit mailbox_uuid", async () => {
        fetchMock.enqueue(
            jsonResponse(TWO_MAILBOXES),
            jsonResponse({ result: "success", data: { signatures: [] } }),
            jsonResponse({ result: "success", data: { uuid: "d1", uid: 1 } }),
        );
        const client = new MailClient("t");
        const draft = await client.createDraft(["a@x.ch"], "s", "b", undefined, undefined, "mb-shared");
        assert.strictEqual(draft.resolved_from.email, "team@x.ch");
        const paths = fetchMock.calls().map((c) => new URL(c.url).pathname);
        assert.deepStrictEqual(paths, [
            "/api/mailbox",
            "/1/mail_hostings/7/mailboxes/team/signatures",
            "/api/mail/mb-shared/draft",
        ]);
    });

    it("warns when identities cannot be loaded for the mailbox address", async () => {
        fetchMock.enqueue(
            jsonResponse(TWO_MAILBOXES),
            jsonResponse({ result: "error" }, { status: 403 }),
            jsonResponse({ result: "success", data: { uuid: "d1", uid: 1 } }),
        );
        const client = new MailClient("t");
        const draft = await client.createDraft(["a@x.ch"], "s", "b");
        assert.match(draft.warnings.join(" "), /identities could not be loaded/);
    });

    it("refuses an alias sender when identities cannot be loaded", async () => {
        fetchMock.enqueue(
            jsonResponse(TWO_MAILBOXES),
            jsonResponse({ result: "error" }, { status: 403 }),
        );
        const client = new MailClient("t");
        await assert.rejects(
            client.createDraft(["a@x.ch"], "s", "b", undefined, undefined, undefined, undefined, undefined, undefined, "alias@x.ch"),
            /Cannot send from alias alias@x.ch/,
        );
        assert.strictEqual(fetchMock.calls().length, 2, "no draft is created");
    });
});
