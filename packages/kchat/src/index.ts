#!/usr/bin/env node

import {createRequire} from "node:module";
import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {KchatClient} from "./kchat-client.js";
import {registerTools} from "./tools.js";

const require = createRequire(import.meta.url);
const {version} = require("../package.json") as {version: string};

const token = process.env.KCHAT_TOKEN;
const teamName = process.env.KCHAT_TEAM_NAME;

if (!token || !teamName) {
    console.error(
        "Please set KCHAT_TOKEN and KCHAT_TEAM_NAME environment variables",
    );
    process.exit(1);
}

const server = new McpServer({name: "kChat MCP Server", version});

registerTools(server, new KchatClient(token, teamName));

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
});
