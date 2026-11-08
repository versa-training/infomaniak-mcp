import { test, describe } from "node:test";
import assert from "node:assert";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CalendarClient } from "../dist/calendar-client.js";
import { registerTools } from "../dist/tools.js";
import { findFreeSlots } from "../dist/slots.js";

const json = (data, extra = {}) => new Response(JSON.stringify({ result: "success", data, ...extra }), { status: 200 });
const profileData = { email: "me@x.ch", display_name: "Me", preferences: { timezone: { name: "Europe/Zurich" } } };

async function withFetch(handler, run) {
    const original = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options) => {
        calls.push({ url: String(url), method: options?.method ?? "GET" });
        return handler(new URL(String(url)), options);
    };
    try { await run(calls); } finally { globalThis.fetch = original; }
}

const base = (events) => (url) => {
    if (url.pathname.endsWith("/profile/emails")) return json([{ email: "alias@x.ch" }]);
    if (url.pathname.endsWith("/profile")) return json(profileData);
    if (url.pathname.endsWith("/pim/calendar")) return json({ calendars: [{ id: 1, name: "Own", default: true }, { id: 2, name: "Shared" }] });
    if (url.pathname.endsWith("/pim/event")) return events(url);
    return json({});
};

describe("listing across calendars", () => {
    test("a calendar that answers 403 becomes a warning and the others still list", async () => {
        await withFetch(base((url) => url.searchParams.get("calendar_id") === "2"
            ? new Response(JSON.stringify({ error: { code: "forbidden" } }), { status: 403 })
            : json([{ id: 10, calendar_id: 1, title: "A", start: "2026-10-20 09:00:00", end: "2026-10-20 10:00:00" }])), async () => {
            const result = await new CalendarClient("t").listEvents("2026-10-20", "2026-10-20");
            assert.deepStrictEqual(result.data.map(e => e.id), [10]);
            assert.strictEqual(result.warnings.length, 1);
            assert.match(result.warnings[0], /Calendar 2 could not be read.*403 forbidden/);
        });
    });

    test("every calendar failing is an error", async () => {
        await withFetch(base(() => new Response("{}", { status: 403 })), async () => {
            await assert.rejects(() => new CalendarClient("t").listEvents("2026-10-20", "2026-10-20"), /403/);
        });
    });

    test("events sort by absolute instant across time zones", async () => {
        await withFetch(base((url) => url.searchParams.get("calendar_id") === "1"
            ? json([{ id: 1, start: "2026-10-20 09:00:00", timezone_start: "Europe/Zurich" }])
            : json([{ id: 2, start: "2026-10-20 05:00:00", timezone_start: "America/New_York" }, { id: 3, start: "2026-10-20 02:00:00", timezone_start: "America/New_York" }])), async () => {
            const result = await new CalendarClient("t").listEvents("2026-10-20", "2026-10-21");
            // 02:00 NY = 08:00 Zurich, 05:00 NY = 11:00 Zurich.
            assert.deepStrictEqual(result.data.map(e => e.id), [3, 1, 2]);
        });
    });

    test("every page of a paged listing is read", async () => {
        const pages = [];
        await withFetch(base((url) => {
            const page = Number(url.searchParams.get("page") ?? 1);
            pages.push(page);
            return json([{ id: page, start: `2026-10-2${page} 09:00:00` }], { pages: 3 });
        }), async () => {
            const result = await new CalendarClient("t").listEvents("2026-10-20", "2026-10-29", 1);
            assert.deepStrictEqual(result.data.map(e => e.id), [1, 2, 3]);
            assert.deepStrictEqual(pages, [1, 2, 3]);
        });
    });

    test("a missing profile time zone is an error, not UTC", async () => {
        await withFetch((url) => url.pathname.endsWith("/profile") ? json({ email: "a@b.c", preferences: {} }) : json({}), async () => {
            await assert.rejects(() => new CalendarClient("t").listEvents("2026-10-20", "2026-10-20"), /no valid time zone/);
        });
    });

    test("profile and calendars are fetched once within the cache TTL", async () => {
        await withFetch(base(() => json([])), async (calls) => {
            const client = new CalendarClient("t");
            await client.listEvents("2026-10-20", "2026-10-20");
            await client.listEvents("2026-10-20", "2026-10-20");
            assert.strictEqual(calls.filter(c => new URL(c.url).pathname.endsWith("/profile")).length, 1);
            assert.strictEqual(calls.filter(c => new URL(c.url).pathname.endsWith("/pim/calendar")).length, 1);
        });
        await withFetch(base(() => json([])), async (calls) => {
            const client = new CalendarClient("t", { cacheTtlMs: 0 });
            await client.listEvents("2026-10-20", "2026-10-20");
            await client.listEvents("2026-10-20", "2026-10-20");
            assert.strictEqual(calls.filter(c => new URL(c.url).pathname.endsWith("/profile")).length, 2);
        });
    });
});

