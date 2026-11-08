import { test, describe } from "node:test";
import assert from "node:assert";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools } from "../dist/tools.js";
import { isValidDateInput } from "../dist/schemas.js";

async function connect(stub = {}) {
    const server = new McpServer({ name: "t", version: "0" });
    registerTools(server, stub);
    const client = new Client({ name: "c", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    return client;
}

describe("input schemas", () => {
    test("date validator accepts documented formats and rejects the rest", () => {
        for (const ok of ["2026-10-18", "2026-10-18 09:00", "2026-10-18T09:00:00", "2026-10-18T09:00:00Z", "2026-10-18T09:00:00+02:00"]) {
            assert.ok(isValidDateInput(ok), ok);
        }
        for (const bad of ["tomorrow", "2026-13-01", "2026-02-30", "18.10.2026", "2026-10-18T25:00"]) {
            assert.ok(!isValidDateInput(bad), bad);
        }
    });

    test("create rejects bad attendees, dates, and rrule before the client runs", async () => {
        let called = 0;
        const client = await connect({ createEvent: async () => { called++; return { data: {} }; } });
        const base = { title: "T", start: "2026-10-18T09:00:00", end: "2026-10-18T10:00:00" };
        for (const bad of [
            { attendees: ["not-an-email"] },
            { attendees: "a@b.ch" },
            { start: "tomorrow" },
            { rrule: "DROP TABLE" },
            { title: "" },
        ]) {
            const result = await client.callTool({ name: "calendar_create_event", arguments: { ...base, ...bad } }).catch(e => ({ isError: true, e }));
            assert.ok(result.isError, JSON.stringify(bad));
        }
        assert.strictEqual(called, 0);
        const ok = await client.callTool({ name: "calendar_create_event", arguments: { ...base, attendees: ["a@b.ch"], rrule: "RRULE:FREQ=DAILY" } });
        assert.ok(!ok.isError);
        assert.strictEqual(called, 1);
    });

    test("event_id must be numeric", async () => {
        let called = 0;
        const client = await connect({ getEvent: async () => { called++; return { data: {} }; } });
        const result = await client.callTool({ name: "calendar_get_event", arguments: { event_id: "../../2/drive" } });
        assert.ok(result.isError);
        assert.strictEqual(called, 0);
    });
});

describe("rrule and time zone validation", async () => {
    const { isValidRrule } = await import("../dist/schemas.js");
    const { isValidTimeZone, canonicalTimeZone } = await import("../dist/dates.js");

    test("an rrule may list its parts in any order but needs exactly one FREQ", () => {
        assert.ok(isValidRrule("BYDAY=MO;FREQ=WEEKLY"));
        assert.ok(isValidRrule("RRULE:INTERVAL=2;FREQ=DAILY;COUNT=3"));
        assert.ok(isValidRrule("FREQ=DAILY"));
        assert.ok(!isValidRrule("BYDAY=MO"));
        assert.ok(!isValidRrule("FREQ=DAILY;FREQ=WEEKLY"));
        assert.ok(!isValidRrule("FREQ=SOMETIMES"));
        assert.ok(!isValidRrule("DROP TABLE"));
    });

    test("only IANA names are time zones", () => {
        for (const ok of ["Europe/Zurich", "America/New_York", "UTC", "Etc/GMT+2", "Asia/Calcutta"]) assert.ok(isValidTimeZone(ok), ok);
        for (const ok of ["GMT", "utc"]) assert.ok(isValidTimeZone(ok), ok);
        for (const bad of ["+02:00", "-05:00", "EST", "Mars/Base", "Europe/Nowhere", ""]) assert.ok(!isValidTimeZone(bad), bad);
    });

    test("names are canonicalized to their official spelling", () => {
        assert.strictEqual(canonicalTimeZone("Europe/zurich"), "Europe/Zurich");
        assert.strictEqual(canonicalTimeZone("Europe/ZURICH"), "Europe/Zurich");
        assert.strictEqual(canonicalTimeZone("GMT"), "UTC");
        assert.strictEqual(canonicalTimeZone("Europe/Zurich"), "Europe/Zurich");
    });
});
