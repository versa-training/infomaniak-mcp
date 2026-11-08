import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { createFetchMock, jsonResponse, connectTools, MAILBOXES } from "./helpers.js";

const { MailClient } = await import("../dist/mail-client.js");

const FOLDERS = {
    result: "success",
    data: [
        { id: "inbox", name: "INBOX", separator: "/", role: "INBOX", children: [] },
        { id: "drafts", name: "Drafts", separator: "/", role: "DRAFT", children: [] },
        { id: "trash", name: "Trash", separator: "/", role: "TRASH", children: [] },
    ],
};

const SOURCE = {
    uid: "42",
    msg_id: "<src@x.ch>",
    subject: "Plan",
    date: "2026-03-01",
    from: [{ name: "Alice", email: "alice@x.ch" }],
    to: [{ name: "", email: "me@x.ch" }],
    headers: {},
    body: { value: "<p>Line one</p>", type: "text/html" },
};

describe("mail polish", () => {
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

    const body = (index) => JSON.parse(fetchMock.calls()[index].options.body);
    const noIdentities = () => jsonResponse({ result: "error" }, { status: 403 });
    const draftCreated = () => jsonResponse({ result: "success", data: { uuid: "d1", uid: 9 } });

    describe("folder lookups", () => {
        it("resolve roles from one cached folder list and refetch after a folder change", async () => {
            fetchMock.enqueue(
                jsonResponse(FOLDERS),
                jsonResponse({ result: "success", data: { threads: [] } }),
                jsonResponse({ result: "success", data: { threads: [] } }),
                jsonResponse({ result: "success", data: {} }),
                jsonResponse(FOLDERS),
                jsonResponse({ result: "success", data: { threads: [] } }),
            );
            const client = new MailClient("t");
            await client.listDrafts("mb1");
            await client.listDrafts("mb1");
            const paths = () => fetchMock.calls().map((c) => new URL(c.url).pathname);
            assert.deepStrictEqual(paths(), [
                "/api/mail/mb1/folder",
                "/api/mail/mb1/folder/drafts/message",
                "/api/mail/mb1/folder/drafts/message",
            ]);
            await client.createFolder("mb1", "New");
            await client.listDrafts("mb1");
            assert.strictEqual(paths().filter((p) => p === "/api/mail/mb1/folder").length, 3, "folder list refetched after create");
        });

        it("searchEmails without a folder searches from the INBOX role", async () => {
            fetchMock.enqueue(jsonResponse(FOLDERS), jsonResponse({ result: "success", data: { threads: [] } }));
            await new MailClient("t").searchEmails("mb1", { query: "x" });
            assert.strictEqual(new URL(fetchMock.calls()[1].url).pathname, "/api/mail/mb1/folder/inbox/message");
        });
    });

    describe("search", () => {
        it("accepts unseen as the only filter and sends filters=unseen", async () => {
            fetchMock.enqueue(jsonResponse({ result: "success", data: { threads: [] } }));
            await new MailClient("t").searchEmails("mb1", { unseen: true, folderId: "inbox" });
            assert.strictEqual(new URL(fetchMock.calls()[0].url).searchParams.get("filters"), "unseen");
        });

        it("rejects unseen with flagged", async () => {
            await assert.rejects(
                new MailClient("t").searchEmails("mb1", { unseen: true, flagged: true, folderId: "inbox" }),
                /only one filter/,
            );
        });

        it("searchAllMailboxes tags each row with its mailbox", async () => {
            const thread = { uid: "t", subject: "S", messages: [{ uid: "1@f", folder_id: "f" }] };
            global.fetch = async (url) => {
                const path = new URL(String(url)).pathname;
                if (path.endsWith("/mailbox")) {
                    return jsonResponse({ result: "success", data: [
                        { uuid: "mbA", email: "a@x.ch", is_primary: true },
                        { uuid: "mbB", email: "b@x.ch" },
                    ] });
                }
                if (path.endsWith("/folder")) return jsonResponse(FOLDERS);
                return jsonResponse({ result: "success", data: { threads: path.includes("/mbA/") ? [thread] : [] } });
            };
            const found = await new MailClient("t").searchAllMailboxes({ query: "x", limit: 1 });
            assert.deepStrictEqual(found.items.map((i) => i.mailbox_uuid), ["mbA"]);
            assert.strictEqual(found.has_more, true);
            assert.deepStrictEqual(found.next_mailbox_offsets, { mbA: 1 });
        });
    });

    describe("drafts", () => {
        it("reply quotes the original and createDraft keeps html bodies as given", async () => {
            fetchMock.enqueue(jsonResponse(MAILBOXES), jsonResponse({ result: "success", data: SOURCE }), noIdentities(), draftCreated());
            const client = new MailClient("t");
            await client.init();
            await client.replyToEmail("mb1", "inbox", "42", "<b>Thanks</b>", { quote: true, bodyFormat: "html" });
            const html = body(3).body;
            assert.match(html, /<b>Thanks<\/b>/);
            assert.match(html, /<blockquote[^>]*>On 2026-03-01, Alice &lt;alice@x\.ch&gt; wrote:<br>Line one<\/blockquote>/);
        });

        it("text bodies stay escaped", async () => {
            fetchMock.enqueue(jsonResponse(MAILBOXES), noIdentities(), draftCreated());
            await new MailClient("t").createDraft(["a@x.ch"], "s", "<b>hi</b>");
            assert.match(body(2).body, /&lt;b&gt;hi&lt;\/b&gt;/);
        });

        it("createDraft resolves the sender first, uploads, and falls back to a PUT when POST ignores attachments", async () => {
            fetchMock.enqueue(
                jsonResponse(MAILBOXES),
                noIdentities(),
                jsonResponse({ result: "success", data: { uuid: "att1" } }),
                draftCreated(),
                jsonResponse({ result: "success", data: { uid: 10 } }),
            );
            const client = new MailClient("t");
            const result = await client.createDraft(["a@x.ch"], "s", "b", undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
                attachments: [{ filename: "a.txt", base64_content: Buffer.from("hi").toString("base64") }],
            });
            const calls = fetchMock.calls().map((c) => `${c.options.method ?? "GET"} ${new URL(c.url).pathname}`);
            assert.deepStrictEqual(calls.slice(1), [
                "GET /1/mail_hostings/7/mailboxes/me/signatures",
                "POST /api/mail/mb1/draft/attachment",
                "POST /api/mail/mb1/draft",
                "PUT /api/mail/mb1/draft/d1",
            ]);
            assert.deepStrictEqual(body(3).attachments, ["att1"]);
            assert.deepStrictEqual(body(4).attachments, ["att1"]);
            assert.strictEqual(result.uuid, "d1");
        });

        it("createDraft skips the PUT when the POST response lists the attachments", async () => {
            fetchMock.enqueue(
                jsonResponse(MAILBOXES),
                noIdentities(),
                jsonResponse({ result: "success", data: { uuid: "att1" } }),
                jsonResponse({ result: "success", data: { uuid: "d1", uid: 9, attachments: [{ uuid: "att1" }] } }),
            );
            await new MailClient("t").createDraft(["a@x.ch"], "s", "b", undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
                attachments: [{ filename: "a.txt", base64_content: Buffer.from("hi").toString("base64") }],
            });
            assert.strictEqual(fetchMock.calls().filter((c) => c.options.method === "PUT").length, 0);
        });

        it("createDraft uploads nothing when the sender cannot be resolved", async () => {
            fetchMock.enqueue(jsonResponse(MAILBOXES), noIdentities());
            await assert.rejects(
                new MailClient("t").createDraft(["a@x.ch"], "s", "b", undefined, undefined, undefined, undefined, undefined, undefined, "alias@x.ch", undefined, {
                    attachments: [{ filename: "a.txt", base64_content: Buffer.from("hi").toString("base64") }],
                }),
                /not allowed/,
            );
            assert.ok(!fetchMock.calls().some((c) => c.url.endsWith("/draft/attachment")));
        });

        it("updateDraft sets threading headers and the sender", async () => {
            fetchMock.enqueue(
                jsonResponse(MAILBOXES),
                noIdentities(),
                draftCreated(),
                jsonResponse({ result: "success", data: { uuid: "d1", subject: "s", body: "<div>b</div>", from: { id: null, name: "Me", email: "me@x.ch" }, to: [{ name: "", email: "a@x.ch" }] } }),
                jsonResponse({ result: "success", data: { ...SOURCE } }),
                noIdentities(),
                jsonResponse({ result: "success", data: { uid: 11 } }),
            );
            const client = new MailClient("t");
            await client.createDraft(["a@x.ch"], "s", "b");
            const result = await client.updateDraft("d1", { inReplyToUid: "42@inbox", fromName: "Me Too" });
            const sent = body(6);
            assert.strictEqual(sent.in_reply_to, "<src@x.ch>");
            assert.strictEqual(sent.references, "<src@x.ch>");
            assert.strictEqual(sent.in_reply_to_uid, "42@inbox");
            assert.strictEqual(sent.from.email, "me@x.ch");
            assert.ok(result.uuid);
        });
    });

    describe("downloads", () => {
        it("stops reading a body that passes the size limit without a content-length", async () => {
            const chunk = new Uint8Array(1024 * 1024);
            let pulled = 0;
            const stream = new ReadableStream({
                pull(controller) {
                    pulled += 1;
                    controller.enqueue(chunk);
                    if (pulled > 60) controller.close();
                },
            });
            fetchMock.enqueue(new Response(stream, { status: 200, headers: { "content-type": "application/pdf" } }));
            await assert.rejects(new MailClient("t").downloadAttachment("mb1", "f", "1", "a"), /over the 5 MB limit/);
            assert.ok(pulled < 12, `read ${pulled} MiB before stopping`);
        });

        it("treats a non-numeric content-length as unknown and still enforces the limit", async () => {
            fetchMock.enqueue(new Response(new Uint8Array(6 * 1024 * 1024), { status: 200, headers: { "content-type": "application/pdf", "content-length": "abc" } }));
            await assert.rejects(new MailClient("t").downloadAttachment("mb1", "f", "1", "a"), /over the 5 MB limit/);
        });

        it("returns an attachment under the limit", async () => {
            fetchMock.enqueue(new Response("hello", { status: 200, headers: { "content-type": "text/plain", "content-length": "5" } }));
            const file = await new MailClient("t").downloadAttachment("mb1", "f", "1", "a");
            assert.strictEqual(Buffer.from(file.content, "base64").toString(), "hello");
        });

        it("uploads a non-ASCII filename as a percent-encoded header instead of throwing", async () => {
            fetchMock.enqueue(jsonResponse({ result: "success", data: { uuid: "att" } }), jsonResponse({ result: "success", data: { uuid: "att2" } }), jsonResponse({ result: "success", data: { uuid: "att3" } }));
            const client = new MailClient("t");
            const content = Buffer.from("hi").toString("base64");
            for (const filename of ["März.pdf", "報告.pdf", "plain.pdf"]) {
                await client.uploadAttachment({ filename, base64_content: content }, "mb1");
            }
            const names = fetchMock.calls().map((c) => c.options.headers["x-ws-attachment-filename"]);
            assert.deepStrictEqual(names, ["M%C3%A4rz.pdf", "%E5%A0%B1%E5%91%8A.pdf", "plain.pdf"]);
        });
    });

    describe("purge and permanent delete", () => {
        it("purgeFolder calls the documented manager endpoints", async () => {
            fetchMock.enqueue(
                jsonResponse(MAILBOXES),
                jsonResponse({ result: "success", data: true }),
                jsonResponse({ result: "success", data: true }),
            );
            const client = new MailClient("t");
            await client.init();
            const trash = await client.purgeFolder("mb1", "trash");
            await client.purgeFolder("mb1", "spam");
            assert.deepStrictEqual(trash, { folder: "trash", purged: true });
            assert.deepStrictEqual(
                fetchMock.calls().slice(1).map((c) => [c.options.method, new URL(c.url).pathname]),
                [
                    ["DELETE", "/1/mail_hostings/7/mailboxes/me/auth/folders/trash"],
                    ["DELETE", "/1/mail_hostings/7/mailboxes/me/auth/folders/spam"],
                ],
            );
        });

        it("allowPermanentDelete false removes the permanent flag and mail_purge_folder", async () => {
            const { mcp, close } = await connectTools({ allowPermanentDelete: false });
            try {
                const { tools } = await mcp.listTools();
                assert.ok(!tools.some((t) => t.name === "mail_purge_folder"));
                const del = tools.find((t) => t.name === "mail_delete_email");
                assert.strictEqual(del.inputSchema.properties.permanent, undefined);
                assert.strictEqual(del.annotations.destructiveHint, false);
            } finally {
                await close();
            }
        });

        it("by default both are offered", async () => {
            const { mcp, close } = await connectTools();
            try {
                const { tools } = await mcp.listTools();
                assert.ok(tools.some((t) => t.name === "mail_purge_folder"));
                assert.ok(tools.find((t) => t.name === "mail_delete_email").inputSchema.properties.permanent);
            } finally {
                await close();
            }
        });
    });

    describe("tool descriptions", () => {
        it("uses one mailbox_uuid description and one message_uid name everywhere", async () => {
            const { mcp, close } = await connectTools();
            try {
                const { tools } = await mcp.listTools();
                const descriptions = new Set();
                for (const tool of tools) {
                    const props = tool.inputSchema.properties ?? {};
                    if (props.mailbox_uuid) descriptions.add(props.mailbox_uuid.description);
                    assert.strictEqual(props.message_id, undefined, `${tool.name} still has message_id`);
                    assert.strictEqual(props.message_ids, undefined, `${tool.name} still has message_ids`);
                }
                assert.strictEqual(descriptions.size, 1, [...descriptions].join(" | "));
                const read = tools.find((t) => t.name === "mail_read_email");
                assert.match(read.inputSchema.properties.message_uid.description, /first_message_uid/);
                const create = tools.find((t) => t.name === "mail_create_draft");
                assert.match(create.inputSchema.properties.in_reply_to_uid.description, /<uid>@<folder_id>/);
                assert.ok(create.inputSchema.properties.attachments);
                const update = tools.find((t) => t.name === "mail_update_draft");
                for (const field of ["in_reply_to", "in_reply_to_uid", "references", "from_email", "from_name", "body_format"]) {
                    assert.ok(update.inputSchema.properties[field], field);
                }
            } finally {
                await close();
            }
        });
    });
});
