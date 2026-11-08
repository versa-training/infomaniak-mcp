import { test, describe } from "node:test";
import assert from "node:assert";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ContactClient } from "../dist/contact-client.js";
import { registerTools } from "../dist/tools.js";
import { phoneDigits, normalizeText, searchContacts, sortContacts, matchedOn } from "../dist/search.js";

const book = [
    { id: 1, name: "Hans Müller", firstname: "Hans", lastname: "Müller", emails: ["hans@example.ch"], phones: ["079 123 45 67"], others: { organization: "ACME AG", nickname: "Hansi" } },
    { id: 2, name: "John Doe", firstname: "John", lastname: "Doe", emails: ["john.doe@example.com"], phones: ["+41 22 345 67 89"] },
    { id: 3, name: "Johnny Doerr", firstname: "Johnny", lastname: "Doerr", emails: [], phones: [] },
    { id: 4, name: "Anna Smith", firstname: "Anna", lastname: "Smith", emails: [{ email: "anna@smith.org" }], phones: [{ value: "0041 79 555 00 11" }] },
];
const ids = (list) => list.map((c) => c.id);

describe("normalization", () => {
    test("normalizeText strips accents and case", () => {
        assert.strictEqual(normalizeText("  MÜLLER   Zoë "), "muller zoe");
    });

    test("accent-insensitive in both directions", () => {
        assert.deepStrictEqual(ids(searchContacts(book, "Muller")), [1]);
        assert.deepStrictEqual(ids(searchContacts(book, "müller")), [1]);
    });

    test("word order does not matter", () => {
        assert.deepStrictEqual(ids(searchContacts(book, "Doe John")), [2, 3]);
        assert.deepStrictEqual(ids(searchContacts(book, "Muller Hans")), [1]);
    });

    test("every word must match", () => {
        assert.deepStrictEqual(ids(searchContacts(book, "John Smith")), []);
    });
});

describe("phone matching", () => {
    test("phoneDigits maps +41 and 0041 to 0", () => {
        assert.strictEqual(phoneDigits("+41 79 123 45 67"), "0791234567");
        assert.strictEqual(phoneDigits("0041 79 123 45 67"), "0791234567");
        assert.strictEqual(phoneDigits("079 123 45 67"), "0791234567");
        assert.strictEqual(phoneDigits("+49 30 1234"), "4930" + "1234");
    });

    test("international query matches a national number", () => {
        assert.deepStrictEqual(ids(searchContacts(book, "+41 79 123 45 67")), [1]);
    });

    test("national query matches an international number", () => {
        assert.deepStrictEqual(ids(searchContacts(book, "022 345 67 89")), [2]);
        assert.deepStrictEqual(ids(searchContacts(book, "079 555")), [4]);
    });

    test("spacing and punctuation do not matter", () => {
        assert.deepStrictEqual(ids(searchContacts(book, "(079)123-45-67")), [1]);
    });
});

describe("other fields and object entries", () => {
    test("matches organization and nickname from others", () => {
        assert.deepStrictEqual(ids(searchContacts(book, "acme")), [1]);
        assert.deepStrictEqual(ids(searchContacts(book, "hansi")), [1]);
    });

    test("reads email and phone entries that are objects", () => {
        assert.deepStrictEqual(ids(searchContacts(book, "anna@smith")), [4]);
    });
});

describe("ranking and query validation", () => {
    test("exact before prefix before substring", () => {
        const list = [
            { id: 10, name: "Marco Rossiter", firstname: "Marco", lastname: "Rossiter", emails: [] },
            { id: 11, name: "Rossi", firstname: "", lastname: "Rossi", emails: [] },
            { id: 12, name: "Dario Crossing", firstname: "Dario", lastname: "Crossing", emails: [] },
            { id: 13, name: "Rossini", firstname: "", lastname: "Rossini", emails: [] },
        ];
        assert.deepStrictEqual(ids(searchContacts(list, "rossi")), [11, 10, 13, 12]);
    });

    test("rejects empty and one-character queries", () => {
        assert.throws(() => searchContacts(book, ""), /at least 2/);
        assert.throws(() => searchContacts(book, "   "), /at least 2/);
        assert.throws(() => searchContacts(book, "a"), /at least 2/);
    });
});

