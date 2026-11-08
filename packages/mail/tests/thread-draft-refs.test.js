import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { createFetchMock, jsonResponse, MAILBOXES } from "./helpers.js";

const { MailClient } = await import("../dist/mail-client.js");

describe("thread refs and draft attachments", () => {
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

    const ok = (data) => jsonResponse({ result: "success", data });

    it("readThread items carry folder_id and a uid@folder_id ref", async () => {
        global.fetch = async (url) => {
            const uid = new URL(String(url)).pathname.split("/").pop();
            return ok({ uid, subject: "s", date: "2026-03-01", headers: {}, body: { value: "t", type: "text/plain" } });
        };
        const result = await new MailClient("t").readThread("mb", [{ folder_id: "f1", uid: "5" }, { folder_id: "f2", uid: "5" }]);
        assert.deepStrictEqual(result.items.map((m) => m.ref).sort(), ["5@f1", "5@f2"]);
        assert.deepStrictEqual(result.items.map((m) => m.folder_id).sort(), ["f1", "f2"]);
    });

    it("an update fails instead of dropping a draft attachment it cannot identify", async () => {
        const draft = { uuid: "d1", from: { id: null, name: "Me", email: "me@x.ch" }, subject: "s", body: "x", to: [], attachments: [{ resource: "/api/mail/mb1/att/abc" }, { part_id: 2 }] };
        fetchMock.enqueue(ok(draft));
        await assert.rejects(
            new MailClient("t").updateDraft("d1", { subject: "new" }, "mb1"),
            /1 attachment\(s\) that cannot be identified/,
        );
        assert.ok(!fetchMock.calls().some((c) => c.options.method === "PUT"));
    });

    it("a message-style attachment resource maps to its UUID", async () => {
        const draft = { uuid: "d1", from: { id: null, name: "Me", email: "me@x.ch" }, subject: "s", body: "x", to: [], attachments: [{ resource: "/api/mail/mb1/att/abc" }] };
        fetchMock.enqueue(ok(draft), ok(true));
        await new MailClient("t").updateDraft("d1", { subject: "new" }, "mb1");
        const put = fetchMock.calls().find((c) => c.options.method === "PUT");
        assert.deepStrictEqual(JSON.parse(put.options.body).attachments, ["abc"]);
    });
});
