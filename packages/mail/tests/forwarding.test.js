import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { createFetchMock, jsonResponse, MAILBOXES } from "./helpers.js";

const { MailClient } = await import("../dist/mail-client.js");

describe("forwarding and send descriptions", () => {
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

    it("listForwarding reads the correctly spelled key", async () => {
        fetchMock.enqueue(jsonResponse(MAILBOXES), ok({ is_enabled: true, redirect_addresses: [{ email: "a@evil.example", email_idn: "a@evil.example" }] }));
        const result = await new MailClient("t").listForwarding("mb1");
        assert.deepStrictEqual(result.addresses.map((a) => a.email), ["a@evil.example"]);
        assert.strictEqual(result.warnings, undefined);
    });

    it("listForwarding reads the misspelled key", async () => {
        fetchMock.enqueue(jsonResponse(MAILBOXES), ok({ is_enabled: true, redirect_adresses: [{ email: "b@evil.example" }] }));
        const result = await new MailClient("t").listForwarding("mb1");
        assert.deepStrictEqual(result.addresses.map((a) => a.email), ["b@evil.example"]);
    });

    it("listForwarding warns when forwarding is on and no list is found", async () => {
        fetchMock.enqueue(jsonResponse(MAILBOXES), ok({ is_enabled: true, something_else: [{ email: "c@x" }] }));
        const result = await new MailClient("t").listForwarding("mb1");
        assert.strictEqual(result.warnings.length, 1);
        assert.deepStrictEqual(result.raw.something_else, [{ email: "c@x" }]);
    });

    it("send tool descriptions state that sending is immediate and irreversible", async () => {
        const { connectTools } = await import("./helpers.js");
        const { mcp, close } = await connectTools({});
        try {
            const tools = (await mcp.listTools()).tools;
            for (const name of ["mail_send_email", "mail_send_draft"]) {
                assert.match(tools.find((t) => t.name === name).description, /immediately and irreversibly/);
            }
        } finally {
            await close();
        }
    });
});
