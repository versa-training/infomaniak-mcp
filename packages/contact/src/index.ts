#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ContactClient } from "./contact-client.js";
import { registerTools } from "./tools.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

async function main() {
    const token = process.env.CONTACT_TOKEN;

    if (!token) {
        console.error(
            "Please set CONTACT_TOKEN environment variable",
        );
        process.exit(1);
    }

    const server = new McpServer({
        name: "Infomaniak Contact MCP Server",
        version,
    });

    registerTools(server, new ContactClient(token));

    await server.connect(new StdioServerTransport());
}

main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
});