describe("listing cost", () => {
    test("a range over 366 days is rejected before any event request", async () => {
        await withFetch(base(() => json([])), async (calls) => {
            await assert.rejects(() => new CalendarClient("t").listEvents("2020-01-01", "2026-01-01"), /limited to 366 days/);
            assert.strictEqual(calls.filter(c => c.url.includes("/pim/event")).length, 0);
        });
    });

    test("paging through a result reuses the fetched listing, and a write clears it", async () => {
        await withFetch(base((url) => url.searchParams.get("calendar_id") === "1" ? json([{ id: 1, start: "2026-10-20 09:00:00" }]) : json([])), async (calls) => {
            const client = new CalendarClient("t");
            const eventCalls = () => calls.filter(c => c.method === "GET" && new URL(c.url).pathname.endsWith("/pim/event")).length;
            await client.listEvents("2026-10-20", "2026-10-20");
            await client.listEvents("2026-10-20", "2026-10-20");
            assert.strictEqual(eventCalls(), 2, "one fetch per calendar, not per page");
            client.getContacts = async () => ({ data: [] });
            await client.createEvent({ title: "T", start: "2026-10-21 09:00:00", end: "2026-10-21 10:00:00" });
            await client.listEvents("2026-10-20", "2026-10-20");
            assert.strictEqual(eventCalls(), 4);
        });
    });

    test("pages 2..N are fetched in parallel batches and keep their order", async () => {
        let running = 0; let peak = 0;
        await withFetch(base(async (url) => {
            const page = Number(url.searchParams.get("page") ?? 1);
            running++; peak = Math.max(peak, running);
            await new Promise(resolve => setTimeout(resolve, 20));
            running--;
            return json([{ id: page, start: `2026-10-20 0${page}:00:00` }], { pages: 7 });
        }), async () => {
            const result = await new CalendarClient("t").listEvents("2026-10-20", "2026-10-29", 1);
            assert.deepStrictEqual(result.data.map(e => e.id), [1, 2, 3, 4, 5, 6, 7]);
            assert.strictEqual(peak, 4);
        });
    });

    test("the resource list is fetched once", async () => {
        let n = 0;
        await withFetch((url) => { if (url.pathname.includes("bookable")) { n++; return json([{ uuid: "r1", name: "Room" }]); } return json({}); }, async () => {
            const client = new CalendarClient("t");
            await client.getBookableResources();
            await client.listBookableResources();
            assert.strictEqual(n, 1);
        });
    });

    test("events that start together sort by id", async () => {
        await withFetch(base((url) => url.searchParams.get("calendar_id") === "1" ? json([{ id: 9, start: "2026-10-20 09:00:00" }, { id: 3, start: "2026-10-20 09:00:00" }]) : json([{ id: 5, start: "2026-10-20 09:00:00" }])), async () => {
            const result = await new CalendarClient("t").listEvents("2026-10-20", "2026-10-20");
            assert.deepStrictEqual(result.data.map(e => e.id), [3, 5, 9]);
        });
    });
});

describe("own state on listed events", () => {
    test("my_state and is_organizer are computed from the owner's addresses", async () => {
        const events = [
            { id: 1, start: "2026-10-20 09:00:00", attendees: [{ address: "boss@x.ch", organizer: true, state: "ACCEPTED" }, { address: "ALIAS@x.ch", state: "NEEDS-ACTION" }] },
            { id: 2, start: "2026-10-20 10:00:00", attendees: [{ address: "me@x.ch", organizer: true, state: "ACCEPTED" }, { address: "o@y.ch", state: "NEEDS-ACTION" }] },
            { id: 3, start: "2026-10-20 11:00:00" },
        ];
        await withFetch(base((url) => url.searchParams.get("calendar_id") === "1" ? json(events) : json([])), async () => {
            const result = await new CalendarClient("t").listEvents("2026-10-20", "2026-10-20");
            assert.deepStrictEqual(result.data.map(e => [e.id, e.my_state, e.is_organizer]), [[1, "NEEDS-ACTION", false], [2, "ACCEPTED", true], [3, undefined, undefined]]);
        });
    });
});

