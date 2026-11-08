import { searchContacts } from "./search.js";

const API_BASE = "https://contacts.infomaniak.com/api/pim";

/** Builds an API URL: every path segment is percent-encoded, the query goes through URLSearchParams. */
export function buildUrl(
    segments: string[],
    query: Record<string, string | undefined> = {},
): string {
    const path = segments.map((s) => `/${encodeURIComponent(s)}`).join("");
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) params.set(key, value);
    }
    const qs = params.toString();
    return `${API_BASE}${path}${qs ? `?${qs}` : ""}`;
}

const REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_CACHE_TTL_MS = 60_000;

export interface ContactClientOptions {
    /** How long the address book stays cached; 0 disables the cache. Default 60000. */
    cacheTtlMs?: number;
    /** Clock, for tests. */
    now?: () => number;
    /** Waits before a retry, for tests. The optional signal ends the wait early. */
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}
const MAX_ERROR_MESSAGE = 200;
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_RETRY_AFTER_MS = 10_000;
const RETRY_BACKOFF_MS = 500;
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const defaultSleep = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal?.reason);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });

/** Reads a body as a stream and cancels it once it passes `maxBytes`; returns null when too large. */
async function readCapped(response: Response, maxBytes: number): Promise<string | null> {
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
        await response.body?.cancel();
        return null;
    }
    if (!response.body) return "";
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
            await reader.cancel();
            return null;
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
}

/** Delay before the retry: Retry-After (seconds or HTTP date, capped at 10 s) on 429 and 503, else a short backoff. */
function retryDelay(response: Response, now: number): number {
    if (response.status === 429 || response.status === 503) {
        const header = response.headers.get("retry-after");
        if (header) {
            const seconds = Number(header);
            const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
            if (Number.isFinite(ms)) return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
        }
    }
    return RETRY_BACKOFF_MS;
}

/** A short message for a failed fetch: the cause code (ENOTFOUND, ECONNREFUSED) or the timeout. */
function networkError(error: unknown, cancelled = false): Error {
    if (cancelled) return new Error("request cancelled");
    const err = error as { name?: string; cause?: { code?: unknown } };
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
        return new Error(`request timed out after ${REQUEST_TIMEOUT_MS / 1000} s`);
    }
    const code = err?.cause?.code;
    return new Error(`network error: ${typeof code === "string" ? code : "fetch failed"}`);
}

/** Settles with `promise`, or rejects early when the caller's `signal` aborts; `promise` itself keeps running. */
function raceCaller<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(networkError(signal.reason, true));
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
        promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
}

function apiErrorFromBody(status: number, body: any): Error {
    const error = body?.error;
    const code = String(error?.code ?? body?.code ?? "error");
    const message = String(
        error?.description ?? error?.message ?? body?.message ?? "",
    );
    return new Error(`${status} ${code}: ${message.slice(0, MAX_ERROR_MESSAGE)}`);
}

/** Error with the status, the API error code and at most 200 characters of message; never the full body. */
async function apiError(response: Response): Promise<Error> {
    let body: any;
    try {
        body = JSON.parse((await readCapped(response, MAX_ERROR_BODY_BYTES)) ?? "");
    } catch {
        body = undefined;
    }
    if (body && typeof body === "object") {
        return apiErrorFromBody(response.status, body);
    }
    return new Error(`${response.status} ${response.statusText || "error"}`);
}

export class ContactClient {
    private readonly token: string;
    private readonly headers: { Authorization: string; "Content-Type": string };

    private readonly cacheTtlMs: number;
    private readonly now: () => number;
    private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
    private cache?: { promise: Promise<any[]>; expires: number };

    constructor(token: string, options: ContactClientOptions = {}) {
        this.token = token;
        this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
        this.now = options.now ?? Date.now;
        this.sleep = options.sleep ?? defaultSleep;
        this.headers = {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
        };
    }

    /**
     * One request with one overall deadline of 30 s, shared by the retry. A GET is retried
     * once on a network error (not a timeout), 429, 502, 503 or 504. `options.signal` is the
     * caller's cancellation signal; it ends the request and the retry wait.
     */
    private async apiRequest(url: string, options: RequestInit = {}): Promise<any> {
        const canRetry = (options.method ?? "GET").toUpperCase() === "GET";
        const caller = options.signal ?? undefined;
        const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        const isCancelled = () => caller?.aborted === true;
        const signal = caller ? AbortSignal.any([deadline, caller]) : deadline;
        let response: Response | undefined;
        for (let attempt = 0; ; attempt++) {
            try {
                response = await fetch(url, {
                    ...options,
                    headers: {
                        ...this.headers,
                        ...(options.headers as Record<string, string> || {}),
                    },
                    signal,
                });
            } catch (error) {
                const timedOut = deadline.aborted || (error as { name?: string })?.name === "TimeoutError";
                const cancelled = isCancelled();
                if (canRetry && attempt === 0 && !timedOut && !cancelled) {
                    try {
                        await this.sleep(RETRY_BACKOFF_MS, signal);
                    } catch {
                        throw networkError(error, isCancelled());
                    }
                    continue;
                }
                throw networkError(error, cancelled);
            }
            if (canRetry && attempt === 0 && RETRY_STATUSES.has(response.status)) {
                const delay = retryDelay(response, this.now());
                await response.body?.cancel();
                try {
                    await this.sleep(delay, signal);
                } catch (error) {
                    throw networkError(error, isCancelled());
                }
                continue;
            }
            break;
        }

        if (!response.ok) {
            throw await apiError(response);
        }

        const text = await readCapped(response, MAX_RESPONSE_BYTES);
        if (text === null) {
            throw new Error(`${response.status} response_too_large: over ${MAX_RESPONSE_BYTES} bytes`);
        }
        let body: any;
        try {
            body = JSON.parse(text);
        } catch {
            throw new Error(`${response.status} invalid_response: response is not JSON`);
        }
        if (body?.result !== undefined && body.result !== "success") {
            throw apiErrorFromBody(response.status, body);
        }
        return body;
    }

    /** The address book, cached per client (one token) for cacheTtlMs; failures are not cached. */
    fetchAllContacts(options: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<any[]> {
        const now = this.now();
        if (!options.refresh && this.cache && this.cache.expires > now) {
            return raceCaller(this.cache.promise, options.signal);
        }
        // The load is shared by concurrent calls, so it runs without the caller's signal
        // (only the per-request timeout applies); each caller races it against its own signal.
        const promise = this.apiRequest(
            buildUrl(["contact", "all"], { with: "emails,phones,others" }),
        ).then((response) => {
            if (!Array.isArray(response?.data)) {
                throw new Error("200 invalid_response: data is not a list");
            }
            return response.data as any[];
        });
        const entry = { promise, expires: now + this.cacheTtlMs };
        this.cache = entry;
        promise.catch(() => {
            if (this.cache === entry) this.cache = undefined;
        });
        return raceCaller(promise, options.signal);
    }

    /** Drops the cached address book; the next read fetches it again. */
    clearCache(): void {
        this.cache = undefined;
    }

    /** Matches, best first. Throws when the query has fewer than 2 characters. */
    searchContacts(contacts: any[], query: string): any[] {
        return searchContacts(contacts, query);
    }
}
