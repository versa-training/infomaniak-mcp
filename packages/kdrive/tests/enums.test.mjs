import { test, describe } from "node:test";
import assert from "node:assert";
import { harness, json } from "./helpers/harness.mjs";
import { decodeBase64 } from "../dist/kdrive-client.js";

const ok = json({ result: "success", data: {} });

async function run(name, args) {
  const h = await harness(() => ok.clone());
  try {
    const result = await h.client.callTool({ name, arguments: args });
    return { result, calls: h.calls };
  } finally {
    await h.close();
  }
}

describe("share link rules", () => {
  test("inherit is not a valid right", async () => {
    const { result, calls } = await run("kdrive_share_link", { file_id: 1, right: "inherit" });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(calls.length, 0);
  });

  test("a password link requires a password", async () => {
    const { result, calls } = await run("kdrive_share_link", { file_id: 1, right: "password" });
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /password is required/);
    assert.strictEqual(calls.length, 0);
  });

  test("a public link rejects a password", async () => {
    const { result, calls } = await run("kdrive_share_link", { file_id: 1, right: "public", password: "x" });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(calls.length, 0);
  });

  test("a password link with a password is sent", async () => {
    const { result, calls } = await run("kdrive_share_link", { file_id: 1, right: "password", password: "pw" });
    assert.ok(!result.isError);
    assert.deepStrictEqual(calls[0].body, { right: "password", password: "pw" });
  });
});

describe("recents type", () => {
  test("file is not a valid recents type", async () => {
    const { result, calls } = await run("kdrive_recents", { type: "file" });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(calls.length, 0);
  });
  test("dir and vault are", async () => {
    for (const type of ["dir", "vault"]) {
      const { calls } = await run("kdrive_recents", { type });
      assert.strictEqual(calls[0].url.searchParams.get("type[]"), type);
    }
  });
});

describe("upload content", () => {
  test("an empty text_content creates an empty file", async () => {
    const { result, calls } = await run("kdrive_upload_file", { file_name: "empty.txt", text_content: "" });
    assert.ok(!result.isError);
    assert.strictEqual(calls[0].url.searchParams.get("total_size"), "0");
    assert.strictEqual(calls[0].rawBody.length, 0);
  });

  test("an empty base64_content creates an empty file", async () => {
    const { result, calls } = await run("kdrive_upload_file", { file_name: "empty.bin", base64_content: "" });
    assert.ok(!result.isError);
    assert.strictEqual(calls[0].url.searchParams.get("total_size"), "0");
  });

  test("a data: URL prefix is stripped", async () => {
    const { calls } = await run("kdrive_upload_file", { file_name: "a.bin", base64_content: "data:application/octet-stream;base64,AQID" });
    assert.deepStrictEqual([...calls[0].rawBody], [1, 2, 3]);
  });

  test("malformed base64 is rejected before any request", async () => {
    for (const bad of ["AQ*D", "AQI", "AQID=", "AQ==AQ=="]) {
      const { result, calls } = await run("kdrive_upload_file", { file_name: "a.bin", base64_content: bad });
      assert.strictEqual(result.isError, true, bad);
      assert.match(result.content[0].text, /not valid base64/);
      assert.strictEqual(calls.length, 0);
    }
  });

  test("decodeBase64 accepts padded input and line breaks", () => {
    assert.deepStrictEqual([...decodeBase64("AQI=")], [1, 2]);
    assert.deepStrictEqual([...decodeBase64("AQ\nID")], [1, 2, 3]);
  });
});