describe("findFreeSlots on the client", () => {
    const monday = "2026-10-19";
    const now = Date.parse("2026-10-19T12:00:00+02:00");

    test("starts at the later of from and now, and clips the first day", async () => {
        await withFetch(base(() => json([])), async () => {
            const { slots } = await new CalendarClient("t").findFreeSlots({ from: monday, to: monday, durationMinutes: 30, now });
            assert.deepStrictEqual(slots.map(s => [s.start.slice(11, 16), s.end.slice(11, 16)]), [["12:00", "17:00"]]);
            const later = await new CalendarClient("t").findFreeSlots({ from: `${monday}T14:30`, to: monday, durationMinutes: 30, now });
            assert.deepStrictEqual(later.slots.map(s => s.start.slice(11, 16)), ["14:30"]);
        });
    });

    test("a time in to ends the search there", async () => {
        await withFetch(base(() => json([])), async () => {
            const { slots } = await new CalendarClient("t").findFreeSlots({ from: `${monday}T09:00`, to: `${monday}T11:00`, durationMinutes: 30, now: Date.parse("2026-10-19T00:00:00+02:00") });
            assert.deepStrictEqual(slots.map(s => [s.start.slice(11, 16), s.end.slice(11, 16)]), [["09:00", "11:00"]]);
        });
    });

    test("declined and cancelled events do not block, and the profile is fetched once", async () => {
        const events = [
            { id: 1, start: `${monday} 09:00:00`, end: `${monday} 10:00:00`, attendees: [{ address: "ALIAS@x.ch", state: "DECLINED" }] },
            { id: 2, start: `${monday} 10:00:00`, end: `${monday} 11:00:00`, status: "CANCELLED" },
            { id: 3, start: `${monday} 11:00:00`, end: `${monday} 12:00:00`, attendees: [{ address: "other@x.ch", state: "DECLINED" }] },
        ];
        await withFetch(base((url) => url.searchParams.get("calendar_id") === "1" ? json(events) : json([])), async (calls) => {
            const { slots } = await new CalendarClient("t").findFreeSlots({ from: monday, to: monday, durationMinutes: 30, now: Date.parse("2026-10-19T00:00:00+02:00") });
            // Event 1 was declined through the alias address and event 2 is cancelled: only event 3 blocks.
            assert.deepStrictEqual(slots.map(s => [s.start.slice(11, 16), s.end.slice(11, 16)]), [["09:00", "11:00"], ["12:00", "17:00"]]);
            assert.strictEqual(calls.filter(c => new URL(c.url).pathname.endsWith("/profile")).length, 1);
        });
    });
});

describe("findFreeSlots: whose time counts", () => {
    const monday = "2026-10-19";
    const now = Date.parse("2026-10-19T00:00:00+02:00");
    const shared = (events) => (url) => {
        if (url.pathname.endsWith("/pim/calendar")) return json({ calendars: [{ id: 1, name: "Own", is_owner: true }, { id: 2, name: "Team", is_owner: false }] });
        if (url.pathname.endsWith("/pim/event")) return url.searchParams.get("calendar_id") === "2" ? json(events) : json([]);
        return base(() => json([]))(url);
    };
    const teamEvents = [
        { id: 1, start: `${monday} 09:00:00`, end: `${monday} 10:00:00`, attendees: [{ address: "colleague@x.ch" }] },
        { id: 2, start: `${monday} 11:00:00`, end: `${monday} 12:00:00`, attendees: [{ address: "ALIAS@x.ch" }] },
    ];

    test("a shared calendar only blocks events the user attends", async () => {
        await withFetch(shared(teamEvents), async () => {
            const { slots } = await new CalendarClient("t").findFreeSlots({ from: monday, to: monday, durationMinutes: 30, now });
            assert.deepStrictEqual(slots.map(s => [s.start.slice(11, 16), s.end.slice(11, 16)]), [["09:00", "11:00"], ["12:00", "17:00"]]);
        });
    });

    test("calendarIds override counts every event of those calendars", async () => {
        await withFetch(shared(teamEvents), async () => {
            const { slots } = await new CalendarClient("t").findFreeSlots({ from: monday, to: monday, durationMinutes: 30, now, calendarIds: [1, 2] });
            assert.deepStrictEqual(slots.map(s => [s.start.slice(11, 16), s.end.slice(11, 16)]), [["10:00", "11:00"], ["12:00", "17:00"]]);
        });
    });

    test("a range in the past warns instead of looking fully booked", async () => {
        await withFetch(base(() => json([])), async () => {
            const result = await new CalendarClient("t").findFreeSlots({ from: "2026-10-12", to: "2026-10-13", durationMinutes: 30, now });
            assert.deepStrictEqual(result.slots, []);
            assert.match(result.warnings[0], /lies in the past/);
        });
    });

    test("an all-day event stored in another zone blocks its own days when all_day_blocks is set", async () => {
        const events = [{ id: 1, fullday: true, start: `${monday} 00:00:00`, end: `${monday} 23:59:59`, timezone_start: "America/Los_Angeles", timezone_end: "America/Los_Angeles" }];
        await withFetch(base(() => json(events)), async () => {
            const blocked = await new CalendarClient("t").findFreeSlots({ from: monday, to: "2026-10-20", durationMinutes: 30, now, allDayBlocks: true });
            assert.deepStrictEqual(blocked.slots.map(s => s.start.slice(0, 10)), ["2026-10-20"]);
        });
    });

    test("a range over 62 days is rejected before any request", async () => {
        await withFetch(base(() => json([])), async (calls) => {
            await assert.rejects(() => new CalendarClient("t").findFreeSlots({ from: "2026-10-19", to: "2027-03-01", durationMinutes: 30, now }), /limited to 62 days/);
            assert.strictEqual(calls.filter(c => c.url.includes("/pim/event")).length, 0);
        });
    });
});

