import { test } from "node:test";
import assert from "node:assert";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools } from "../dist/tools.js";

test("every tool declares title and annotations", async () => {
    const server = new McpServer({ name: "t", version: "0" });
    registerTools(server, {});
    const client = new Client({ name: "c", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    assert.strictEqual(tools.length, 8);
    for (const tool of tools) {
        assert.ok(tool.title, `${tool.name} has a title`);
        assert.strictEqual(typeof tool.annotations.readOnlyHint, "boolean", tool.name);
        if (!tool.annotations.readOnlyHint) {
            assert.strictEqual(typeof tool.annotations.destructiveHint, "boolean", tool.name);
            assert.strictEqual(tool.annotations.openWorldHint, true, tool.name);
        }
    }
    assert.strictEqual(tools.find(t => t.name === "calendar_delete_event").annotations.destructiveHint, true);
    assert.strictEqual(tools.find(t => t.name === "calendar_create_event").annotations.destructiveHint, false);
    assert.strictEqual(tools.find(t => t.name === "calendar_update_event").annotations.idempotentHint, false);
    await client.close();
});
