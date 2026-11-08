import { test, describe } from "node:test";
import assert from "node:assert";
import { CalendarClient } from "../dist/calendar-client.js";

const profile = { data: { email: "Me@x.ch", display_name: "Me", preferences: { timezone: { name: "Europe/Zurich" } } } };

function clientWith(existing) {
    const client = new CalendarClient("t");
    client.getUserProfile = async () => profile;
    client.getDefaultCalendar = async () => ({ id: 1 });
    client.getContacts = async () => ({ data: [] });
    client.getProfileEmails = async () => ({ data: [] });
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

const base = { title: "T", start: "2026-10-20 09:00:00", end: "2026-10-20 10:00:00" };
const organizer = { className: "Attendee", address: "boss@x.ch", name: "Boss", organizer: true, state: "ACCEPTED" };
const alice = { className: "Attendee", address: "alice@x.ch", name: "Alice", organizer: false, state: "ACCEPTED" };
const bob = { className: "Attendee", address: "bob@x.ch", name: "Bob", organizer: false, state: "DECLINED" };
const existing = { id: 1, calendar_id: 1, title: "T", start: "2026-10-20 09:00:00", end: "2026-10-20 10:00:00", timezone_start: "Europe/Zurich", timezone_end: "Europe/Zurich", attendees: [organizer, alice, bob] };

describe("attendees", () => {
    test("create does not notify by default", async () => {
        const body = await capture(() => clientWith().createEvent({ ...base, attendees: ["a@x.ch"] }));
        assert.strictEqual(body.notifyAttendees, false);
        assert.strictEqual(body.attendees.length, 2);
    });

    test("create notifies only on request", async () => {
        const body = await capture(() => clientWith().createEvent({ ...base, attendees: ["a@x.ch"], notifyAttendees: true }));
        assert.strictEqual(body.notifyAttendees, true);
    });

    test("create with an empty array has no attendees and no notification", async () => {
        const body = await capture(() => clientWith().createEvent({ ...base, attendees: [], notifyAttendees: true }));
        assert.deepStrictEqual(body.attendees, []);
        assert.strictEqual(body.notifyAttendees, false);
    });

    test("create skips the token owner in the list and dedupes addresses", async () => {
        const body = await capture(() => clientWith().createEvent({ ...base, attendees: ["me@x.ch", "A@x.ch", "a@x.ch"] }));
        const addresses = body.attendees.map(a => a.address);
        assert.deepStrictEqual(addresses, ["A@x.ch", "Me@x.ch"]);
        assert.strictEqual(body.attendees.filter(a => a.organizer).length, 1);
    });

    test("update merges: keeps replies and organizer, adds new, removes omitted", async () => {
        const body = await capture(() => clientWith(existing).updateEvent("1", { attendees: ["alice@x.ch", "carol@x.ch"] }));
        assert.deepStrictEqual(body.attendees.map(a => a.address), ["boss@x.ch", "alice@x.ch", "carol@x.ch"]);
        assert.strictEqual(body.attendees[1].state, "ACCEPTED");
        assert.strictEqual(body.attendees[2].state, "NEEDS-ACTION");
        assert.strictEqual(body.attendees[0].organizer, true);
        assert.ok(!body.attendees.some(a => a.address === "Me@x.ch"), "does not take over the organizer role");
    });

    test("update with an empty array removes everyone except the organizer and the owner's own entry", async () => {
        const body = await capture(() => clientWith(existing).updateEvent("1", { attendees: [] }));
        assert.deepStrictEqual(body.attendees, [organizer]);
        const own = { className: "Attendee", address: "me@x.ch", name: "Me", organizer: false, state: "ACCEPTED" };
        const withOwn = await capture(() => clientWith({ ...existing, attendees: [organizer, alice, own] }).updateEvent("1", { attendees: [] }));
        assert.deepStrictEqual(withOwn.attendees, [organizer, own]);
        const none = await capture(() => clientWith({ ...existing, attendees: [] }).updateEvent("1", { attendees: [] }));
        assert.deepStrictEqual(none.attendees, []);
    });

    test("an owner on the event under an alias is promoted to organizer, not added twice", async () => {
        const client = clientWith({ ...existing, attendees: [{ ...alice, address: "alias@x.ch" }, bob] });
        client.getProfileEmails = async () => ({ data: [{ email: "alias@x.ch", checked: true }] });
        const body = await capture(() => client.updateEvent("1", { attendees: ["bob@x.ch", "c@d.ch"] }));
        assert.deepStrictEqual(body.attendees.map(a => [a.address, a.organizer]), [["alias@x.ch", true], ["bob@x.ch", false], ["c@d.ch", false]]);
    });

    test("an unverified profile address is not the owner's own", async () => {
        const client = clientWith();
        client.getProfileEmails = async () => ({ data: [{ email: "alias@x.ch", checked: false }, { email: "ok@x.ch", checked: true }, "str@x.ch"] });
        const body = await capture(() => client.createEvent({ ...base, attendees: ["alias@x.ch", "ok@x.ch", "str@x.ch"] }));
        assert.deepStrictEqual(body.attendees.map(a => a.address), ["alias@x.ch", "Me@x.ch"]);
    });

    test("notify_attendees is for organizers only, on update and delete", async () => {
        const invited = { ...existing, attendees: [organizer, { ...alice, address: "me@x.ch" }] };
        await assert.rejects(() => clientWith(invited).updateEvent("1", { title: "N", notifyAttendees: true }), /organizers only/);
        const calls = [];
        const original = globalThis.fetch;
        globalThis.fetch = async (url, options) => { calls.push(options?.method ?? "GET"); return new Response("{}", { status: 200 }); };
        try {
            await assert.rejects(() => clientWith(invited).deleteEvent("1", 1, true), /organizers only/);
            assert.deepStrictEqual(calls, []);
            const mine = { ...existing, attendees: [{ ...organizer, address: "me@x.ch" }, alice] };
            await clientWith(mine).deleteEvent("1", 1, true);
            assert.deepStrictEqual(calls, ["DELETE"]);
        } finally {
            globalThis.fetch = original;
        }
    });

    test("update without attendees leaves them alone", async () => {
        const body = await capture(() => clientWith(existing).updateEvent("1", { title: "New" }));
        assert.deepStrictEqual(body.attendees, existing.attendees);
    });

    test("update adds the token owner as organizer when the event has none", async () => {
        const noOrganizer = { ...existing, attendees: [] };
        const body = await capture(() => clientWith(noOrganizer).updateEvent("1", { attendees: ["alice@x.ch"] }));
        assert.deepStrictEqual(body.attendees.map(a => [a.address, a.organizer]), [["alice@x.ch", false], ["Me@x.ch", true]]);
    });

    test("update keeps the token owner's own entry when they are an invitee", async () => {
        const me = { className: "Attendee", address: "me@x.ch", name: "Me", organizer: false, state: "ACCEPTED" };
        const body = await capture(() => clientWith({ ...existing, attendees: [organizer, me, alice] }).updateEvent("1", { attendees: ["carol@x.ch"] }));
        assert.deepStrictEqual(body.attendees.map(a => a.address), ["boss@x.ch", "me@x.ch", "carol@x.ch"]);
        assert.strictEqual(body.attendees[1].state, "ACCEPTED");
    });

    test("an alias address of the token owner is not invited as an external attendee", async () => {
        const client = clientWith();
        client.getProfileEmails = async () => ({ data: [{ id: 1, email: "alias@x.ch", type: "other" }] });
        const body = await capture(() => client.createEvent({ ...base, attendees: ["ALIAS@x.ch", "a@x.ch"] }));
        assert.deepStrictEqual(body.attendees.map(a => a.address), ["a@x.ch", "Me@x.ch"]);
    });

    test("contact emails given as objects still give attendees a contactId", async () => {
        const client = clientWith();
        client.getContacts = async () => ({ data: [{ id: 9, name: "Alice A", emails: [{ email: "Alice@x.ch" }, "other@x.ch"] }] });
        const body = await capture(() => client.createEvent({ ...base, attendees: ["alice@x.ch", "other@x.ch"] }));
        assert.deepStrictEqual(body.attendees.slice(0, 2).map(a => [a.contactId, a.name]), [[9, "Alice A"], [9, "Alice A"]]);
    });

    test("a failed profile email lookup falls back to the primary address", async () => {
        const client = clientWith();
        client.getProfileEmails = async () => { throw new Error("403"); };
        const body = await capture(() => client.createEvent({ ...base, attendees: ["me@x.ch", "a@x.ch"] }));
        assert.deepStrictEqual(body.attendees.map(a => a.address), ["a@x.ch", "Me@x.ch"]);
    });
});
