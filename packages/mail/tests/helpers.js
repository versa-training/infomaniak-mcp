import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const { registerTools } = await import("../dist/tools.js");
const { MailClient } = await import("../dist/mail-client.js");

/** fetch mock that serves queued Response objects and records every call. */
export function createFetchMock() {
    const calls = [];
    const queue = [];
    const mock = async (url, options = {}) => {
        calls.push({ url: String(url), options });
        if (queue.length === 0) throw new Error(`Unexpected fetch to ${url}`);
        const next = queue.shift();
        if (next instanceof Error) throw next;
        return next;
    };
    mock.enqueue = (...responses) => queue.push(...responses);
    mock.calls = () => calls;
    mock.remaining = () => queue.length;
    return mock;
}

export function jsonResponse(body, init = {}) {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
        ...init,
    });
}

/** Connects a Client to registerTools() through an in-memory transport. */
export async function connectTools(options, client = new MailClient("test-token")) {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerTools(server, client, options);
    const mcp = new Client({ name: "test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
    return {
        mcp,
        client,
        close: async () => {
            await mcp.close();
            await server.close();
        },
    };
}

export const MAILBOXES = {
    result: "success",
    data: [{ uuid: "mb1", email: "me@x.ch", mailbox: "me", hosting_id: 7, is_primary: true }],
};
