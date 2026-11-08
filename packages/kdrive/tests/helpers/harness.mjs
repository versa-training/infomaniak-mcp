import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools } from "../../dist/tools.js";
import { KdriveClient } from "../../dist/kdrive-client.js";

export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

// Connects an in-memory MCP client to a server wired to a KdriveClient whose
// fetch is `handler(url: URL, init) => Response`. Returns the calls made.
export async function harness(handler, options) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    let body;
    if (typeof init.body === "string") body = JSON.parse(init.body);
    calls.push({ url: u, method: init.method ?? "GET", body, rawBody: init.body, headers: init.headers });
    return handler(u, init, calls.length);
  };
  const server = new McpServer({ name: "t", version: "0" });
  registerTools(server, new KdriveClient("tok", "123", 0), options);
  const client = new Client({ name: "c", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return {
    client,
    calls,
    async close() {
      globalThis.fetch = original;
      await client.close();
    },
  };
}
