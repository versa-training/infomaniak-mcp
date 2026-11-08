#!/usr/bin/env node

import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {CalendarClient} from "./calendar-client.js";
import {registerTools} from "./tools.js";
import {createRequire} from "node:module";

const require = createRequire(import.meta.url);
const {version} = require("../package.json") as {version: string};

const token = process.env.CALENDAR_TOKEN;

if (!token) {
    console.error(
        "Please set CALENDAR_TOKEN environment variable",
    );
    process.exit(1);
}

const server = new McpServer(
    {
        name: "Infomaniak calendar MCP Server",
        version,
    },
    {
        capabilities: {
            tools: {},
        },
    },
);

registerTools(server, new CalendarClient(token, {kmeetHostname: process.env.KMEET_HOSTNAME || undefined}));

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
});
