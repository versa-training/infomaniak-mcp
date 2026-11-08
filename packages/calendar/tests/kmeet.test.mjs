import { test, describe } from "node:test";
import assert from "node:assert";
import { CalendarClient } from "../dist/calendar-client.js";

const profile = { data: { email: "me@x.ch", display_name: "Me", preferences: { timezone: { name: "Europe/Zurich" } } } };

function clientWith(options) {
    const client = new CalendarClient("t", options);
    client.getUserProfile = async () => profile;
    client.getDefaultCalendar = async () => ({ id: 4 });
    client.getContacts = async () => ({ data: [] });
    client.getProfileEmails = async () => ({ data: [] });
    return client;
}

async function withFetch(run) {
    const original = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options) => {
        const u = new URL(String(url));
        calls.push({ path: u.pathname, method: options?.method ?? "GET", body: options?.body ? JSON.parse(options.body) : undefined });
        if (u.pathname === "/1/kmeet/rooms") return new Response(JSON.stringify({ result: "success", data: { id: 1, event_id: 55 } }), { status: 200 });
        if (u.pathname.endsWith("/pim/event/55")) return new Response(JSON.stringify({ result: "success", data: { id: 55, title: "Sync", meet_room_url: "https://kmeet.infomaniak.com/abc" } }), { status: 200 });
        if (u.pathname.startsWith("/1/calendar/pim/event")) return new Response(JSON.stringify({ result: "success", data: { id: 1 } }), { status: 200 });
        return new Response("{}", { status: 404 });
    };
    try { await run(calls); } finally { globalThis.fetch = original; }
}

const base = { title: "Sync", start: "2026-10-20 09:00:00", end: "2026-10-20 10:00:00" };

describe("with_kmeet", () => {
    test("plans the conference through /1/kmeet/rooms and returns the created event", async () => {
        await withFetch(async (calls) => {
            const result = await clientWith({ kmeetHostname: "meet.example.ch" }).createEvent({ ...base, withKmeet: true, description: "d" });
            const post = calls.find(c => c.method === "POST");
            assert.strictEqual(post.path, "/1/kmeet/rooms");
            assert.deepStrictEqual({ ...post.body, options: undefined, attendees: undefined }, {
                calendar_id: 4, starting_at: "2026-10-20 09:00:00", ending_at: "2026-10-20 10:00:00", timezone: "Europe/Zurich",
                hostname: "meet.example.ch", title: "Sync", description: "d", options: undefined, attendees: undefined,
            });
            assert.strictEqual(post.body.options.subject, "Sync");
            assert.strictEqual(post.body.options.password_enabled, false);
            assert.strictEqual(result.data.meet_room_url, "https://kmeet.infomaniak.com/abc");
        });
    });

    test("whole days are rejected", async () => {
        await withFetch(async (calls) => {
            await assert.rejects(() => clientWith().createEvent({ title: "T", start: "2026-10-20", end: "2026-10-21", withKmeet: true }), /start and end time/);
            assert.strictEqual(calls.length, 0);
        });
    });

    test("options at their default value do not block the room endpoint", async () => {
        await withFetch(async (calls) => {
            await clientWith().createEvent({ ...base, withKmeet: true, private: false, showAs: "busy", remindersMinutes: [], rrule: "", location: "", allDay: false });
            assert.deepStrictEqual(calls.map(c => c.path), ["/1/kmeet/rooms", "/1/calendar/pim/event/55"]);
        });
    });

    test("recurrence, location, reminders, or rooms create a normal event with a generated link", async () => {
        await withFetch(async (calls) => {
            const result = await clientWith({ kmeetHostname: "meet.example.ch" }).createEvent({ ...base, withKmeet: true, rrule: "FREQ=WEEKLY", location: "x", remindersMinutes: [10] });
            const post = calls.find(c => c.method === "POST");
            assert.strictEqual(post.path, "/1/calendar/pim/event");
            assert.match(post.body.meet_room_url, /^https:\/\/meet\.example\.ch\/[A-Za-z0-9]{12}$/);
            assert.strictEqual(post.body.rrule, "FREQ=WEEKLY");
            assert.match(result.warnings[0], /generated locally/);
            await assert.rejects(() => clientWith().createEvent({ ...base, withKmeet: true, private: true, kmeetPassword: "secret1" }), /cannot be combined with private/);
        });
    });

    test("update adds a generated link only when the event has none", async () => {
        const existing = { id: 5, calendar_id: 4, title: "T", start: "2026-10-20 09:00:00", end: "2026-10-20 10:00:00", timezone_start: "Europe/Zurich", timezone_end: "Europe/Zurich", attendees: [] };
        for (const [stored, expected] of [[undefined, /^https:\/\/kmeet\.infomaniak\.com\/[A-Za-z0-9]{12}$/], ["https://kmeet.infomaniak.com/old", /old$/]]) {
            const client = clientWith();
            client.fetchEvent = async () => ({ data: { ...existing, meet_room_url: stored } });
            await withFetch(async (calls) => {
                await client.updateEvent(5, { withKmeet: true });
                assert.match(calls.find(c => c.method === "PUT").body.meet_room_url, expected);
            });
        }
    });

    test("lobby defaults on for invited people, and lobby and password are sent when given", async () => {
        await withFetch(async (calls) => {
            await clientWith().createEvent({ ...base, withKmeet: true, attendees: ["a@x.ch"], notifyAttendees: true });
            assert.strictEqual(calls.find(c => c.method === "POST").body.options.lobby_enabled, true);
        });
        await withFetch(async (calls) => {
            await clientWith().createEvent({ ...base, withKmeet: true, kmeetLobby: false, kmeetPassword: "secret1" });
            const options = calls.find(c => c.method === "POST").body.options;
            assert.deepStrictEqual([options.lobby_enabled, options.password_enabled, options.password], [false, true, "secret1"]);
            await assert.rejects(() => clientWith().createEvent({ ...base, kmeetLobby: true }), /need with_kmeet/);
        });
    });

    test("attendees need notify_attendees, and are sent in the documented shape", async () => {
        await withFetch(async (calls) => {
            await assert.rejects(() => clientWith().createEvent({ ...base, withKmeet: true, attendees: ["a@x.ch"] }), /notify_attendees/);
            await clientWith().createEvent({ ...base, withKmeet: true, attendees: ["a@x.ch"], notifyAttendees: true });
            const post = calls.find(c => c.method === "POST");
            assert.deepStrictEqual(post.body.attendees.map(a => [a.address, a.organizer, a.state]), [["a@x.ch", false, "NEEDS-ACTION"], ["me@x.ch", true, "ACCEPTED"]]);
        });
    });

    test("a time zone given in another spelling is sent in its canonical form", async () => {
        await withFetch(async (calls) => {
            await clientWith().createEvent({ ...base, withKmeet: true, timezone: "Europe/zurich" });
            assert.strictEqual(calls.find(c => c.method === "POST").body.timezone, "Europe/Zurich");
        });
    });

    test("without with_kmeet the normal event endpoint is used", async () => {
        await withFetch(async (calls) => {
            const original = globalThis.fetch;
            globalThis.fetch = async (url, options) => { calls.push({ path: new URL(String(url)).pathname }); return new Response(JSON.stringify({ data: { id: 1 } }), { status: 200 }); };
            try { await clientWith().createEvent(base); } finally { globalThis.fetch = original; }
            assert.deepStrictEqual(calls.map(c => c.path), ["/1/calendar/pim/event"]);
        });
    });
});
