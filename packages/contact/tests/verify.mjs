import { test, describe } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ContactClient, buildUrl } from "../dist/contact-client.js";

describe("ContactClient instantiation", () => {
    test("creates a client with token", () => {
        const client = new ContactClient("test-token");
        assert.ok(client);
    });

    test("exposes all expected methods", () => {
        const client = new ContactClient("test-token");
        const methods = ["fetchAllContacts", "searchContacts"];
        for (const m of methods) {
            assert.strictEqual(
                typeof client[m],
                "function",
                `method ${m} should be a function`
            );
        }
    });
});

describe("ContactClient.fetchAllContacts", () => {
    async function withFetch(impl, fn) {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = impl;
        try {
            await fn();
        } finally {
            globalThis.fetch = originalFetch;
        }
    }
    const success = (data) => new Response(JSON.stringify({ result: "success", data }), { status: 200 });

    test("calls fetch with correct URL", async () => {
        let capturedUrl = null;
        await withFetch(
            async (url) => {
                capturedUrl = url;
                return success([]);
            },
            async () => {
                await new ContactClient("test-token").fetchAllContacts();
            },
        );
        assert.ok(capturedUrl, "fetch was called");
        assert.ok(capturedUrl.includes("contacts.infomaniak.com/api/pim"), "URL contains correct base URL");
        assert.ok(capturedUrl.includes("/contact/all"), "URL contains /contact/all");
    });

    test("returns contacts on success", async () => {
        const mockContacts = [{ id: 1, name: "John", emails: ["john@test.com"] }];
        await withFetch(
            async () => success(mockContacts),
            async () => {
                const result = await new ContactClient("test-token").fetchAllContacts();
                assert.deepStrictEqual(result, mockContacts, "returns contacts");
            },
        );
    });

    test("throws when result is not success", async () => {
        await withFetch(
            async () => new Response(JSON.stringify({ result: "error", message: "auth failed" }), { status: 200 }),
            async () => {
                await assert.rejects(new ContactClient("test-token").fetchAllContacts(), /auth failed/);
            },
        );
    });

    test("throws on HTTP error", async () => {
        await withFetch(
            async () => new Response("invalid token", { status: 401, statusText: "Unauthorized" }),
            async () => {
                await assert.rejects(new ContactClient("test-token").fetchAllContacts(), /401 Unauthorized/);
            },
        );
    });
});

describe("ContactClient.searchContacts", () => {
    const mockContacts = [
        { id: 1, name: "John Doe", firstname: "John", lastname: "Doe", emails: ["john@test.com"], phones: [] },
        { id: 2, name: "Jane Doe", firstname: "Jane", lastname: "Doe", emails: [], phones: ["123456"] },
        { id: 3, name: "Bob Smith", firstname: "Bob", lastname: "Smith", emails: [], phones: [] },
    ];

    test("filters by name", () => {
        const client = new ContactClient("test-token");
        const result = client.searchContacts(mockContacts, "John");

        assert.strictEqual(result.length, 1, "finds one contact");
        assert.strictEqual(result[0].id, 1, "finds John");
    });

    test("filters by firstname", () => {
        const client = new ContactClient("test-token");
        const result = client.searchContacts(mockContacts, "Jane");

        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].id, 2);
    });

    test("filters by email", () => {
        const client = new ContactClient("test-token");
        const result = client.searchContacts(mockContacts, "john@test");

        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].id, 1);
    });

    test("filters by phone", () => {
        const client = new ContactClient("test-token");
        const result = client.searchContacts(mockContacts, "123456");

        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].id, 2);
    });

    test("returns empty array for no match", () => {
        const client = new ContactClient("test-token");
        const result = client.searchContacts(mockContacts, "nonexistent");

        assert.strictEqual(result.length, 0);
    });

    test("is case insensitive", () => {
        const client = new ContactClient("test-token");
        const result = client.searchContacts(mockContacts, "JOHN");

        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].id, 1);
    });
});

