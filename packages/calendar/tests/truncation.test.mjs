import { test, describe } from "node:test";
import assert from "node:assert";
import { capResult, shrinkToFit } from "../dist/shape.js";
import { CalendarClient } from "../dist/calendar-client.js";

const item = (id, size = 100) => ({ id, title: `T${id}`, untrusted_content: { description: "x".repeat(size) } });

describe("capResult", () => {
    test("drops trailing items and resumes right after the last returned one", () => {
        const items = Array.from({ length: 10 }, (_, i) => item(i, 200));
        const { structured, text } = capResult({ items, has_more: false, offset: 20, total: 30 }, 1000);
        assert.ok(text.length <= 1000);
        assert.strictEqual(structured.truncated, true);
        assert.strictEqual(structured.has_more, true);
        assert.ok(structured.items.length > 0 && structured.items.length < 10);
        assert.strictEqual(structured.next_offset, 20 + structured.items.length);
        assert.deepStrictEqual(structured.items.map(i => i.id), items.slice(0, structured.items.length).map(i => i.id));
    });

    test("a first item larger than the cap is returned with its text cut, never an empty page", () => {
        const { structured, text } = capResult({ items: [item(1, 5000), item(2, 10)], has_more: false, offset: 0 }, 1000);
        assert.ok(text.length <= 1000, `length ${text.length}`);
        assert.strictEqual(structured.items.length, 1);
        assert.strictEqual(structured.items[0].id, 1);
        assert.ok(structured.items[0].untrusted_content.description.length > 0);
        assert.strictEqual(structured.has_more, true);
        assert.strictEqual(structured.next_offset, 1);
        assert.strictEqual(structured.truncated, true);
    });

    test("a single event over the cap is cut and the serialized result fits", () => {
        const event = { id: 1, untrusted_content: { description: "d".repeat(800), location: "l".repeat(800) }, attendees: Array.from({ length: 30 }, (_, i) => ({ address: `a${i}@x.ch`, name: "n".repeat(50) })) };
        const { structured, text } = capResult({ event, warnings: ["w"] }, 1200);
        assert.ok(text.length <= 1200, `length ${text.length}`);
        assert.strictEqual(structured.truncated, true);
        assert.ok(structured.event.untrusted_content.description.length > 0);
        assert.ok("location" in structured.event.untrusted_content);
    });

    test("a result that fits is untouched", () => {
        const input = { items: [item(1, 10)], has_more: false };
        const { structured } = capResult(input, 10000);
        assert.deepStrictEqual(structured, input);
    });

    test("many small values are trimmed too, and the final text fits the cap", () => {
        const attendees = Array.from({ length: 3000 }, (_, i) => ({ address: `a${i}@x.ch`, name: `N${i}`, state: "ACCEPTED" }));
        const event = { id: 1, title: "T", meet_room_url: "https://kmeet.infomaniak.com/" + "a".repeat(30), attendees, alarms: Array.from({ length: 500 }, () => ({ action: "DISPLAY", trigger: "-PT5M" })), untrusted_content: { description: "d".repeat(200) } };
        const { structured, text } = capResult({ event }, 20000);
        assert.ok(text.length <= 20000, `length ${text.length}`);
        assert.deepStrictEqual(JSON.parse(text), structured);
        assert.strictEqual(structured.truncated, true);
        assert.ok(structured.event.attendees.length > 0 && structured.event.attendees.length < 3000);
        assert.strictEqual(structured.event.attendees_omitted, 3000 - structured.event.attendees.length);
        assert.ok(structured.shortened.some(entry => entry.startsWith("attendees")));
        assert.ok("untrusted_content" in structured.event);
    });

    test("a list item with thousands of small values still fits", () => {
        const big = { id: 1, attendees: Array.from({ length: 5000 }, (_, i) => ({ address: `a${i}@x.ch` })) };
        const { structured, text } = capResult({ items: [big, { id: 2 }], has_more: false, offset: 0 }, 10000);
        assert.ok(text.length <= 10000);
        assert.strictEqual(structured.items.length, 1);
        assert.strictEqual(structured.has_more, true);
        assert.strictEqual(structured.next_offset, 1);
    });

    test("free text is cut first with a marker, and links are not cut while free text remains", () => {
        const { structured } = capResult({ event: { id: 1, meet_room_url: "https://kmeet.infomaniak.com/" + "k".repeat(100), untrusted_content: { description: "d".repeat(5000) } } }, 1500);
        assert.ok(structured.event.untrusted_content.description.endsWith("…"));
        assert.strictEqual(structured.event.meet_room_url.length, 129);
        assert.deepStrictEqual(structured.shortened, ["untrusted_content.description"]);
    });

    test("many warnings are limited", () => {
        const warnings = Array.from({ length: 400 }, (_, i) => `Calendar ${i} could not be read: ${"x".repeat(120)}`);
        const { structured, text } = capResult({ items: [{ id: 1 }], has_more: false, offset: 0, warnings }, 5000);
        assert.ok(text.length <= 5000);
        assert.strictEqual(structured.warnings.length, 11);
    });

    test("shrinkToFit keeps the keys", () => {
        const out = shrinkToFit({ untrusted_content: { description: "x".repeat(500) }, id: 1 }, 100);
        assert.ok(JSON.stringify(out).length <= 100);
        assert.ok("untrusted_content" in out);
    });
});

