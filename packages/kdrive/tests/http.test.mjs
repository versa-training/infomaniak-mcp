import { test, describe } from "node:test";
import assert from "node:assert";
import { KdriveClient, parseRetryAfterMs, withDeadline } from "../dist/kdrive-client.js";

function withFetch(fn, body) {
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  return body().finally(() => {
    globalThis.fetch = original;
  });
}

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("HTTP error handling", () => {
  test("a non-2xx response throws status, code, and a trimmed message", async () => {
    const long = "x".repeat(500);
    await withFetch(
      async () => json({ result: "error", error: { code: "not_authorized", description: long }, secret: "do-not-leak" }, 403),
      async () => {
        const client = new KdriveClient("t", "1", 0);
        await assert.rejects(client.info(5), (error) => {
          assert.match(error.message, /^403 not_authorized: x{200}$/);
          assert.ok(!error.message.includes("do-not-leak"));
          return true;
        });
      },
    );
  });

  test("a non-JSON error body still reports the status", async () => {
    await withFetch(
      async () => new Response("<html>bad gateway</html>", { status: 400, statusText: "Bad Request" }),
      async () => {
        const client = new KdriveClient("t", "1", 0);
        await assert.rejects(client.rename(5, "a"), /^Error: 400: Bad Request$/);
      },
    );
  });

  test("a GET is retried once on 503 and then succeeds", async () => {
    let calls = 0;
    await withFetch(
      async () => (++calls === 1 ? json({}, 503) : json({ result: "success", data: [] })),
      async () => {
        const client = new KdriveClient("t", "1", 0);
        const result = await client.search("abc");
        assert.strictEqual(result.result, "success");
        assert.strictEqual(calls, 2);
      },
    );
  });

  test("a GET is retried once on a network error, then fails", async () => {
    let calls = 0;
    await withFetch(
      async () => {
        calls++;
        throw new TypeError("fetch failed");
      },
      async () => {
        const client = new KdriveClient("t", "1", 0);
        await assert.rejects(client.search("abc"), /kDrive request failed: fetch failed/);
        assert.strictEqual(calls, 2);
      },
    );
  });

  test("a POST is never retried", async () => {
    let calls = 0;
    await withFetch(
      async () => {
        calls++;
        return json({}, 503);
      },
      async () => {
        const client = new KdriveClient("t", "1", 0);
        await assert.rejects(client.rename(5, "a"), /^Error: 503/);
        assert.strictEqual(calls, 1);
      },
    );
  });

  test("a 404 on GET is not retried", async () => {
    let calls = 0;
    await withFetch(
      async () => {
        calls++;
        return json({ error: { code: "object_not_found", description: "gone" } }, 404);
      },
      async () => {
        const client = new KdriveClient("t", "1", 0);
        await assert.rejects(client.info(5), /^Error: 404 object_not_found: gone$/);
        assert.strictEqual(calls, 1);
      },
    );
  });

  test("every request carries an abort signal", async () => {
    let signal;
    await withFetch(
      async (_url, init) => {
        signal = init.signal;
        return json({ result: "success", data: {} });
      },
      async () => {
        await new KdriveClient("t", "1", 0).info(5);
        assert.ok(signal instanceof AbortSignal);
      },
    );
  });

  test("a network error reports the cause code", async () => {
    await withFetch(
      async () => {
        throw new TypeError("fetch failed", { cause: Object.assign(new Error("dns"), { code: "ENOTFOUND" }) });
      },
      async () => {
        await assert.rejects(new KdriveClient("t", "1", 0).info(5), /fetch failed \(ENOTFOUND\)/);
      },
    );
  });

  test("a timeout reports 30 s", async () => {
    await withFetch(
      async () => {
        throw new DOMException("timed out", "TimeoutError");
      },
      async () => {
        await assert.rejects(new KdriveClient("t", "1", 0).info(5), /timed out after 30 s/);
      },
    );
  });

  test("Retry-After on 429 is honored and the first body is cancelled", async () => {
    let calls = 0;
    let cancelled = false;
    const times = [];
    const first = new ReadableStream({ cancel() { cancelled = true; } });
    await withFetch(
      async () => {
        times.push(Date.now());
        return ++calls === 1
          ? new Response(first, { status: 429, headers: { "retry-after": "1" } })
          : json({ result: "success", data: [] });
      },
      async () => {
        await new KdriveClient("t", "1", 0).search("abc");
        assert.strictEqual(calls, 2);
        assert.strictEqual(cancelled, true);
        assert.ok(times[1] - times[0] >= 900, `waited ${times[1] - times[0]} ms`);
      },
    );
  });

  test("parseRetryAfterMs reads seconds and dates, caps at 10 s, and ignores junk", () => {
    assert.strictEqual(parseRetryAfterMs("2"), 2000);
    assert.strictEqual(parseRetryAfterMs("3600"), 10000);
    assert.strictEqual(parseRetryAfterMs(new Date(5000).toUTCString(), 2000), 3000);
    assert.strictEqual(parseRetryAfterMs("soon"), undefined);
    assert.strictEqual(parseRetryAfterMs(null), undefined);
  });

  test("a TimeoutError is not retried", async () => {
    let calls = 0;
    await withFetch(
      async () => {
        calls++;
        throw new DOMException("timed out", "TimeoutError");
      },
      async () => {
        await assert.rejects(new KdriveClient("t", "1", 0).info(5), /timed out after 30 s/);
        assert.strictEqual(calls, 1);
      },
    );
  });

  test("a reset while the body streams reports a network error, a timeout reports 30 s", async () => {
    const stream = (error) => new ReadableStream({ start(controller) { controller.error(error); } });
    await withFetch(
      async () => new Response(stream(new DOMException("aborted", "TimeoutError")), { status: 200 }),
      async () => {
        await assert.rejects(new KdriveClient("t", "1", 0).info(5), /timed out after 30 s/);
      },
    );
    await withFetch(
      async () => new Response(stream(new TypeError("terminated", { cause: Object.assign(new Error("x"), { code: "ECONNRESET" }) })), { status: 200 }),
      async () => {
        await assert.rejects(new KdriveClient("t", "1", 0).info(5), /terminated \(ECONNRESET\)/);
      },
    );
  });

  test("the overall deadline and the host signal stop requests and are not retried", async () => {
    let calls = 0;
    let seen;
    const hang = (_url, init) => {
      calls++;
      seen = init.signal;
      return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
    };
    await withFetch(hang, async () => {
      await assert.rejects(withDeadline(undefined, 20, () => new KdriveClient("t", "1", 0).info(5)), /passed its deadline/);
      assert.strictEqual(calls, 1);
      const host = new AbortController();
      const pending = withDeadline(host.signal, 60000, () => new KdriveClient("t", "1", 0).info(5));
      setTimeout(() => host.abort(), 10);
      await assert.rejects(pending, /cancelled/);
      assert.strictEqual(calls, 2);
      assert.ok(seen.aborted);
    });
  });
});
