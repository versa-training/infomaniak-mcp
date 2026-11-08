import {test, before, after} from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {createRequire} from "node:module";
import {loadConfig} from "../dist/config.js";
import {buildProducts, checkToolNames} from "../dist/products.js";
import {createApp} from "../dist/app.js";
import {TokenResolver} from "../dist/auth.js";

const TOKEN = "t".repeat(40);
const baseEnv = {MCP_BEARER_TOKEN: TOKEN, INFOMANIAK_TOKEN: "x", KDRIVE_ID: "1", KCHAT_TEAM_NAME: "team", PORT: "0"};

const fetchCalls = [];
const realFetch = globalThis.fetch;
const MCP_HEADERS = {"Content-Type": "application/json", Accept: "application/json, text/event-stream"};
const rpc = (method, params = {}, id = 1) => JSON.stringify({jsonrpc: "2.0", id, method, params});
const INIT = rpc("initialize", {protocolVersion: "2025-03-26", capabilities: {}, clientInfo: {name: "t", version: "0"}});

async function start(env) {
    const config = loadConfig({...baseEnv, ...env});
    const products = buildProducts(config, () => {});
    const resolver = new TokenResolver(config.allowedEmailDomains, async () => ({status: 401}));
    const server = createApp(config, products, {resolver});
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    return {server, url: `http://127.0.0.1:${server.address().port}`, products};
}
const post = (url, body, token = TOKEN) =>
    realFetch(`${url}/mcp`, {method: "POST", headers: {...MCP_HEADERS, ...(token ? {Authorization: `Bearer ${token}`} : {})}, body});
const listTools = async (url) => (await (await post(url, rpc("tools/list"))).json()).result.tools.map((t) => t.name);

let app;
before(async () => {
    globalThis.fetch = async (...a) => {
        fetchCalls.push(a[0]);
        throw new Error("no live calls in tests");
    };
    app = await start({});
});
after(() => {
    globalThis.fetch = realFetch;
    app.server.close();
});

test("401 without token and with wrong token", async () => {
    const none = await post(app.url, INIT, null);
    assert.equal(none.status, 401);
    assert.equal(none.headers.get("www-authenticate"), "Bearer");
    const wrong = await post(app.url, INIT, "w".repeat(40));
    assert.equal(wrong.status, 401);
    const shorter = await post(app.url, INIT, "w");
    assert.equal(shorter.status, 401);
});

test("initialize returns 200 with the right token", async () => {
    const res = await post(app.url, INIT);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.result.serverInfo.name, "infomaniak-mcp");
});

test("tools/list is the union of all five forks", async () => {
    const names = await listTools(app.url);
    const per = await checkToolNames(app.products);
    assert.deepEqual(Object.keys(per).sort(), ["calendar", "contact", "kchat", "kdrive", "mail"]);
    const sum = Object.values(per).reduce((n, l) => n + l.length, 0);
    assert.equal(names.length, sum);
    assert.equal(new Set(names).size, names.length);
    for (const l of Object.values(per)) for (const n of l) assert.ok(names.includes(n), n);
    assert.ok(sum > 0 && Object.values(per).every((l) => l.length > 0));
    assert.equal(fetchCalls.length, 0);
});

test("send tools are absent unless MAIL_ALLOW_SEND=true", async () => {
    const off = (await listTools(app.url)).filter((n) => /send/i.test(n) && n.startsWith("mail"));
    assert.deepEqual(off, []);
    const on = await start({MAIL_ALLOW_SEND: "true"});
    try {
        const names = (await listTools(on.url)).filter((n) => /send/i.test(n) && n.startsWith("mail"));
        assert.ok(names.length > 0, "send tools present when enabled");
    } finally {
        on.server.close();
    }
});

test("startup fails on a short bearer token and on an invalid flag", () => {
    assert.throws(() => loadConfig({...baseEnv, MCP_BEARER_TOKEN: "short"}), /at least 32/);
    assert.throws(() => loadConfig({...baseEnv, MAIL_ALLOW_SEND: "maybe"}), /MAIL_ALLOW_SEND/);
    for (const v of ["true", "false", "1", "0", "yes", "no"]) loadConfig({...baseEnv, KDRIVE_ALLOW_PUBLIC_LINKS: v});
    const r = spawnSync(process.execPath, ["dist/index.js"], {env: {PATH: process.env.PATH, MCP_BEARER_TOKEN: "short"}, encoding: "utf8"});
    assert.equal(r.status, 1);
    assert.match(r.stderr, /at least 32/);
    const r2 = spawnSync(process.execPath, ["dist/index.js"], {env: {PATH: process.env.PATH, MCP_BEARER_TOKEN: TOKEN, KDRIVE_ALLOW_PUBLIC_LINKS: "x"}, encoding: "utf8"});
    assert.equal(r2.status, 1);
});

test("missing product env skips the product without crashing", () => {
    const logs = [];
    const products = buildProducts(loadConfig({MCP_BEARER_TOKEN: TOKEN, INFOMANIAK_TOKEN: "x"}), (l) => logs.push(l));
    assert.deepEqual(products.map((p) => p.name), ["mail", "calendar", "contact"]);
    assert.equal(logs.length, 2);
});

test("a body over 1 MB gets 413", async () => {
    const big = JSON.stringify({jsonrpc: "2.0", id: 1, method: "tools/list", params: {pad: "a".repeat(1024 * 1024 + 10)}});
    const res = await post(app.url, big);
    assert.equal(res.status, 413);
});

test("/healthz answers without auth; other paths 404", async () => {
    const res = await realFetch(`${app.url}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {ok: true});
    assert.equal((await realFetch(`${app.url}/other`)).status, 404);
});
