#!/usr/bin/env node

import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {createRequire} from "node:module";
import {MailClient} from "./mail-client.js";
import {registerTools} from "./tools.js";

const require = createRequire(import.meta.url);
const {version} = require("../package.json") as {version: string};

async function main() {
    if (!process.env.MAIL_TOKEN) {
        console.error("Please set MAIL_TOKEN environment variable");
        process.exit(1);
    }

    const server = new McpServer({
        name: "Infomaniak Mail MCP Server",
        version,
    });
    registerTools(server, new MailClient(process.env.MAIL_TOKEN), {
        allowLocalFiles: process.env.MAIL_ALLOW_LOCAL_FILES?.toLowerCase() !== "false",
        allowSend: process.env.MAIL_ALLOW_SEND?.toLowerCase() !== "false",
        allowPermanentDelete: process.env.MAIL_ALLOW_PERMANENT_DELETE?.toLowerCase() !== "false",
        attachmentDir: process.env.MAIL_ATTACHMENT_DIR || undefined,
    });
    await server.connect(new StdioServerTransport());
}

main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
});
