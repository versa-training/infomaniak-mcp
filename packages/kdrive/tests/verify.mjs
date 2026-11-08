import { test, describe } from "node:test";
import assert from "node:assert";
import { KdriveClient } from "../dist/kdrive-client.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function mockFetch(fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fn;
  return () => { globalThis.fetch = originalFetch; };
}

describe("KdriveClient instantiation", () => {
  test("creates a client with token and driveId", () => {
    const client = new KdriveClient("test-token", "123456");
    assert.ok(client);
  });

  test("exposes all expected methods", () => {
    const client = new KdriveClient("test-token", "123456");
    const methods = [
      "search", "uploadFile", "listFiles", "rename", "move",
      "deleteFile", "shareLink", "shareAccess", "createFolder",
      "restore", "info", "recents", "sharedWithMe", "downloadFile",
    ];
    for (const m of methods) {
      assert.strictEqual(
        typeof client[m],
        "function",
        `method ${m} should be a function`
      );
    }
  });
});

describe("KdriveClient.search", () => {
  test("calls fetch with correct URL", async () => {
    let capturedUrl = null;
    const restore = mockFetch(async (url) => {
      capturedUrl = url;
      return jsonResponse(({ result: "success", data: [] }));
    });

    try {
      const client = new KdriveClient("mock-token", "123");
      await client.search("test");

      assert.ok(capturedUrl, "fetch was called");
      assert.ok(new URL(capturedUrl).pathname.endsWith("/drive/123/files/search"), "URL contains drive ID");
      assert.ok(new URL(capturedUrl).searchParams.get("query") === "test", "URL contains query");
      assert.strictEqual(new URL(capturedUrl).searchParams.get("limit"), null, "limit is left to the API default");
    } finally {
      restore();
    }
  });

  test("scopes search to a directory when directory_id provided", async () => {
    let capturedUrl = null;
    const restore = mockFetch(async (url) => {
      capturedUrl = url;
      return jsonResponse(({ result: "success", data: [] }));
    });

    try {
      const client = new KdriveClient("mock-token", "123");
      await client.search("test", { directory_id: 91535 });
      assert.ok(new URL(capturedUrl).searchParams.get("directory_id") === "91535", "URL contains directory_id");
    } finally {
      restore();
    }
  });

  test("passes depth parameter when provided", async () => {
    let capturedUrl = null;
    const restore = mockFetch(async (url) => {
      capturedUrl = url;
      return jsonResponse(({ result: "success", data: [] }));
    });

    try {
      const client = new KdriveClient("mock-token", "123");
      await client.search("test", { directory_id: 10, depth: "unlimited" });
      assert.ok(new URL(capturedUrl).searchParams.get("directory_id") === "10", "URL contains directory_id");
      assert.ok(new URL(capturedUrl).searchParams.get("depth") === "unlimited", "URL contains depth");
    } finally {
      restore();
    }
  });

  test("does not include directory_id or depth when not provided", async () => {
    let capturedUrl = null;
    const restore = mockFetch(async (url) => {
      capturedUrl = url;
      return jsonResponse(({ result: "success", data: [] }));
    });

    try {
      const client = new KdriveClient("mock-token", "123");
      await client.search("test");
      assert.ok(!new URL(capturedUrl).searchParams.has("directory_id"), "URL does not contain directory_id");
      assert.ok(!new URL(capturedUrl).searchParams.has("depth"), "URL does not contain depth");
    } finally {
      restore();
    }
  });
});

describe("KdriveClient.uploadFile", () => {
  test("throws when neither text nor base64 provided", async () => {
    const client = new KdriveClient("mock-token", "123");
    await assert.rejects(
      async () => client.uploadFile("test.txt"),
      /Either text_content or base64_content must be provided/
    );
  });

  test("uploads text content with correct headers", async () => {
    let capturedOptions = null;
    const restore = mockFetch(async (url, options) => {
      capturedOptions = options;
      return jsonResponse(({ result: "success", data: { id: 1 } }));
    });

    try {
      const client = new KdriveClient("mock-token", "123");
      await client.uploadFile("test.txt", 1, "hello world");

      assert.ok(capturedOptions, "fetch was called with options");
      assert.strictEqual(capturedOptions.method, "POST", "uses POST method");
      assert.strictEqual(
        capturedOptions.headers["Content-Type"],
        "application/octet-stream",
        "sets octet-stream content type"
      );
    } finally {
      restore();
    }
  });

  test("uploads base64 content", async () => {
    let capturedBody = null;
    const restore = mockFetch(async (url, options) => {
      capturedBody = options?.body;
      return jsonResponse(({ result: "success", data: { id: 2 } }));
    });

    try {
      const client = new KdriveClient("mock-token", "123");
      await client.uploadFile("test.bin", 1, undefined, "aGVsbG8=");

      assert.ok(capturedBody, "body was provided");
      assert.ok(capturedBody instanceof Uint8Array, "body is a Uint8Array");
      assert.equal(
        Buffer.from(capturedBody).toString(),
        "hello",
        "body contains the decoded base64 content",
      );
    } finally {
      restore();
    }
  });
});

