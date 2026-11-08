import { test, describe } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools, KdriveClient } from "../dist/tools.js";
import { harness, json } from "./helpers/harness.mjs";

const ok = (data = {}, extra = {}) => json({ result: "success", data, ...extra });

async function call(name, args, handler = () => ok()) {
  const h = await harness(handler);
  try {
    const result = await h.client.callTool({ name, arguments: args });
    return { result, calls: h.calls };
  } finally {
    await h.close();
  }
}

describe("tools/call", () => {
  test("importing dist/tools.js in a clean process has no side effects", () => {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", 'const m = await import("./dist/tools.js"); if (typeof m.registerTools !== "function" || typeof m.KdriveClient !== "function") process.exit(3);'], {
      cwd: new URL("..", import.meta.url),
      env: { PATH: process.env.PATH },
      encoding: "utf8",
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(result.stdout, "");
    assert.strictEqual(result.stderr, "");
  });

  test("the package imports itself by name and a host can build the client", async () => {
    const mod = await import("@infomaniak/mcp-server-kdrive");
    assert.strictEqual(typeof mod.registerTools, "function");
    const client = new mod.KdriveClient("token", "1");
    assert.strictEqual(typeof client.search, "function");
  });

  test("kdrive_search sends query, directory_id, depth, and limit", async () => {
    const { calls, result } = await call("kdrive_search", { query: "report", directory_id: 7, depth: "child" });
    assert.ok(!result.isError);
    const { url, method } = calls[0];
    assert.strictEqual(method, "GET");
    assert.strictEqual(url.pathname, "/3/drive/123/files/search");
    assert.strictEqual(url.searchParams.get("query"), "report");
    assert.strictEqual(url.searchParams.get("directory_id"), "7");
    assert.strictEqual(url.searchParams.get("depth"), "child");
    assert.strictEqual(url.searchParams.get("limit"), null);
  });

  test("kdrive_upload_file sends text as bytes with total_size and defaults to root", async () => {
    const { calls } = await call("kdrive_upload_file", { file_name: "a b.txt", text_content: "héllo" });
    const { url, method, rawBody, headers } = calls[0];
    assert.strictEqual(method, "POST");
    assert.strictEqual(url.pathname, "/3/drive/123/upload");
    assert.strictEqual(url.searchParams.get("file_name"), "a b.txt");
    assert.strictEqual(url.searchParams.get("directory_id"), "1");
    assert.strictEqual(url.searchParams.get("total_size"), String(Buffer.byteLength("héllo")));
    assert.strictEqual(Buffer.from(rawBody).toString("utf8"), "héllo");
    assert.strictEqual(headers["Content-Type"], "application/octet-stream");
  });

  test("kdrive_upload_file decodes base64 content", async () => {
    const { calls } = await call("kdrive_upload_file", { file_name: "b.bin", base64_content: Buffer.from([1, 2, 3]).toString("base64") });
    assert.deepStrictEqual([...calls[0].rawBody], [1, 2, 3]);
  });

  test("kdrive_upload_file rejects both or neither content fields", async () => {
    const both = await call("kdrive_upload_file", { file_name: "a", text_content: "x", base64_content: "eA==" });
    assert.strictEqual(both.result.isError, true);
    assert.strictEqual(both.calls.length, 0);
    const none = await call("kdrive_upload_file", { file_name: "a" });
    assert.strictEqual(none.result.isError, true);
    assert.strictEqual(none.calls.length, 0);
  });

  test("kdrive_list sends type[] and cursor", async () => {
    const { calls } = await call("kdrive_list", { file_id: 5, type: "dir", cursor: "abc" });
    const { url } = calls[0];
    assert.strictEqual(url.pathname, "/3/drive/123/files/5/files");
    assert.strictEqual(url.searchParams.get("type[]"), "dir");
    assert.strictEqual(url.searchParams.get("cursor"), "abc");
  });

  test("kdrive_rename posts the new name", async () => {
    const { calls } = await call("kdrive_rename", { file_id: 5, name: "new.txt" });
    assert.strictEqual(calls[0].method, "POST");
    assert.strictEqual(calls[0].url.pathname, "/2/drive/123/files/5/rename");
    assert.deepStrictEqual(calls[0].body, { name: "new.txt" });
  });

  test("kdrive_move posts to the destination path", async () => {
    const { calls } = await call("kdrive_move", { file_id: 5, dest_id: 9 });
    assert.strictEqual(calls[0].method, "POST");
    assert.strictEqual(calls[0].url.pathname, "/3/drive/123/files/5/move/9");
  });

  test("kdrive_delete sends DELETE", async () => {
    const { calls } = await call("kdrive_delete", { file_id: 5 });
    assert.strictEqual(calls[0].method, "DELETE");
    assert.strictEqual(calls[0].url.pathname, "/2/drive/123/files/5");
  });

  test("kdrive_share_link sends only the options given", async () => {
    const { calls } = await call("kdrive_share_link", { file_id: 5, right: "password", password: "pw", valid_until: 1900000000, can_download: false });
    assert.strictEqual(calls[0].url.pathname, "/2/drive/123/files/5/link");
    assert.deepStrictEqual(calls[0].body, { right: "password", password: "pw", valid_until: 1900000000, can_download: false });
  });

  test("kdrive_share_access posts emails, right, and message", async () => {
    const { calls } = await call("kdrive_share_access", { file_id: 5, emails: ["a@example.com"], right: "read", message: "hi" });
    assert.strictEqual(calls[0].url.pathname, "/2/drive/123/files/5/access/invitations");
    assert.strictEqual(calls[0].url.searchParams.get("lang"), "en");
    assert.deepStrictEqual(calls[0].body, { emails: ["a@example.com"], right: "read", message: "hi" });
  });

  test("kdrive_create_folder posts the name under the parent", async () => {
    const { calls } = await call("kdrive_create_folder", { name: "docs" });
    assert.strictEqual(calls[0].url.pathname, "/3/drive/123/files/1/directory");
    assert.deepStrictEqual(calls[0].body, { name: "docs" });
  });

  test("kdrive_restore posts the destination directory", async () => {
    const { calls } = await call("kdrive_restore", { file_id: 5, destination_directory_id: 2 });
    assert.strictEqual(calls[0].url.pathname, "/2/drive/123/trash/5/restore");
    assert.deepStrictEqual(calls[0].body, { destination_directory_id: 2 });
  });

  test("kdrive_info gets the v3 file", async () => {
    const { calls, result } = await call("kdrive_info", { file_id: 5 }, () => ok({ id: 5, name: "x" }));
    assert.strictEqual(calls[0].url.pathname, "/3/drive/123/files/5");
    assert.deepStrictEqual(JSON.parse(result.content[0].text).data, { id: 5, name: "x" });
  });

  test("kdrive_recents and kdrive_shared_with_me send type[]", async () => {
    const recents = await call("kdrive_recents", { type: "dir" });
    assert.strictEqual(recents.calls[0].url.pathname, "/3/drive/123/files/recents");
    assert.strictEqual(recents.calls[0].url.searchParams.get("type[]"), "dir");
    const shared = await call("kdrive_shared_with_me", { type: "vault" });
    assert.strictEqual(shared.calls[0].url.pathname, "/3/drive/123/files/shared_with_me");
    assert.strictEqual(shared.calls[0].url.searchParams.get("type[]"), "vault");
  });

  test("kdrive_download_file requests the download endpoint", async () => {
    const { calls } = await call("kdrive_download_file", { file_id: 5 }, () => new Response("hi", { headers: { "content-type": "text/plain" } }));
    assert.strictEqual(calls[0].url.pathname, "/2/drive/123/files/5/download");
  });

  test("every request carries the bearer token", async () => {
    const { calls } = await call("kdrive_info", { file_id: 5 });
    assert.strictEqual(calls[0].headers.Authorization, "Bearer tok");
  });

  test("an API failure comes back as isError", async () => {
    const { result } = await call("kdrive_delete", { file_id: 5 }, () => json({ error: { code: "forbidden", description: "no" } }, 403));
    assert.strictEqual(result.isError, true);
  });
});

