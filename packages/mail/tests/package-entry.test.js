import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";

describe("package entry", () => {
    it("exports registerTools and MailClient when imported by package name", async () => {
        const entry = await import("@infomaniak/mcp-server-mail");
        assert.strictEqual(typeof entry.registerTools, "function");
        assert.strictEqual(typeof entry.MailClient, "function");
        assert.ok(new entry.MailClient("token", { timeoutMs: 1000 }) instanceof entry.MailClient);
    });

    it("lists the SDK and zod as dependencies and peer dependencies, not dev dependencies", () => {
        const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
        for (const name of ["@modelcontextprotocol/sdk", "zod"]) {
            assert.match(pkg.dependencies[name], /^\^\d/, `${name} has a caret range in dependencies`);
            assert.ok(pkg.peerDependencies[name], `${name} is a peer dependency`);
            assert.strictEqual(pkg.devDependencies?.[name], undefined);
        }
        assert.strictEqual(pkg.devDependencies.shx, undefined);
    });
});
