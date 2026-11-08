import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("the SDK and zod are runtime dependencies as caret ranges and also peers", () => {
    for (const name of ["@modelcontextprotocol/sdk", "zod"]) {
        assert.match(pkg.dependencies[name], /^\^\d+\.\d+\.\d+$/, `${name} is a caret range in dependencies`);
        assert.ok(pkg.peerDependencies[name], `${name} is a peer dependency`);
        assert.strictEqual(pkg.devDependencies?.[name], undefined, `${name} is not a devDependency`);
    }
});
