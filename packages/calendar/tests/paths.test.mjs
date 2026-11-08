import { test, describe } from "node:test";
import assert from "node:assert";
import { CalendarClient } from "../dist/calendar-client.js";

const json = (data) => new Response(JSON.stringify({ result: "success", data }), { status: 200, headers: { "Content-Type": "application/json" } });

async function withFetch(handler, run) {
    const original = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options) => {
        calls.push({ url: String(url), options });
        return handler(String(url), options);
    };
    try {
        await run(calls);
    } finally {
        globalThis.fetch = original;
    }
}

describe("path segment encoding", () => {
    const traversal = "../../../../2/drive/1/files/5";

    for (const method of ["getEvent", "updateEvent", "deleteEvent"]) {
        test(`${method} rejects a non-numeric event id before any request`, async () => {
            await withFetch(() => json({}), async (calls) => {
                const client = new CalendarClient("t");
                await assert.rejects(() => client[method](traversal), /Invalid event_id/);
                await assert.rejects(() => client[method]("5#x"), /Invalid event_id/);
                assert.strictEqual(calls.length, 0);
            });
        });
    }

    test("rejects a non-numeric calendar id", async () => {
        await withFetch(() => json([]), async (calls) => {
            const client = new CalendarClient("t");
            await assert.rejects(() => client.deleteEvent("5", "1&x=2"), /Invalid calendar_id/);
            assert.strictEqual(calls.length, 0);
        });
    });

    test("deleteEvent builds the URL from the event id and an encoded query", async () => {
        await withFetch(() => json({}), async (calls) => {
            await new CalendarClient("t").deleteEvent(42, 7);
            const url = new URL(calls[0].url);
            assert.strictEqual(url.pathname, "/1/calendar/pim/event/42");
            assert.strictEqual(url.searchParams.get("calendar_id"), "7");
            assert.strictEqual(calls[0].options.method, "DELETE");
        });
    });
});
