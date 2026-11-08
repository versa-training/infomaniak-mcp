import { test, describe } from "node:test";
import assert from "node:assert";
import { CalendarClient } from "../dist/calendar-client.js";

const json = (data) => new Response(JSON.stringify({ result: "success", data }), { status: 200 });

async function withFetch(handler, run) {
    const original = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options) => {
        calls.push({ url: String(url), method: options?.method ?? "GET" });
        return handler(new URL(String(url)), options);
    };
    try {
        await run(calls);
    } finally {
        globalThis.fetch = original;
    }
}

const router = (url) => {
    if (url.pathname.endsWith("/profile")) return json({ email: "me@x.ch", display_name: "Me", preferences: { timezone: { name: "Europe/Zurich" } } });
    if (url.pathname.endsWith("/pim/calendar")) return json({ calendars: [{ id: 1, name: "Own", default: true }, { id: 2, name: "Shared" }] });
    if (url.pathname.endsWith("/pim/event/77")) return json({ id: 77, calendar_id: 2, title: "Shared event", start: "2026-10-20 09:00:00", end: "2026-10-20 10:00:00" });
    if (url.pathname.endsWith("/pim/event")) {
        const id = url.searchParams.get("calendar_id");
        return json(id === "1" ? [{ id: 10, calendar_id: 1, title: "B", start: "2026-10-20 11:00:00" }] : [{ id: 20, calendar_id: 2, title: "A", start: "2026-10-20 08:00:00" }]);
    }
    return json({});
};

describe("multiple calendars", () => {
    test("listEvents without calendar_id queries every calendar, tags names, sorts by start", async () => {
        await withFetch(router, async (calls) => {
            const result = await new CalendarClient("t").listEvents("2026-10-20", "2026-10-20");
            assert.deepStrictEqual(result.data.map(e => [e.id, e.calendar_name]), [[20, "Shared"], [10, "Own"]]);
            const queried = calls.filter(c => c.url.includes("/pim/event?")).map(c => new URL(c.url).searchParams.get("calendar_id")).sort();
            assert.deepStrictEqual(queried, ["1", "2"]);
        });
    });

    test("listEvents with calendar_id queries only that calendar", async () => {
        await withFetch(router, async (calls) => {
            const result = await new CalendarClient("t").listEvents("2026-10-20", "2026-10-20", 2);
            assert.deepStrictEqual(result.data.map(e => [e.id, e.calendar_name]), [[20, "Shared"]]);
            const queried = calls.filter(c => c.url.includes("/pim/event?")).map(c => new URL(c.url).searchParams.get("calendar_id"));
            assert.deepStrictEqual(queried, ["2"]);
        });
    });

    test("deleteEvent without calendar_id uses the event's own calendar", async () => {
        await withFetch(router, async (calls) => {
            await new CalendarClient("t").deleteEvent(77);
            const del = calls.find(c => c.method === "DELETE");
            assert.strictEqual(new URL(del.url).searchParams.get("calendar_id"), "2");
        });
    });

    test("deleteEvent with calendar_id skips the lookup", async () => {
        await withFetch(router, async (calls) => {
            await new CalendarClient("t").deleteEvent(77, 5);
            assert.strictEqual(calls.length, 1);
            assert.strictEqual(new URL(calls[0].url).searchParams.get("calendar_id"), "5");
        });
    });
});
