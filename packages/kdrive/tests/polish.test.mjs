import { test, describe } from "node:test";
import assert from "node:assert";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools } from "../dist/tools.js";
import { KdriveClient } from "../dist/kdrive-client.js";
import { json } from "./helpers/harness.mjs";

async function setup(options, handler = () => json({ result: "success", data: {} })) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: new URL(String(url)), method: init.method ?? "GET", body: typeof init.body === "string" ? JSON.parse(init.body) : undefined });
    return handler();
  };
  const server = new McpServer({ name: "t", version: "0" });
  registerTools(server, new KdriveClient("tok", "123", 0), options);
  const client = new Client({ name: "c", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return {
    calls,
    call: (name, args) => client.callTool({ name, arguments: args }),
    async close() {
      globalThis.fetch = original;
      await client.close();
    },
  };
}

describe("search filters", () => {
  test("filters become documented query parameters", async () => {
    const s = await setup();
    try {
      await s.call("kdrive_search", { query: "invoice", query_scope: "content", types: ["pdf", "image"], extensions: ["pdf"], modified_after: 1700000000, modified_before: 1800000000, order_by: "last_modified_at", order: "desc" });
      const p = s.calls[0].url.searchParams;
      assert.strictEqual(p.get("query_scope"), "content");
      assert.deepStrictEqual(p.getAll("types[]"), ["pdf", "image"]);
      assert.deepStrictEqual(p.getAll("extensions[]"), ["pdf"]);
      assert.strictEqual(p.get("modified_at"), "custom");
      assert.strictEqual(p.get("modified_after"), "1700000000");
      assert.strictEqual(p.get("modified_before"), "1800000000");
      assert.strictEqual(p.get("order_by[]"), "last_modified_at");
      assert.strictEqual(p.get("order"), "desc");
    } finally {
      await s.close();
    }
  });

  test("without date filters modified_at is not sent", async () => {
    const s = await setup();
    try {
      await s.call("kdrive_search", { query: "abc" });
      assert.strictEqual(s.calls[0].url.searchParams.has("modified_at"), false);
    } finally {
      await s.close();
    }
  });
});

describe("move and invitations", () => {
  test("move forwards name and conflict", async () => {
    const s = await setup();
    try {
      await s.call("kdrive_move", { file_id: 1, dest_id: 2, name: "n", conflict: "rename" });
      assert.deepStrictEqual(s.calls[0].body, { name: "n", conflict: "rename" });
    } finally {
      await s.close();
    }
  });

  test("invitation language is exposed and validated", async () => {
    const s = await setup();
    try {
      await s.call("kdrive_share_access", { file_id: 1, emails: ["a@example.com"], right: "read", lang: "fr" });
      assert.strictEqual(s.calls[0].url.searchParams.get("lang"), "fr");
      const bad = await s.call("kdrive_share_access", { file_id: 1, emails: ["a@example.com"], right: "read", lang: "xx" });
      assert.strictEqual(bad.isError, true);
    } finally {
      await s.close();
    }
  });

  test("shareEmailDomains limits invitation recipients", async () => {
    const s = await setup({ shareEmailDomains: ["Example.com"] });
    try {
      const bad = await s.call("kdrive_share_access", { file_id: 1, emails: ["a@example.com", "b@evil.test"], right: "read" });
      assert.strictEqual(bad.isError, true);
      assert.strictEqual(s.calls.length, 0);
      const good = await s.call("kdrive_share_access", { file_id: 1, emails: ["a@EXAMPLE.com"], right: "read" });
      assert.ok(!good.isError);
    } finally {
      await s.close();
    }
  });
});

describe("public link guards", () => {
  test("a public link cannot allow editing", async () => {
    const s = await setup();
    try {
      const bad = await s.call("kdrive_share_link", { file_id: 1, right: "public", can_edit: true });
      assert.strictEqual(bad.isError, true);
      assert.strictEqual(s.calls.length, 0);
      const bad2 = await s.call("kdrive_update_share_link", { file_id: 1, right: "public", can_edit: true });
      assert.strictEqual(bad2.isError, true);
    } finally {
      await s.close();
    }
  });

  test("a public link without valid_until gets the default expiry", async () => {
    const s = await setup();
    try {
      const before = Math.floor(Date.now() / 1000);
      await s.call("kdrive_share_link", { file_id: 1, right: "public" });
      const v = s.calls[0].body.valid_until;
      assert.ok(v >= before + 7 * 86400 && v <= before + 7 * 86400 + 5);
    } finally {
      await s.close();
    }
  });

  test("an explicit valid_until is kept, and the default can be turned off", async () => {
    const s = await setup({ publicLinkTtlSeconds: 0 });
    try {
      await s.call("kdrive_share_link", { file_id: 1, right: "public" });
      assert.strictEqual("valid_until" in s.calls[0].body, false);
      await s.call("kdrive_share_link", { file_id: 1, right: "public", valid_until: 1900000000 });
      assert.strictEqual(s.calls[1].body.valid_until, 1900000000);
    } finally {
      await s.close();
    }
  });

  test("allowPublicLinks false refuses public links but not password links", async () => {
    const s = await setup({ allowPublicLinks: false });
    try {
      const bad = await s.call("kdrive_share_link", { file_id: 1, right: "public" });
      assert.strictEqual(bad.isError, true);
      const good = await s.call("kdrive_share_link", { file_id: 1, right: "password", password: "pw", can_edit: true });
      assert.ok(!good.isError);
    } finally {
      await s.close();
    }
  });
});

describe("documents and comments", () => {
  test("kdrive_create_office_file posts name and type", async () => {
    const s = await setup();
    try {
      await s.call("kdrive_create_office_file", { name: "Plan", type: "docx", directory_id: 4 });
      assert.strictEqual(s.calls[0].url.pathname, "/3/drive/123/files/4/file");
      assert.deepStrictEqual(s.calls[0].body, { name: "Plan", type: "docx" });
      const bad = await s.call("kdrive_create_office_file", { name: "x", type: "exe" });
      assert.strictEqual(bad.isError, true);
    } finally {
      await s.close();
    }
  });

  test("comments list and add", async () => {
    const s = await setup();
    try {
      await s.call("kdrive_list_comments", { file_id: 5, page: 2 });
      assert.strictEqual(s.calls[0].url.pathname, "/2/drive/123/files/5/comments");
      assert.strictEqual(s.calls[0].url.searchParams.get("page"), "2");
      await s.call("kdrive_add_comment", { file_id: 5, body: "hello" });
      assert.deepStrictEqual([s.calls[1].method, s.calls[1].body], ["POST", { body: "hello" }]);
    } finally {
      await s.close();
    }
  });
});