describe("slots helper", () => {
    test("day_end 24:00 is allowed, 24:30 is not", () => {
        const query = { busy: [], from: "2026-10-19", to: "2026-10-19", durationMinutes: 30, dayStart: "20:00", includeWeekends: false };
        assert.strictEqual(findFreeSlots({ ...query, dayEnd: "24:00" })[0].minutes, 240);
        assert.throws(() => findFreeSlots({ ...query, dayEnd: "24:30" }), /Invalid time/);
    });
});

describe("tools", () => {
    async function connect(stub) {
        const server = new McpServer({ name: "t", version: "0" }, { capabilities: { tools: {} } });
        registerTools(server, stub);
        const client = new Client({ name: "c", version: "0" });
        const [a, b] = InMemoryTransport.createLinkedPair();
        await Promise.all([server.connect(a), client.connect(b)]);
        return client;
    }

    test("calendar_list_events filters by query on title and location and passes warnings", async () => {
        const events = [{ id: 1, title: "Dentist", start: "x" }, { id: 2, title: "Lunch", location: "Zahnarzt DENTIST office", start: "x" }, { id: 3, title: "Other", start: "x" }];
        const client = await connect({ listEvents: async () => ({ data: events, warnings: ["Calendar 2 could not be read"] }) });
        const res = await client.callTool({ name: "calendar_list_events", arguments: { from: "2026-10-20", to: "2026-10-21", query: "dentist" } });
        assert.deepStrictEqual(res.structuredContent.items.map(i => i.id), [1, 2]);
        assert.strictEqual(res.structuredContent.total, 2);
        assert.deepStrictEqual(res.structuredContent.warnings, ["Calendar 2 could not be read"]);
    });

    test("calendar_list_events query ignores accents and needs every word", async () => {
        const events = [{ id: 1, title: "Dentist Zürich", start: "x" }, { id: 2, title: "Dentist Bern", start: "x" }, { id: 3, title: "Lunch", location: "Zurich Monday", start: "x" }];
        const client = await connect({ listEvents: async () => ({ data: events }) });
        const ids = async (query) => (await client.callTool({ name: "calendar_list_events", arguments: { from: "2026-10-20", to: "2026-10-21", query } })).structuredContent.items.map(i => i.id);
        assert.deepStrictEqual(await ids("zurich"), [1, 3]);
        assert.deepStrictEqual(await ids("DENTIST zürich"), [1]);
        assert.deepStrictEqual(await ids("dentist monday"), []);
    });

    test("calendar_list_calendars drops share lists and user addresses", async () => {
        const client = await connect({ getCalendars: async () => ({ data: { calendars: [{ id: 1, name: "Main", color: "#fff", default: true, shares: [{ email: "x@y.ch" }], owner: { email: "o@y.ch" } }] } }) });
        const res = await client.callTool({ name: "calendar_list_calendars", arguments: {} });
        assert.deepStrictEqual(res.structuredContent.items, [{ id: 1, name: "Main", color: "#fff", default: true }]);
    });
});
