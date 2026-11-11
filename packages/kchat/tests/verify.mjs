import { test, describe } from "node:test";
import assert from "node:assert";
import { KchatClient, withCallSignal } from "../dist/kchat-client.js";
import { mockFetch } from "./helpers/mock-fetch.mjs";

const make = (fetchStub, options = {}) =>
    new KchatClient("mock-token", "my-team", { fetch: fetchStub, retryDelayMs: 1, ...options });

describe("KchatClient instantiation", () => {
    test("exposes all expected methods", () => {
        const client = make(mockFetch());
        const methods = [
            "getTeamByName", "getChannels", "postMessage", "addReaction",
            "getPostForChannel", "getPost", "getThread", "getUsers", "getUser", "getMyChannels",
            "getCurrentUser", "getUserByUsername", "createDirectChannel", "sendDirectMessage",
        ];
        for (const m of methods) {
            assert.strictEqual(typeof client[m], "function", `method ${m} should be a function`);
        }
    });

    test("rejects a team name that could change the host", () => {
        assert.throws(() => new KchatClient("t", "evil.example.com/x"), /Invalid kChat team name/);
    });
});

describe("KchatClient requests", () => {
    test("getTeamByName", async () => {
        const f = mockFetch({ body: { id: "team-123" } });
        await make(f).getTeamByName();
        assert.strictEqual(f.calls[0].url.href, "https://my-team.kchat.infomaniak.com/api/v4/teams/name/my-team");
        assert.strictEqual(f.calls[0].method, "GET");
    });

    test("getChannels resolves the team, then clamps per_page to 100", async () => {
        const f = mockFetch({ body: { id: "team-123" } }, { body: [] });
        await make(f).getChannels(500, 2);
        assert.strictEqual(f.calls[1].url.pathname, "/api/v4/teams/team-123/channels");
        assert.strictEqual(f.calls[1].url.searchParams.get("per_page"), "100");
        assert.strictEqual(f.calls[1].url.searchParams.get("page"), "2");
    });

    test("postMessage sends a POST with channel, message, and root", async () => {
        const f = mockFetch({ body: { id: "post-123" } });
        await make(f).postMessage("channel-123", "Hello world", "root-1");
        assert.strictEqual(f.calls[0].url.pathname, "/api/v4/posts");
        assert.strictEqual(f.calls[0].method, "POST");
        assert.deepStrictEqual(JSON.parse(f.calls[0].body), {
            channel_id: "channel-123", message: "Hello world", root_id: "root-1",
        });
    });

    test("addReaction posts post_id and emoji_name", async () => {
        const f = mockFetch({ body: { id: "me" } }, { body: {} });
        await make(f).addReaction("p1", "thumbsup");
        assert.strictEqual(f.calls[1].url.pathname, "/api/v4/reactions");
        assert.deepStrictEqual(JSON.parse(f.calls[1].body), { user_id: "me", post_id: "p1", emoji_name: "thumbsup" });
    });

    test("getPost, getThread, getUser, getCurrentUser", async () => {
        const f = mockFetch({ body: {} });
        const client = make(f);
        await client.getPost("p1");
        await client.getThread("p1", { limit: 10 });
        await client.getUser("u1");
        await client.getCurrentUser();
        assert.deepStrictEqual(f.calls.map((c) => c.url.pathname), [
            "/api/v4/posts/p1", "/api/v4/posts/p1/thread", "/api/v4/users/u1", "/api/v4/users/me",
        ]);
    });

    test("getUsers filters to active users of the team and allows 200 per page", async () => {
        const f = mockFetch({ body: { id: "team-1" } }, { body: [] });
        await make(f).getUsers(250, 1);
        const url = f.calls[1].url;
        assert.strictEqual(url.pathname, "/api/v4/users");
        assert.strictEqual(url.searchParams.get("per_page"), "200");
        assert.strictEqual(url.searchParams.get("page"), "1");
        assert.strictEqual(url.searchParams.get("in_team"), "team-1");
        assert.strictEqual(url.searchParams.get("active"), "true");
    });

    test("caches the team ID across calls and does not cache a failure", async () => {
        const f = mockFetch({ status: 500, body: {} }, { body: { id: "team-1" } }, { body: [] }, { body: [] });
        const client = make(f);
        await assert.rejects(client.getUsers(10, 0), /500/);
        await client.getUsers(10, 0);
        await client.getUsers(10, 0);
        const teamLookups = f.calls.filter((c) => c.url.pathname.startsWith("/api/v4/teams/name/"));
        assert.strictEqual(teamLookups.length, 2);
    });

    test("getMyChannels lists the user's channels and pages locally", async () => {
        const channels = Array.from({ length: 5 }, (_, i) => ({ id: `c${i}` }));
        const f = mockFetch({ body: { id: "team-1" } }, { body: channels });
        const result = await make(f).getMyChannels(2, 1);
        assert.strictEqual(f.calls[1].url.pathname, "/api/v4/users/me/teams/team-1/channels");
        assert.deepStrictEqual(result.channels.map((c) => c.id), ["c2", "c3"]);
        assert.strictEqual(result.total, 5);
    });

    test("getPostForChannel passes page and before, sends only since in since mode, and returns an ordered array", async () => {
        const list = {
            order: ["p2", "p1"],
            posts: { p1: { id: "p1" }, p2: { id: "p2" } },
            has_next: true,
            prev_post_id: "p0",
            next_post_id: "",
        };
        const f = mockFetch({ body: list });
        const page = await make(f).getPostForChannel("c1", { limit: 50, page: 3, before: "b" });
        const url = f.calls[0].url;
        assert.strictEqual(url.pathname, "/api/v4/channels/c1/posts");
        assert.strictEqual(url.searchParams.get("per_page"), "50");
        assert.strictEqual(url.searchParams.get("page"), "3");
        assert.strictEqual(url.searchParams.get("before"), "b");
        assert.strictEqual(url.searchParams.has("since"), false);
        assert.strictEqual(url.searchParams.has("after"), false);
        await make(f).getPostForChannel("c1", { limit: 50, page: 3, before: "b", since: 99 });
        assert.deepStrictEqual([...f.calls[1].url.searchParams.entries()], [["since", "99"]]);
        assert.deepStrictEqual(page.posts.map((p) => p.id), ["p2", "p1"]);
        assert.strictEqual(page.has_next, true);
        assert.strictEqual(page.prev_post_id, "p0");
        assert.strictEqual("next_post_id" in page, false);
    });

    test("getThread sorts the posts by create_at", async () => {
        const f = mockFetch({ body: {
            order: ["b", "a"],
            posts: { a: { id: "a", create_at: 1 }, b: { id: "b", create_at: 2 } },
        } });
        const page = await make(f).getThread("a", { limit: 10 });
        assert.deepStrictEqual(page.posts.map((p) => p.id), ["a", "b"]);
    });

    test("addReaction sends the current user's ID, resolved once", async () => {
        const f = mockFetch({ body: { id: "me-1" } }, { body: {} });
        const client = make(f);
        await client.addReaction("p1", "thumbsup");
        await client.addReaction("p2", "tada");
        assert.deepStrictEqual(JSON.parse(f.calls[1].body), { user_id: "me-1", post_id: "p1", emoji_name: "thumbsup" });
        assert.strictEqual(f.calls.filter((c) => c.url.pathname === "/api/v4/users/me").length, 1);
    });

    test("getUserByUsername strips @, lowercases, and checks the returned user", async () => {
        const f = mockFetch({ body: { id: "u1", username: "alice" } }, { body: { id: "u2", username: "other" } });
        const client = make(f);
        const user = await client.getUserByUsername("@Alice");
        assert.strictEqual(f.calls[0].url.pathname, "/api/v4/users/username/alice");
        assert.strictEqual(user.id, "u1");
        await assert.rejects(client.getUserByUsername("alice"), /User not found/);
    });

    test("getUserByUsername rejects path characters before any request", async () => {
        const f = mockFetch({ body: {} });
        await assert.rejects(make(f).getUserByUsername("../teams"), /Invalid username/);
        await assert.rejects(make(f).getUserByUsername("a?b"), /Invalid username/);
        assert.strictEqual(f.calls.length, 0);
    });

    test("getUserByUsername rejects dots-only names before any request", async () => {
        const f = mockFetch({ body: {} });
        for (const name of [".", "..", "..."]) {
            await assert.rejects(make(f).getUserByUsername(name), /Invalid username/);
        }
        assert.strictEqual(f.calls.length, 0);
    });

    test("getUserByUsername accepts dotted, short, and 64-character names and rejects 65", async () => {
        for (const name of ["a.b", "@Name", "a", "x".repeat(64)]) {
            const clean = name.replace(/^@/, "").toLowerCase();
            const f = mockFetch({ body: { id: "u1", username: clean } });
            const user = await make(f).getUserByUsername(name);
            assert.strictEqual(user.id, "u1");
            assert.strictEqual(f.calls.length, 1);
        }
        const f = mockFetch({ body: {} });
        await assert.rejects(make(f).getUserByUsername("x".repeat(65)), /Invalid username/);
        assert.strictEqual(f.calls.length, 0);
    });

    test("createDirectChannel posts the id pair as the body", async () => {
        const f = mockFetch({ body: { id: "dm" } });
        await make(f).createDirectChannel(["a", "b"]);
        assert.strictEqual(f.calls[0].url.pathname, "/api/v4/channels/direct");
        assert.deepStrictEqual(JSON.parse(f.calls[0].body), ["a", "b"]);
    });

    test("sendDirectMessage looks up me, opens the channel, and posts", async () => {
        const f = mockFetch({ body: { id: "me" } }, { body: { id: "dm" } }, { body: { id: "post" } });
        const result = await make(f).sendDirectMessage("u2", "hi");
        assert.deepStrictEqual(f.calls.map((c) => c.url.pathname), [
            "/api/v4/users/me", "/api/v4/channels/direct", "/api/v4/posts",
        ]);
        assert.strictEqual(JSON.parse(f.calls[2].body).channel_id, "dm");
        assert.strictEqual(result.id, "post");
    });

    test("encodes every path segment", async () => {
        const f = mockFetch({ body: {} });
        await make(f).getUser("../../teams?x=1#frag");
        assert.strictEqual(f.calls[0].url.pathname, "/api/v4/users/..%2F..%2Fteams%3Fx%3D1%23frag");
        assert.strictEqual(f.calls[0].url.search, "");
    });

    test("every request carries a timeout signal", async () => {
        const f = mockFetch({ body: {} });
        await make(f).getPost("p1");
        assert.ok(f.calls[0].signal instanceof AbortSignal);
    });
});

