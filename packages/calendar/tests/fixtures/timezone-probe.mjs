// Runs a probe against the built client under a fixed TZ (set by the parent test process).
// Prints one line: PROBE_RESULT <json> so the parent can assert on captured API payloads.
import { CalendarClient } from "../../dist/calendar-client.js";

const calls = { createBodies: [], listUrls: [], updateBodies: [] };
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
    const u = String(url);
    if (options?.method === "POST" && u.includes("/calendar/pim/event")) {
        calls.createBodies.push(JSON.parse(options.body));
        return { ok: true, text: async () => JSON.stringify({ result: "success", data: { id: 1 } }) };
    }
    if (options?.method === "PUT" && u.includes("/calendar/pim/event/")) {
        calls.updateBodies.push(JSON.parse(options.body));
        return { ok: true, text: async () => JSON.stringify({ result: "success", data: {} }) };
    }
    if (/\/calendar\/pim\/event\/\d+$/.test(u)) {
        return {
            ok: true,
            text: async () => JSON.stringify({
                result: "success",
                data: { id: 1, calendar_id: 1, title: "Existing", start: "2026-02-01T09:00:00+01:00", end: "2026-02-01T09:30:00+01:00", timezone_start: "Europe/Zurich", timezone_end: "Europe/Zurich", attendees: [] },
            }),
        };
    }
    if (u.includes("/calendar/pim/event?")) {
        calls.listUrls.push(u);
        return { ok: true, text: async () => JSON.stringify({ result: "success", data: [] }) };
    }
    if (u.includes("/profile")) {
        const preferences = { timezone: { name: "Europe/Zurich" } };
        return {
            ok: true,
            text: async () => JSON.stringify({
                result: "success",
                data: {
                    email: "a@b.c",
                    display_name: "A",
                    preferences,
                },
            }),
        };
    }
    return { ok: true, text: async () => JSON.stringify({ result: "success", data: { calendars: [{ id: 1, default: true }] } }) };
};

const client = new CalendarClient("mock-token");

await client.createEvent({ title: "Summer", start: "2026-10-20 09:00:00", end: "2026-10-20 10:00:00" });
await client.createEvent({ title: "Winter", start: "2026-01-20 09:00:00", end: "2026-01-20 10:00:00" });
await client.createEvent({ title: "OffsetZ", start: "2026-10-20T09:00:00Z", end: "2026-10-20T10:00:00Z" });
await client.createEvent({ title: "OffsetExplicit", start: "2026-01-20T09:00:00+01:00", end: "2026-01-20T10:00:00+01:00" });
await client.createEvent({ title: "DateOnly", start: "2026-10-20", end: "2026-10-21" });
await client.listEvents("2026-10-20 09:00:00", "2026-10-20 10:00:00");
await client.updateEvent("1", { start: "2026-02-01T09:00:00Z" });

globalThis.fetch = originalFetch;
console.log("PROBE_RESULT " + JSON.stringify(calls));
