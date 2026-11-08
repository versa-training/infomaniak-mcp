import { test, describe } from "node:test";
import assert from "node:assert";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools } from "../dist/tools.js";

async function connect(stub) {
    const server = new McpServer({ name: "t", version: "0" }, { capabilities: { tools: {} } });
    registerTools(server, stub);
    const client = new Client({ name: "c", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    return client;
}

const event = (id, extra = {}) => ({ id, calendar_id: 1, title: `E${id}`, start: "2026-10-20 09:00:00", end: "2026-10-20 10:00:00", description: "secret", ...extra });

describe("tools/call", () => {
    test("update_event describes naive times as read in the event's own zone", async () => {
        const client = await connect({});
        const { tools } = await client.listTools();
        const update = tools.find(t => t.name === "calendar_update_event");
        assert.match(update.inputSchema.properties.start.description, /event's own time zone/);
        assert.doesNotMatch(update.inputSchema.properties.start.description, /in the profile time zone/);
        const create = tools.find(t => t.name === "calendar_create_event");
        assert.match(create.inputSchema.properties.start.description, /profile time zone/);
    });

    test("the server advertises tools only", async () => {
        const client = await connect({});
        const caps = client.getServerCapabilities();
        assert.ok(caps.tools);
        assert.strictEqual(caps.resources, undefined);
        assert.strictEqual(caps.prompts, undefined);
        const { tools } = await client.listTools();
        assert.deepStrictEqual(tools.map(t => t.name).sort(), [
            "calendar_create_event", "calendar_delete_event", "calendar_find_free_slots", "calendar_get_event",
            "calendar_list_calendars", "calendar_list_events", "calendar_list_resources", "calendar_update_event",
        ]);
    });

    test("calendar_list_calendars returns items with structuredContent and one text block", async () => {
        const client = await connect({ getCalendars: async () => ({ data: { calendars: [{ id: 1, name: "Main" }] } }) });
        const res = await client.callTool({ name: "calendar_list_calendars", arguments: {} });
        assert.strictEqual(res.content.length, 1);
        assert.deepStrictEqual(res.structuredContent, { items: [{ id: 1, name: "Main" }], has_more: false, offset: 0, total: 1 });
        assert.deepStrictEqual(JSON.parse(res.content[0].text), res.structuredContent);
    });

    test("calendar_list_events passes arguments, pages, and omits free text", async () => {
        let args;
        const events = [event(1), event(2), event(3)];
        const client = await connect({ listEvents: async (...a) => { args = a; return { data: events }; } });
        const res = await client.callTool({ name: "calendar_list_events", arguments: { from: "2026-10-20", to: "2026-10-21", calendar_id: "5", limit: 2 } });
        assert.deepStrictEqual(args.slice(0, 3), ["2026-10-20", "2026-10-21", 5]);
        assert.strictEqual(res.structuredContent.items.length, 2);
        assert.strictEqual(res.structuredContent.has_more, true);
        assert.strictEqual(res.structuredContent.next_offset, 2);
        assert.strictEqual(res.structuredContent.total, 3);
        assert.ok(!res.content[0].text.includes("secret"));
        const page2 = await client.callTool({ name: "calendar_list_events", arguments: { from: "2026-10-20", to: "2026-10-21", limit: 2, offset: 2 } });
        assert.strictEqual(page2.structuredContent.items.length, 1);
        assert.strictEqual(page2.structuredContent.has_more, false);
    });

    test("calendar_get_event returns third-party text under untrusted_content", async () => {
        const client = await connect({ getEvent: async (id) => ({ data: event(id, { location: "Room" }) }) });
        const res = await client.callTool({ name: "calendar_get_event", arguments: { event_id: 7 } });
        assert.strictEqual(res.structuredContent.event.id, 7);
        assert.deepStrictEqual(res.structuredContent.event.untrusted_content, { description: "secret", location: "Room" });
    });

    test("calendar_create_event forwards fields", async () => {
        let args;
        const client = await connect({ createEvent: async (...a) => { args = a; return { data: { id: 9 } }; } });
        const res = await client.callTool({ name: "calendar_create_event", arguments: { title: "T", start: "2026-10-20T09:00:00", end: "2026-10-20T10:00:00", attendees: ["a@b.ch"], rrule: "FREQ=DAILY" } });
        assert.deepStrictEqual(args, [{ title: "T", start: "2026-10-20T09:00:00", end: "2026-10-20T10:00:00", description: undefined, attendees: ["a@b.ch"], rrule: "FREQ=DAILY", calendarId: undefined, allDay: undefined, notifyAttendees: undefined, location: undefined, remindersMinutes: undefined, private: undefined, showAs: undefined, timezone: undefined, bookableResourceId: undefined, withKmeet: undefined, kmeetLobby: undefined, kmeetPassword: undefined }]);
        assert.strictEqual(res.structuredContent.event.id, 9);
    });

    test("calendar_update_event forwards fields", async () => {
        let args;
        const client = await connect({ updateEvent: async (...a) => { args = a; return { data: { id: 9 } }; } });
        const res = await client.callTool({ name: "calendar_update_event", arguments: { event_id: "9", title: "New", notify_attendees: true } });
        assert.strictEqual(args[0], 9);
        assert.strictEqual(args[1].title, "New");
        assert.strictEqual(args[1].notifyAttendees, true);
        assert.strictEqual(res.structuredContent.event.id, 9);
    });

    test("calendar_delete_event forwards ids and the notify flag", async () => {
        let args;
        const client = await connect({ deleteEvent: async (...a) => { args = a; return { data: {} }; } });
        const res = await client.callTool({ name: "calendar_delete_event", arguments: { event_id: 4, notify_attendees: false } });
        assert.deepStrictEqual(args, [4, undefined, false]);
        assert.deepStrictEqual(res.structuredContent, { deleted: true, event_id: 4 });
    });

    test("calendar_find_free_slots maps arguments and pages slots", async () => {
        let args;
        const slots = [1, 2, 3].map(i => ({ start: `2026-10-19 0${i}:00:00`, end: `2026-10-19 0${i}:30:00`, minutes: 30 }));
        const client = await connect({ findFreeSlots: async (a) => { args = a; return { timezone: "Europe/Zurich", slots }; } });
        const res = await client.callTool({ name: "calendar_find_free_slots", arguments: { from: "2026-10-19", to: "2026-10-20", duration_minutes: 30, limit: 2 } });
        assert.deepStrictEqual(args, { from: "2026-10-19", to: "2026-10-20", durationMinutes: 30, dayStart: "09:00", dayEnd: "17:00", includeWeekends: false, allDayBlocks: false, calendarId: undefined, calendarIds: undefined });
        assert.strictEqual(res.structuredContent.items.length, 2);
        assert.strictEqual(res.structuredContent.has_more, true);
        assert.strictEqual(res.structuredContent.timezone, "Europe/Zurich");
    });

    test("client errors surface as isError results", async () => {
        const client = await connect({ getEvent: async () => { throw new Error("Calendar event retrieval failed: 404 not_found"); } });
        const res = await client.callTool({ name: "calendar_get_event", arguments: { event_id: 1 } });
        assert.strictEqual(res.isError, true);
        assert.match(res.content[0].text, /404 not_found/);
    });
});

describe("tools/call: resources", () => {
    test("calendar_list_resources returns the list", async () => {
        const client = await connect({ listBookableResources: async () => ({ data: [{ uuid: "r1", name: "Room" }] }) });
        const res = await client.callTool({ name: "calendar_list_resources", arguments: {} });
        assert.deepStrictEqual(res.structuredContent.items, [{ uuid: "r1", name: "Room" }]);
    });

    test("calendar_list_resources drops permission data and user lists", async () => {
        const client = await connect({ listBookableResources: async () => ({ data: [{ uuid: "r1", name: "Room", capacity: 8, permission: { users: ["a@b.ch"] }, users: [{ email: "x@y.ch" }] }] }) });
        const res = await client.callTool({ name: "calendar_list_resources", arguments: {} });
        assert.deepStrictEqual(res.structuredContent.items, [{ uuid: "r1", name: "Room", capacity: 8 }]);
    });
});

describe("tools/call: unexpected field types", () => {
    const odd = { id: "abc", calendar_id: null, title: 42, start: { wall: 1 }, end: ["x"], fullday: "yes", attendees: [{ address: 5, state: {}, organizer: "true" }, "str"], alarms: "none", private: 1, color: { r: 1 }, meet_room_url: 7 };

    test("list and detail results still pass the output schema", async () => {
        const client = await connect({
            listEvents: async () => ({ data: [odd], warnings: ["w"] }),
            getEvent: async () => ({ data: odd }),
            getCalendars: async () => ({ data: { calendars: [{ id: "x", name: 5, color: { a: 1 }, default: "no" }] } }),
            listBookableResources: async () => ({ data: [{ uuid: 1, name: ["a"] }, "text", null] }),
        });
        for (const [name, args] of [["calendar_list_events", { from: "2026-10-20", to: "2026-10-21" }], ["calendar_get_event", { event_id: 1 }], ["calendar_list_calendars", {}], ["calendar_list_resources", {}]]) {
            const res = await client.callTool({ name, arguments: args });
            assert.ok(!res.isError, `${name}: ${JSON.stringify(res.content)}`);
        }
    });
});
