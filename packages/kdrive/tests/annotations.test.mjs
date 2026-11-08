import { test } from "node:test";
import assert from "node:assert";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools } from "../dist/tools.js";
import { KdriveClient } from "../dist/kdrive-client.js";

async function connect() {
  const server = new McpServer({ name: "t", version: "0" });
  registerTools(server, new KdriveClient("t", "1"));
  const client = new Client({ name: "c", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

test("every tool has a title and readOnlyHint; writers declare destructiveHint", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  assert.ok(tools.length >= 14);
  for (const tool of tools) {
    assert.ok(tool.title, `${tool.name} has a title`);
    assert.strictEqual(typeof tool.annotations?.readOnlyHint, "boolean", `${tool.name} readOnlyHint`);
    if (!tool.annotations.readOnlyHint) {
      assert.strictEqual(typeof tool.annotations.destructiveHint, "boolean", `${tool.name} destructiveHint`);
    }
  }
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.strictEqual(byName.kdrive_delete.annotations.destructiveHint, true);
  assert.strictEqual(byName.kdrive_share_link.annotations.openWorldHint, true);
  assert.strictEqual(byName.kdrive_create_folder.annotations.destructiveHint, false);
  await client.close();
});

test("the server registers the kdrive_file resource template", async () => {
  const client = await connect();
  const { resourceTemplates } = await client.listResourceTemplates();
  assert.strictEqual(resourceTemplates[0].uriTemplate, "kdrive://{id}");
  await client.close();
});
