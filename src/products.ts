import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {MailClient, registerTools as registerMail} from "@infomaniak/mcp-server-mail";
import {CalendarClient, registerTools as registerCalendar} from "@infomaniak/mcp-server-calendar";
import {KdriveClient, registerTools as registerKdrive} from "@infomaniak/mcp-server-kdrive";
import {ContactClient, registerTools as registerContact} from "@infomaniak/mcp-server-contact";
import {KchatClient, registerTools as registerKchat} from "@infomaniak/mcp-server-kchat";
import type {Config} from "./config.js";

export interface Product {
    name: string;
    register: (server: McpServer) => void;
}

export function buildProducts(
    config: Config,
    log: (line: string) => void = console.error,
    token: string | undefined = config.infomaniakToken,
): Product[] {
    if (!token) {
        log("INFOMANIAK_TOKEN is not set: no product registered");
        return [];
    }
    const products: Product[] = [];
    const mail = new MailClient(token);
    products.push({
        name: "mail",
        register: (s) =>
            registerMail(s, mail, {
                allowSend: config.mailAllowSend,
                allowLocalFiles: false,
                allowPermanentDelete: config.mailAllowPermanentDelete,
            }),
    });
    const calendar = new CalendarClient(token);
    products.push({name: "calendar", register: (s) => registerCalendar(s, calendar)});
    if (config.kdriveId) {
        const kdrive = new KdriveClient(token, config.kdriveId);
        products.push({
            name: "kdrive",
            register: (s) => registerKdrive(s, kdrive, {allowPublicLinks: config.kdriveAllowPublicLinks}),
        });
    } else log("KDRIVE_ID is not set: kdrive skipped");
    const contact = new ContactClient(token);
    products.push({name: "contact", register: (s) => registerContact(s, contact)});
    if (config.kchatTeamName) {
        const kchat = new KchatClient(token, config.kchatTeamName);
        products.push({name: "kchat", register: (s) => registerKchat(s, kchat)});
    } else log("KCHAT_TEAM_NAME is not set: kchat skipped");
    return products;
}

export function createServer(products: Product[]): McpServer {
    const server = new McpServer({name: "infomaniak-mcp", version: "0.1.0"});
    for (const p of products) p.register(server);
    return server;
}

/** Registers each product on its own server and returns the tool names per product; throws on a duplicate. */
export async function checkToolNames(products: Product[]): Promise<Record<string, string[]>> {
    const {Client} = await import("@modelcontextprotocol/sdk/client/index.js");
    const {InMemoryTransport} = await import("@modelcontextprotocol/sdk/inMemory.js");
    const byProduct: Record<string, string[]> = {};
    const seen = new Map<string, string>();
    for (const p of products) {
        const server = new McpServer({name: p.name, version: "0.0.0"});
        p.register(server);
        const [a, b] = InMemoryTransport.createLinkedPair();
        const client = new Client({name: "check", version: "0.0.0"});
        await Promise.all([server.connect(a), client.connect(b)]);
        const {tools} = await client.listTools();
        await client.close();
        byProduct[p.name] = tools.map((t) => t.name);
        for (const t of tools) {
            const prev = seen.get(t.name);
            if (prev) throw new Error(`Tool name ${t.name} is registered by both ${prev} and ${p.name}`);
            seen.set(t.name, p.name);
        }
    }
    return byProduct;
}
