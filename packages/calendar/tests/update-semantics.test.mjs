import { test, describe } from "node:test";
import assert from "node:assert";
import { CalendarClient } from "../dist/calendar-client.js";

const profile = { data: { email: "me@x.ch", display_name: "Me", preferences: { timezone: { name: "Europe/Zurich" } } } };

function clientWith(existing) {
    const client = new CalendarClient("t");
    client.getUserProfile = async () => profile;
    client.getDefaultCalendar = async () => ({ id: 1 });
    client.getContacts = async () => ({ data: [] });
    client.getProfileEmails = async () => ({ data: [] });
    client.fetchEvent = async () => ({ data: existing });
    return client;
}

async function capture(run) {
    const original = globalThis.fetch;
    let body;
    globalThis.fetch = async (url, options) => {
        body = JSON.parse(options.body);
        return new Response(JSON.stringify({ result: "success", data: { id: 1 } }), { status: 200 });
    };
    try { await run(); } finally { globalThis.fetch = original; }
    return body;
}

const timed = { id: 1, calendar_id: 1, title: "T", start: "2026-10-20 09:00:00", end: "2026-10-20 10:00:00", timezone_start: "Europe/Zurich", timezone_end: "Europe/Zurich", fullday: false, bookable_resource_id: "room-1" };

describe("update semantics", () => {
    test("a title-only update of an all-day event sends the stored dates unchanged", async () => {
        const exclusive = { ...timed, fullday: true, start: "2026-10-20T00:00:00+02:00", end: "2026-10-21T00:00:00+02:00" };
        const body = await capture(() => clientWith(exclusive).updateEvent("1", { title: "New" }));
        assert.strictEqual(body.start, "2026-10-20 00:00:00");
        assert.strictEqual(body.end, "2026-10-21 00:00:00");
        assert.strictEqual(body.fullday, true);
    });

    test("an all-day update normalizes only the dates the caller gave", async () => {
        const stored = { ...timed, fullday: true, start: "2026-10-20 00:00:00", end: "2026-10-21 00:00:00" };
        const body = await capture(() => clientWith(stored).updateEvent("1", { end: "2026-10-23" }));
        assert.strictEqual(body.start, "2026-10-20 00:00:00");
        assert.strictEqual(body.end, "2026-10-23 23:59:59");
    });

    test("a time zone change without start and end keeps the instant", async () => {
        const body = await capture(() => clientWith(timed).updateEvent("1", { timezone: "America/New_York" }));
        assert.strictEqual(body.timezone_start, "America/New_York");
        assert.strictEqual(body.start, "2026-10-20 03:00:00");
        assert.strictEqual(body.end, "2026-10-20 04:00:00");
    });

    test("a time zone change leaves all-day dates on their day", async () => {
        const stored = { ...timed, fullday: true, start: "2026-10-20 00:00:00", end: "2026-10-20 23:59:59" };
        const body = await capture(() => clientWith(stored).updateEvent("1", { timezone: "America/New_York" }));
        assert.strictEqual(body.start, "2026-10-20 00:00:00");
        assert.strictEqual(body.end, "2026-10-20 23:59:59");
    });

    test("an empty bookable_resource_id releases the room, and omitting it keeps the room", async () => {
        const released = await capture(() => clientWith(timed).updateEvent("1", { bookableResourceId: "" }));
        assert.strictEqual(released.bookable_resource_id, null);
        const kept = await capture(() => clientWith(timed).updateEvent("1", { title: "x" }));
        assert.strictEqual(kept.bookable_resource_id, "room-1");
    });

    test("imip_request follows notify_attendees", async () => {
        const on = await capture(() => clientWith(timed).updateEvent("1", { title: "x", notifyAttendees: true }));
        assert.strictEqual(on.imip_request, true);
        const off = await capture(() => clientWith(timed).updateEvent("1", { title: "x" }));
        assert.strictEqual(off.imip_request, false);
    });

    test("update and delete read the raw event without the resource lookup", async () => {
        const original = globalThis.fetch;
        const urls = [];
        globalThis.fetch = async (url, options) => {
            urls.push(`${options?.method ?? "GET"} ${new URL(String(url)).pathname}`);
            return new Response(JSON.stringify({ result: "success", data: { ...timed } }), { status: 200 });
        };
        try {
            const client = new CalendarClient("t");
            client.getUserProfile = async () => profile;
            await client.updateEvent("1", { title: "x" });
            await client.deleteEvent("1");
        } finally { globalThis.fetch = original; }
        assert.ok(!urls.some(u => u.includes("bookable-resources")), urls.join(", "));
    });

    test("create reads the calendar and the profile in parallel", async () => {
        const client = clientWith(timed);
        let open = 0, peak = 0;
        const slow = (value) => async () => { open++; peak = Math.max(peak, open); await new Promise(r => setTimeout(r, 10)); open--; return value; };
        client.getDefaultCalendar = slow({ id: 1 });
        client.getUserProfile = slow(profile);
        await capture(() => client.createEvent({ title: "T", start: "2026-10-20 09:00:00", end: "2026-10-20 10:00:00" }));
        assert.strictEqual(peak, 2);
    });
});
