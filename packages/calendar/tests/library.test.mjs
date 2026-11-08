import { test, describe } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("library entry", () => {
    test("the package name resolves through exports and exposes the client class and registerTools", async () => {
        const lib = await import("@infomaniak/mcp-server-calendar");
        assert.strictEqual(typeof lib.registerTools, "function");
        assert.strictEqual(typeof lib.CalendarClient, "function");
        const client = new lib.CalendarClient("token", { retryDelayMs: 1 });
        assert.ok(client instanceof lib.CalendarClient);
    });

    test("importing dist/tools.js has no side effects", () => {
        const env = { PATH: process.env.PATH };
        const child = spawnSync(
            process.execPath,
            ["--input-type=module", "-e", `await import(${JSON.stringify(path.join(root, "dist", "tools.js"))})`],
            { env, encoding: "utf8" },
        );
        assert.strictEqual(child.status, 0, child.stderr);
        assert.strictEqual(child.stdout, "");
        assert.strictEqual(child.stderr, "");
    });

    test("the SDK and zod are runtime dependencies with caret ranges inside the peer ranges", async () => {
        const { default: pkg } = await import("../package.json", { with: { type: "json" } });
        for (const name of ["@modelcontextprotocol/sdk", "zod"]) {
            assert.match(pkg.dependencies[name], /^\^\d+\.\d+\.\d+$/);
            const major = pkg.dependencies[name].slice(1).split(".")[0];
            assert.ok(pkg.peerDependencies[name].startsWith(`^${major}`));
            assert.ok(pkg.peerDependencies[name]);
            assert.ok(!pkg.devDependencies?.[name]);
        }
    });
});
