import { test, describe } from "node:test";
import assert from "node:assert";
import { harness, json } from "./helpers/harness.mjs";

describe("output shaping", () => {
  test("list tools return items, has_more, next_cursor, and structuredContent", async () => {
    const h = await harness(() => json({ result: "success", data: [{ id: 1, name: "a" }], cursor: "c2", has_more: true }));
    try {
      const result = await h.client.callTool({ name: "kdrive_list", arguments: { file_id: 5 } });
      assert.deepStrictEqual(result.structuredContent, { items: [{ id: 1, name: "a" }], has_more: true, next_cursor: "c2" });
      assert.strictEqual(result.content.length, 1);
      assert.ok(!result.content[0].text.includes("\n"), "compact JSON");
    } finally {
      await h.close();
    }
  });

  test("a list page above 100000 characters is refused with a smaller limit hint, never cut with a skipping cursor", async () => {
    const data = Array.from({ length: 400 }, (_, i) => ({ id: i, a: "n".repeat(900), b: "n".repeat(900), c: "n".repeat(900), d: "n".repeat(900) }));
    const h = await harness(() => json({ result: "success", data, has_more: true, cursor: "C2" }));
    try {
      const result = await h.client.callTool({ name: "kdrive_search", arguments: { query: "abc" } });
      assert.strictEqual(result.isError, true);
      assert.match(result.content[0].text, /smaller limit/);
      assert.ok(!result.content[0].text.includes("C2"));
    } finally {
      await h.close();
    }
  });

  test("long text fields in a list are cut and every item stays, with the cursor intact", async () => {
    const data = Array.from({ length: 80 }, (_, i) => ({ id: i, description: "d".repeat(3000) }));
    const h = await harness(() => json({ result: "success", data, has_more: true, cursor: "C2" }));
    try {
      const result = await h.client.callTool({ name: "kdrive_search", arguments: { query: "abc" } });
      assert.ok(!result.isError);
      const body = result.structuredContent;
      assert.strictEqual(body.truncated, true);
      assert.strictEqual(body.items.length, 80);
      assert.strictEqual(body.next_cursor, "C2");
      assert.ok(result.content[0].text.length <= 100000);
    } finally {
      await h.close();
    }
  });

  test("a single item above the cap is returned with its text cut, within the cap", async () => {
    const h = await harness(() => json({ result: "success", data: [{ id: 1, description: "\"".repeat(150000) }], has_more: false }));
    try {
      const result = await h.client.callTool({ name: "kdrive_list", arguments: {} });
      assert.ok(!result.isError);
      assert.strictEqual(result.structuredContent.items.length, 1);
      assert.strictEqual(result.structuredContent.truncated, true);
      assert.ok(result.content[0].text.length <= 100000);
    } finally {
      await h.close();
    }
  });

  test("a non-list result above 100000 characters is cut within the cap and flagged", async () => {
    const h = await harness(() => json({ result: "success", data: { blob: "\"".repeat(150000) } }));
    try {
      const result = await h.client.callTool({ name: "kdrive_info", arguments: { file_id: 5 } });
      assert.ok(result.content[0].text.length <= 100000);
      const body = JSON.parse(result.content[0].text);
      assert.strictEqual(body.truncated, true);
      assert.strictEqual(body.result, "success");
      assert.ok(body.data.blob.length > 10000);
    } finally {
      await h.close();
    }
  });

  test("a long next_cursor is never cut, even when the page is cut", async () => {
    const cursor = "C".repeat(800);
    const data = Array.from({ length: 80 }, (_, i) => ({ id: i, description: "d".repeat(3000) }));
    const h = await harness(() => json({ result: "success", data, has_more: true, cursor }));
    try {
      const result = await h.client.callTool({ name: "kdrive_search", arguments: { query: "abc" } });
      assert.strictEqual(result.structuredContent.truncated, true);
      assert.strictEqual(result.structuredContent.next_cursor, cursor);
      assert.strictEqual(result.structuredContent.has_more, true);
    } finally {
      await h.close();
    }
  });

  test("the smaller limit hint is computed from the page size", async () => {
    const data = Array.from({ length: 1000 }, (_, i) => ({ id: i, name: "n".repeat(150) }));
    const size = JSON.stringify({ items: data, has_more: true, next_cursor: "c" }).length;
    const h = await harness(() => json({ result: "success", data, has_more: true, cursor: "c" }));
    try {
      const result = await h.client.callTool({ name: "kdrive_search", arguments: { query: "abc" } });
      assert.strictEqual(result.isError, true);
      const suggested = Number(/for example (\d+)/.exec(result.content[0].text)[1]);
      assert.strictEqual(suggested, Math.floor((1000 * 100000) / size));
      assert.ok(suggested * (size / 1000) <= 100000);
    } finally {
      await h.close();
    }
  });

  test("many small values in an item are trimmed within the cap, with every item kept", async () => {
    const data = Array.from({ length: 20 }, (_, i) => ({ id: i, tags: Array.from({ length: 4000 }, (_, n) => n), meta: Object.fromEntries(Array.from({ length: 800 }, (_, n) => [`k${n}`, n])) }));
    const h = await harness(() => json({ result: "success", data, has_more: false }));
    try {
      const result = await h.client.callTool({ name: "kdrive_list", arguments: {} });
      assert.ok(!result.isError);
      assert.strictEqual(result.structuredContent.items.length, 20);
      assert.strictEqual(result.structuredContent.truncated, true);
      assert.ok(result.content[0].text.length <= 100000);
    } finally {
      await h.close();
    }
  });

  test("a non-list result with many small values is trimmed within the cap and keeps untrusted_content", async () => {
    const h = await harness(() => json({ result: "success", data: { list: Array.from({ length: 60000 }, (_, n) => n), untrusted_content: "x" } }));
    try {
      const result = await h.client.callTool({ name: "kdrive_info", arguments: { file_id: 5 } });
      assert.ok(result.content[0].text.length <= 100000);
      const body = JSON.parse(result.content[0].text);
      assert.strictEqual(body.truncated, true);
      assert.strictEqual(body.data.untrusted_content, "x");
      assert.match(String(body.data.list.at(-1)), /more/);
    } finally {
      await h.close();
    }
  });

  test("API fields of an unexpected type pass the output schema", async () => {
    const data = [{ id: "a", name: 5, size: null, nested: { deep: [1, "x", null] }, path: ["a"] }];
    const h = await harness(() => json({ result: "success", data, has_more: false, cursor: null, total: "many" }));
    try {
      const result = await h.client.callTool({ name: "kdrive_list", arguments: {} });
      assert.ok(!result.isError, JSON.stringify(result.content));
      assert.deepStrictEqual(result.structuredContent.items, data);
    } finally {
      await h.close();
    }
  });

  test("download returns an embedded resource with its MIME type", async () => {
    const h = await harness(() => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "application/pdf" } }));
    try {
      const result = await h.client.callTool({ name: "kdrive_download_file", arguments: { file_id: 9 } });
      assert.strictEqual(result.content[0].type, "resource");
      assert.strictEqual(result.content[0].resource.mimeType, "application/pdf");
      assert.strictEqual(result.content[0].resource.blob, Buffer.from([1, 2, 3]).toString("base64"));
      assert.strictEqual(result.content[0].resource.uri, "kdrive://9");
    } finally {
      await h.close();
    }
  });

  test("download returns images as image content", async () => {
    const h = await harness(() => new Response(new Uint8Array([7]), { status: 200, headers: { "content-type": "image/png" } }));
    try {
      const result = await h.client.callTool({ name: "kdrive_download_file", arguments: { file_id: 9 } });
      assert.strictEqual(result.content[0].type, "image");
      assert.strictEqual(result.content[0].mimeType, "image/png");
    } finally {
      await h.close();
    }
  });

  test("download refuses files above 5 MB by content-length and by body size", async () => {
    for (const headers of [{ "content-length": String(6 * 1024 * 1024) }, {}]) {
      const body = headers["content-length"] ? new Uint8Array(1) : new Uint8Array(6 * 1024 * 1024);
      const h = await harness(() => new Response(body, { status: 200, headers }));
      try {
        const result = await h.client.callTool({ name: "kdrive_download_file", arguments: { file_id: 9 } });
        assert.strictEqual(result.isError, true);
        assert.match(result.content[0].text, /refused/);
      } finally {
        await h.close();
      }
    }
  });

  test("errors surface as isError, not as normal content", async () => {
    const h = await harness(() => json({ error: { code: "forbidden", description: "no" } }, 403));
    try {
      const result = await h.client.callTool({ name: "kdrive_info", arguments: { file_id: 5 } });
      assert.strictEqual(result.isError, true);
      assert.match(result.content[0].text, /403 forbidden: no/);
    } finally {
      await h.close();
    }
  });

  test("a chunked download without content-length is cancelled once it passes 5 MB", async () => {
    let pulled = 0;
    let cancelled = false;
    const stream = new ReadableStream({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const h = await harness(() => new Response(stream, { status: 200 }));
    try {
      const result = await h.client.callTool({ name: "kdrive_download_file", arguments: { file_id: 9 } });
      assert.strictEqual(result.isError, true);
      assert.match(result.content[0].text, /larger than/);
      assert.strictEqual(cancelled, true);
      assert.ok(pulled < 20, `pulled ${pulled} chunks`);
    } finally {
      await h.close();
    }
  });

  test("a non-numeric content-length counts as unknown and the body is still capped", async () => {
    const h = await harness(() => new Response(new Uint8Array(6 * 1024 * 1024), { status: 200, headers: { "content-length": "abc" } }));
    try {
      const result = await h.client.callTool({ name: "kdrive_download_file", arguments: { file_id: 9 } });
      assert.strictEqual(result.isError, true);
    } finally {
      await h.close();
    }
  });
});
