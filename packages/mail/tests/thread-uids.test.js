import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { createFetchMock, jsonResponse } from "./helpers.js";

const { MailClient } = await import("../dist/mail-client.js");

const FOLDERS = {
    result: "success",
    data: [
        { id: "inbox", name: "INBOX", separator: "/", role: "INBOX", children: [] },
        { id: "trash", name: "Trash", separator: "/", role: "TRASH", children: [] },
        { id: "mine", name: "Mine", separator: "/", role: null, children: [] },
    ],
};

describe("thread UIDs, folders, and filenames", () => {
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

    it("listEmails returns every message UID of a thread with its folder", async () => {
        fetchMock.enqueue(jsonResponse({
            result: "success",
            data: {
                threads: [{
                    uid: "t1",
                    subject: "S",
                    from: [{ name: "", email: "a@x.ch" }],
                    messages: [
                        { uid: "7@inbox", folder_id: "inbox" },
                        { uid: "9@sent", folder_id: "sent" },
                    ],
                }],
            },
        }));
        const [thread] = await new MailClient("t").listEmails("mb", "inbox");
        assert.strictEqual(thread.first_message_uid, "7");
        assert.deepStrictEqual(thread.messages, [
            { uid: "7", folder_id: "inbox", ref: "7@inbox" },
            { uid: "9", folder_id: "sent", ref: "9@sent" },
        ]);
        assert.strictEqual(thread.from, "a@x.ch");
    });

    it("searchEmails sends the end of the before day and rejects malformed dates", async () => {
        fetchMock.enqueue(jsonResponse({ result: "success", data: { threads: [] } }));
        await new MailClient("t").searchEmails("mb", { before: "2026-06-30", folderId: "inbox" });
        const params = new URL(fetchMock.calls()[0].url).searchParams;
        assert.strictEqual(params.get("stodate"), "2026-06-30 23:59:59");
        await assert.rejects(
            new MailClient("t").searchEmails("mb", { since: "June 1", folderId: "inbox" }),
            /since must be a date/,
        );
    });

    it("deleteFolder refuses a folder that has a system role", async () => {
        fetchMock.enqueue(jsonResponse(FOLDERS));
        await assert.rejects(new MailClient("t").deleteFolder("mb", "trash"), /system folder "Trash"/);
        assert.strictEqual(fetchMock.calls().length, 1);
    });

    it("deleteEmails in Trash reports that nothing moved", async () => {
        fetchMock.enqueue(jsonResponse(FOLDERS));
        const result = await new MailClient("t").deleteEmails("mb", "trash", ["1"], false);
        assert.strictEqual(result.deleted, 0);
        assert.strictEqual(result.result, "skipped");
        assert.match(result.note, /permanent=true/);
        assert.strictEqual(fetchMock.calls().length, 1, "no move request");
    });

    it("deleteEmails with folder_id Trash still moves refs from other folders and never advises purging them", async () => {
        fetchMock.enqueue(jsonResponse(FOLDERS), jsonResponse({ result: "success" }));
        const result = await new MailClient("t").deleteEmails("mb", "trash", ["5@inbox", "7", "8@trash"], false);
        const moved = JSON.parse(fetchMock.calls()[1].options.body);
        assert.deepStrictEqual(moved.uids, ["5@inbox"]);
        assert.strictEqual(moved.to, "trash");
        assert.strictEqual(result.result, "success");
        assert.strictEqual(result.deleted, 1);
        assert.strictEqual(result.already_in_trash, 2);
        assert.match(result.note, /7@trash, 8@trash/);
    });

    it("deleteEmails with folder_id inbox does not count refs already in Trash as deleted", async () => {
        fetchMock.enqueue(jsonResponse(FOLDERS), jsonResponse({ result: "success" }));
        const result = await new MailClient("t").deleteEmails("mb", "inbox", ["1", "2@trash", "3@mine"], false);
        assert.deepStrictEqual(JSON.parse(fetchMock.calls()[1].options.body).uids, ["1@inbox", "3@mine"]);
        assert.strictEqual(result.deleted, 2);
        assert.strictEqual(result.already_in_trash, 1);
    });

    it("downloadAttachment survives a malformed or Latin-1 filename*", async () => {
        const cases = [
            ["attachment; filename*=UTF-8''bad%E9name.pdf; filename=\"fallback.pdf\"", "fallback.pdf"],
            ["attachment; filename*=ISO-8859-1''caf%E9.txt", "café.txt"],
            ["attachment; filename*=UTF-8''%E2%82%AC.txt", "€.txt"],
            ['attachment; filename="a;b.txt"', "a;b.txt"],
            ['attachment; filename="q\\"uote.txt"', 'q"uote.txt'],
        ];
        for (const [disposition, expected] of cases) {
            fetchMock.enqueue(new Response("x", {
                status: 200,
                headers: { "content-type": "text/plain", "content-disposition": disposition },
            }));
            const file = await new MailClient("t").downloadAttachment("mb", "f", "1", "a1");
            assert.strictEqual(file.filename, expected, disposition);
        }
    });

    it("a thread across folders is marked with refs that keep each folder", async () => {
        fetchMock.enqueue(jsonResponse({ result: "success", data: {} }));
        await new MailClient("t").markEmails("mb", "inbox", ["7@inbox", "9@sent"], true);
        assert.deepStrictEqual(JSON.parse(fetchMock.calls()[0].options.body).uids, ["7@inbox", "9@sent"]);
    });

    it("path UIDs are bare numbers while body UIDs accept refs", async () => {
        const { connectTools } = await import("./helpers.js");
        fetchMock.enqueue(jsonResponse({ result: "success", data: [{ uuid: "mb1", email: "me@x.ch", is_primary: true }] }));
        const { mcp, close } = await connectTools();
        try {
            const read = await mcp.callTool({ name: "mail_read_email", arguments: { folder_id: "inbox", message_uid: "123@inbox" } }).catch((e) => ({ isError: true, e }));
            assert.strictEqual(read.isError, true);
            assert.match(String(read.e?.message ?? read.content?.[0]?.text), /bare number/);
            fetchMock.enqueue(jsonResponse({ result: "success", data: {} }));
            const mark = await mcp.callTool({ name: "mail_mark_email", arguments: { folder_id: "inbox", message_uids: ["7", "9@sent"], read: true } });
            assert.notStrictEqual(mark.isError, true, JSON.stringify(mark.content));
        } finally {
            await close();
        }
    });
});
