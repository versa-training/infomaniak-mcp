import { test, describe } from "node:test";
import assert from "node:assert";
import { CalendarClient } from "../dist/calendar-client.js";

const reply = (status, body = {}) => new Response(JSON.stringify(body), { status });

async function withFetch(handler, run) {
    const original = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options) => {
        calls.push({ url: String(url), options });
        return handler(calls.length, String(url), options);
    };
    try {
        await run(calls);
    } finally {
        globalThis.fetch = original;
    }
}

describe("request helper", () => {
    test("retries a GET once on 503 and succeeds", async () => {
        await withFetch((n) => n === 1 ? reply(503) : reply(200, { result: "success", data: { calendars: [{ id: 1 }] } }), async (calls) => {
            const result = await new CalendarClient("t", { retryDelayMs: 0 }).getCalendars();
            assert.strictEqual(calls.length, 2);
            assert.strictEqual(result.data.calendars[0].id, 1);
        });
    });

    test("retries a GET once on a network error", async () => {
        await withFetch((n) => { if (n === 1) throw new TypeError("fetch failed"); return reply(200, { data: {} }); }, async (calls) => {
            await new CalendarClient("t", { retryDelayMs: 0 }).getUserProfile();
            assert.strictEqual(calls.length, 2);
        });
    });

    test("never retries a POST", async () => {
        await withFetch(() => reply(503, { error: { code: "unavailable" } }), async (calls) => {
            const client = new CalendarClient("t", { retryDelayMs: 0 });
            client.getUserProfile = async () => ({ data: { email: "a@b.c", display_name: "A", preferences: { timezone: { name: "Europe/Zurich" } } } });
            await assert.rejects(() => client.createEvent({ title: "T", start: "2026-01-01 10:00:00", end: "2026-01-01 11:00:00", calendarId: 1 }), /503 unavailable/);
            assert.strictEqual(calls.length, 1);
        });
    });

    test("sends a timeout signal", async () => {
        await withFetch(() => reply(200, { data: {} }), async (calls) => {
            await new CalendarClient("t").getUserProfile();
            assert.ok(calls[0].options.signal instanceof AbortSignal);
        });
    });

    test("getUserProfile throws on a failed response", async () => {
        await withFetch(() => reply(401, { error: { code: "unauthorized", description: "no scope" } }), async () => {
            await assert.rejects(() => new CalendarClient("t").getUserProfile(), /401 unauthorized: no scope/);
        });
    });

    test("getDefaultCalendar reports an empty calendar list", async () => {
        await withFetch(() => reply(200, { data: { calendars: [] } }), async () => {
            await assert.rejects(() => new CalendarClient("t").getDefaultCalendar(), /No calendar found/);
        });
    });

    test("getDefaultCalendar reports an API error", async () => {
        await withFetch(() => reply(500, {}), async () => {
            await assert.rejects(() => new CalendarClient("t").getDefaultCalendar(), /500/);
        });
    });
});
