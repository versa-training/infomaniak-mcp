import { describe, it } from "node:test";
import assert from "node:assert";
import { connectTools, createFetchMock, jsonResponse, MAILBOXES } from "./helpers.js";

const { MailClient } = await import("../dist/mail-client.js");

/** Stub client: records every call and answers with canned data. */
function stubClient(overrides = {}) {
    const calls = [];
    const record = (name, result) => (...args) => {
        calls.push({ name, args });
        return Promise.resolve(typeof result === "function" ? result(...args) : result);
    };
    const client = {
        calls,
        getMailboxUuid: record("getMailboxUuid", "mb-default"),
        listMailboxes: record("listMailboxes", [{ uuid: "mb1" }]),
        listIdentities: record("listIdentities", [{ id: 1, sender: "me@x.ch" }]),
        listFolders: record("listFolders", [{ id: "f1" }]),
        createFolder: record("createFolder", { id: "f2" }),
        deleteFolder: record("deleteFolder", { result: "success" }),
        renameFolder: record("renameFolder", { id: "f1" }),
        listEmails: record("listEmails", [{ thread_uid: "t1" }]),
        searchEmails: record("searchEmails", [{ thread_uid: "t2" }]),
        readEmail: record("readEmail", { uid: "1" }),
        downloadAttachment: record("downloadAttachment", {
            filename: "a.txt", mime_type: "text/plain", size: 1, content: "eA==",
        }),
        sendEmail: record("sendEmail", { sent_to: {} }),
        createDraft: record("createDraft", { uuid: "d1" }),
        updateDraft: record("updateDraft", { uuid: "d1" }),
        sendDraft: record("sendDraft", { sent_to: {} }),
        deleteDraft: record("deleteDraft", true),
        listDrafts: record("listDrafts", [{ draft_uuid: "d1" }]),
        markEmails: record("markEmails", { result: "success" }),
        moveEmails: record("moveEmails", { result: "success" }),
        flagEmails: record("flagEmails", { result: "success" }),
        archiveEmails: record("archiveEmails", { result: "success" }),
        deleteEmails: record("deleteEmails", { result: "success" }),
        purgeFolder: record("purgeFolder", { folder: "trash", purged: true }),
        searchAllMailboxes: record("searchAllMailboxes", { items: [{ mailbox_uuid: "mb1" }], has_more: false }),
        replyToEmail: record("replyToEmail", { uuid: "d1" }),
        forwardEmail: record("forwardEmail", { uuid: "d2" }),
        readThread: record("readThread", { items: [{ uid: "1" }] }),
        listForwarding: record("listForwarding", { is_enabled: true, addresses: [], has_dont_deliver: false, has_forward_spam: false }),
        listAutoReplies: record("listAutoReplies", [{ id: 5 }]),
        createAutoReply: record("createAutoReply", { id: 6 }),
        updateAutoReply: record("updateAutoReply", { id: 5 }),
        deleteAutoReply: record("deleteAutoReply", { id: 5 }),
        ...overrides,
    };
    return client;
}

async function call(name, args, options, client = stubClient()) {
    const { mcp, close } = await connectTools(options, client);
    try {
        const result = await mcp.callTool({ name, arguments: args });
        return { result, client };
    } finally {
        await close();
    }
}

function lastCall(client, method) {
    return client.calls.filter((c) => c.name === method).at(-1);
}