describe("registerTools export", () => {
    test("importing dist/tools.js has no side effects and registers both tools", async () => {
        const { registerTools } = await import("../dist/tools.js");
        const registered = [];
        const server = { registerTool: (name) => registered.push(name) };
        registerTools(server, new ContactClient("test-token"));
        assert.deepStrictEqual(registered, ["contact_list_contacts", "contact_search_contacts"]);
    });

    test("importing dist/tools.js in a child process with no env writes nothing and exits 0", () => {
        const dist = fileURLToPath(new URL("../dist/tools.js", import.meta.url));
        const result = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(dist)});`], {
            env: {},
            encoding: "utf8",
        });
        assert.strictEqual(result.status, 0);
        assert.strictEqual(result.stdout, "");
        assert.strictEqual(result.stderr, "");
    });

    test("the package name resolves through exports and gives a host everything it needs", async () => {
        const pkg = await import("@infomaniak/mcp-server-contact");
        assert.strictEqual(typeof pkg.registerTools, "function");
        assert.strictEqual(typeof pkg.ContactClient, "function");
        const client = new pkg.ContactClient("test-token", { cacheTtlMs: 0 });
        assert.strictEqual(typeof client.fetchAllContacts, "function");
    });
});

describe("buildUrl", () => {
    test("encodes every path segment so it cannot escape the pim API", () => {
        const url = new URL(buildUrl(["contact", "../../2/drive/1/files/5"]));
        assert.strictEqual(url.host, "contacts.infomaniak.com");
        assert.ok(url.pathname.startsWith("/api/pim/contact/"));
        assert.ok(!url.pathname.includes("/../"));
        assert.strictEqual(url.pathname.split("/").length, 5);
    });

    test("builds the query through URLSearchParams", () => {
        const url = new URL(buildUrl(["contact", "all"], { with: "emails,phones", skip: undefined }));
        assert.strictEqual(url.pathname, "/api/pim/contact/all");
        assert.deepStrictEqual([...url.searchParams], [["with", "emails,phones"]]);
    });
});

describe("ContactClient errors", () => {
    async function withFetch(impl, fn) {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = impl;
        try {
            await fn();
        } finally {
            globalThis.fetch = originalFetch;
        }
    }

    test("HTTP error reports status, code and a message capped at 200 characters", async () => {
        const body = { result: "error", error: { code: "not_authorized", description: "x".repeat(500) } };
        await withFetch(
            async () => new Response(JSON.stringify(body), { status: 403 }),
            async () => {
                const client = new ContactClient("test-token");
                await assert.rejects(client.fetchAllContacts(), (err) => {
                    assert.match(err.message, /^403 not_authorized: x{200}$/);
                    return true;
                });
            },
        );
    });

    test("HTTP error with a non-JSON body never includes the body", async () => {
        await withFetch(
            async () => new Response("secret contact data", { status: 500, statusText: "Server Error" }),
            async () => {
                const client = new ContactClient("test-token");
                await assert.rejects(client.fetchAllContacts(), (err) => {
                    assert.strictEqual(err.message, "500 Server Error");
                    return true;
                });
            },
        );
    });

    test("result other than success on a 200 response throws", async () => {
        await withFetch(
            async () => new Response(JSON.stringify({ result: "error", error: { code: "oops", description: "bad" } }), { status: 200 }),
            async () => {
                const client = new ContactClient("test-token");
                await assert.rejects(client.fetchAllContacts(), /^Error: 200 oops: bad$/);
            },
        );
    });

    test("invalid JSON on a 200 response throws a short error", async () => {
        await withFetch(
            async () => new Response("<html>", { status: 200 }),
            async () => {
                const client = new ContactClient("test-token");
                await assert.rejects(client.fetchAllContacts(), /200 invalid_response/);
            },
        );
    });

    test("every request carries a 30 s timeout signal", async () => {
        let signal;
        const realTimeout = AbortSignal.timeout;
        const requested = [];
        AbortSignal.timeout = (ms) => {
            requested.push(ms);
            return realTimeout.call(AbortSignal, ms);
        };
        try {
            await withFetch(
                async (_url, init) => {
                    signal = init.signal;
                    return new Response(JSON.stringify({ result: "success", data: [] }), { status: 200 });
                },
                async () => {
                    await new ContactClient("test-token").fetchAllContacts();
                },
            );
        } finally {
            AbortSignal.timeout = realTimeout;
        }
        assert.ok(signal instanceof AbortSignal);
        assert.deepStrictEqual(requested, [30000]);
    });
});

describe("tool annotations", () => {
    test("every tool has a title and readOnlyHint", async () => {
        const { registerTools } = await import("../dist/tools.js");
        const tools = {};
        const server = { registerTool: (name, config) => { tools[name] = config; } };
        registerTools(server, new ContactClient("test-token"));
        for (const [name, config] of Object.entries(tools)) {
            assert.ok(config.title, `${name} has a title`);
            assert.strictEqual(config.annotations.readOnlyHint, true, `${name} readOnlyHint`);
            assert.strictEqual(config.annotations.openWorldHint, false, `${name} openWorldHint`);
        }
    });
});

describe("input schemas", () => {
    test("contact_search_contacts rejects empty, one-character and oversized queries", async () => {
        const { registerTools } = await import("../dist/tools.js");
        const { z } = await import("zod");
        let schema;
        const server = { registerTool: (name, config) => { if (name === "contact_search_contacts") schema = z.object(config.inputSchema); } };
        registerTools(server, new ContactClient("test-token"));
        assert.ok(!schema.safeParse({ query: "" }).success);
        assert.ok(!schema.safeParse({ query: "   " }).success);
        assert.ok(!schema.safeParse({ query: "a" }).success);
        assert.ok(!schema.safeParse({ query: "a".repeat(201) }).success);
        assert.ok(schema.safeParse({ query: "ab" }).success);
    });
});

describe("output shaping", () => {
    test("projectContact keeps the default fields only", async () => {
        const { projectContact } = await import("../dist/output.js");
        const out = projectContact({ id: 1, name: "A", emails: ["a@b.ch"], others: { secret: 1 }, user_id: 9 });
        assert.deepStrictEqual(out, { id: 1, name: "A", emails: ["a@b.ch"] });
    });

    test("listResult returns compact JSON text and structuredContent", async () => {
        const { listResult } = await import("../dist/output.js");
        const result = listResult([{ id: 1 }, { id: 2 }], { total: 2 });
        assert.strictEqual(result.content.length, 1);
        assert.strictEqual(result.content[0].text, '{"items":[{"id":1},{"id":2}],"has_more":false,"total":2}');
        assert.deepStrictEqual(result.structuredContent.items, [{ id: 1 }, { id: 2 }]);
    });

    test("listResult caps the text at 100000 characters and flags truncated", async () => {
        const { listResult, MAX_TEXT_CHARS } = await import("../dist/output.js");
        const items = Array.from({ length: 500 }, (_, id) => ({ id, name: "x".repeat(1000) }));
        const result = listResult(items, { total: 500 });
        assert.ok(result.content[0].text.length <= MAX_TEXT_CHARS);
        const payload = result.structuredContent;
        assert.strictEqual(payload.truncated, true);
        assert.strictEqual(payload.has_more, true);
        assert.strictEqual(payload.next_offset, payload.items.length);
        assert.ok(payload.items.length > 0 && payload.items.length < 500);
        assert.strictEqual(JSON.parse(result.content[0].text).truncated, true);
    });

    test("an item larger than the cap is returned with its long text cut, and paging advances", async () => {
        const { listResult, MAX_TEXT_CHARS } = await import("../dist/output.js");
        const huge = { id: 7, name: "Big", others: { note: "n".repeat(300000) } };
        const result = listResult([huge, { id: 8 }], { offset: 4, total: 6 });
        const text = result.content[0].text;
        assert.ok(text.length <= MAX_TEXT_CHARS);
        const payload = JSON.parse(text);
        assert.deepStrictEqual(payload.items.map((i) => i.id), [7]);
        assert.strictEqual(payload.items[0].name, "Big");
        assert.ok(payload.items[0].others.note.length < 300000);
        assert.strictEqual(payload.truncated, true);
        assert.strictEqual(payload.has_more, true);
        assert.strictEqual(payload.next_offset, 5);
    });

    test("dropped items resume right after the last returned item and never skip", async () => {
        const { listResult, MAX_TEXT_CHARS } = await import("../dist/output.js");
        const items = Array.from({ length: 300 }, (_, id) => ({ id, name: "x".repeat(1000) }));
        const seen = [];
        let offset = 0;
        for (let guard = 0; guard < 50; guard++) {
            const result = listResult(items.slice(offset), { offset, total: 300 });
            const payload = result.structuredContent;
            assert.ok(result.content[0].text.length <= MAX_TEXT_CHARS);
            assert.ok(payload.items.length > 0, "a page is never empty");
            seen.push(...payload.items.map((i) => i.id));
            if (!payload.has_more) break;
            assert.strictEqual(payload.next_offset, offset + payload.items.length);
            offset = payload.next_offset;
        }
        assert.deepStrictEqual(seen, items.map((i) => i.id));
    });
});

describe("ContactClient retries and limits", () => {
    const ok = () => new Response(JSON.stringify({ result: "success", data: [{ id: 1 }] }), { status: 200 });
    async function withFetch(impl, fn) {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = impl;
        try {
            await fn();
        } finally {
            globalThis.fetch = originalFetch;
        }
    }

    test("a GET is retried once after 503 and cancels the first body", async () => {
        let calls = 0;
        let cancelled = false;
        const sleeps = [];
        await withFetch(
            async () => {
                calls += 1;
                if (calls === 1) {
                    const body = new ReadableStream({ cancel() { cancelled = true; } });
                    return new Response(body, { status: 503 });
                }
                return ok();
            },
            async () => {
                const client = new ContactClient("t", { sleep: async (ms) => { sleeps.push(ms); } });
                assert.deepStrictEqual(await client.fetchAllContacts(), [{ id: 1 }]);
            },
        );
        assert.strictEqual(calls, 2);
        assert.strictEqual(cancelled, true);
        assert.deepStrictEqual(sleeps, [500]);
    });

    test("Retry-After is honored on 429 and capped at 10 s", async () => {
        for (const [header, expected] of [["3", 3000], ["120", 10000]]) {
            let calls = 0;
            const sleeps = [];
            await withFetch(
                async () => (++calls === 1 ? new Response("", { status: 429, headers: { "retry-after": header } }) : ok()),
                async () => {
                    const client = new ContactClient("t", { sleep: async (ms) => { sleeps.push(ms); } });
                    await client.fetchAllContacts();
                },
            );
            assert.deepStrictEqual(sleeps, [expected]);
        }
    });

    test("a second 503 is reported, not retried again", async () => {
        let calls = 0;
        await withFetch(
            async () => { calls += 1; return new Response("{}", { status: 503, statusText: "Unavailable" }); },
            async () => {
                const client = new ContactClient("t", { sleep: async () => {} });
                await assert.rejects(client.fetchAllContacts(), /^Error: 503 error: $/);
            },
        );
        assert.strictEqual(calls, 2);
    });

    test("a network error is retried once, then reports the cause code", async () => {
        let calls = 0;
        await withFetch(
            async () => { calls += 1; throw new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } }); },
            async () => {
                const client = new ContactClient("t", { sleep: async () => {} });
                await assert.rejects(client.fetchAllContacts(), /^Error: network error: ENOTFOUND$/);
            },
        );
        assert.strictEqual(calls, 2);
    });

    test("a timeout reports 30 s", async () => {
        await withFetch(
            async () => { throw new DOMException("timed out", "TimeoutError"); },
            async () => {
                const client = new ContactClient("t", { sleep: async () => {} });
                await assert.rejects(client.fetchAllContacts(), /^Error: request timed out after 30 s$/);
            },
        );
    });

    test("an error object without description or message does not print [object Object]", async () => {
        await withFetch(
            async () => new Response(JSON.stringify({ result: "error", error: { code: "x" } }), { status: 400 }),
            async () => {
                await assert.rejects(new ContactClient("t").fetchAllContacts(), /^Error: 400 x: $/);
            },
        );
    });

    test("a response over the size cap is cancelled while streaming", async () => {
        let cancelled = false;
        let pulled = 0;
        const chunk = new Uint8Array(8 * 1024 * 1024);
        await withFetch(
            async () =>
                new Response(
                    new ReadableStream({
                        pull(controller) { pulled += 1; controller.enqueue(chunk); },
                        cancel() { cancelled = true; },
                    }),
                    { status: 200 },
                ),
            async () => {
                await assert.rejects(new ContactClient("t").fetchAllContacts(), /response_too_large/);
            },
        );
        assert.strictEqual(cancelled, true);
        assert.ok(pulled <= 8, `read ${pulled} chunks`);
    });

    test("a declared content-length over the cap is refused without reading", async () => {
        await withFetch(
            async () => new Response("{}", { status: 200, headers: { "content-length": "99999999999" } }),
            async () => {
                await assert.rejects(new ContactClient("t").fetchAllContacts(), /response_too_large/);
            },
        );
    });

    test("a non-numeric content-length counts as unknown and the stream is still capped", async () => {
        await withFetch(
            async () => new Response(JSON.stringify({ result: "success", data: [] }), { status: 200, headers: { "content-length": "abc" } }),
            async () => {
                assert.deepStrictEqual(await new ContactClient("t").fetchAllContacts(), []);
            },
        );
    });
});