async function withFetch(handler, run) {
    const original = globalThis.fetch;
    globalThis.fetch = async (url, options) => handler(new URL(String(url)), options);
    try { await run(); } finally { globalThis.fetch = original; }
}

describe("request retries and failures", () => {
    test("honors Retry-After on 429, capped, and cancels the first body", async () => {
        let n = 0; let cancelled = false;
        const started = Date.now();
        await withFetch(() => {
            n++;
            if (n === 1) {
                const res = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 429, headers: { "retry-after": "0" } });
                return res;
            }
            return new Response(JSON.stringify({ data: { calendars: [] } }), { status: 200 });
        }, async () => {
            await new CalendarClient("t", { retryDelayMs: 5000 }).getCalendars();
        });
        assert.strictEqual(n, 2);
        assert.ok(Date.now() - started < 2000, "Retry-After 0 overrides the base delay");
        assert.ok(cancelled);
    });

    test("caps a long Retry-After at 10 s", async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        let n = 0;
        await withFetch(() => {
            n++;
            return n === 1
                ? new Response("", { status: 503, headers: { "retry-after": "3600" } })
                : new Response(JSON.stringify({ data: { calendars: [] } }), { status: 200 });
        }, async () => {
            const pending = new CalendarClient("t", { retryDelayMs: 0 }).getCalendars();
            for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
            assert.strictEqual(n, 1);
            t.mock.timers.tick(9999);
            for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
            assert.strictEqual(n, 1, "still waiting just before the cap");
            t.mock.timers.tick(1);
            await pending;
            assert.strictEqual(n, 2);
        });
    });

    test("a POST is retried once on 429 only", async () => {
        const statuses = [];
        const run = async (status) => {
            let n = 0;
            await withFetch(() => { n++; return n === 1 ? new Response("{}", { status, headers: { "retry-after": "0" } }) : new Response("{}", { status: 200 }); }, async () => {
                const client = new CalendarClient("t", { retryDelayMs: 0 });
                await client.request("https://api.infomaniak.com/x", { method: "POST", body: "{}" }, "write").catch(() => undefined);
            });
            statuses.push(n);
        };
        await run(429);
        await run(503);
        assert.deepStrictEqual(statuses, [2, 1]);
    });

    test("a timeout is not retried", async () => {
        let n = 0;
        await withFetch(() => { n++; throw new DOMException("t", "TimeoutError"); }, async () => {
            await assert.rejects(() => new CalendarClient("t", { retryDelayMs: 0 }).getCalendars(), /timed out after 30 s/);
        });
        assert.strictEqual(n, 1);
    });

    test("a cancelled tool call stops its requests", async () => {
        const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
        const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
        const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
        const { registerTools } = await import("../dist/tools.js");
        let sawAbort;
        const seen = new Promise(resolve => { sawAbort = resolve; });
        await withFetch((url, options) => new Promise((resolve, reject) => {
            options.signal.addEventListener("abort", () => { sawAbort(true); reject(options.signal.reason); });
        }), async () => {
            const server = new McpServer({ name: "t", version: "0" });
            registerTools(server, new CalendarClient("t", { retryDelayMs: 0 }));
            const client = new Client({ name: "c", version: "0" });
            const [a, b] = InMemoryTransport.createLinkedPair();
            await Promise.all([server.connect(a), client.connect(b)]);
            const controller = new AbortController();
            const call = client.callTool({ name: "calendar_list_calendars", arguments: {} }, undefined, { signal: controller.signal }).catch(() => undefined);
            await new Promise(resolve => setTimeout(resolve, 50));
            controller.abort();
            assert.strictEqual(await seen, true);
            await call;
            await client.close();
        });
    });

    test("reports the network error code and timeouts", async () => {
        const cause = Object.assign(new Error("getaddrinfo"), { code: "ENOTFOUND" });
        await withFetch(() => { throw Object.assign(new TypeError("fetch failed"), { cause }); }, async () => {
            await assert.rejects(() => new CalendarClient("t", { retryDelayMs: 0 }).getCalendars(), /Calendar calendar listing failed: ENOTFOUND$/);
        });
        await withFetch(() => { throw new DOMException("t", "TimeoutError"); }, async () => {
            await assert.rejects(() => new CalendarClient("t", { retryDelayMs: 0 }).getCalendars(), /timed out after 30 s$/);
        });
    });

    test("a 204 or empty body is an empty object", async () => {
        await withFetch(() => new Response(null, { status: 204 }), async () => {
            assert.deepStrictEqual(await new CalendarClient("t").deleteEvent(1, 2), {});
        });
        await withFetch(() => new Response("", { status: 200 }), async () => {
            assert.deepStrictEqual(await new CalendarClient("t").deleteEvent(1, 2), {});
        });
    });
});