describe("KchatClient errors and retries", () => {
    test("throws status, API code, and a message capped at 200 characters", async () => {
        const f = mockFetch({ status: 403, body: { id: "api.context.permissions.app_error", message: "x".repeat(500), secret: "leak" } });
        await assert.rejects(make(f).getPost("p1"), (error) => {
            assert.match(error.message, /^403 api\.context\.permissions\.app_error: x{200}$/);
            assert.ok(!error.message.includes("leak"));
            return true;
        });
    });

    test("handles a non-JSON error body", async () => {
        const f = mockFetch({ status: 500, body: "<html>oops</html>" });
        await assert.rejects(make(f, { retryDelayMs: 1 }).postMessage("c", "t", undefined), /^Error: 500/);
        assert.strictEqual(f.calls.length, 1, "POST is never retried");
    });

    test("retries a GET once on 503", async () => {
        const f = mockFetch({ status: 503, body: {} }, { body: { id: "p1" } });
        const result = await make(f).getPost("p1");
        assert.strictEqual(result.id, "p1");
        assert.strictEqual(f.calls.length, 2);
    });

    test("retries a GET once on a network error, then throws without the cause text", async () => {
        const f = mockFetch(new TypeError("fetch failed token=abc"));
        await assert.rejects(make(f).getPost("p1"), (error) => {
            assert.ok(!error.message.includes("token=abc"));
            return true;
        });
        assert.strictEqual(f.calls.length, 2);
    });

    test("does not retry after a TimeoutError", async () => {
        const f = mockFetch(new DOMException("timed out", "TimeoutError"));
        await assert.rejects(make(f).getPost("p1"), /timed out after 30 s/);
        assert.strictEqual(f.calls.length, 1);
    });

    test("retries the read-only POSTs once on a 503, but not a write", async () => {
        const f = mockFetch({ status: 503, body: {} }, { body: [] });
        await make(f).getUsersByIds(["u1"]);
        assert.strictEqual(f.calls.length, 2);
        const g = mockFetch({ status: 503, body: {} }, { body: {} });
        await assert.rejects(make(g).postMessage("c1", "hi", undefined), /503/);
        assert.strictEqual(g.calls.length, 1);
    });

    test("one overall deadline stops the request and its retry", async () => {
        const waiting = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
        let calls = 0;
        const f = async (url, init) => { calls++; return waiting(url, init); };
        await assert.rejects(withCallSignal(undefined, () => make(f).getPost("p1"), 20), /tool call timed out/);
        assert.strictEqual(calls, 1);
    });

    test("a cancelled call does not fail another call sharing the same cached load", async () => {
        const gate = Promise.withResolvers();
        const f = async (url) => {
            await gate.promise;
            const path = new URL(url).pathname;
            return new Response(JSON.stringify(path.endsWith("/teams/name/my-team") ? { id: "team-123" } : []), { status: 200, headers: { "content-type": "application/json" } });
        };
        const client = make(f);
        const controller = new AbortController();
        const a = withCallSignal(controller.signal, () => client.getTeamId());
        const b = withCallSignal(undefined, () => client.getTeamId());
        controller.abort();
        await assert.rejects(a);
        gate.resolve();
        assert.strictEqual(await b, "team-123");
        assert.strictEqual(await withCallSignal(undefined, () => client.getTeamId()), "team-123");
    });

    test("a failed shared load is not cached", async () => {
        const f = mockFetch({ status: 500, body: {} }, { body: { id: "team-9" } });
        const client = make(f);
        await assert.rejects(client.getTeamId());
        assert.strictEqual(await client.getTeamId(), "team-9");
    });

    test("a cancelled call aborts the pending request without a retry", async () => {
        const controller = new AbortController();
        let calls = 0;
        const f = (url, init) => new Promise((_, reject) => {
            calls++;
            init.signal.addEventListener("abort", () => reject(init.signal.reason));
        });
        const pending = withCallSignal(controller.signal, () => make(f).getPost("p1"));
        setTimeout(() => controller.abort(), 10);
        await assert.rejects(pending, /cancelled/);
        assert.strictEqual(calls, 1);
    });

    test("honors Retry-After on 429, capped at 10 s, and cancels the first body", async () => {
        const f = mockFetch({ status: 429, headers: { "retry-after": "0" }, body: {} }, { body: { id: "p1" } });
        const result = await make(f, { retryDelayMs: 5000 }).getPost("p1");
        assert.strictEqual(result.id, "p1");
        assert.strictEqual(f.calls.length, 2);
    });

    test("reports the network error code or a timeout, without URL or token", async () => {
        const dns = Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
        await assert.rejects(make(mockFetch(dns)).getPost("p1"), /^Error: kChat request failed: ENOTFOUND$/);
        const timeout = Object.assign(new Error("aborted"), { name: "TimeoutError" });
        await assert.rejects(make(mockFetch(timeout)).getPost("p1"), /timed out after 30 s/);
    });

    test("download cancels the stream once it passes 5 MB, even with an unknown size", async () => {
        let cancelled = false;
        const chunk = new Uint8Array(1024 * 1024);
        const stream = new ReadableStream({
            pull(controller) { controller.enqueue(chunk); },
            cancel() { cancelled = true; },
        });
        const answers = [
            new Response(JSON.stringify({ mime_type: "text/plain" })),
            new Response(stream),
        ];
        const f = async () => answers.shift();
        await assert.rejects(make(f).downloadFile("f1"), /larger than 5 MB/);
        assert.strictEqual(cancelled, true);
    });

    test("does not retry a 404", async () => {
        const f = mockFetch({ status: 404, body: { id: "x", message: "nope" } });
        await assert.rejects(make(f).getPost("p1"), /^Error: 404 x: nope$/);
        assert.strictEqual(f.calls.length, 1);
    });
});
