import {AsyncLocalStorage} from "node:async_hooks";

const API_ORIGIN = "https://api.infomaniak.com";

type QueryValue = string | number | boolean | undefined | null | Array<string | number>;

export function buildQuery(query?: Record<string, QueryValue>): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) {
            for (const item of value) params.append(`${key}[]`, String(item));
        } else {
            params.set(key, String(value));
        }
    }
    const text = params.toString();
    return text ? `?${text}` : "";
}

const REQUEST_TIMEOUT_MS = 30000;
export const MAX_DIRECT_UPLOAD_BYTES = 1_000_000_000;
export const MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024;
/** Extra fields requested with a file: where it lives, whether it is a favorite, and its share link. */
const FILE_DETAILS = "path,is_favorite,sharelink";
export const MAX_PREVIEW_BYTES = 1024 * 1024;
const MAX_RETRY_AFTER_MS = 10_000;
const RETRY_STATUSES = new Set([429, 502, 503, 504]);

/** Milliseconds to wait from a Retry-After header (seconds or HTTP date), capped at 10 s; undefined when absent or invalid. */
export function parseRetryAfterMs(value: string | null | undefined, now = Date.now()): number | undefined {
    const text = value?.trim();
    if (!text) return undefined;
    let ms: number;
    if (/^\d+(\.\d+)?$/.test(text)) {
        ms = Number(text) * 1000;
    } else {
        const date = Date.parse(text);
        if (Number.isNaN(date)) return undefined;
        ms = date - now;
    }
    return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
}

const callSignals = new AsyncLocalStorage<AbortSignal>();
export const TOOL_DEADLINE_MS = 60000;

/**
 * Runs `fn` with one overall deadline. Every kDrive request made inside it stops when
 * `signal` (the SDK's `extra.signal`) aborts or `timeoutMs` passes.
 */
export function withDeadline<T>(signal: AbortSignal | undefined, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
    const combined = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
    return callSignals.run(combined, fn);
}

function isTimeout(error: unknown): boolean {
    return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function describeNetworkError(error: unknown): string {
    const deadline = callSignals.getStore();
    if (deadline?.aborted) {
        return (deadline.reason as {name?: string} | undefined)?.name === "TimeoutError"
            ? "kDrive request stopped: the tool call passed its deadline"
            : "kDrive request cancelled";
    }
    if (error instanceof Error) {
        if (isTimeout(error)) {
            return `kDrive request timed out after ${REQUEST_TIMEOUT_MS / 1000} s`;
        }
        const code = (error.cause as {code?: unknown} | undefined)?.code;
        return typeof code === "string" ? `kDrive request failed: ${error.message} (${code})` : `kDrive request failed: ${error.message}`;
    }
    return `kDrive request failed: ${String(error)}`;
}

/** Reads the body as a stream and cancels it once it passes `cap` bytes. Sizes are counted, never trusted. */
export async function readCapped(response: Response, cap: number): Promise<{data: Buffer; exceeded: boolean}> {
    const reader = response.body?.getReader();
    if (!reader) return {data: Buffer.alloc(0), exceeded: false};
    const chunks: Buffer[] = [];
    let total = 0;
    let exceeded = false;
    for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
            chunk = await reader.read();
        } catch (error) {
            throw new Error(describeNetworkError(error));
        }
        const {done, value} = chunk;
        if (done) break;
        if (total + value.length > cap) {
            chunks.push(Buffer.from(value.subarray(0, cap - total)));
            total = cap;
            exceeded = true;
            await reader.cancel();
            break;
        }
        chunks.push(Buffer.from(value));
        total += value.length;
    }
    return {data: Buffer.concat(chunks), exceeded};
}

export function decodeBase64(input: string): Buffer {
    const stripped = input.replace(/^data:[^,]*;base64,/i, "").replace(/\s+/g, "");
    if (stripped.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(stripped)) {
        throw new Error("base64_content is not valid base64");
    }
    return Buffer.from(stripped, "base64");
}

/** Parses a JSON body; a timeout or reset while the body streams reports like any other network error. */
async function readJson(response: Response): Promise<any> {
    try {
        return await response.json();
    } catch (error) {
        if (error instanceof SyntaxError) throw error;
        throw new Error(describeNetworkError(error));
    }
}

