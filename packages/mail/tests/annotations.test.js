import { describe, it } from "node:test";
import assert from "node:assert";
import { connectTools } from "./helpers.js";

describe("tool annotations", () => {
    it("every tool declares a title and explicit hints", async () => {
        const { mcp, close } = await connectTools();
        try {
            const { tools } = await mcp.listTools();
            assert.ok(tools.length >= 20);
            for (const tool of tools) {
                const a = tool.annotations ?? {};
                assert.ok(tool.title, `${tool.name} title`);
                assert.strictEqual(typeof a.readOnlyHint, "boolean", `${tool.name} readOnlyHint`);
                assert.strictEqual(typeof a.openWorldHint, "boolean", `${tool.name} openWorldHint`);
                if (!a.readOnlyHint) {
                    assert.strictEqual(typeof a.destructiveHint, "boolean", `${tool.name} destructiveHint`);
                    assert.strictEqual(typeof a.idempotentHint, "boolean", `${tool.name} idempotentHint`);
                }
            }
        } finally {
            await close();
        }
    });

    it("marks reads, sends, and deletes correctly", async () => {
        const { mcp, close } = await connectTools();
        try {
            const { tools } = await mcp.listTools();
            const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
            for (const name of ["mail_list_emails", "mail_read_email", "mail_search_emails", "mail_list_folders", "mail_download_attachment"]) {
                assert.strictEqual(byName[name].readOnlyHint, true, name);
            }
            for (const name of ["mail_send_email", "mail_send_draft"]) {
                assert.strictEqual(byName[name].destructiveHint, true, name);
                assert.strictEqual(byName[name].openWorldHint, true, name);
            }
            for (const name of ["mail_delete_email", "mail_delete_folder", "mail_delete_draft"]) {
                assert.strictEqual(byName[name].destructiveHint, true, name);
            }
            assert.strictEqual(byName.mail_create_draft.destructiveHint, false);
            assert.strictEqual(byName.mail_create_draft.openWorldHint, false);
        } finally {
            await close();
        }
    });
});
