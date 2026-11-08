import { test, describe } from "node:test";
import assert from "node:assert";
import { CalendarClient } from "../dist/calendar-client.js";
import { classifyWallClock } from "../dist/dates.js";

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
    const seen = { url: null, body: null };
    globalThis.fetch = async (url, options) => {
        seen.url = String(url);
        seen.body = options?.body ? JSON.parse(options.body) : null;
        return new Response(JSON.stringify({ result: "success", data: options?.method ? { id: 1 } : [] }), { status: 200 });
    };
    try {
        seen.result = await run();
    } finally {
        globalThis.fetch = original;
    }
    return seen;
}

const existing = { id: 1, calendar_id: 1, title: "T", start: "2026-02-01T09:00:00+01:00", end: "2026-02-01T10:30:00+01:00", timezone_start: "Europe/Zurich", timezone_end: "Europe/Zurich", attendees: [], fullday: false };

describe("date handling", () => {
    test("date-only to covers the whole day", async () => {
        const { url } = await capture(() => clientWith().listEvents("2026-10-18", "2026-10-18", 1));
        const params = new URL(url).searchParams;
        assert.strictEqual(params.get("from"), "2026-10-18 00:00:00");
        assert.strictEqual(params.get("to"), "2026-10-19 00:00:00");
    });

    test("a datetime to is used as given", async () => {
        const { url } = await capture(() => clientWith().listEvents("2026-10-18", "2026-10-18 12:00", 1));
        assert.strictEqual(new URL(url).searchParams.get("to"), "2026-10-18 12:00:00");
    });

    test("from after to is rejected", async () => {
        await assert.rejects(() => clientWith().listEvents("2026-10-19", "2026-10-18 12:00", 1), /from must not be after to/);
    });

    test("an unparseable date names the field and formats", async () => {
        await assert.rejects(() => clientWith().listEvents("tomorrow", "2026-10-18", 1), /Invalid from "tomorrow": use YYYY-MM-DD/);
        await assert.rejects(() => clientWith().createEvent({ title: "T", start: "2026-10-18 09:00", end: "soon" }), /Invalid end "soon"/);
    });

    test("update keeps the unchanged times when the API returns offsets", async () => {
        const { body } = await capture(() => clientWith({ ...existing, start: "2026-02-01T08:00:00Z", end: "2026-02-01T09:30:00Z" }).updateEvent("1", { title: "New" }));
        assert.strictEqual(body.start, "2026-02-01 09:00:00");
        assert.strictEqual(body.end, "2026-02-01 10:30:00");
    });

    test("update of only start shifts the end by the original duration", async () => {
        const { body } = await capture(() => clientWith(existing).updateEvent("1", { start: "2026-02-03 14:00:00" }));
        assert.strictEqual(body.start, "2026-02-03 14:00:00");
        assert.strictEqual(body.end, "2026-02-03 15:30:00");
    });

    test("update of only end keeps the start", async () => {
        const { body } = await capture(() => clientWith(existing).updateEvent("1", { end: "2026-02-01 12:00:00" }));
        assert.strictEqual(body.start, "2026-02-01 09:00:00");
        assert.strictEqual(body.end, "2026-02-01 12:00:00");
    });

    test("an end that is not after the start is rejected on create and update", async () => {
        await assert.rejects(() => clientWith().createEvent({ title: "T", start: "2026-10-18 11:00", end: "2026-10-18 10:00" }), /end must be after start/);
        await assert.rejects(() => clientWith().createEvent({ title: "T", start: "2026-10-18 10:00", end: "2026-10-18 10:00" }), /end must be after start/);
        await assert.rejects(() => clientWith(existing).updateEvent("1", { end: "2026-02-01 08:00:00" }), /end must be after start/);
    });

    test("a nonexistent local time in the spring-forward gap is rejected", async () => {
        assert.strictEqual(classifyWallClock("2026-03-29 02:30:00", "Europe/Zurich"), "gap");
        await assert.rejects(() => clientWith().createEvent({ title: "T", start: "2026-03-29 02:30", end: "2026-03-29 04:00" }), /does not exist in Europe\/Zurich/);
    });

    test("an ambiguous local time in the fall-back overlap returns a warning", async () => {
        assert.strictEqual(classifyWallClock("2026-10-25 02:30:00", "Europe/Zurich"), "ambiguous");
        const { result } = await capture(() => clientWith().createEvent({ title: "T", start: "2026-10-25 02:30", end: "2026-10-25 03:30" }));
        assert.match(result.warnings[0], /happens twice/);
    });

    test("ordinary times are fine", () => {
        assert.strictEqual(classifyWallClock("2026-10-18 09:00:00", "Europe/Zurich"), "ok");
        assert.strictEqual(classifyWallClock("2026-10-18 09:00:00", "UTC"), "ok");
    });
});
