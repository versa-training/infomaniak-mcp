import { test } from "node:test";
import assert from "node:assert";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools } from "../dist/tools.js";
import { KdriveClient } from "../dist/kdrive-client.js";

async function connect() {
  const server = new McpServer({ name: "t", version: "0" });
  registerTools(server, new KdriveClient("t", "1", 0));
  const client = new Client({ name: "c", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

async function rejected(name, args) {
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response("{}", { status: 200 });
  };
  const client = await connect();
  try {
    const result = await client.callTool({ name, arguments: args });
    assert.strictEqual(result.isError, true, `${name} ${JSON.stringify(args)} should be rejected`);
    assert.strictEqual(called, false, "no request leaves the server");
  } finally {
    globalThis.fetch = original;
    await client.close();
  }
}

test("ids must be positive integers", async () => {
  await rejected("kdrive_info", { file_id: -1 });
  await rejected("kdrive_info", { file_id: 1.5 });
  await rejected("kdrive_info", { file_id: "../1" });
});

test("emails must be addresses, at least one", async () => {
  await rejected("kdrive_share_access", { file_id: 1, emails: ["not-an-email"], right: "read" });
  await rejected("kdrive_share_access", { file_id: 1, emails: [], right: "read" });
});

test("valid_until must be a positive integer", async () => {
  await rejected("kdrive_share_link", { file_id: 1, right: "public", valid_until: 1.5 });
  await rejected("kdrive_share_link", { file_id: 1, right: "public", valid_until: -5 });
});

test("names and queries are bounded", async () => {
  await rejected("kdrive_rename", { file_id: 1, name: "" });
  await rejected("kdrive_create_folder", { name: "x".repeat(256) });
  await rejected("kdrive_search", { query: "" });
});