async function toApiError(response: Response): Promise<Error> {
    let code = "";
    let message = response.statusText;
    try {
        const body = await response.json() as {error?: {code?: unknown; description?: unknown}; message?: unknown};
        if (typeof body?.error?.code === "string") code = body.error.code;
        if (typeof body?.error?.description === "string") message = body.error.description;
        else if (typeof body?.message === "string") message = body.message;
    } catch {
        // body is not JSON; the status line is enough
    }
    const prefix = code ? `${response.status} ${code}` : `${response.status}`;
    return new Error(`${prefix}: ${message.slice(0, 200)}`);
}

function accessTarget(target: {user_id?: number; team_id?: number}): [string, number] {
    if ((target.user_id === undefined) === (target.team_id === undefined)) {
        throw new Error("Provide exactly one of user_id and team_id");
    }
    return target.user_id !== undefined ? ["users", target.user_id] : ["teams", target.team_id!];
}

export interface SearchOptions {
    directory_id?: number;
    depth?: string;
    limit?: number;
    cursor?: string;
    query_scope?: string;
    types?: string[];
    extensions?: string[];
    modified_after?: number;
    modified_before?: number;
    order_by?: string;
    order?: string;
}

export class KdriveClient {
    private readonly token: string;
    private readonly driveId: string;
    private readonly headers: { Authorization: string; "Content-Type": string };

    constructor(token: string, driveId: string, private readonly retryDelayMs = 500) {
        if (!/^\d+$/.test(driveId)) {
            throw new Error("KDRIVE_ID must be a positive integer");
        }
        this.token = token;
        this.driveId = driveId;
        this.headers = {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
        };
    }

