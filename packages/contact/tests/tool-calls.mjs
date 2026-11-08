import { test, describe } from "node:test";
import assert from "node:assert";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools } from "../dist/tools.js";
import { ContactClient } from "../dist/contact-client.js";

const contacts = [
    { id: 1, name: "John Doe", firstname: "John", lastname: "Doe", emails: ["john@test.com"], phones: ["079 123 45 67"], others: { note: "secret" }, user_id: 5 },
    { id: 2, name: "Jane Roe", firstname: "Jane", lastname: "Roe", emails: [], phones: [] },
];

async function connect(client) {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerTools(server, client);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
    return mcp;
}

function stubClient() {
    const real = new ContactClient("test-token");
    return {
        fetchAllContacts: async () => contacts,
        searchContacts: (all, q) => real.searchContacts(all, q),
    };
}

describe("tools/call through an in-memory transport", () => {
    test("server advertises only the tools capability", async () => {
        const mcp = await connect(stubClient());
        const caps = mcp.getServerCapabilities();
        assert.ok(caps.tools);
        assert.strictEqual(caps.prompts, undefined);
        assert.strictEqual(caps.resources, undefined);
        assert.strictEqual(caps.completions, undefined);
        await mcp.close();
    });

    test("listTools exposes titles, annotations and output schemas", async () => {
        const mcp = await connect(stubClient());
        const { tools } = await mcp.listTools();
        assert.deepStrictEqual(tools.map((t) => t.name).sort(), ["contact_list_contacts", "contact_search_contacts"]);
        for (const tool of tools) {
            assert.ok(tool.title);
            assert.strictEqual(tool.annotations.readOnlyHint, true);
            assert.ok(tool.outputSchema);
        }
        await mcp.close();
    });

    test("contact_list_contacts returns projected contacts as structuredContent", async () => {
        const mcp = await connect(stubClient());
        const result = await mcp.callTool({ name: "contact_list_contacts", arguments: {} });
        assert.ok(!result.isError);
        assert.strictEqual(result.content.length, 1);
        assert.strictEqual(result.structuredContent.items.length, 2);
        assert.strictEqual(result.structuredContent.items[0].others, undefined);
        assert.strictEqual(result.structuredContent.items[0].user_id, undefined);
        assert.deepStrictEqual(JSON.parse(result.content[0].text), result.structuredContent);
        await mcp.close();
    });

    test("contact_search_contacts returns matching contacts", async () => {
        const mcp = await connect(stubClient());
        const result = await mcp.callTool({ name: "contact_search_contacts", arguments: { query: "john" } });
        assert.ok(!result.isError);
        assert.deepStrictEqual(result.structuredContent.items.map((c) => c.id), [1]);
        await mcp.close();
    });

    test("contact_search_contacts rejects an empty query with isError", async () => {
        const mcp = await connect(stubClient());
        const result = await mcp.callTool({ name: "contact_search_contacts", arguments: { query: "" } });
        assert.strictEqual(result.isError, true);
        await mcp.close();
    });

    test("client errors surface as isError without the response body", async () => {
        const failing = {
            fetchAllContacts: async () => {
                throw new Error("403 not_authorized: token rejected");
            },
            searchContacts: () => [],
        };
        const mcp = await connect(failing);
        const result = await mcp.callTool({ name: "contact_list_contacts", arguments: {} });
        assert.strictEqual(result.isError, true);
        assert.match(result.content[0].text, /403 not_authorized/);
        await mcp.close();
    });

    test("end to end through a mocked fetch", async () => {
        const originalFetch = globalThis.fetch;
        let requested;
        globalThis.fetch = async (url) => {
            requested = new URL(url);
            return new Response(JSON.stringify({ result: "success", data: contacts }), { status: 200 });
        };
        try {
            const mcp = await connect(new ContactClient("test-token"));
            const result = await mcp.callTool({ name: "contact_search_contacts", arguments: { query: "roe" } });
            assert.deepStrictEqual(result.structuredContent.items.map((c) => c.id), [2]);
            assert.strictEqual(requested.pathname, "/api/pim/contact/all");
            await mcp.close();
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    test("odd field types and others-only organization do not break the output schema", async () => {
        const book = [
            { id: "7", name: "Odd One", organization: { name: "Acme" }, nickname: 5, emails: "x", phones: {} },
            { id: 8, name: "Bob Other", emails: [], phones: [], others: { organization: "Globex", nickname: "Bobby" } },
        ];
        const real = new ContactClient("t");
        const mcp = await connect({ fetchAllContacts: async () => book, searchContacts: (a, q) => real.searchContacts(a, q) });
        const list = await mcp.callTool({ name: "contact_list_contacts", arguments: {} });
        assert.ok(!list.isError, list.content[0].text);
        const bob = list.structuredContent.items.find((c) => c.id === 8);
        assert.strictEqual(bob.organization, "Globex");
        assert.strictEqual(bob.nickname, "Bobby");
        const search = await mcp.callTool({ name: "contact_search_contacts", arguments: { query: "globex" } });
        assert.ok(!search.isError, search.content[0].text);
        assert.strictEqual(search.structuredContent.items[0].organization, "Globex");
        await mcp.close();
    });

    test("an item made large by many short values still fits the text cap", async () => {
        const many = Array.from({ length: 30000 }, (_, i) => `n${i}`);
        const book = [
            { id: 1, name: "Big One", emails: [], phones: many, others: { notes: many } },
        ];
        const real = new ContactClient("t");
        const mcp = await connect({ fetchAllContacts: async () => book, searchContacts: (a, q) => real.searchContacts(a, q) });
        for (const fields of [undefined, ["id", "name", "phones", "others"]]) {
            const result = await mcp.callTool({ name: "contact_list_contacts", arguments: fields ? { fields } : {} });
            assert.ok(!result.isError, result.content[0].text);
            assert.ok(result.content[0].text.length <= 100000, `${result.content[0].text.length}`);
            assert.strictEqual(result.structuredContent.truncated, true);
            assert.strictEqual(result.structuredContent.items[0].id, 1);
        }
        await mcp.close();
    });
});
