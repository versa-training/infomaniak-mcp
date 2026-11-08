import { test, describe } from "node:test";
import assert from "node:assert";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ContactClient } from "../dist/contact-client.js";
import { registerTools } from "../dist/tools.js";

async function withFetch(impl, fn) {
    const original = globalThis.fetch;
    globalThis.fetch = impl;
    try {
        await fn();
    } finally {
        globalThis.fetch = original;
    }
}

describe("timeouts and cancellation", () => {
    test("a timeout is not retried", async () => {
        let calls = 0;
        const sleeps = [];
        await withFetch(
            async () => {
                calls += 1;
                throw new DOMException("timed out", "TimeoutError");
            },
            async () => {
                const client = new ContactClient("t", { sleep: async (ms) => { sleeps.push(ms); } });
                await assert.rejects(client.fetchAllContacts(), /timed out after 30 s/);
            },
        );
        assert.strictEqual(calls, 1);
        assert.deepStrictEqual(sleeps, []);
    });

    test("a cancelled caller rejects at once while the shared load keeps running", async () => {
        const controller = new AbortController();
        let seen;
        await withFetch(
            (url, init) => {
                seen = init.signal;
                return new Promise(() => {});
            },
            async () => {
                const client = new ContactClient("t");
                const pending = client.fetchAllContacts({ signal: controller.signal });
                controller.abort();
                await assert.rejects(pending, /request cancelled/);
            },
        );
        assert.ok(!seen.aborted);
    });

    test("a cancelled call does not fail another call waiting on the same load", async () => {
        const controller = new AbortController();
        const gate = Promise.withResolvers();
        let calls = 0;
        await withFetch(
            async (url, init) => {
                calls += 1;
                await gate.promise;
                return new Response(JSON.stringify({ result: "success", data: [{ id: 1 }] }), { status: 200 });
            },
            async () => {
                const client = new ContactClient("t");
                const a = client.fetchAllContacts({ signal: controller.signal });
                const b = client.fetchAllContacts();
                controller.abort();
                await assert.rejects(a, /request cancelled/);
                gate.resolve();
                assert.deepStrictEqual(await b, [{ id: 1 }]);
            },
        );
        assert.strictEqual(calls, 1);
    });

    test("a non-list data field is a clear error", async () => {
        for (const data of [{ items: [] }, "x", null]) {
            await withFetch(
                async () => new Response(JSON.stringify({ result: "success", data }), { status: 200 }),
                async () => {
                    await assert.rejects(new ContactClient("t").fetchAllContacts(), /invalid_response: data is not a list/);
                },
            );
        }
    });

    test("the tool handler passes the SDK signal to the client", async () => {
        let received;
        const stub = {
            fetchAllContacts: async (options) => {
                received = options.signal;
                return [];
            },
            searchContacts: () => [],
        };
        const server = new McpServer({ name: "t", version: "0" });
        registerTools(server, stub);
        const [a, b] = InMemoryTransport.createLinkedPair();
        const mcp = new Client({ name: "c", version: "0" });
        await Promise.all([server.connect(b), mcp.connect(a)]);
        await mcp.callTool({ name: "contact_list_contacts", arguments: {} });
        assert.ok(received instanceof AbortSignal);
        await mcp.close();
    });
});
