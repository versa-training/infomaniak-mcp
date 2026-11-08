import { test, describe } from "node:test";
import assert from "node:assert";
import { CalendarClient } from "../dist/calendar-client.js";
import { findFreeSlots } from "../dist/slots.js";
import { convertWall } from "../dist/dates.js";

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
        body = options?.body ? JSON.parse(options.body) : null;
        return new Response(JSON.stringify({ result: "success", data: { id: 1 } }), { status: 200 });
    };
    try {
        await run();
    } finally {
        globalThis.fetch = original;
    }
    return body;
}

const base = { title: "T", start: "2026-10-20 09:00:00", end: "2026-10-20 10:00:00" };
const existing = { id: 1, calendar_id: 1, title: "T", start: "2026-10-20 09:00:00", end: "2026-10-20 10:00:00", timezone_start: "Europe/Zurich", timezone_end: "Europe/Zurich", attendees: [], fullday: false, location: "Old", private: true, freebusy: "free", alarms: [{ action: "DISPLAY", trigger: "-PT5M" }] };

describe("event fields", () => {
    test("create sends location, reminders, private, show_as", async () => {
        const body = await capture(() => clientWith().createEvent({ ...base, location: "Room 1", remindersMinutes: [60, 15, 15], private: true, showAs: "free" }));
        assert.strictEqual(body.location, "Room 1");
        assert.deepStrictEqual(body.alarms, [{ action: "DISPLAY", trigger: "-PT15M" }, { action: "DISPLAY", trigger: "-PT60M" }]);
        assert.strictEqual(body.private, true);
        assert.strictEqual(body.freebusy, "free");
    });

    test("create defaults stay busy and public", async () => {
        const body = await capture(() => clientWith().createEvent(base));
        assert.strictEqual(body.freebusy, "busy");
        assert.strictEqual(body.private, false);
        assert.strictEqual(body.location, undefined);
        assert.strictEqual(body.alarms, undefined);
    });

    test("create with an IANA timezone reads naive times in that zone", async () => {
        const body = await capture(() => clientWith().createEvent({ ...base, timezone: "America/New_York", start: "2026-10-20T09:00:00Z", end: "2026-10-20T10:00:00Z" }));
        assert.strictEqual(body.timezone_start, "America/New_York");
        assert.strictEqual(body.timezone_end, "America/New_York");
        assert.strictEqual(body.start, "2026-10-20 05:00:00");
    });

    test("an invalid timezone is rejected", async () => {
        await assert.rejects(() => clientWith().createEvent({ ...base, timezone: "Mars/Base" }), /Invalid timezone/);
    });

    test("update keeps stored values and changes only what is given", async () => {
        const kept = await capture(() => clientWith(existing).updateEvent("1", { title: "New" }));
        assert.strictEqual(kept.location, "Old");
        assert.strictEqual(kept.private, true);
        assert.strictEqual(kept.freebusy, "free");
        assert.deepStrictEqual(kept.alarms, existing.alarms);
        const changed = await capture(() => clientWith(existing).updateEvent("1", { location: "New", private: false, showAs: "tentative", remindersMinutes: [] }));
        assert.strictEqual(changed.location, "New");
        assert.strictEqual(changed.private, false);
        assert.strictEqual(changed.freebusy, "tentative");
        assert.deepStrictEqual(changed.alarms, []);
        const cleared = await capture(() => clientWith(existing).updateEvent("1", { location: "" }));
        assert.strictEqual(cleared.location, "");
        assert.ok("location" in cleared);
    });
});

describe("free slots", () => {
    const day = "2026-10-19"; // Monday
    test("subtracts busy intervals from working hours", () => {
        const slots = findFreeSlots({ busy: [{ start: `${day} 10:00:00`, end: `${day} 11:00:00` }, { start: `${day} 10:30:00`, end: `${day} 12:00:00` }, { start: `${day} 15:00:00`, end: `${day} 18:00:00` }], from: day, to: day, durationMinutes: 30, dayStart: "09:00", dayEnd: "17:00", includeWeekends: false });
        assert.deepStrictEqual(slots.map(s => [s.start.slice(11, 16), s.end.slice(11, 16), s.minutes]), [["09:00", "10:00", 60], ["12:00", "15:00", 180]]);
    });

    test("drops gaps shorter than the duration and skips weekends", () => {
        const sat = "2026-10-24";
        const none = findFreeSlots({ busy: [{ start: `${day} 09:00:00`, end: `${day} 16:45:00` }], from: day, to: day, durationMinutes: 30, dayStart: "09:00", dayEnd: "17:00", includeWeekends: false });
        assert.deepStrictEqual(none, []);
        assert.strictEqual(findFreeSlots({ busy: [], from: sat, to: sat, durationMinutes: 30, dayStart: "09:00", dayEnd: "17:00", includeWeekends: false }).length, 0);
        assert.strictEqual(findFreeSlots({ busy: [], from: sat, to: sat, durationMinutes: 30, dayStart: "09:00", dayEnd: "17:00", includeWeekends: true }).length, 1);
    });

    test("rejects a range over 62 days", () => {
        assert.throws(() => findFreeSlots({ busy: [], from: "2026-01-01", to: "2026-06-01", durationMinutes: 30, dayStart: "09:00", dayEnd: "17:00", includeWeekends: false }), /62 days/);
    });

    test("converts wall clocks between zones", () => {
        assert.strictEqual(convertWall("2026-10-20 09:00:00", "America/New_York", "Europe/Zurich"), "2026-10-20 15:00:00");
    });

    test("findFreeSlots on the client lists every calendar and ignores free and all-day events", async () => {
        const original = globalThis.fetch;
        globalThis.fetch = async (url) => {
            const u = new URL(String(url));
            const data = u.pathname.endsWith("/pim/calendar")
                ? { calendars: [{ id: 1, name: "A" }]}
                : [
                    { id: 1, start: "2026-10-19 09:00:00", end: "2026-10-19 10:00:00", timezone_start: "Europe/Zurich" },
                    { id: 2, start: "2026-10-19 10:00:00", end: "2026-10-19 12:00:00", freebusy: "free" },
                    { id: 3, start: "2026-10-19 00:00:00", end: "2026-10-19 23:59:59", fullday: true },
                    { id: 4, start: "2026-10-19T08:00:00Z", end: "2026-10-19T09:00:00Z" },
                ];
            return new Response(JSON.stringify({ result: "success", data }), { status: 200 });
        };
        try {
            const { timezone, slots } = await clientWith().findFreeSlots({ from: "2026-10-19", to: "2026-10-19", durationMinutes: 60, now: Date.parse("2026-10-19T00:00:00+02:00") });
            assert.strictEqual(timezone, "Europe/Zurich");
            assert.deepStrictEqual(slots.map(s => s.start.slice(11, 16)), ["11:00"]);
        } finally {
            globalThis.fetch = original;
        }
    });
});

describe("resources", () => {
    test("listBookableResources reports API errors and sends bookable_resource_id", async () => {
        const original = globalThis.fetch;
        globalThis.fetch = async () => new Response("{}", { status: 403 });
        try {
            await assert.rejects(() => clientWith().listBookableResources(), /403/);
        } finally {
            globalThis.fetch = original;
        }
        const body = await capture(() => clientWith().createEvent({ ...base, bookableResourceId: "res-1" }));
        assert.strictEqual(body.bookable_resource_id, "res-1");
        const kept = await capture(() => clientWith({ ...existing, bookable_resource_id: "res-9" }).updateEvent("1", { title: "x" }));
        assert.strictEqual(kept.bookable_resource_id, "res-9");
    });
});