describe("address book cache", () => {
    function counting(now) {
        const calls = [];
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async (url) => {
            calls.push(new URL(url));
            return new Response(JSON.stringify({ result: "success", data: book }), { status: 200 });
        };
        return { calls, restore: () => { globalThis.fetch = originalFetch; } };
    }

    test("second read inside the TTL reuses the first request, a read after it fetches again", async () => {
        const { calls, restore } = counting();
        try {
            let time = 1000;
            const client = new ContactClient("t", { cacheTtlMs: 60000, now: () => time });
            await client.fetchAllContacts();
            time += 59000;
            await client.fetchAllContacts();
            assert.strictEqual(calls.length, 1);
            time += 2000;
            await client.fetchAllContacts();
            assert.strictEqual(calls.length, 2);
        } finally {
            restore();
        }
    });

    test("requests only emails, phones and others", async () => {
        const { calls, restore } = counting();
        try {
            await new ContactClient("t").fetchAllContacts();
            assert.strictEqual(calls[0].searchParams.get("with"), "emails,phones,others");
        } finally {
            restore();
        }
    });

    test("a failed request is not cached", async () => {
        const originalFetch = globalThis.fetch;
        let n = 0;
        globalThis.fetch = async () => {
            n += 1;
            return n === 1
                ? new Response("{}", { status: 500, statusText: "Server Error" })
                : new Response(JSON.stringify({ result: "success", data: book }), { status: 200 });
        };
        try {
            const client = new ContactClient("t");
            await assert.rejects(client.fetchAllContacts(), /500/);
            assert.strictEqual((await client.fetchAllContacts()).length, 4);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});

describe("paging and field projection through tools/call", () => {
    async function connect() {
        const server = new McpServer({ name: "test", version: "0.0.0" });
        const real = new ContactClient("t");
        registerTools(server, { fetchAllContacts: async () => book, searchContacts: (a, q) => real.searchContacts(a, q) });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        const mcp = new Client({ name: "c", version: "0" });
        await Promise.all([server.connect(st), mcp.connect(ct)]);
        return mcp;
    }

    test("contact_list_contacts pages with limit and offset", async () => {
        const mcp = await connect();
        const first = await mcp.callTool({ name: "contact_list_contacts", arguments: { limit: 3 } });
        assert.deepStrictEqual(first.structuredContent.items.map((c) => c.id), [4, 1, 2]);
        assert.strictEqual(first.structuredContent.has_more, true);
        assert.strictEqual(first.structuredContent.next_offset, 3);
        assert.strictEqual(first.structuredContent.total, 4);
        const second = await mcp.callTool({ name: "contact_list_contacts", arguments: { limit: 3, offset: 3 } });
        assert.deepStrictEqual(second.structuredContent.items.map((c) => c.id), [3]);
        assert.strictEqual(second.structuredContent.has_more, false);
        await mcp.close();
    });

    test("fields adds others; default hides it", async () => {
        const mcp = await connect();
        const plain = await mcp.callTool({ name: "contact_search_contacts", arguments: { query: "acme" } });
        assert.strictEqual(plain.structuredContent.items[0].others, undefined);
        const withOthers = await mcp.callTool({ name: "contact_search_contacts", arguments: { query: "acme", fields: ["id", "others"] } });
        assert.deepStrictEqual(withOthers.structuredContent.items[0], { id: 1, matched_on: ["organization"], others: { organization: "ACME AG", nickname: "Hansi" } });
        await mcp.close();
    });

    test("limit above the maximum is rejected", async () => {
        const mcp = await connect();
        const result = await mcp.callTool({ name: "contact_search_contacts", arguments: { query: "john", limit: 101 } });
        assert.strictEqual(result.isError, true);
        await mcp.close();
    });

    test("search returns ranked matches with a total", async () => {
        const mcp = await connect();
        const result = await mcp.callTool({ name: "contact_search_contacts", arguments: { query: "john" } });
        assert.deepStrictEqual(result.structuredContent.items.map((c) => c.id), [2, 3]);
        assert.strictEqual(result.structuredContent.total, 2);
        await mcp.close();
    });
});

describe("search precision", () => {
    const people = [
        { id: 1, name: "Anna Meier", firstname: "Anna", lastname: "Meier", emails: [], phones: [] },
        { id: 2, name: "Jean Dupont", firstname: "Jean", lastname: "Dupont", emails: [], phones: [] },
        { id: 3, name: "Bob Stan", firstname: "Bob", lastname: "Stan", emails: [], phones: [] },
        { id: 4, name: "Andre Rey", firstname: "Andre", lastname: "Rey", emails: [], phones: [] },
    ];

    test("a two-character query matches only the start of a word", () => {
        assert.deepStrictEqual(ids(searchContacts(people, "an")), [4, 1]);
    });

    test("three characters match inside a word", () => {
        assert.deepStrictEqual(ids(searchContacts(people, "ean")), [2]);
    });

    test("numbers and labels inside others are not searchable", () => {
        const list = [
            { id: 1, name: "Zed", firstname: "Zed", lastname: "", emails: [], others: { birthday: 19900101, id: 19, type: "work", label: "home" } },
        ];
        assert.deepStrictEqual(ids(searchContacts(list, "19")), []);
        assert.deepStrictEqual(ids(searchContacts(list, "work")), []);
        assert.deepStrictEqual(ids(searchContacts(list, "home")), []);
    });

    test("only named text fields of others are searchable", () => {
        const list = [
            { id: 1, name: "Zed", emails: [], others: { company: "Initech", addresses: [{ city: "Bern" }], notes: "met at fair" } },
        ];
        assert.deepStrictEqual(ids(searchContacts(list, "initech")), [1]);
        assert.deepStrictEqual(ids(searchContacts(list, "fair")), [1]);
    });

    test("matched_on names the fields behind a hit", () => {
        assert.deepStrictEqual(matchedOn(book[0], "acme"), ["organization"]);
        assert.deepStrictEqual(matchedOn(book[0], "hans"), ["name", "emails", "nickname"]);
        assert.deepStrictEqual(matchedOn(book[0], "079 123"), ["phones"]);
    });

    test("top-level organization and nickname are searchable", () => {
        const list = [{ id: 1, name: "Zed", emails: [], organization: "Globex", nickname: "Zedd" }];
        assert.deepStrictEqual(ids(searchContacts(list, "globex")), [1]);
        assert.deepStrictEqual(matchedOn(list[0], "zedd"), ["nickname"]);
    });

    test("international numbers match stored national numbers by the last 9 digits", () => {
        const list = [
            { id: 1, name: "A", emails: [], phones: ["79 123 45 67"] },
            { id: 2, name: "B", emails: [], phones: ["06 12 34 56 78"] },
        ];
        assert.deepStrictEqual(ids(searchContacts(list, "+41 79 123 45 67")), [1]);
        assert.deepStrictEqual(ids(searchContacts(list, "+33 6 12 34 56 78")), [2]);
    });
});

describe("stable order and cache control", () => {
    test("sortContacts orders by name whatever the input order", () => {
        const a = sortContacts([...book]);
        const b = sortContacts([...book].reverse());
        assert.deepStrictEqual(ids(a), [4, 1, 2, 3]);
        assert.deepStrictEqual(ids(b), [4, 1, 2, 3]);
    });

    test("refresh and clearCache bypass the cache", async () => {
        const originalFetch = globalThis.fetch;
        let calls = 0;
        globalThis.fetch = async () => {
            calls += 1;
            return new Response(JSON.stringify({ result: "success", data: book }), { status: 200 });
        };
        try {
            const client = new ContactClient("t");
            await client.fetchAllContacts();
            await client.fetchAllContacts();
            assert.strictEqual(calls, 1);
            await client.fetchAllContacts({ refresh: true });
            assert.strictEqual(calls, 2);
            client.clearCache();
            await client.fetchAllContacts();
            assert.strictEqual(calls, 3);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    test("the list tool output schema describes contact fields", async () => {
        const server = new McpServer({ name: "test", version: "0.0.0" });
        registerTools(server, { fetchAllContacts: async () => book, searchContacts: () => [] });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        const mcp = new Client({ name: "c", version: "0" });
        await Promise.all([server.connect(st), mcp.connect(ct)]);
        const { tools } = await mcp.listTools();
        const item = tools[0].outputSchema.properties.items.items;
        assert.ok(item.properties.emails && item.properties.phones && item.properties.others);
        await mcp.close();
    });
});

describe("round 3 matching", () => {
    test("ß ø æ œ ł fold to ASCII", () => {
        const b = [
            { id: 1, name: "Anna Strauß", emails: [], phones: [] },
            { id: 2, name: "Søren Ølsen", emails: [], phones: [] },
        ];
        assert.deepStrictEqual(ids(searchContacts(b, "strauss")), [1]);
        assert.deepStrictEqual(ids(searchContacts(b, "soren")), [2]);
        assert.deepStrictEqual(ids(searchContacts(b, "olsen")), [2]);
    });

    test("email labels are not indexed", () => {
        const b = [
            { id: 1, name: "Zed One", emails: [{ type: "home", value: "zed@a.org" }, { label: "home", email: "z2@a.org" }], phones: [] },
        ];
        assert.deepStrictEqual(ids(searchContacts(b, "home")), []);
        assert.deepStrictEqual(ids(searchContacts(b, "z2@a")), [1]);
        assert.deepStrictEqual(matchedOn(b[0], "zed"), ["name", "emails"].filter((x) => matchedOn(b[0], "zed").includes(x)));
    });

    test("punctuation in the query does not hide a match", () => {
        const b = [
            { id: 1, name: "Jean Dupont", firstname: "Jean", lastname: "Dupont", organization: "Acme", emails: [], phones: [] },
            { id: 2, name: "Anna Meier", firstname: "Anna", lastname: "Meier", organization: "Acme", emails: [], phones: [] },
        ];
        for (const q of ["Dupont, Jean", "J. Dupont", "Meier (Acme)", '"Anna Meier"', "Anna Meier, Acme"]) {
            assert.ok(searchContacts(b, q).length > 0, q);
        }
        assert.deepStrictEqual(ids(searchContacts(b, "Dupont, Jean")), [1]);
        assert.deepStrictEqual(ids(searchContacts(b, "J. Dupont")), [1]);
        assert.deepStrictEqual(ids(searchContacts(b, '"Anna Meier"')), [2]);
    });

    test("an empty name falls back and equal names order by id", () => {
        const b = [
            { id: 9, name: "", firstname: "Zoe", lastname: "Zed", emails: [], phones: [] },
            { id: 5, name: "Adam Same", emails: [], phones: [] },
            { id: 3, name: "Adam Same", emails: [], phones: [] },
        ];
        assert.deepStrictEqual(ids(sortContacts(b)), [3, 5, 9]);
        assert.deepStrictEqual(ids(sortContacts([...b].reverse())), [3, 5, 9]);
        assert.deepStrictEqual(ids(searchContacts(b, "adam")), [3, 5]);
        assert.deepStrictEqual(ids(searchContacts([...b].reverse(), "adam")), [3, 5]);
    });
});
