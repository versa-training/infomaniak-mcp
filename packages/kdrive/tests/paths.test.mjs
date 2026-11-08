import { test, describe } from "node:test";
import assert from "node:assert";
import { KdriveClient, buildQuery } from "../dist/kdrive-client.js";

async function capture(fn) {
  const original = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url) => {
    captured = new URL(url);
    return new Response(JSON.stringify({ result: "success", data: [] }), { status: 200 });
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
  return captured;
}

describe("path segment encoding", () => {
  test("a path-traversal id stays inside the file segment", async () => {
    const client = new KdriveClient("t", "123");
    const url = await capture(() => client.info("../../../../2/drive/1/files/5"));
    assert.strictEqual(url.pathname.split("/").length, 6);
    assert.ok(url.pathname.startsWith("/3/drive/123/files/"));
    assert.ok(!url.pathname.includes("/files/5"));
  });

  test("a hash or question mark in an id cannot cut the query", async () => {
    const client = new KdriveClient("t", "123");
    const url = await capture(() => client.listFiles("7#x?y", { type: "dir" }));
    assert.strictEqual(url.hash, "");
    assert.strictEqual(url.searchParams.get("type[]"), "dir");
    assert.ok(url.pathname.includes("7%23x%3Fy"));
  });

  test("the drive id must be numeric", () => {
    assert.throws(() => new KdriveClient("t", "1/../2"), /KDRIVE_ID/);
  });

  test("buildQuery repeats array keys and skips undefined", () => {
    assert.strictEqual(buildQuery({ a: undefined, b: ["x", "y"], c: 1 }), "?b%5B%5D=x&b%5B%5D=y&c=1");
    assert.strictEqual(buildQuery({}), "");
  });

  test("the share invitation language goes through URLSearchParams", async () => {
    const client = new KdriveClient("t", "123");
    const url = await capture(() => client.shareAccess(5, ["a@b.ch"], "read", undefined, "en&x=1"));
    assert.strictEqual(url.searchParams.get("lang"), "en&x=1");
    assert.strictEqual(url.searchParams.get("x"), null);
  });
});