describe("tools/call maps arguments onto the client", () => {
    const cases = [
        {
            tool: "mail_list_mailboxes", args: {}, method: "listMailboxes", expected: [],
        },
        {
            tool: "mail_list_identities", args: {}, method: "listIdentities", expected: ["mb-default"],
        },
        {
            tool: "mail_list_folders", args: {}, method: "listFolders", expected: ["mb-default"],
        },
        {
            tool: "mail_list_folders", args: { mailbox_uuid: "mbX" }, method: "listFolders", expected: ["mbX"],
        },
        {
            tool: "mail_create_folder",
            args: { name: "Bills", parent_folder_id: "p1" },
            method: "createFolder",
            expected: ["mb-default", "Bills", "p1"],
        },
        {
            tool: "mail_delete_folder", args: { folder_id: "f9" }, method: "deleteFolder", expected: ["mb-default", "f9"],
        },
        {
            tool: "mail_rename_folder",
            args: { folder_id: "f9", name: "New" },
            method: "renameFolder",
            expected: ["mb-default", "f9", "New"],
        },
        {
            tool: "mail_list_emails",
            args: { folder_id: "f1" },
            method: "listEmails",
            expected: ["mb-default", "f1", 50, 0, { unseen: undefined, flagged: undefined }],
        },
        {
            tool: "mail_list_emails",
            args: { folder_id: "f1", limit: 5, offset: 10, unseen: true },
            method: "listEmails",
            expected: ["mb-default", "f1", 5, 10, { unseen: true, flagged: undefined }],
        },
        {
            tool: "mail_search_emails",
            args: { query: "invoice", from: "a@x.ch", since: "2026-01-01", before: "2026-02-01", folder_id: "f1", limit: 7 },
            method: "searchEmails",
            expected: [
                "mb-default",
                {
                    query: "invoice", from: "a@x.ch", to: undefined, subject: undefined, since: "2026-01-01",
                    before: "2026-02-01", folderId: "f1", unseen: undefined, flagged: undefined, limit: 7, offset: 0,
                },
            ],
        },
        {
            tool: "mail_read_email",
            args: { folder_id: "f1", message_uid: "42" },
            method: "readEmail",
            expected: ["mb-default", "f1", "42", { format: "text", maxLength: 50000 }],
        },
        {
            tool: "mail_download_attachment",
            args: { folder_id: "f1", message_uid: "42", attachment_id: "2" },
            method: "downloadAttachment",
            expected: ["mb-default", "f1", "42", "2"],
        },
        {
            tool: "mail_send_email",
            args: {
                to: ["a@x.ch"], subject: "S", body: "B", cc: ["c@x.ch"], bcc: ["b@x.ch"], mailbox_uuid: "mbX",
                in_reply_to: "<m@x.ch>", in_reply_to_uid: "42@f1", references: "<r@x.ch>", from_email: "me@x.ch", from_name: "Me",
            },
            method: "sendEmail",
            expected: [
                ["a@x.ch"], "S", "B", ["c@x.ch"], ["b@x.ch"], undefined, "mbX",
                "<m@x.ch>", "42@f1", "<r@x.ch>", "me@x.ch", "Me", { bodyFormat: "text" },
            ],
        },
        {
            tool: "mail_create_draft",
            args: { subject: "S", body: "B" },
            method: "createDraft",
            expected: [
                undefined, "S", "B", undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
                { bodyFormat: "text", attachments: undefined },
            ],
        },
        {
            tool: "mail_update_draft",
            args: { draft_uuid: "d1", subject: "S2", cc: [] },
            method: "updateDraft",
            expected: ["d1", { bodyFormat: "text", subject: "S2", cc: [] }, undefined],
        },
        {
            tool: "mail_send_draft", args: { draft_uuid: "d1" }, method: "sendDraft", expected: ["d1", 0, undefined],
        },
        {
            tool: "mail_send_draft",
            args: { draft_uuid: "d1", delay: 30, mailbox_uuid: "mbX" },
            method: "sendDraft",
            expected: ["d1", 30, "mbX"],
        },
        {
            tool: "mail_delete_draft", args: { draft_uuid: "d1" }, method: "deleteDraft", expected: ["d1", undefined],
        },
        {
            tool: "mail_list_drafts", args: {}, method: "listDrafts", expected: [undefined, 50, 0],
        },
        {
            tool: "mail_mark_email",
            args: { folder_id: "f1", message_uids: ["1", "2"], read: true },
            method: "markEmails",
            expected: ["mb-default", "f1", ["1", "2"], true],
        },
        {
            tool: "mail_move_email",
            args: { message_uids: ["1"], from_folder_id: "f1", to_folder_id: "f2" },
            method: "moveEmails",
            expected: ["mb-default", ["1"], "f1", "f2"],
        },
        {
            tool: "mail_flag_email",
            args: { folder_id: "f1", message_uids: ["1"], flagged: false },
            method: "flagEmails",
            expected: ["mb-default", "f1", ["1"], false],
        },
        {
            tool: "mail_archive_email",
            args: { folder_id: "f1", message_uids: ["1"] },
            method: "archiveEmails",
            expected: ["mb-default", "f1", ["1"]],
        },
        {
            tool: "mail_delete_email",
            args: { folder_id: "f1", message_uids: ["1"] },
            method: "deleteEmails",
            expected: ["mb-default", "f1", ["1"], false],
        },
        {
            tool: "mail_delete_email",
            args: { folder_id: "f1", message_uids: ["1"], permanent: true, mailbox_uuid: "mbX" },
            method: "deleteEmails",
            expected: ["mbX", "f1", ["1"], true],
        },
        {
            tool: "mail_purge_folder", args: { folder: "trash" }, method: "purgeFolder", expected: ["mb-default", "trash"],
        },
        {
            tool: "mail_search_emails",
            args: { query: "x", all_mailboxes: true, unseen: true },
            method: "searchAllMailboxes",
            expected: [{
                query: "x", from: undefined, to: undefined, subject: undefined, since: undefined, before: undefined,
                unseen: true, flagged: undefined, limit: 50,
            }, undefined],
        },
        {
            tool: "mail_reply",
            args: { folder_id: "f1", message_uid: "42", body: "Thanks" },
            method: "replyToEmail",
            expected: ["mb-default", "f1", "42", "Thanks", { replyAll: false, quote: true, bodyFormat: "text", send: false, fromEmail: undefined, fromName: undefined }],
        },
        {
            tool: "mail_reply",
            args: { folder_id: "f1", message_uid: "42", body: "Thanks", reply_all: true, send: true },
            method: "replyToEmail",
            expected: ["mb-default", "f1", "42", "Thanks", { replyAll: true, quote: true, bodyFormat: "text", send: true, fromEmail: undefined, fromName: undefined }],
        },
        {
            tool: "mail_forward",
            args: { folder_id: "f1", message_uid: "42", to: ["z@x.ch"], body: "FYI", cc: ["c@x.ch"] },
            method: "forwardEmail",
            expected: ["mb-default", "f1", "42", ["z@x.ch"], "FYI", { cc: ["c@x.ch"], bodyFormat: "text", send: false, fromEmail: undefined, fromName: undefined }],
        },
        {
            tool: "mail_read_thread",
            args: { messages: [{ folder_id: "f1", uid: "1" }, { folder_id: "f2", uid: "9" }] },
            method: "readThread",
            expected: ["mb-default", [{ folder_id: "f1", uid: "1" }, { folder_id: "f2", uid: "9" }], { maxLength: 50000 }],
        },
        {
            tool: "mail_list_forwarding", args: {}, method: "listForwarding", expected: ["mb-default"],
        },
        {
            tool: "mail_list_auto_replies", args: {}, method: "listAutoReplies", expected: ["mb-default"],
        },
        {
            tool: "mail_create_auto_reply",
            args: { name: "Holiday", message: "Away", reply_from_id: 3 },
            method: "createAutoReply",
            expected: ["mb-default", { name: "Holiday", message: "Away", reply_from_id: 3, is_recurrent: false }],
        },
        {
            tool: "mail_update_auto_reply",
            args: { model_id: 5, is_active: true, message: "Back soon" },
            method: "updateAutoReply",
            expected: ["mb-default", 5, { is_active: true, message: "Back soon" }],
        },
        {
            tool: "mail_delete_auto_reply", args: { model_id: 5 }, method: "deleteAutoReply", expected: ["mb-default", 5],
        },
    ];

    for (const { tool, args, method, expected } of cases) {
        it(`${tool} ${JSON.stringify(args).slice(0, 60)} calls ${method}`, async () => {
            const { result, client } = await call(tool, args);
            assert.notStrictEqual(result.isError, true, JSON.stringify(result.content));
            assert.strictEqual(result.content[0].type, "text");
            assert.deepStrictEqual(lastCall(client, method).args, expected);
        });
    }

    it("covers every registered tool", async () => {
        const { mcp, close } = await connectTools({}, stubClient());
        try {
            const names = (await mcp.listTools()).tools.map((t) => t.name);
            const covered = new Set(cases.map((c) => c.tool));
            assert.deepStrictEqual(names.filter((n) => !covered.has(n)), []);
        } finally {
            await close();
        }
    });

    it("returns a client error as isError without leaking more than the message", async () => {
        const client = stubClient({
            readEmail: () => Promise.reject(new Error("404 not_found: Message not found")),
        });
        const { result } = await call("mail_read_email", { folder_id: "f1", message_uid: "1" }, undefined, client);
        assert.strictEqual(result.isError, true);
        assert.match(result.content[0].text, /404 not_found: Message not found/);
    });

    it("rejects a call with a missing required argument before touching the client", async () => {
        const { result, client } = await call("mail_move_email", { message_uids: ["1"], from_folder_id: "f1" });
        assert.strictEqual(result.isError, true);
        assert.strictEqual(client.calls.length, 0);
    });
});