    private async send(url: string, init: RequestInit = {}): Promise<Response> {
        const method = (init.method ?? "GET").toUpperCase();
        const attempts = method === "GET" ? 2 : 1;
        let delayMs = this.retryDelayMs;
        let lastError: unknown;
        for (let attempt = 0; attempt < attempts; attempt++) {
            if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
            delayMs = this.retryDelayMs;
            const deadline = callSignals.getStore();
            let response: Response;
            try {
                response = await fetch(url, {...init, signal: AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(deadline ? [deadline] : [])])});
            } catch (error) {
                lastError = new Error(describeNetworkError(error));
                // A timeout or a cancelled call is not retried: a second try would wait as long again.
                if (isTimeout(error) || deadline?.aborted) throw lastError;
                continue;
            }
            if (response.ok) return response;
            if (RETRY_STATUSES.has(response.status) && attempt < attempts - 1) {
                if (response.status === 429 || response.status === 503) {
                    delayMs = parseRetryAfterMs(response.headers.get("retry-after")) ?? delayMs;
                }
                await response.body?.cancel();
                lastError = new Error(`${response.status}: ${response.statusText}`);
                continue;
            }
            throw await toApiError(response);
        }
        throw lastError;
    }

    private url(version: 2 | 3, path: Array<string | number>, query?: Record<string, QueryValue>): string {
        const segments = ["drive", this.driveId, ...path].map((segment) => encodeURIComponent(String(segment)));
        return `${API_ORIGIN}/${version}/${segments.join("/")}${buildQuery(query)}`;
    }

    async search(query: string, options?: SearchOptions): Promise<any> {
        const response = await this.send(
            this.url(3, ["files", "search"], {
                query,
                limit: options?.limit,
                cursor: options?.cursor,
                directory_id: options?.directory_id,
                depth: options?.depth,
                query_scope: options?.query_scope,
                types: options?.types,
                extensions: options?.extensions,
                modified_at: options?.modified_after !== undefined || options?.modified_before !== undefined ? "custom" : undefined,
                modified_after: options?.modified_after,
                modified_before: options?.modified_before,
                order_by: options?.order_by ? [options.order_by] : undefined,
                order: options?.order,
                with: FILE_DETAILS,
            }),
            {headers: this.headers},
        );

        return readJson(response);
    }

    async uploadFile(
        file_name: string,
        directory_id: number | undefined,
        textContent?: string,
        base64Content?: string,
        conflict?: "error" | "rename" | "version",
        directory_path?: string,
    ): Promise<any> {
        let buffer: Buffer;

        if (textContent !== undefined && base64Content !== undefined) {
            throw new Error("Cannot provide both text_content and base64_content");
        }
        if (textContent !== undefined) {
            buffer = Buffer.from(textContent, "utf-8");
        } else if (base64Content !== undefined) {
            buffer = decodeBase64(base64Content);
        } else {
            throw new Error("Either text_content or base64_content must be provided");
        }
        if (buffer.length > MAX_DIRECT_UPLOAD_BYTES) {
            throw new Error(`Content is ${buffer.length} bytes; direct uploads above ${MAX_DIRECT_UPLOAD_BYTES} bytes are not supported`);
        }

        const response = await this.send(
            this.url(3, ["upload"], {directory_id, directory_path, file_name, total_size: buffer.length, conflict}),
            {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    "Content-Type": "application/octet-stream",
                },
                body: new Uint8Array(buffer),
            },
        );

        return readJson(response);
    }

    async listFiles(file_id = 1, filters?: { type?: string; cursor?: string; limit?: number; order_by?: string; order?: string }): Promise<any> {
        const response = await this.send(
            this.url(3, ["files", file_id, "files"], {
                type: filters?.type ? [filters.type] : undefined,
                cursor: filters?.cursor,
                limit: filters?.limit,
                order_by: filters?.order_by ? [filters.order_by] : undefined,
                order: filters?.order,
            }),
            {
                headers: this.headers,
            },
        );

        return readJson(response);
    }

    async rename(file_id: number, name: string): Promise<any> {
        const response = await this.send(
            this.url(2, ["files", file_id, "rename"]),
            {
                method: "POST",
                headers: this.headers,
                body: JSON.stringify({ name }),
            },
        );

        return readJson(response);
    }

    async move(file_id: number, dest_id: number, options?: { name?: string; conflict?: string }): Promise<any> {
        const body: Record<string, unknown> = {};
        if (options?.name !== undefined) body.name = options.name;
        if (options?.conflict !== undefined) body.conflict = options.conflict;
        const response = await this.send(
            this.url(3, ["files", file_id, "move", dest_id]),
            {
                method: "POST",
                headers: this.headers,
                ...(Object.keys(body).length > 0 ? {body: JSON.stringify(body)} : {}),
            },
        );

        return readJson(response);
    }

    async deleteFile(file_id: number): Promise<any> {
        const response = await this.send(
            this.url(2, ["files", file_id]),
            {
                method: "DELETE",
                headers: {
                    Authorization: `Bearer ${this.token}`,
                },
            },
        );

        return readJson(response);
    }

    async shareLink(file_id: number, options: Record<string, unknown>): Promise<any> {
        const response = await this.send(
            this.url(2, ["files", file_id, "link"]),
            {
                method: "POST",
                headers: this.headers,
                body: JSON.stringify(options),
            },
        );

        return readJson(response);
    }

    async shareAccess(file_id: number, emails: string[], right: string, message?: string, lang = "en"): Promise<any> {
        const body: Record<string, unknown> = { emails, right };
        if (message) body.message = message;

        const response = await this.send(
            this.url(2, ["files", file_id, "access", "invitations"], {lang}),
            {
                method: "POST",
                headers: this.headers,
                body: JSON.stringify(body),
            },
        );

        return readJson(response);
    }

    /** Users, teams, and pending invitations of a file, from one request. */
    async listAccess(file_id: number): Promise<any> {
        const response = await this.send(this.url(2, ["files", file_id, "access"]), {headers: this.headers});
        return (await readJson(response))?.data ?? {};
    }

    async removeAccess(file_id: number, target: {user_id?: number; team_id?: number}): Promise<any> {
        const response = await this.send(
            this.url(2, ["files", file_id, "access", ...accessTarget(target)]),
            {method: "DELETE", headers: {Authorization: `Bearer ${this.token}`}},
        );
        return readJson(response);
    }

    async updateAccess(file_id: number, target: {user_id?: number; team_id?: number}, right: string): Promise<any> {
        const response = await this.send(
            this.url(2, ["files", file_id, "access", ...accessTarget(target)]),
            {method: "PUT", headers: this.headers, body: JSON.stringify({right})},
        );
        return readJson(response);
    }

    async setFavorite(file_id: number, favorite: boolean): Promise<any> {
        const response = await this.send(
            this.url(2, ["files", file_id, "favorite"]),
            {method: favorite ? "POST" : "DELETE", headers: {Authorization: `Bearer ${this.token}`}},
        );
        return readJson(response);
    }

    async findByName(directory_id: number, name: string): Promise<any> {
        const response = await this.send(
            this.url(3, ["files", directory_id, "name"], {name, with: FILE_DETAILS}),
            {headers: this.headers},
        );
        return readJson(response);
    }

    async createFolder(file_id = 1, name: string): Promise<any> {
        const response = await this.send(
            this.url(3, ["files", file_id, "directory"]),
            {
                method: "POST",
                headers: this.headers,
                body: JSON.stringify({ name }),
            },
        );

        return readJson(response);
    }

    async restore(file_id: number, destination_directory_id: number): Promise<any> {
        const response = await this.send(
            this.url(2, ["trash", file_id, "restore"]),
            {
                method: "POST",
                headers: this.headers,
                body: JSON.stringify({ destination_directory_id }),
            },
        );

        return readJson(response);
    }

    async info(file_id: number): Promise<any> {
        const response = await this.send(
            this.url(3, ["files", file_id], {with: FILE_DETAILS}),
            {
                headers: this.headers,
            },
        );

        return readJson(response);
    }

    async recents(filters?: { type?: string; cursor?: string; limit?: number }): Promise<any> {
        const response = await this.send(
            this.url(3, ["files", "recents"], {type: filters?.type ? [filters.type] : undefined, cursor: filters?.cursor, limit: filters?.limit}),
            {
                headers: this.headers,
            },
        );

        return readJson(response);
    }

    async sharedWithMe(filters?: { type?: string; cursor?: string; limit?: number }): Promise<any> {
        const response = await this.send(
            this.url(3, ["files", "shared_with_me"], {type: filters?.type ? [filters.type] : undefined, cursor: filters?.cursor, limit: filters?.limit}),
            {
                headers: this.headers,
            },
        );

        return readJson(response);
    }

    async previewText(file_id: number): Promise<{text: string; truncated: boolean}> {
        const response = await this.send(
            this.url(2, ["files", file_id, "preview"], {as: "text"}),
            {headers: this.headers},
        );
        const type = (response.headers.get("content-type") ?? "").toLowerCase();
        if (!type.startsWith("text/")) {
            await response.body?.cancel();
            throw new Error("Text conversion is not available for this file");
        }
        const {data, exceeded} = await readCapped(response, MAX_PREVIEW_BYTES);
        return {text: new TextDecoder().decode(data), truncated: exceeded};
    }

    async listTrash(options?: { query?: string; type?: string; cursor?: string; limit?: number; order_by?: string; order?: string; deleted_after?: number }): Promise<any> {
        const type = options?.type ? [options.type] : undefined;
        const common = {cursor: options?.cursor, limit: options?.limit, order_by: options?.order_by ? [options.order_by] : undefined, order: options?.order};
        const search = options?.query !== undefined || options?.deleted_after !== undefined;
        if (search && options?.type === "vault") {
            throw new Error("Searching the trash cannot filter by type vault. Use type dir or file, or list the trash without query and deleted_after.");
        }
        if (search && options?.order_by !== undefined && options.order_by !== "last_modified_at") {
            throw new Error("Searching the trash can only sort by last_modified_at. Use order_by deleted_at when listing without query and deleted_after.");
        }
        const response = search
            ? await this.send(
                this.url(3, ["files", "search", "trash"], {
                    ...common,
                    query: options?.query,
                    types: type,
                    deleted_at: options?.deleted_after !== undefined ? "custom" : undefined,
                    deleted_after: options?.deleted_after,
                }),
                {headers: this.headers},
            )
            : await this.send(this.url(3, ["trash"], {...common, type}), {headers: this.headers});
        return readJson(response);
    }

    async getShareLink(file_id: number): Promise<any> {
        const response = await this.send(this.url(2, ["files", file_id, "link"]), {headers: this.headers});
        return readJson(response);
    }

    async updateShareLink(file_id: number, options: Record<string, unknown>): Promise<any> {
        const response = await this.send(
            this.url(2, ["files", file_id, "link"]),
            {method: "PUT", headers: this.headers, body: JSON.stringify(options)},
        );
        return readJson(response);
    }

    async deleteShareLink(file_id: number): Promise<any> {
        const response = await this.send(
            this.url(2, ["files", file_id, "link"]),
            {method: "DELETE", headers: {Authorization: `Bearer ${this.token}`}},
        );
        return readJson(response);
    }

    async copy(file_id: number, destination_directory_id: number, options?: { name?: string; conflict?: string }): Promise<any> {
        const body: Record<string, unknown> = {};
        if (options?.name !== undefined) body.name = options.name;
        if (options?.conflict !== undefined) body.conflict = options.conflict;
        const response = await this.send(
            this.url(3, ["files", file_id, "copy", destination_directory_id]),
            {method: "POST", headers: this.headers, body: JSON.stringify(body)},
        );
        return readJson(response);
    }

    async listVersions(file_id: number, options?: { page?: number; per_page?: number; order?: string }): Promise<any> {
        const response = await this.send(
            this.url(3, ["files", file_id, "versions"], {page: options?.page ?? 1, per_page: options?.per_page, total: true, order_by: ["created_at"], order: options?.order ?? "desc"}),
            {headers: this.headers},
        );
        return readJson(response);
    }

    async restoreVersion(file_id: number, version_id: number): Promise<any> {
        const response = await this.send(
            this.url(3, ["files", file_id, "versions", version_id, "restore"]),
            {method: "POST", headers: this.headers},
        );
        return readJson(response);
    }

    async temporaryUrl(file_id: number, duration?: number): Promise<any> {
        const response = await this.send(
            this.url(2, ["files", file_id, "temporary_url"], {duration}),
            {headers: this.headers},
        );
        return readJson(response);
    }

    async listFavorites(filters?: { type?: string; cursor?: string; limit?: number }): Promise<any> {
        const response = await this.send(
            this.url(3, ["files", "favorites"], {type: filters?.type ? [filters.type] : undefined, cursor: filters?.cursor, limit: filters?.limit}),
            {headers: this.headers},
        );
        return readJson(response);
    }

    async listMyShared(filters?: { type?: string; cursor?: string; limit?: number }): Promise<any> {
        const response = await this.send(
            this.url(3, ["files", "my_shared"], {type: filters?.type ? [filters.type] : undefined, cursor: filters?.cursor, limit: filters?.limit}),
            {headers: this.headers},
        );
        return readJson(response);
    }

    async listActivities(file_id: number, filters?: {cursor?: string; limit?: number; actions?: string[]; from?: number; until?: number; users?: number[]; order?: string}): Promise<any> {
        const response = await this.send(
            this.url(3, ["files", file_id, "activities"], {
                cursor: filters?.cursor,
                limit: filters?.limit,
                actions: filters?.actions,
                from: filters?.from,
                until: filters?.until,
                users: filters?.users,
                with: "user",
                order_by: ["created_at"],
                order: filters?.order ?? "desc",
            }),
            {headers: this.headers},
        );
        return readJson(response);
    }

    async driveInfo(): Promise<any> {
        const response = await this.send(`${API_ORIGIN}/2/drive/${encodeURIComponent(this.driveId)}`, {headers: this.headers});
        return readJson(response);
    }

    async createOfficeFile(directory_id: number, name: string, type: string): Promise<any> {
        const response = await this.send(
            this.url(3, ["files", directory_id, "file"]),
            {method: "POST", headers: this.headers, body: JSON.stringify({name, type})},
        );
        return readJson(response);
    }

    async listComments(file_id: number, options?: { page?: number; per_page?: number }): Promise<any> {
        const response = await this.send(
            this.url(2, ["files", file_id, "comments"], {page: options?.page ?? 1, per_page: options?.per_page, total: true, with: "user,responses,responses.user"}),
            {headers: this.headers},
        );
        return readJson(response);
    }

    async addComment(file_id: number, body: string): Promise<any> {
        const response = await this.send(
            this.url(2, ["files", file_id, "comments"]),
            {method: "POST", headers: this.headers, body: JSON.stringify({body})},
        );
        return readJson(response);
    }

    async downloadFile(file_id: number): Promise<{data: ArrayBuffer; mimeType: string}> {
        const response = await this.send(
            this.url(2, ["files", file_id, "download"]),
            {
                headers: this.headers
            },
        );

        const header = response.headers.get("content-length");
        const declared = header !== null && /^\d+$/.test(header.trim()) ? Number(header) : undefined;
        if (declared !== undefined && declared > MAX_DOWNLOAD_BYTES) {
            await response.body?.cancel();
            throw new Error(`File is ${declared} bytes; downloads above ${MAX_DOWNLOAD_BYTES} bytes are refused`);
        }
        const {data: buffer, exceeded} = await readCapped(response, MAX_DOWNLOAD_BYTES);
        if (exceeded) {
            throw new Error(`File is larger than ${MAX_DOWNLOAD_BYTES} bytes; downloads above that size are refused`);
        }
        const data = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
        const mimeType = (response.headers.get("content-type") ?? "").split(";")[0].trim() || "application/octet-stream";
        return {data, mimeType};
    }
}
