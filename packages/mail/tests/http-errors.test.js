import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { createFetchMock, jsonResponse, connectTools, MAILBOXES } from "./helpers.js";

const { MailClient, withCallDeadline } = await import("../dist/mail-client.js");

describe("http errors, timeouts, and retries", () => {
    let fetchMock;
    let originalFetch;

    beforeEach(() => {
        fetchMock = createFetchMock();
        originalFetch = global.fetch;
        global.fetch = fetchMock;
    });

    afterEach(() => {
        global.fetch = originalFetch;
    });

    const client = () => new MailClient("t", { retryDelayMs: 1 });

    it("formats an HTTP error as status, code, and message", async () => {
        fetchMock.enqueue(jsonResponse(
            { result: "error", error: { code: "not_authorized", description: "No access", secret: "TOPSECRET" } },
            { status: 403 },
        ));
        await assert.rejects(client().listFolders("mb"), (e) => {
            assert.strictEqual(e.message, "403 not_authorized: No access");
            return true;
        });
    });

    it("truncates the message to 200 characters and never echoes the body", async () => {
        fetchMock.enqueue(jsonResponse(
            { result: "error", error: { code: "bad", description: "x".repeat(500) }, data: { body: "PRIVATE MAIL" } },
            { status: 400 },
        ));
        await assert.rejects(client().createFolder("mb", "n"), (e) => {
            assert.strictEqual(e.message, `400 bad: ${"x".repeat(200)}`);
            assert.ok(!e.message.includes("PRIVATE"));
            return true;
        });
    });

    it("keeps the status line for a non-JSON error body", async () => {
        fetchMock.enqueue(new Response("<html>secret page</html>", { status: 500, statusText: "Internal Server Error" }));
        await assert.rejects(client().createFolder("mb", "n"), (e) => {
            assert.strictEqual(e.message, "500 api_error: Internal Server Error");
            return true;
        });
    });

    it("throws when a 200 response carries result error", async () => {
        fetchMock.enqueue(jsonResponse({ result: "error", error: { code: "folder_exists", description: "exists" } }));
        await assert.rejects(client().listFolders("mb"), /^Error: 200 folder_exists: exists$/);
    });

    it("retries a GET once on 503 and returns the second response", async () => {
        fetchMock.enqueue(new Response("", { status: 503 }), jsonResponse({ result: "success", data: [] }));
        assert.deepStrictEqual(await client().listFolders("mb"), []);
        assert.strictEqual(fetchMock.calls().length, 2);
    });

    it("retries a GET once on a network error", async () => {
        fetchMock.enqueue(new TypeError("fetch failed"), jsonResponse({ result: "success", data: [] }));
        assert.deepStrictEqual(await client().listFolders("mb"), []);
        assert.strictEqual(fetchMock.calls().length, 2);
    });

    it("retries a GET only once", async () => {
        fetchMock.enqueue(new Response("", { status: 429 }), new Response("", { status: 429 }));
        await assert.rejects(client().listFolders("mb"), /^Error: 429 api_error/);
        assert.strictEqual(fetchMock.calls().length, 2);
    });

    it("does not retry a GET on 404 or 500", async () => {
        fetchMock.enqueue(new Response("", { status: 500 }));
        await assert.rejects(client().listFolders("mb"), /500/);
        assert.strictEqual(fetchMock.calls().length, 1);
    });

    it("does not retry a POST", async () => {
        fetchMock.enqueue(new Response("", { status: 503 }));
        await assert.rejects(client().createFolder("mb", "n"), /503/);
        assert.strictEqual(fetchMock.calls().length, 1);
    });

    it("sends an abort signal with a timeout on every request", async () => {
        fetchMock.enqueue(jsonResponse({ result: "success", data: [] }));
        await client().listFolders("mb");
        assert.ok(fetchMock.calls()[0].options.signal instanceof AbortSignal);
    });

    it("aborts a request that exceeds the timeout", async () => {
        global.fetch = (url, options) => new Promise((resolve, reject) => {
            options.signal.addEventListener("abort", () => reject(options.signal.reason));
        });
        const slow = new MailClient("t", { timeoutMs: 20, retryDelayMs: 1 });
        await assert.rejects(slow.createFolder("mb", "n"), /timed out after 0 s/);
    });

    it("does not retry a GET after a timeout", async () => {
        let calls = 0;
        global.fetch = (url, options) => new Promise((resolve, reject) => {
            calls++;
            options.signal.addEventListener("abort", () => reject(options.signal.reason));
        });
        const slow = new MailClient("t", { timeoutMs: 20, retryDelayMs: 1 });
        await assert.rejects(slow.listFolders("mb"), /timed out/);
        assert.strictEqual(calls, 1);
    });

    it("names the network error code from the cause", async () => {
        const failure = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
        fetchMock.enqueue(failure(), failure());
        await assert.rejects(client().listFolders("mb"), /^Error: Request failed: ENOTFOUND$/);
    });

    it("honors Retry-After on 429 and 503 up to 10 s and cancels the first body", async () => {
        const realSetTimeout = global.setTimeout;
        const delays = [];
        global.setTimeout = (fn, ms, ...rest) => { delays.push(ms); return realSetTimeout(fn, 0, ...rest); };
        try {
            const first = new Response("busy", { status: 429, headers: { "retry-after": "3" } });
            const second = new Response("busy", { status: 503, headers: { "retry-after": "99" } });
            fetchMock.enqueue(first, jsonResponse({ result: "success", data: [] }));
            await new MailClient("t", { retryDelayMs: 1 }).listFolders("mb");
            fetchMock.enqueue(second, jsonResponse({ result: "success", data: [] }));
            await new MailClient("t", { retryDelayMs: 1 }).listFolders("mb");
            assert.ok(delays.includes(3000));
            assert.ok(delays.includes(10000));
            assert.strictEqual(first.bodyUsed || first.body.locked, true);
        } finally {
            global.setTimeout = realSetTimeout;
        }
    });

    it("stops requests when the tool call is cancelled", async () => {
        let started;
        const reached = new Promise((resolve) => { started = resolve; });
        global.fetch = (url, options) => new Promise((resolve, reject) => {
            started();
            options.signal.addEventListener("abort", () => reject(options.signal.reason));
        });
        const controller = new AbortController();
        const run = withCallDeadline(controller.signal, () => client().listFolders("mb"));
        await reached;
        controller.abort();
        await assert.rejects(run, /Request cancelled/);
    });

    it("passes the SDK cancellation signal of a tool call into fetch", async () => {
        let fetchSignal;
        let started;
        const reached = new Promise((resolve) => { started = resolve; });
        global.fetch = (url, options) => new Promise((resolve, reject) => {
            fetchSignal = options.signal;
            started();
            options.signal.addEventListener("abort", () => reject(options.signal.reason));
        });
        const { mcp, close } = await connectTools(undefined, new MailClient("t", { retryDelayMs: 1 }));
        try {
            const controller = new AbortController();
            const call = mcp.callTool({ name: "mail_list_mailboxes", arguments: {} }, undefined, { signal: controller.signal });
            await reached;
            controller.abort();
            await assert.rejects(call);
            await new Promise((resolve) => setImmediate(resolve));
            assert.strictEqual(fetchSignal.aborted, true);
        } finally {
            await close();
        }
    });

    it("gives a tool call one overall deadline across retries", async () => {
        global.fetch = (url, options) => new Promise((resolve, reject) => {
            options.signal.addEventListener("abort", () => reject(options.signal.reason));
        });
        await assert.rejects(
            withCallDeadline(undefined, () => new MailClient("t", { timeoutMs: 10_000 }).listFolders("mb"), 30),
            /deadline/,
        );
    });

    it("returns tool errors as isError results", async () => {
        fetchMock.enqueue(
            jsonResponse(MAILBOXES),
            jsonResponse({ result: "error", error: { code: "nope", description: "denied" } }, { status: 403 }),
        );
        const { mcp, close } = await connectTools();
        try {
            const result = await mcp.callTool({ name: "mail_list_folders", arguments: {} });
            assert.strictEqual(result.isError, true);
            assert.match(result.content[0].text, /403 nope: denied/);
        } finally {
            await close();
        }
    });
});