describe("KdriveClient.listFiles", () => {
  test("lists files without filter", async () => {
    let capturedUrl = null;
    const restore = mockFetch(async (url) => {
      capturedUrl = url;
      return jsonResponse(({ result: "success", data: [] }));
    });

    try {
      const client = new KdriveClient("mock-token", "123");
      await client.listFiles(10);
      assert.ok(new URL(capturedUrl).pathname.endsWith("/drive/123/files/10/files"), "URL is correct");
      assert.ok(!new URL(capturedUrl).searchParams.has("type[]"), "no type filter");
    } finally {
      restore();
    }
  });

  test("lists files with type filter", async () => {
    let capturedUrl = null;
    const restore = mockFetch(async (url) => {
      capturedUrl = url;
      return jsonResponse(({ result: "success", data: [] }));
    });

    try {
      const client = new KdriveClient("mock-token", "123");
      await client.listFiles(10, { type: "file" });
      assert.ok(new URL(capturedUrl).searchParams.get("type[]") === "file", "URL contains type filter");
    } finally {
      restore();
    }
  });

  test("lists files with cursor for pagination", async () => {
    let capturedUrl = null;
    const restore = mockFetch(async (url) => {
      capturedUrl = url;
      return jsonResponse(({ result: "success", data: [] }));
    });

    try {
      const client = new KdriveClient("mock-token", "123");
      await client.listFiles(10, { cursor: "SGVsbG8gV29ybGQ" });
      assert.ok(new URL(capturedUrl).searchParams.get("cursor") === "SGVsbG8gV29ybGQ", "URL contains cursor");
    } finally {
      restore();
    }
  });

  test("lists files with both type filter and cursor", async () => {
    let capturedUrl = null;
    const restore = mockFetch(async (url) => {
      capturedUrl = url;
      return jsonResponse(({ result: "success", data: [] }));
    });

    try {
      const client = new KdriveClient("mock-token", "123");
      await client.listFiles(10, { type: "dir", cursor: "abc123" });
      assert.ok(new URL(capturedUrl).searchParams.get("type[]") === "dir", "URL contains type filter");
      assert.ok(new URL(capturedUrl).searchParams.get("cursor") === "abc123", "URL contains cursor");
    } finally {
      restore();
    }
  });

  test("does not include cursor when not provided", async () => {
    let capturedUrl = null;
    const restore = mockFetch(async (url) => {
      capturedUrl = url;
      return jsonResponse(({ result: "success", data: [] }));
    });

    try {
      const client = new KdriveClient("mock-token", "123");
      await client.listFiles(10);
      assert.ok(!new URL(capturedUrl).searchParams.has("cursor"), "URL does not contain cursor");
    } finally {
      restore();
    }
  });
});

describe("KdriveClient.rename", () => {
  test("calls correct endpoint with correct body", async () => {
    let capturedUrl = null;
    let capturedBody = null;
    const restore = mockFetch(async (url, options) => {
      capturedUrl = url;
      capturedBody = options?.body;
      return jsonResponse(({ result: "success", data: { id: 42 } }));
    });

    try {
      const client = new KdriveClient("mock-token", "123");
      const result = await client.rename(10, "new-name.txt");

      assert.strictEqual(result.data.id, 42);
      assert.ok(new URL(capturedUrl).pathname.endsWith("/drive/123/files/10/rename"), "URL contains correct path");
      assert.strictEqual(capturedBody, JSON.stringify({ name: "new-name.txt" }), "Body is correct");
    } finally {
      restore();
    }
  });
});