describe("write methods fail on a result:error response", () => {
    const writes = [
        ["flagEmails", (c) => c.flagEmails("mb", "f", ["1"], true)],
        ["markEmails", (c) => c.markEmails("mb", "f", ["1"], true)],
        ["moveEmails", (c) => c.moveEmails("mb", ["1"], "f", "g")],
        ["createFolder", (c) => c.createFolder("mb", "n")],
        ["renameFolder", (c) => c.renameFolder("mb", "f", "n")],
        ["deleteEmails permanent", (c) => c.deleteEmails("mb", "f", ["1"], true)],
        ["deleteDraft", (c) => c.deleteDraft("d1", "mb")],
    ];
    for (const [name, run] of writes) {
        it(`${name} throws the API error`, async () => {
            const original = global.fetch;
            const fetchMock = createFetchMock();
            global.fetch = fetchMock;
            try {
                fetchMock.enqueue(jsonResponse({ result: "error", error: { code: "forbidden", description: "No" } }, { status: 403 }));
                await assert.rejects(run(new MailClient("t")), /403 forbidden: No/);
            } finally {
                global.fetch = original;
            }
        });
    }

    it("flagEmails sends star and unstar bodies with folder-qualified UIDs", async () => {
        const original = global.fetch;
        const fetchMock = createFetchMock();
        global.fetch = fetchMock;
        try {
            fetchMock.enqueue(jsonResponse({ result: "success", data: true }), jsonResponse({ result: "success", data: true }));
            const client = new MailClient("t");
            const starred = await client.flagEmails("mb", "f1", ["1", "2@f9"], true);
            const unstarred = await client.flagEmails("mb", "f1", ["3"], false);
            const [first, second] = fetchMock.calls();
            assert.strictEqual(new URL(first.url).pathname, "/api/mail/mb/message/star");
            assert.deepStrictEqual(JSON.parse(first.options.body), { uids: ["1@f1", "2@f9"] });
            assert.strictEqual(new URL(second.url).pathname, "/api/mail/mb/message/unstar");
            assert.deepStrictEqual(JSON.parse(second.options.body), { uids: ["3@f1"] });
            assert.strictEqual(starred.starred, 2);
            assert.strictEqual(unstarred.unstarred, 1);
        } finally {
            global.fetch = original;
        }
    });
});
