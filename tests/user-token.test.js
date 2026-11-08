import {test} from "node:test";
import assert from "node:assert/strict";
import {loadConfig} from "../dist/config.js";
import {buildProducts} from "../dist/products.js";
import {createApp} from "../dist/app.js";
import {TokenResolver} from "../dist/auth.js";

const SHARED = "s".repeat(40);
const HEADERS = {"Content-Type": "application/json", Accept: "application/json, text/event-stream"};
const rpc = (method, params = {}) => JSON.stringify({jsonrpc: "2.0", id: 1, method, params});
const INIT = rpc("initialize", {protocolVersion: "2025-03-26", capabilities: {}, clientInfo: {name: "t", version: "0"}});

const PROFILES = {
    "good-user": {status: 200, email: "user@versa.training"},
    "other-domain": {status: 200, email: "bob@example.com"},
    "no-scope": {status: 403},
    "expired": {status: 401},
};

async function start(env = {}) {
    const config = loadConfig({MCP_BEARER_TOKEN: SHARED, INFOMANIAK_TOKEN: "shared-ik", KDRIVE_ID: "1", KCHAT_TEAM_NAME: "nimbus", PORT: "0", ...env});
    const profileCalls = [];
    const built = [];
    const resolver = new TokenResolver(config.allowedEmailDomains, async (token) => {
        profileCalls.push(token);
        return PROFILES[token] ?? {status: 401};
    });
    const buildFor = (token) => {
        built.push(token);
        return buildProducts(config, () => {}, token);
    };
    const server = createApp(config, buildProducts(config, () => {}), {resolver, buildFor});
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${server.address().port}/mcp`;
    const post = (token, body = INIT) => fetch(url, {method: "POST", headers: {...HEADERS, Authorization: `Bearer ${token}`}, body});
    return {server, post, profileCalls, built};
}

test("a versa.training user's own Infomaniak token works and is checked once", async () => {
    const app = await start();
    try {
        assert.equal((await app.post("good-user")).status, 200);
        const list = await (await app.post("good-user", rpc("tools/list"))).json();
        assert.ok(list.result.tools.length > 50);
        assert.deepEqual(app.profileCalls, ["good-user"]);
        assert.deepEqual(app.built, ["good-user"]);
    } finally {
        app.server.close();
    }
});

test("other domains get 403, missing scopes and expired tokens get 401", async () => {
    const app = await start();
    try {
        const other = await app.post("other-domain");
        assert.equal(other.status, 403);
        assert.match((await other.json()).error, /not allowed/);
        const scope = await app.post("no-scope");
        assert.equal(scope.status, 401);
        assert.match(scope.headers.get("www-authenticate"), /invalid_token/);
        assert.match((await scope.json()).error, /user_info/);
        assert.equal((await app.post("expired")).status, 401);
        assert.deepEqual(app.built, []);
    } finally {
        app.server.close();
    }
});

test("the shared token still works and skips the profile check", async () => {
    const app = await start();
    try {
        assert.equal((await app.post(SHARED)).status, 200);
        assert.deepEqual(app.profileCalls, []);
    } finally {
        app.server.close();
    }
});

test("ALLOWED_EMAIL_DOMAINS widens the allowlist; shared token is optional", async () => {
    const app = await start({ALLOWED_EMAIL_DOMAINS: "versa.training, example.com"});
    try {
        assert.equal((await app.post("other-domain")).status, 200);
    } finally {
        app.server.close();
    }
    const config = loadConfig({PORT: "0"});
    assert.equal(config.bearerToken, undefined);
    assert.deepEqual(config.allowedEmailDomains, ["versa.training"]);
    assert.throws(() => loadConfig({MCP_BEARER_TOKEN: SHARED}), /needs INFOMANIAK_TOKEN/);
});

test("a failing profile check is a 503, not a crash", async () => {
    const config = loadConfig({PORT: "0"});
    const resolver = new TokenResolver(["versa.training"], async () => {
        throw new Error("network");
    });
    const server = createApp(config, [], {resolver, buildFor: () => []});
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, {method: "POST", headers: {...HEADERS, Authorization: "Bearer x"}, body: INIT});
        assert.equal(res.status, 503);
    } finally {
        server.close();
    }
});
