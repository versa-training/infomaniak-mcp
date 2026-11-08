import { test, describe } from "node:test";
import assert from "node:assert";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools } from "../dist/tools.js";
import { KchatClient } from "../dist/kchat-client.js";

describe("registerTools", () => {
    test("registerTools registers the tools and advertises only tools", async () => {
        const server = new McpServer({ name: "test", version: "0.0.0" });
        registerTools(server, new KchatClient("token", "team"));

        const client = new Client({ name: "c", version: "0.0.0" });
        const [a, b] = InMemoryTransport.createLinkedPair();
        await Promise.all([server.connect(a), client.connect(b)]);

        const { tools } = await client.listTools();
        assert.ok(tools.length >= 9);
        assert.deepStrictEqual(Object.keys(client.getServerCapabilities()), ["tools"]);
        await client.close();
    });
});

describe("tool metadata", () => {
    test("every tool has a title and a readOnlyHint, and write tools set destructiveHint", async () => {
        const server = new McpServer({ name: "test", version: "0.0.0" });
        registerTools(server, new KchatClient("token", "team"));
        const client = new Client({ name: "c", version: "0.0.0" });
        const [a, b] = InMemoryTransport.createLinkedPair();
        await Promise.all([server.connect(a), client.connect(b)]);

        const { tools } = await client.listTools();
        for (const tool of tools) {
            assert.ok(tool.title, `${tool.name} has a title`);
            assert.strictEqual(typeof tool.annotations.readOnlyHint, "boolean", `${tool.name} readOnlyHint`);
            if (!tool.annotations.readOnlyHint) {
                assert.strictEqual(typeof tool.annotations.destructiveHint, "boolean", `${tool.name} destructiveHint`);
            }
        }
        const dm = tools.find((tool) => tool.name === "kchat_send_direct_message");
        assert.strictEqual(dm.annotations.openWorldHint, true);
        await client.close();
    });
});

describe("package surface", () => {
    test("importing dist/tools.js in a child process reads no env and prints nothing", async () => {
        const { spawnSync } = await import("node:child_process");
        const result = spawnSync(process.execPath, ["--input-type=module", "-e", 'await import("./dist/tools.js");'], {
            cwd: new URL("..", import.meta.url),
            env: { PATH: process.env.PATH },
            encoding: "utf8",
        });
        assert.strictEqual(result.status, 0);
        assert.strictEqual(result.stdout, "");
        assert.strictEqual(result.stderr, "");
    });

    test("the package imports by its own name and exports the client as a value", async () => {
        const self = await import("@infomaniak/mcp-server-kchat");
        assert.strictEqual(typeof self.registerTools, "function");
        assert.strictEqual(typeof self.KchatClient, "function");
        const server = new McpServer({ name: "test", version: "0.0.0" });
        self.registerTools(server, new self.KchatClient("token", "team"));
    });
});