describe("KdriveClient.move", () => {
  test("calls correct endpoint", async () => {
    let capturedUrl = null;
    const restore = mockFetch(async (url, options) => {
      capturedUrl = url;
      return jsonResponse(({ result: "success", data: { id: 10 } }));
    });

    try {
      const client = new KdriveClient("mock-token", "123");
      await client.move(10, 20);

      assert.ok(new URL(capturedUrl).pathname.endsWith("/drive/123/files/10/move/20"), "URL contains correct path");
      assert.strictEqual(capturedUrl, "https://api.infomaniak.com/3/drive/123/files/10/move/20");
    } finally {
      restore();
    }
  });
});

describe("KdriveClient.deleteFile", () => {
  test("calls DELETE on correct endpoint", async () => {
    let capturedUrl = null;
    let capturedMethod = null;
    const restore = mockFetch(async (url, options) => {
      capturedUrl = url;
      capturedMethod = options?.method;
      return jsonResponse(({ result: "success", data: {} }));
    });

    try {
      const client = new KdriveClient("mock-token", "123");
      await client.deleteFile(10);

      assert.strictEqual(capturedMethod, "DELETE", "uses DELETE method");
      assert.ok(new URL(capturedUrl).pathname.endsWith("/drive/123/files/10"), "URL is correct");
    } finally {
      restore();
    }
  });
});

describe("KdriveClient.shareLink", () => {
  test("calls correct endpoint with options", async () => {
    let capturedUrl = null;
    let capturedBody = null;
    const restore = mockFetch(async (url, options) => {
      capturedUrl = url;
      capturedBody = options?.body;
      return jsonResponse(({ result: "success", data: { link: "https://example.com" } }));
    });

    try {
      const client = new KdriveClient("mock-token", "123");
      await client.shareLink(10, { right: "public", can_download: true });

      assert.ok(new URL(capturedUrl).pathname.endsWith("/drive/123/files/10/link"), "URL is correct");
      assert.strictEqual(
        capturedBody,
        JSON.stringify({ right: "public", can_download: true }),
        "Body contains options"
      );
    } finally {
      restore();
    }
  });
});

describe("KdriveClient.shareAccess", () => {
  test("calls correct endpoint with emails and right", async () => {
    let capturedUrl = null;
    let capturedBody = null;
    const restore = mockFetch(async (url, options) => {
      capturedUrl = url;
      capturedBody = options?.body;
      return jsonResponse(({ result: "success", data: {} }));
    });

    try {
      const client = new KdriveClient("mock-token", "123");
      await client.shareAccess(10, ["user@example.com"], "read");

      assert.ok(new URL(capturedUrl).pathname.endsWith("/drive/123/files/10/access/invitations"), "URL is correct");
      assert.ok(new URL(capturedUrl).searchParams.get("lang") === "en", "default lang is en");
      assert.strictEqual(
        capturedBody,
        JSON.stringify({ emails: ["user@example.com"], right: "read" }),
        "Body is correct"
      );
    } finally {
      restore();
    }
  });

  test("includes message when provided", async () => {
    let capturedBody = null;
    const restore = mockFetch(async (url, options) => {
      capturedBody = options?.body;
      return jsonResponse(({ result: "success", data: {} }));
    });

    try {
      const client = new KdriveClient("mock-token", "123");
      await client.shareAccess(10, ["user@example.com"], "write", "Hello!");

      assert.strictEqual(
        capturedBody,
        JSON.stringify({ emails: ["user@example.com"], right: "write", message: "Hello!" }),
        "Body includes message"
      );
    } finally {
      restore();
    }
  });
});

describe("KdriveClient.createFolder", () => {
  test("calls correct endpoint", async () => {
    let capturedUrl = null;
    let capturedBody = null;
    const restore = mockFetch(async (url, options) => {
      capturedUrl = url;
      capturedBody = options?.body;
      return jsonResponse(({ result: "success", data: { id: 42 } }));
    });

    try {
      const client = new KdriveClient("mock-token", "123");
      const result = await client.createFolder(10, "my-folder");

      assert.strictEqual(result.data.id, 42);
      assert.ok(new URL(capturedUrl).pathname.endsWith("/drive/123/files/10/directory"), "URL contains correct path");
      assert.strictEqual(capturedBody, JSON.stringify({ name: "my-folder" }), "Body is correct");
    } finally {
      restore();
    }
  });
});

