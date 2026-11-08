import { test, describe } from "node:test";
import assert from "node:assert";
import { CalendarClient } from "../dist/calendar-client.js";

const profile = { data: { email: "me@x.ch", display_name: "Me", preferences: { timezone: { name: "Europe/Zurich" } } } };

function clientWith(existing) {
    const client = new CalendarClient("t");
    client.getUserProfile = async () => profile;
    client.getDefaultCalendar = async () => ({ id: 1 });
    client.getContacts = async () => ({ data: [] });
    if (existing) client.fetchEvent = async () => ({ data: existing });
    return client;
}

async function capture(run) {
    const original = globalThis.fetch;
    let body;
    globalThis.fetch = async (url, options) => {
        body = JSON.parse(options.body);
        return new Response(JSON.stringify({ result: "success", data: { id: 1 } }), { status: 200 });
    };
    try {
        await run();
    } finally {
        globalThis.fetch = original;
    }
    return body;
}

const timed = { id: 1, calendar_id: 1, title: "T", start: "2026-10-20 09:00:00", end: "2026-10-20 10:00:00", timezone_start: "Europe/Zurich", timezone_end: "Europe/Zurich", fullday: false };
const allDay = { ...timed, start: "2026-10-20 00:00:00", end: "2026-10-20 23:59:59", fullday: true };

describe("all-day events", () => {
    test("create with all_day true uses the dates only", async () => {
        const body = await capture(() => clientWith().createEvent({ title: "T", start: "2026-10-20T14:00:00", end: "2026-10-21T15:00:00", allDay: true }));
        assert.strictEqual(body.fullday, true);
        assert.strictEqual(body.start, "2026-10-20 00:00:00");
        assert.strictEqual(body.end, "2026-10-21 23:59:59");
    });

    test("create with date-only start and end infers all-day, one day when equal", async () => {
        const body = await capture(() => clientWith().createEvent({ title: "T", start: "2026-10-20", end: "2026-10-20" }));
        assert.strictEqual(body.fullday, true);
        assert.strictEqual(body.end, "2026-10-20 23:59:59");
    });

    test("create with all_day false keeps a timed event for date-only input", async () => {
        const body = await capture(() => clientWith().createEvent({ title: "T", start: "2026-10-20", end: "2026-10-21", allDay: false }));
        assert.strictEqual(body.fullday, false);
        assert.strictEqual(body.end, "2026-10-21 00:00:00");
    });

    test("create without all_day and with times stays timed", async () => {
        const body = await capture(() => clientWith().createEvent({ title: "T", start: "2026-10-20 09:00:00", end: "2026-10-20 10:00:00" }));
        assert.strictEqual(body.fullday, false);
    });

    test("update switches a timed event to all-day without new dates", async () => {
        const body = await capture(() => clientWith(timed).updateEvent("1", { allDay: true }));
        assert.strictEqual(body.fullday, true);
        assert.strictEqual(body.start, "2026-10-20 00:00:00");
        assert.strictEqual(body.end, "2026-10-20 23:59:59");
    });

    test("update keeps an all-day event all-day when only the title changes", async () => {
        const body = await capture(() => clientWith(allDay).updateEvent("1", { title: "New" }));
        assert.strictEqual(body.fullday, true);
        assert.strictEqual(body.start, "2026-10-20 00:00:00");
        assert.strictEqual(body.end, "2026-10-20 23:59:59");
    });

    test("update keeps an all-day event all-day when a datetime is sent", async () => {
        const body = await capture(() => clientWith(allDay).updateEvent("1", { start: "2026-10-22T10:00:00", end: "2026-10-22T11:00:00" }));
        assert.strictEqual(body.fullday, true);
        assert.strictEqual(body.start, "2026-10-22 00:00:00");
    });

    test("update turns an all-day event into a timed event when given times", async () => {
        const body = await capture(() => clientWith(allDay).updateEvent("1", { allDay: false, start: "2026-10-20 09:00:00", end: "2026-10-20 10:00:00" }));
        assert.strictEqual(body.fullday, false);
        assert.strictEqual(body.start, "2026-10-20 09:00:00");
    });

    test("update refuses all_day false on an all-day event without start and end", async () => {
        await assert.rejects(() => clientWith(allDay).updateEvent("1", { allDay: false }), /start and end are required/);
    });
});
