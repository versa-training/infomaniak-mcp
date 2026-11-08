import http from "node:http";
import crypto from "node:crypto";
import {StreamableHTTPServerTransport} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type {Config} from "./config.js";
import {buildProducts, createServer, type Product} from "./products.js";
import {TokenResolver, tokenKey} from "./auth.js";

export const MAX_BODY_BYTES = 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 150_000;

function bearer(header: string | undefined): string | undefined {
    const m = /^Bearer (\S+)$/.exec(header ?? "");
    return m?.[1];
}

function sameSecret(given: string, want: string | undefined): boolean {
    if (!want) return false;
    const a = Buffer.from(given);
    const b = Buffer.from(want);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export const USER_PRODUCTS_TTL_MS = 10 * 60_000;
const MAX_USERS = 200;

export interface AppDeps {
    resolver?: TokenResolver;
    /** Builds the product set for one user's Infomaniak token. */
    buildFor?: (token: string) => Product[];
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    if (res.headersSent) return;
    res.writeHead(status, {"Content-Type": "application/json", ...headers});
    res.end(JSON.stringify(body));
}

class TooLarge extends Error {}

function readBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on("data", (c: Buffer) => {
            size += c.length;
            if (size > MAX_BODY_BYTES) {
                reject(new TooLarge());
                return;
            }
            chunks.push(c);
        });
        req.on("end", () => {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch {
                reject(new SyntaxError("invalid JSON"));
            }
        });
        req.on("error", reject);
    });
}

export function createApp(config: Config, sharedProducts: Product[], deps: AppDeps = {}): http.Server {
    const resolver = deps.resolver ?? new TokenResolver(config.allowedEmailDomains);
    const buildFor = deps.buildFor ?? ((token: string) => buildProducts(config, () => {}, token));
    const userProducts = new Map<string, {products: Product[]; expires: number}>();
    const productsFor = (token: string): Product[] => {
        const key = tokenKey(token);
        const hit = userProducts.get(key);
        if (hit && hit.expires > Date.now()) return hit.products;
        if (userProducts.size >= MAX_USERS) userProducts.delete(userProducts.keys().next().value as string);
        const products = buildFor(token);
        userProducts.set(key, {products, expires: Date.now() + USER_PRODUCTS_TTL_MS});
        return products;
    };
    return http.createServer(async (req, res) => {
        const path = (req.url ?? "").split("?")[0];
        if (path === "/healthz" && req.method === "GET") return send(res, 200, {ok: true});
        if (path !== "/mcp") return send(res, 404, {error: "not found"});
        const token = bearer(req.headers.authorization);
        if (!token) return send(res, 401, {error: "unauthorized"}, {"WWW-Authenticate": "Bearer"});
        let products: Product[];
        if (sameSecret(token, config.bearerToken)) {
            products = sharedProducts;
        } else {
            const r = await resolver.resolve(token);
            if (!r.ok) {
                const headers: Record<string, string> = r.status === 401 ? {"WWW-Authenticate": 'Bearer error="invalid_token"'} : {};
                return send(res, r.status, {error: r.message}, headers);
            }
            products = productsFor(r.token);
        }
        if (req.method !== "POST") return send(res, 405, {error: "method not allowed"}, {Allow: "POST"});
        const declared = Number(req.headers["content-length"] ?? 0);
        if (declared > MAX_BODY_BYTES) {
            req.resume();
            return send(res, 413, {error: "payload too large"}, {Connection: "close"});
        }
        let body: unknown;
        try {
            body = await readBody(req);
        } catch (e) {
            if (e instanceof TooLarge) return send(res, 413, {error: "payload too large"}, {Connection: "close"});
            return send(res, 400, {jsonrpc: "2.0", error: {code: -32700, message: "Parse error"}, id: null});
        }
        const server = createServer(products);
        const transport = new StreamableHTTPServerTransport({sessionIdGenerator: undefined, enableJsonResponse: true});
        const abort = setTimeout(() => {
            send(res, 504, {error: "request timeout"});
            res.end();
        }, REQUEST_TIMEOUT_MS);
        res.on("close", () => {
            clearTimeout(abort);
            void transport.close();
            void server.close();
        });
        try {
            await server.connect(transport);
            await transport.handleRequest(req, res, body);
        } catch {
            send(res, 500, {jsonrpc: "2.0", error: {code: -32603, message: "Internal error"}, id: null});
        }
    });
}