describe("KdriveClient.restore", () => {
  test("calls correct endpoint with destination", async () => {
    let capturedUrl = null;
    let capturedBody = null;
    const restore = mockFetch(async (url, options) => {
      capturedUrl = url;
      capturedBody = options?.body;
      return jsonResponse(({ result: "success", data: { id: 10 } }));
    });

    try {
      const client = new KdriveClient("mock-token", "123");
      await client.restore(10, 20);

      assert.ok(new URL(capturedUrl).pathname.endsWith("/drive/123/trash/10/restore"), "URL is correct");
      assert.strictEqual(capturedBody, JSON.stringify({ destination_directory_id: 20 }), "Body is correct");
    } finally {
      restore();
    }
  });
});

describe("KdriveClient.info", () => {
  test("calls correct endpoint", async () => {
    let capturedUrl = null;
    const restore = mockFetch(async (url) => {
      capturedUrl = url;
      return jsonResponse(({ result: "success", data: { id: 10 } }));
    });

    try {
      const client = new KdriveClient("mock-token", "123");
      await client.info(10);

      assert.ok(new URL(capturedUrl).pathname.endsWith("/drive/123/files/10"), "URL is correct");
      assert.ok(!new URL(capturedUrl).pathname.endsWith("/download"), "not download endpoint");
    } finally {
      restore();
    }
  });
});

describe("KdriveClient.recents", () => {
  test("calls correct endpoint without filter", async () => {
    let capturedUrl = null;
    const restore = mockFetch(async (url) => {
      capturedUrl = url;
      return jsonResponse(({ result: "success", data: [] }));
    });

    try {
      const client = new KdriveClient("mock-token", "123");
      await client.recents();

      assert.ok(new URL(capturedUrl).pathname.endsWith("/drive/123/files/recents"), "URL is correct");
      assert.ok(!new URL(capturedUrl).searchParams.has("type[]"), "no type filter");
    } finally {
      restore();
    }
  });

  test("calls correct endpoint with type filter", async () => {
    let capturedUrl = null;
    const restore = mockFetch(async (url) => {
      capturedUrl = url;
      return jsonResponse(({ result: "success", data: [] }));
    });

    try {
      const client = new KdriveClient("mock-token", "123");
      await client.recents({ type: "file" });

      assert.ok(new URL(capturedUrl).searchParams.get("type[]") === "file", "URL contains type filter");
    } finally {
      restore();
    }
  });
});

describe("KdriveClient.sharedWithMe", () => {
  test("calls correct endpoint without filter", async () => {
    let capturedUrl = null;
    const restore = mockFetch(async (url) => {
      capturedUrl = url;
      return jsonResponse(({ result: "success", data: [] }));
    });

    try {
      const client = new KdriveClient("mock-token", "123");
      await client.sharedWithMe();

      assert.ok(new URL(capturedUrl).pathname.endsWith("/drive/123/files/shared_with_me"), "URL is correct");
      assert.ok(!new URL(capturedUrl).searchParams.has("type[]"), "no type filter");
    } finally {
      restore();
    }
  });

  test("calls correct endpoint with type filter", async () => {
    let capturedUrl = null;
    const restore = mockFetch(async (url) => {
      capturedUrl = url;
      return jsonResponse(({ result: "success", data: [] }));
    });

    try {
      const client = new KdriveClient("mock-token", "123");
      await client.sharedWithMe({ type: "dir" });

      assert.ok(new URL(capturedUrl).searchParams.get("type[]") === "dir", "URL contains type filter");
    } finally {
      restore();
    }
  });
});

describe("KdriveClient.downloadFile", () => {
  test("calls correct download endpoint", async () => {
    let capturedUrl = null;
    const restore = mockFetch(async (url) => {
      capturedUrl = url;
      return new Response(new ArrayBuffer(0), { status: 200 });
    });

    try {
      const client = new KdriveClient("mock-token", "123");
      await client.downloadFile(10);

      assert.ok(new URL(capturedUrl).pathname.endsWith("/drive/123/files/10/download"), "URL is correct");
    } finally {
      restore();
    }
  });

  test("returns ArrayBuffer", async () => {
    const restore = mockFetch(async (url) => {
      return new Response(new ArrayBuffer(42), { status: 200 });
    });

    try {
      const client = new KdriveClient("mock-token", "123");
      const { data: result } = await client.downloadFile(10);

      assert.ok(result instanceof ArrayBuffer, "result is ArrayBuffer");
      assert.strictEqual(result.byteLength, 42, "ArrayBuffer has correct length");
    } finally {
      restore();
    }
  });
});

// Helper used across all tests - ensure describe groups close properly
