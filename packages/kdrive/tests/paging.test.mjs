import { test, describe } from "node:test";
import assert from "node:assert";
import { harness, json } from "./helpers/harness.mjs";

const page = (cursor) => json({ result: "success", data: [{ id: 1 }], has_more: Boolean(cursor), cursor });

async function firstCall(name, args) {
  const h = await harness(() => page("n1"));
  try {
    const result = await h.client.callTool({ name, arguments: args });
    return { url: h.calls[0].url, result };
  } finally {
    await h.close();
  }
}

describe("paging", () => {
  for (const [tool, path, extra] of [
    ["kdrive_search", "/3/drive/123/files/search", { query: "abc" }],
    ["kdrive_list", "/3/drive/123/files/1/files", {}],
    ["kdrive_recents", "/3/drive/123/files/recents", {}],
    ["kdrive_shared_with_me", "/3/drive/123/files/shared_with_me", {}],
  ]) {
    test(`${tool} forwards limit and cursor`, async () => {
      const { url, result } = await firstCall(tool, { ...extra, limit: 50, cursor: "c0" });
      assert.strictEqual(url.pathname, path);
      assert.strictEqual(url.searchParams.get("limit"), "50");
      assert.strictEqual(url.searchParams.get("cursor"), "c0");
      assert.strictEqual(result.structuredContent.has_more, true);
      assert.strictEqual(result.structuredContent.next_cursor, "n1");
    });

    test(`${tool} rejects limit outside 5 to 1000`, async () => {
      for (const limit of [4, 1001, 7.5]) {
        const h = await harness(() => page());
        try {
          const result = await h.client.callTool({ name: tool, arguments: { ...extra, limit } });
          assert.strictEqual(result.isError, true, `limit ${limit}`);
          assert.strictEqual(h.calls.length, 0);
        } finally {
          await h.close();
        }
      }
    });
  }

  test("kdrive_list forwards order_by and order", async () => {
    const { url } = await firstCall("kdrive_list", { order_by: "name", order: "asc" });
    assert.strictEqual(url.searchParams.get("order_by[]"), "name");
    assert.strictEqual(url.searchParams.get("order"), "asc");
  });
});