describe("cancellation", () => {
  test("a cancelled tool call aborts its kDrive request", async () => {
    let signal;
    const h = await harness((_url, init) => {
      signal = init.signal;
      return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
    });
    try {
      const controller = new AbortController();
      const pending = h.client.callTool({ name: "kdrive_info", arguments: { file_id: 5 } }, undefined, { signal: controller.signal });
      await new Promise((resolve) => setTimeout(resolve, 20));
      controller.abort();
      await assert.rejects(pending);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.strictEqual(signal.aborted, true);
      assert.strictEqual(h.calls.length, 1);
    } finally {
      await h.close();
    }
  });
});

describe("resource kdrive://{id}", () => {
  test("read returns a blob with the MIME type", async () => {
    const h = await harness(() => new Response(new Uint8Array([9]), { headers: { "content-type": "text/plain; charset=utf-8" } }));
    try {
      const out = await h.client.readResource({ uri: "kdrive://42" });
      assert.strictEqual(out.contents[0].mimeType, "text/plain");
      assert.strictEqual(out.contents[0].blob, Buffer.from([9]).toString("base64"));
      assert.strictEqual(h.calls[0].url.pathname, "/2/drive/123/files/42/download");
    } finally {
      await h.close();
    }
  });

  test("list returns the root directory children, files and directories", async () => {
    const h = await harness(() => ok([{ id: 11, name: "docs", type: "dir" }, { id: 12, name: "a.pdf", type: "file", mime_type: "application/pdf" }], { has_more: false }));
    try {
      const out = await h.client.listResources();
      assert.deepStrictEqual(out.resources.map((r) => [r.uri, r.name]), [["kdrive://11", "docs"], ["kdrive://12", "a.pdf"]]);
      assert.strictEqual(out.resources[1].mimeType, "application/pdf");
      assert.strictEqual(out.nextCursor, undefined);
      assert.strictEqual(h.calls[0].url.pathname, "/3/drive/123/files/1/files");
      assert.strictEqual(h.calls[0].url.searchParams.get("type[]"), null);
      assert.strictEqual(h.calls[0].url.searchParams.get("limit"), "100");
    } finally {
      await h.close();
    }
  });

  test("list keeps the host's own resources and templates", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => ok([{ id: 13, name: "b.txt" }], { has_more: false });
    try {
      for (const hostFirst of [true, false]) {
        const server = new McpServer({ name: "t", version: "0" });
        const hostResource = () => {
          server.registerResource("host_static", "host://one", {}, async (uri) => ({ contents: [{ uri: uri.href, text: "x" }] }));
          server.registerResource("host_tpl", new ResourceTemplate("host://{id}", { list: async () => ({ resources: [{ uri: "host://2", name: "two" }] }) }), {}, async (uri) => ({ contents: [{ uri: uri.href, text: "x" }] }));
        };
        if (hostFirst) hostResource();
        registerTools(server, new KdriveClient("tok", "123", 0));
        if (!hostFirst) hostResource();
        const client = new Client({ name: "c", version: "0" });
        const [a, b] = InMemoryTransport.createLinkedPair();
        await Promise.all([server.connect(a), client.connect(b)]);
        const out = await client.listResources();
        assert.deepStrictEqual(out.resources.map((r) => r.uri).sort(), ["host://one", "host://2", "kdrive://13"].sort());
        await client.close();
      }
    } finally {
      globalThis.fetch = original;
    }
  });

  test("list on an empty drive returns no resources instead of throwing", async () => {
    const h = await harness(() => ok([], { has_more: false }));
    try {
      const out = await h.client.listResources();
      assert.deepStrictEqual(out.resources, []);
    } finally {
      await h.close();
    }
  });

  test("list returns no resources when the API fails", async () => {
    const h = await harness(() => json({ error: { code: "internal", description: "boom" } }, 500));
    try {
      assert.deepStrictEqual((await h.client.listResources()).resources, []);
    } finally {
      await h.close();
    }
  });

  test("read rejects a non-numeric id", async () => {
    const h = await harness(() => ok());
    try {
      await assert.rejects(h.client.readResource({ uri: "kdrive://..%2F5" }));
      assert.strictEqual(h.calls.length, 0);
    } finally {
      await h.close();
    }
  });
});
