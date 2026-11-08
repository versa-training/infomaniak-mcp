#!/usr/bin/env node

import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {KdriveClient} from "./kdrive-client.js";
import {registerTools} from "./tools.js";
import {createRequire} from "node:module";

const require = createRequire(import.meta.url);
const {version} = require("../package.json") as {version: string};

const token = process.env.KDRIVE_TOKEN;
const drive_id = process.env.KDRIVE_ID;

if (!token || !drive_id) {
    console.error(
        "Please set KDRIVE_TOKEN and KDRIVE_ID environment variables",
    );
    process.exit(1);
}

const server = new McpServer(
    {
        name: "kDrive MCP Server",
        version,
    },
    {
        capabilities: {
            resources: {},
            tools: {},
        },
    },
);

function envFlag(name: string, fallback: boolean): boolean {
    const value = process.env[name]?.trim().toLowerCase();
    if (value === undefined || value === "") return fallback;
    if (["true", "1", "yes"].includes(value)) return true;
    if (["false", "0", "no"].includes(value)) return false;
    console.error(`${name} must be true, false, 1, 0, yes, or no (got "${process.env[name]}")`);
    process.exit(1);
}

const ttlDays = process.env.KDRIVE_PUBLIC_LINK_TTL_DAYS?.trim();
const ttlSeconds = ttlDays ? Math.round(Number(ttlDays) * 86400) : undefined;
if (ttlSeconds !== undefined && (!Number.isFinite(ttlSeconds) || ttlSeconds < 0)) {
    console.error("KDRIVE_PUBLIC_LINK_TTL_DAYS must be a number of days, 0 or more");
    process.exit(1);
}

registerTools(server, new KdriveClient(token, drive_id), {
    allowPublicLinks: envFlag("KDRIVE_ALLOW_PUBLIC_LINKS", true),
    publicLinkTtlSeconds: ttlSeconds,
    shareEmailDomains: process.env.KDRIVE_SHARE_EMAIL_DOMAINS?.split(",") ?? [],
});

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
});
