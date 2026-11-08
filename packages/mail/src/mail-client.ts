import {AsyncLocalStorage} from "node:async_hooks";
import path from "node:path";
import type {AttachmentInput, DownloadedAttachment} from "./types.js";
import {MAX_DOWNLOAD_SIZE, decodeBase64Attachment} from "./attachments.js";
import {DraftCache, type DraftEntry} from "./draft-cache.js";
import {htmlToText, htmlToTextResult} from "./html-text.js";
import {MAX_TEXT_LENGTH, capJsonString} from "./output.js";

const API_BASE = "https://mail.infomaniak.com/api";
const MANAGER_API_V1_BASE = "https://api.infomaniak.com/1";
const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 10_000;
/** One tool call, retries included, never runs longer than this. */
const TOOL_DEADLINE_MS = 120_000;
const MAX_ERROR_MESSAGE = 200;
const FOLDER_CACHE_TTL_MS = 60_000;
/** Mailbox list and sending identities change when the user edits them in kMail. */
const ACCOUNT_CACHE_TTL_MS = 60_000;
const THREAD_READ_CONCURRENCY = 4;
const RETRY_STATUSES = new Set([429, 502, 503, 504]);

export interface MailClientOptions {
    /** Per-request timeout in milliseconds (default 30000). */
    timeoutMs?: number;
    /** Base delay before the single GET retry in milliseconds (default 500). */
    retryDelayMs?: number;
}

/**
 * Build `Error("<status> <api error code>: <message>")` from a decoded API
 * error body. Only the code and a message of at most 200 characters are kept:
 * the rest of the body can hold message or contact content.
 */
function apiError(status: number, body: any, fallbackMessage = ""): Error {
    const error = body?.error;
    let code = "";
    let message = fallbackMessage;
    if (typeof error === "string") {
        message = error;
    } else if (error && typeof error === "object") {
        if (typeof error.code === "string") code = error.code;
        const detail = error.description ?? error.message;
        if (typeof detail === "string") message = detail;
    }
    return new Error(`${status} ${code || "api_error"}: ${message.slice(0, MAX_ERROR_MESSAGE)}`);
}

async function errorFromResponse(response: Response): Promise<Error> {
    let body: any = null;
    try {
        body = JSON.parse(await response.text());
    } catch {
        // Not JSON (for example a proxy error page): status line only
    }
    return apiError(response.status, body, response.statusText || "");
}

const callContext = new AsyncLocalStorage<AbortSignal>();

/**
 * Run `work` with one overall deadline. Every request the client makes inside
 * it stops when the deadline passes or when `signal` (the SDK's
 * `extra.signal` of a cancelled tool call) aborts.
 */
export function withCallDeadline<T>(signal: AbortSignal | undefined, work: () => Promise<T>, deadlineMs = TOOL_DEADLINE_MS): Promise<T> {
    const deadline = AbortSignal.timeout(deadlineMs);
    return callContext.run(signal ? AbortSignal.any([signal, deadline]) : deadline, work);
}

/** Why a request failed, without the full cause chain: `ENOTFOUND`, `ECONNRESET`, or the message. */
function describeNetworkError(error: unknown): string {
    const err = error as { cause?: { code?: unknown }; code?: unknown; message?: unknown } | null;
    const code = err?.cause?.code ?? err?.code;
    if (typeof code === "string") return code;
    return typeof err?.message === "string" ? err.message.slice(0, MAX_ERROR_MESSAGE) : "unknown error";
}

/**
 * Build a request path: every segment goes through encodeURIComponent, so an
 * identifier cannot add path separators, query strings, or `%2e%2e` tricks.
 * Dot segments are refused because encodeURIComponent leaves them unchanged.
 */
export function buildPath(...segments: Array<string | number>): string {
    const encoded = segments.map((segment) => {
        const value = String(segment);
        if (value === "" || value === "." || value === "..") {
            throw new Error(`Invalid path segment: "${value}"`);
        }
        return encodeURIComponent(value);
    });
    return `/${encoded.join("/")}`;
}

/**
 * A filename as an HTTP header value. Headers are Latin-1 bytes, so a name
 * with other characters is percent-encoded (`fetch` throws on CJK or emoji, and
 * Latin-1 bytes such as the one in `März.pdf` reach the server as invalid
 * UTF-8). A name that holds `%` is percent-encoded too, so a raw `%` never
 * appears and the two forms cannot be confused. Unverified: whether kMail
 * decodes the percent-encoded form; no live upload was possible.
 */
export function headerFilename(name: string): string {
    return /^[\x20-\x7e]*$/.test(name) && !name.includes("%") ? name : encodeURIComponent(name);
}

/** Draft payload fields the API accepts, with the values of an empty draft. */
const DRAFT_DEFAULTS: Record<string, any> = {
    uuid: null,
    subject: "",
    body: "",
    quote: null,
    mime_type: "text/html",
    from: null,
    reply_to: null,
    to: null,
    cc: null,
    bcc: null,
    references: "",
    in_reply_to: null,
    in_reply_to_uid: null,
    forwarded_uid: null,
    attachments: [],
    identity_id: null,
    ack_request: false,
    st_uuid: null,
    uid: null,
    resource: null,
    priority: "normal",
    encrypted: false,
    encryption_password: "",
    event_poll_uuid: null,
    action: "save",
    delay: 0,
};

/** The draft UUID in a message's draft resource (`/api/mail/<mailbox>/draft/<uuid>`). */
function draftUuidOf(message: any): string | null {
    if (typeof message?.draft_uuid === "string") return message.draft_uuid;
    for (const resource of [message?.draft_resource, message?.resource]) {
        const match = typeof resource === "string" ? resource.match(/\/draft\/([^/?#]+)/) : null;
        if (match) return decodeURIComponent(match[1]);
    }
    return null;
}

const ADDRESS_PATTERN = /^[^\s@<>,;"()]+@[^\s@<>,;"()]+\.[^\s@<>,;"()]+$/;

/** Split on commas that sit outside quotes and angle brackets. */
function splitAddressList(text: string): string[] {
    const parts: string[] = [];
    let current = "";
    let quoted = false;
    let angle = false;
    for (const char of text) {
        if (char === '"') quoted = !quoted;
        else if (!quoted && char === "<") angle = true;
        else if (!quoted && char === ">") angle = false;
        if (char === "," && !quoted && !angle) {
            parts.push(current);
            current = "";
        } else {
            current += char;
        }
    }
    parts.push(current);
    return parts.map((part) => part.trim()).filter(Boolean);
}

/** Parse `addr`, `Name <addr>`, or `"Last, First" <addr>`; throws on anything that is not an address. */
export function parseAddress(token: string): { name: string; email: string } {
    const bracket = token.match(/^(.*)<([^<>]*)>\s*$/);
    const email = (bracket ? bracket[2] : token).trim();
    if (!ADDRESS_PATTERN.test(email)) {
        throw new Error(`Invalid email address: "${token.slice(0, 100)}"`);
    }
    let name = bracket ? bracket[1].trim() : "";
    if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) {
        name = name.slice(1, -1).replace(/\\(.)/g, "$1");
    }
    return {name, email};
}

/** `Name <addr>`, or the bare address when there is no name. */
export function formatAddress(entry: any): string {
    const email = entry?.email ?? "";
    const name = typeof entry?.name === "string" ? entry.name.trim() : "";
    return name ? `${name} <${email}>` : email;
}

function formatAddresses(list: any): string {
    return Array.isArray(list) ? list.map(formatAddress).join(", ") : "";
}

/** Case-insensitive header lookup in the API's header map. */
function headerValue(headers: any, name: string): string {
    if (!headers || typeof headers !== "object") return "";
    const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
    const value = key ? headers[key] : "";
    return typeof value === "string" ? value : "";
}

/**
 * Every message of a thread as `{uid, folder_id, ref}`. `uid` is the bare UID
 * for read calls; `ref` is `uid@folder_id` for mark, move, flag, archive, and
 * delete, because a UID is only unique within its folder.
 */
function threadMessages(thread: any): Array<{ uid: string; folder_id: string | null; ref: string | null }> {
    return (Array.isArray(thread?.messages) ? thread.messages : [])
        .filter((m: any) => typeof m?.uid === "string" || typeof m?.uid === "number")
        .map((m: any) => {
            const [uid, uidFolder] = String(m.uid).split("@");
            const folderId = m.folder_id ?? uidFolder ?? null;
            return {uid, folder_id: folderId, ref: folderId === null ? null : `${uid}@${folderId}`};
        });
}

/** One row of a list or search result: the same fields for both. */
function threadRow(thread: any): Record<string, unknown> {
    const first = thread.messages?.[0];
    const draftUuid = draftUuidOf(first);
    return {
        thread_uid: thread.uid,
        subject: thread.subject || "(no subject)",
        from: formatAddresses(thread.from),
        to: formatAddresses(thread.to),
        date: thread.date,
        messages_count: thread.messages_count,
        unseen_messages: thread.unseen_messages,
        seen: (thread.unseen_messages ?? 0) === 0,
        flagged: thread.flagged ?? thread.messages?.some((m: any) => m.flagged) ?? false,
        preview: first?.preview || "",
        // A UID can arrive as a number
        first_message_uid: first?.uid === undefined || first?.uid === null ? null : String(first.uid).split("@")[0] || null,
        // A message without a folder cannot be read or changed through a ref, so it is left out
        messages: threadMessages(thread).filter((m) => m.folder_id !== null),
        folder_id: first?.folder_id || null,
        folder: first?.folder || null,
        ...(draftUuid ? {draft_uuid: draftUuid} : {}),
    };
}

/** Percent-decode a header value in the given charset; null when it is malformed. */
function decodeExtendedValue(value: string, charset: string): string | null {
    try {
        const bytes = Uint8Array.from(
            value.replace(/%([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))),
            (c) => c.charCodeAt(0),
        );
        return new TextDecoder(charset || "utf-8", {fatal: true}).decode(bytes).trim() || null;
    } catch {
        return null;
    }
}

/** Headers worth returning; the full map is large and mostly routing noise. */
const HEADER_ALLOWLIST = ["message-id", "in-reply-to", "references", "list-id", "list-unsubscribe", "reply-to"];

function pickHeaders(headers: any): Record<string, string> {
    const picked: Record<string, string> = {};
    for (const name of HEADER_ALLOWLIST) {
        const value = headerValue(headers, name);
        if (value) picked[name] = value.slice(0, 1000);
    }
    return picked;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function recipientsToText(recipients: any): string {
    if (!Array.isArray(recipients)) return "";
    return recipients.map((r: any) => r?.email).filter(Boolean).join(", ");
}

/** Mailbox offsets after the rows in `items` (each row has `mailbox_uuid`) were returned. */
export function advanceMailboxOffsets(base: Record<string, number>, items: any[]): Record<string, number> {
    const next = {...base};
    for (const item of items) {
        next[item.mailbox_uuid] = (next[item.mailbox_uuid] ?? 0) + 1;
    }
    return next;
}

/** A recipient list: addresses (`a@x.ch`, `Name <a@x.ch>`) or `{email, name}` objects. */
export type RecipientInput = string | Array<string | { email: string; name?: string }>;

/** Optional draft settings, kept out of the positional parameters. */
export interface DraftExtras {
    /** `text` (default) is escaped and wrapped; `html` is used as given. */
    bodyFormat?: "text" | "html";
    /** Plain text of the message being answered, appended as a quoted block. */
    quote?: string;
    /** Source message (`uid@folder_id`) for a forward. */
    forwardedUid?: string;
    attachments?: AttachmentInput[];
}

/** Fields `updateDraft` can change. */
export interface DraftUpdate {
    to?: RecipientInput;
    subject?: string;
    /** New text; the quoted original of a reply or forward made by this server stays below it. */
    body?: string;
    cc?: RecipientInput;
    bcc?: RecipientInput;
    /** Uploaded and appended to the draft's attachments; an empty array removes all of them. */
    attachments?: AttachmentInput[];
    /** Already uploaded attachment UUIDs, appended like `attachments` (used by createDraft). */
    attachmentUuids?: string[];
    /** With `attachmentUuids`: the draft's attachments become exactly these. */
    replaceAttachments?: boolean;
    bodyFormat?: "text" | "html";
    inReplyTo?: string;
    inReplyToUid?: string;
    references?: string;
    fromEmail?: string;
    fromName?: string;
}

/**
 * Split a draft body at the quote block `createHtmlBody` writes: the text
 * before it and the quoted text. Null when the body has no such block (the
 * block carries a marker attribute, or its original inline style). It finds the
 * quote in a draft that kMail saved again or that another process made.
 */
function splitQuote(html: string): { head: string; quote: string } | null {
    let found: RegExpMatchArray | null = null;
    for (const match of html.matchAll(/<blockquote\b[^>]{0,600}>/gi)) {
        if (/data-mcp-quote|border-left:\s*2px solid #ccc/i.test(match[0])) found = match;
    }
    if (!found || found.index === undefined) return null;
    const start = found.index + found[0].length;
    const end = html.slice(start).search(/<\/blockquote\s*>/i);
    return {
        head: html.slice(0, found.index),
        quote: htmlToText(end === -1 ? html.slice(start) : html.slice(start, start + end)),
    };
}

export class MailClient {
    private readonly headers: { Authorization: string; "Content-Type": string };
    private mailboxUuid: string | null = null;
    private mailboxes: any[] = [];
    private readonly draftsCache = new DraftCache();
    private mailboxesAt = 0;
    private readonly identitiesCache = new Map<string, { at: number; identities: any[] }>();
    private readonly folderCache = new Map<string, { at: number; folders: any[] }>();
    private readonly timeoutMs: number;
    private readonly retryDelayMs: number;

    constructor(token: string, options: MailClientOptions = {}) {
        this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
        this.retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
        this.headers = {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
        };
    }

    private parseRecipients(recipientInput?: RecipientInput): any[] | null {
        if (!recipientInput) return null;
        const entries = Array.isArray(recipientInput) ? recipientInput : [recipientInput];
        const recipients = entries.flatMap((entry) => {
            if (typeof entry !== "string") {
                // {email, name} keeps the display name as given
                return [{...parseAddress(entry.email), name: (entry.name ?? "").trim()}];
            }
            return splitAddressList(entry).map(parseAddress);
        });

        return recipients.length > 0 ? recipients : null;
    }

    private escapeHtml(text: string): string {
        const replacements: Record<string, string> = {
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            "\"": "&quot;",
            "'": "&#39;",
        };

        return text.replace(/[&<>"']/g, (char) => replacements[char]);
    }

    private createHtmlBody(body: string, format: "text" | "html" = "text", quote?: string): string {
        const content = format === "html" ? body : this.escapeHtml(body).replace(/\n/g, "<br>");
        const quoted = quote
            ? `<br><br><blockquote data-mcp-quote="1" style="margin: 0 0 0 0.8em; padding-left: 0.8em; border-left: 2px solid #ccc;">${this.escapeHtml(quote).replace(/\n/g, "<br>")}</blockquote>`
            : "";
        return `<html><body><div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; font-size: 14px;">${content}${quoted}</div></body></html>`;
    }

    /**
     * fetch with a timeout and the call's overall deadline. A GET is retried
     * once on a network error or status 429, 502, 503, 504 (honoring
     * Retry-After up to 10 s on 429 and 503). A timeout, a cancelled call, and
     * other methods are never retried: a timed-out request can still have side
     * effects, and a retry would double the wait.
     */
    private async fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
        const method = (init.method ?? "GET").toUpperCase();
        const attempts = method === "GET" ? 2 : 1;
        const call = callContext.getStore();
        for (let attempt = 1; ; attempt++) {
            this.throwIfCallEnded(call);
            const timeout = AbortSignal.timeout(this.timeoutMs);
            let response: Response;
            try {
                response = await fetch(url, {...init, signal: call ? AbortSignal.any([timeout, call]) : timeout});
            } catch (error) {
                this.throwIfCallEnded(call);
                if (timeout.aborted || (error as Error)?.name === "TimeoutError") {
                    throw new Error(`Request timed out after ${Math.round(this.timeoutMs / 1000)} s`, {cause: error});
                }
                if (attempt >= attempts) {
                    throw new Error(`Request failed: ${describeNetworkError(error)}`, {cause: error});
                }
                await this.sleep(this.retryDelayMs, call);
                continue;
            }
            if (attempt < attempts && RETRY_STATUSES.has(response.status)) {
                await response.body?.cancel().catch(() => undefined);
                await this.sleep(this.retryDelay(response), call);
                continue;
            }
            return response;
        }
    }

    private throwIfCallEnded(call: AbortSignal | undefined): void {
        if (!call?.aborted) return;
        const reason = call.reason as { name?: string } | undefined;
        throw new Error(reason?.name === "TimeoutError"
            ? `Tool call exceeded its ${Math.round(TOOL_DEADLINE_MS / 1000)} s deadline`
            : "Request cancelled");
    }

    private retryDelay(response: Response): number {
        if (![429, 503].includes(response.status)) return this.retryDelayMs;
        const header = response.headers?.get("retry-after")?.trim();
        if (!header) return this.retryDelayMs;
        // Seconds, or an HTTP date (RFC 9110)
        const seconds = /^\d+(\.\d+)?$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now();
        return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, MAX_RETRY_DELAY_MS) : this.retryDelayMs;
    }

    private sleep(ms: number, call?: AbortSignal): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const abort = () => {
                clearTimeout(timer);
                reject(call?.reason);
            };
            const timer = setTimeout(() => {
                call?.removeEventListener("abort", abort);
                resolve();
            }, ms);
            call?.addEventListener("abort", abort, {once: true});
        }).catch((error) => {
            this.throwIfCallEnded(call);
            throw error;
        });
    }

    private async apiRequestFull(url: string, options: RequestInit = {}): Promise<any> {
        const response = await this.fetchWithRetry(url, {
            ...options,
            headers: {
                ...this.headers,
                ...(options.headers as Record<string, string> || {}),
            },
        });

        if (!response.ok) {
            throw await errorFromResponse(response);
        }

        const body = await response.json();
        if (body?.result !== "success") {
            throw apiError(response.status, body, "unexpected response");
        }
        return body;
    }

    private async apiRequest(path: string, options: RequestInit = {}): Promise<any> {
        return this.apiRequestFull(`${API_BASE}${path}`, options);
    }

    private async loadMailboxes(): Promise<any[]> {
        const response = await this.apiRequest(
            "/mailbox?with=aliases,permissions,accountId,count_users",
        );
        this.mailboxes = response.data || [];
        this.mailboxesAt = Date.now();
        return this.mailboxes;
    }

    async init(): Promise<void> {
        const mailboxes = await this.loadMailboxes();
        if (!mailboxes.length) {
            throw new Error("No mailboxes found. Check your MAIL_TOKEN.");
        }
        const mailbox = mailboxes.find((m: any) => m.is_primary) ?? mailboxes[0];
        this.mailboxUuid = mailbox.uuid;
    }

    async getMailboxUuid(): Promise<string> {
        if (!this.mailboxUuid) await this.init();
        if (!this.mailboxUuid) throw new Error("Mailbox not initialized");
        return this.mailboxUuid;
    }

    private getMimeType(fileName: string): string {
        const ext = path.extname(fileName).toLowerCase();
        const mimeTypes: Record<string, string> = {
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".png": "image/png",
            ".gif": "image/gif",
            ".webp": "image/webp",
            ".pdf": "application/pdf",
            ".txt": "text/plain",
            ".html": "text/html",
            ".ics": "text/calendar",
            ".csv": "text/csv",
            ".doc": "application/msword",
            ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ".xls": "application/vnd.ms-excel",
            ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            ".ppt": "application/vnd.ms-powerpoint",
            ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            ".zip": "application/zip",
            ".rar": "application/x-rar-compressed",
            ".7z": "application/x-7z-compressed",
            ".mp3": "audio/mpeg",
            ".mp4": "video/mp4",
            ".mov": "video/quicktime",
            ".avi": "video/x-msvideo",
        };
        return mimeTypes[ext] || "application/octet-stream";
    }

    private async getMailboxInfo(mailboxUuid: string, refresh = false) {
        // An explicit mailbox_uuid skips getMailboxUuid, so load the list on first use
        if (!this.mailboxes.length) await this.init();
        else if (refresh || Date.now() - this.mailboxesAt > ACCOUNT_CACHE_TTL_MS) await this.loadMailboxes().catch(() => undefined);
        let mb = this.mailboxes.find((m: any) => m.uuid === mailboxUuid);
        if (!mb && !refresh) {
            // A mailbox added since the list was loaded
            await this.loadMailboxes().catch(() => undefined);
            mb = this.mailboxes.find((m: any) => m.uuid === mailboxUuid);
        }
        if (!mb) {
            throw new Error(`Mailbox not found: ${mailboxUuid}`);
        }
        return mb;
    }

    private async getIdentities(mailboxUuid: string, mbInfo: any, refresh = false): Promise<any[]> {
        const hit = this.identitiesCache.get(mailboxUuid);
        if (hit && !refresh && Date.now() - hit.at < ACCOUNT_CACHE_TTL_MS) return hit.identities;

        if (!mbInfo.hosting_id || !mbInfo.mailbox) {
            throw new Error("Mailbox is missing hosting_id or mailbox name; cannot load identities");
        }

        const response = await this.apiRequestFull(
            `${MANAGER_API_V1_BASE}${buildPath("mail_hostings", mbInfo.hosting_id, "mailboxes", mbInfo.mailbox, "signatures")}`,
        );

        const signatures = response?.data?.signatures;
        if (!Array.isArray(signatures)) {
            throw new Error("Unexpected signatures response");
        }

        this.identitiesCache.set(mailboxUuid, {at: Date.now(), identities: signatures});
        return signatures;
    }

    private async resolveFrom(
        mailboxUuid: string,
        mbInfo: any,
        fromEmailParam?: string,
        fromNameParam?: string,
    ): Promise<{ email: string; name: string; identityId: string | null; warnings: string[] }> {
        const warnings: string[] = [];

        const allowed = (info: any): string[] => [
            info.email,
            ...(Array.isArray(info.aliases) ? info.aliases : []),
        ].filter((e: any) => typeof e === "string" && e.trim().length > 0);
        let allowedEmails = allowed(mbInfo);

        let fromEmail = mbInfo.email;
        if (fromEmailParam) {
            const requested = fromEmailParam.trim().toLowerCase();
            let match = allowedEmails.find((e: string) => e.toLowerCase() === requested);
            if (!match) {
                // An alias added in kMail since the list was loaded
                mbInfo = await this.getMailboxInfo(mailboxUuid, true);
                allowedEmails = allowed(mbInfo);
                match = allowedEmails.find((e: string) => e.toLowerCase() === requested);
            }
            if (!match) {
                throw new Error(
                    `from_email "${fromEmailParam}" is not allowed: use the mailbox address or one of its aliases (${allowedEmails.join(", ")})`,
                );
            }
            fromEmail = match;
        }

        // The API builds the From header from the sending identity (identity_id):
        // - identity_id set  -> signature sender + signature full_name
        // - identity_id null -> default identity sender + account profile display name
        // The from.name payload field is ignored by the API.
        let identity: any = null;
        try {
            let identities = await this.getIdentities(mailboxUuid, mbInfo);
            const forFrom = (list: any[]) => list.filter(
                (s: any) => typeof s?.sender === "string" && s.sender.toLowerCase() === fromEmail.toLowerCase(),
            );
            let candidates = forFrom(identities);
            if (fromEmailParam && candidates.length === 0) {
                // An identity created in kMail since the list was loaded
                identities = await this.getIdentities(mailboxUuid, mbInfo, true);
                candidates = forFrom(identities);
            }

            if (fromNameParam) {
                const requested = fromNameParam.trim().toLowerCase();
                identity =
                    candidates.find(
                        (s: any) => typeof s?.full_name === "string" && s.full_name.trim().toLowerCase() === requested,
                    ) || null;
                if (!identity) {
                    warnings.push(
                        `No identity named "${fromNameParam}" for ${fromEmail}: the display name comes from the matching identity or the account profile, not from from_name`,
                    );
                }
            }

            if (!identity) {
                // A signature with an empty full_name would produce an anonymous From header
                const named = candidates.filter(
                    (s: any) => typeof s?.full_name === "string" && s.full_name.trim().length > 0,
                );
                identity = named.find((s: any) => s.is_default) || named[0] || null;
            }

            if (fromEmailParam && !identity && fromEmail.toLowerCase() !== String(mbInfo.email).toLowerCase()) {
                warnings.push(
                    `No sending identity exists for ${fromEmail}: the API will send from the default identity address instead. Create an identity for this alias in kMail to use it`,
                );
            }
        } catch (error) {
            // Without identities the API sends from the default address, which is wrong for an alias
            if (fromEmail.toLowerCase() !== String(mbInfo.email).toLowerCase()) {
                throw new Error(
                    `Cannot send from alias ${fromEmail}: the sending identities could not be loaded (${error instanceof Error ? error.message : "unknown error"})`,
                );
            }
            warnings.push(
                "Sending identities could not be loaded: the display name comes from the account profile",
            );
        }

        return {
            email: fromEmail,
            name: identity?.full_name || fromNameParam || fromEmail.split("@")[0],
            identityId: identity ? String(identity.id) : null,
            warnings,
        };
    }

    async uploadAttachment(attachment: AttachmentInput, mailboxUuid?: string): Promise<string> {
        const uuid = mailboxUuid || await this.getMailboxUuid();
        if (!uuid) throw new Error("Mailbox not initialized");

        const fileBuffer = decodeBase64Attachment(attachment.base64_content);
        const fileName = attachment.filename;
        const mimeType = attachment.mime_type || this.getMimeType(fileName);

        const response = await this.apiRequest(
            buildPath("mail", uuid, "draft", "attachment"),
            {
                method: "POST",
                body: new Uint8Array(fileBuffer),
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    "x-ws-attachment-disposition": "attachment",
                    "x-ws-attachment-filename": headerFilename(fileName),
                    "x-ws-attachment-mime-type": mimeType,
                },
            },
        );

        return response.data.uuid;
    }

    async listMailboxes(): Promise<any[]> {
        if (!this.mailboxes.length) await this.loadMailboxes();
        else if (Date.now() - this.mailboxesAt > ACCOUNT_CACHE_TTL_MS) await this.loadMailboxes().catch(() => undefined);
        return this.mailboxes.map((m: any) => ({
            uuid: m.uuid,
            email: m.email,
            mailbox: m.mailbox,
            is_primary: m.is_primary,
            hosting_id: m.hosting_id,
            aliases: Array.isArray(m.aliases) ? m.aliases.filter((a: unknown) => typeof a === "string") : [],
        }));
    }

    /**
     * Sending identities of a mailbox (from `GET /1/mail_hostings/{id}/mailboxes/{name}/signatures`):
     * the `from_email` and `from_name` values that `createDraft` and friends resolve.
     */
    async listIdentities(mailboxUuid: string): Promise<any[]> {
        const mbInfo = await this.getMailboxInfo(mailboxUuid);
        const identities = await this.getIdentities(mailboxUuid, mbInfo);
        return identities.map((s: any) => ({
            id: s?.id,
            sender: s?.sender,
            full_name: s?.full_name,
            is_default: s?.is_default === true,
        }));
    }

    /** Folders per mailbox for role lookups; the folder tools always fetch fresh counts. */
    private async cachedFolders(mailboxUuid: string): Promise<any[]> {
        const hit = this.folderCache.get(mailboxUuid);
        if (hit && Date.now() - hit.at < FOLDER_CACHE_TTL_MS) return hit.folders;
        return this.listFolders(mailboxUuid);
    }

    async listFolders(mailboxUuid: string): Promise<any[]> {
        const response = await this.apiRequest(
            `${buildPath("mail", mailboxUuid, "folder")}?with=ik-static`,
        );

        const flatten = (folders: any[], prefix = ""): any[] => {
            const result: any[] = [];
            for (const folder of folders || []) {
                const fullPath = prefix
                    ? `${prefix}${folder.separator}${folder.name}`
                    : folder.name;
                result.push({
                    id: folder.id,
                    name: folder.name,
                    path: fullPath,
                    role: folder.role,
                    unread_count: folder.unread_count,
                    total_count: folder.total_count,
                });
                if (folder.children?.length) {
                    result.push(...flatten(folder.children, fullPath));
                }
            }
            return result;
        };

        const folders = flatten(response.data || []);
        this.folderCache.set(mailboxUuid, {at: Date.now(), folders});
        return folders;
    }

    async createFolder(
        mailboxUuid: string,
        name: string,
        parentFolderId?: string,
    ): Promise<any> {
        const payload: any = {
            name,
        };
        if (parentFolderId) {
            payload.parent = parentFolderId;
        }

        const response = await this.apiRequest(buildPath("mail", mailboxUuid, "folder"), {
            method: "POST",
            body: JSON.stringify(payload),
        });
        this.folderCache.delete(mailboxUuid);

        return {
            id: response.data?.id,
            name: response.data?.name,
            parent_folder_id: parentFolderId || null,
        };
    }

    async deleteFolder(
        mailboxUuid: string,
        folderId: string,
    ): Promise<any> {
        const folders = await this.cachedFolders(mailboxUuid);
        const folder = folders.find((f: any) => String(f.id) === folderId);
        if (folder?.role) {
            throw new Error(`Refusing to delete the system folder "${folder.name}" (role ${folder.role})`);
        }

        const response = await this.apiRequest(buildPath("mail", mailboxUuid, "folder", folderId), {
            method: "DELETE",
        });
        this.folderCache.delete(mailboxUuid);

        return {
            result: "success",
            folder_id: folderId,
        };
    }

    async renameFolder(
        mailboxUuid: string,
        folderId: string,
        name: string,
    ): Promise<any> {
        const response = await this.apiRequest(buildPath("mail", mailboxUuid, "folder", folderId, "rename"), {
            method: "POST",
            body: JSON.stringify({ name }),
        });
        this.folderCache.delete(mailboxUuid);

        return {
            id: folderId,
            name,
        };
    }

    async listEmails(
        mailboxUuid: string,
        folderId: string,
        limit: number = 50,
        offset: number = 0,
        options: { unseen?: boolean; flagged?: boolean } = {},
    ): Promise<any[]> {
        if (options.unseen && options.flagged) {
            throw new Error(
                "The mail API supports only one filter at a time; request unseen or flagged, not both.",
            );
        }

        const filter = options.unseen ? "unseen" : options.flagged ? "starred" : null;
        const params = new URLSearchParams({
            offset: String(offset),
            thread: "on",
            severywhere: "0",
            limit: String(limit),
        });
        if (filter) params.set("filters", filter);

        const response = await this.apiRequest(
            `${buildPath("mail", mailboxUuid, "folder", folderId, "message")}?${params.toString()}`,
        );

        return (response.data?.threads || []).map((thread: any) => threadRow(thread));
    }

    async searchEmails(
        mailboxUuid: string,
        options: {
            query?: string;
            from?: string;
            to?: string;
            subject?: string;
            since?: string;
            before?: string;
            folderId?: string;
            limit?: number;
            offset?: number;
            unseen?: boolean;
            flagged?: boolean;
        },
    ): Promise<any[]> {
        const {
            query,
            from,
            to,
            subject,
            since,
            before,
            folderId,
            limit = 50,
            offset = 0,
            unseen,
            flagged,
        } = options;

        if (!query && !from && !to && !subject && !since && !before && !unseen && !flagged) {
            throw new Error(
                "At least one search filter (query, from, to, subject, since, before, unseen, or flagged) must be provided.",
            );
        }
        if (unseen && flagged) {
            throw new Error(
                "The mail API supports only one filter at a time; request unseen or flagged, not both.",
            );
        }

        let searchFolderId = folderId;
        let severywhere = "0";

        if (!searchFolderId) {
            severywhere = "1";
            searchFolderId = await this.findFolderByRole(mailboxUuid, "INBOX");
        }

        const params = new URLSearchParams();
        params.set("offset", String(offset));
        params.set("thread", "off");
        params.set("severywhere", severywhere);
        params.set("limit", String(limit));

        if (unseen) params.set("filters", "unseen");
        if (flagged) params.set("filters", "starred");
        if (query) params.set("scontains", query);
        if (from) params.set("sfrom", from);
        if (to) params.set("sto", to);
        if (subject) params.set("ssubject", subject);
        for (const [label, value] of [["since", since], ["before", before]]) {
            if (value && !DATE_PATTERN.test(value)) {
                throw new Error(`${label} must be a date in YYYY-MM-DD format`);
            }
        }
        // before is inclusive: the whole day is searched
        if (since) params.set("sfromdate", `${since} 00:00:00`);
        if (before) params.set("stodate", `${before} 23:59:59`);

        const response = await this.apiRequest(
            `${buildPath("mail", mailboxUuid, "folder", searchFolderId as string, "message")}?${params.toString()}`,
        );

        return (response.data?.threads || []).map((thread: any) => threadRow(thread));
    }

    private async fetchMessage(mailboxUuid: string, folderId: string, messageId: string): Promise<any> {
        const response = await this.apiRequest(
            `${buildPath("mail", mailboxUuid, "folder", folderId, "message", messageId)}?prefered_format=html&with=auto_uncrypt`,
        );
        return response.data;
    }

    /**
     * Body of a fetched message as text (HTML converted) or raw HTML, cut to
     * `maxLength` characters and to `budget` JSON-escaped characters.
     */
    private messageBody(data: any, format: "text" | "html", maxLength: number, budget = MAX_TEXT_LENGTH) {
        const rawBody: string =
            typeof data.body === "string" ? data.body : data.body?.value ?? data.html ?? "";
        const bodyType = String(data.body?.type ?? "");
        const isHtml = bodyType ? /html/i.test(bodyType) : /<[a-z][\s\S]*>/i.test(rawBody);
        const converted = format === "html" || !isHtml ? {text: rawBody, truncated: false} : htmlToTextResult(rawBody);
        const content = converted.text;
        const text = capJsonString(content.length > maxLength ? content.slice(0, maxLength) : content, Math.max(0, budget));
        return {text, truncated: converted.truncated || text.length < content.length, isHtml};
    }

    /**
     * Search every mailbox of the account; each row carries its `mailbox_uuid`.
     * Mailboxes are queried in parallel and merged newest first; a failing
     * mailbox is reported in `warnings`. `mailboxOffsets` is the
     * `next_mailbox_offsets` of the previous page.
     */
    async searchAllMailboxes(
        options: Omit<Parameters<MailClient["searchEmails"]>[1], "folderId" | "offset">,
        mailboxOffsets: Record<string, number> = {},
    ): Promise<{ items: any[]; has_more: boolean; next_mailbox_offsets: Record<string, number>; warnings?: string[] }> {
        const limit = options.limit ?? 50;
        const mailboxes = await this.listMailboxes();
        const settled = await Promise.allSettled(
            mailboxes.map((mailbox: any) =>
                this.searchEmails(mailbox.uuid, {...options, offset: mailboxOffsets[mailbox.uuid] ?? 0})),
        );

        const warnings: string[] = [];
        const lists: Array<{ uuid: string; rows: any[] }> = [];
        let hasMore = false;
        settled.forEach((result, index) => {
            const uuid = mailboxes[index].uuid;
            if (result.status === "rejected") {
                const reason = result.reason instanceof Error ? result.reason.message : "request failed";
                warnings.push(`Mailbox ${uuid} (${mailboxes[index].email}) was not searched: ${reason}`);
                return;
            }
            if (result.value.length >= limit) hasMore = true;
            lists.push({uuid, rows: result.value});
        });

        if (lists.length === 0) {
            // Warnings with no items would read as "no results"
            throw new Error(`No mailbox could be searched: ${warnings.join("; ")}`.slice(0, 1000));
        }

        // k-way merge, newest first; ties go to the mailbox UUID, then the thread UID
        const time = (row: any) => (Number.isNaN(Date.parse(row.date)) ? -Infinity : Date.parse(row.date));
        const positions = lists.map(() => 0);
        const items: any[] = [];
        const consumed: Record<string, number> = {};
        while (items.length < limit) {
            let best = -1;
            for (let i = 0; i < lists.length; i++) {
                const row = lists[i].rows[positions[i]];
                if (!row) continue;
                if (best === -1) {
                    best = i;
                    continue;
                }
                const current = lists[best].rows[positions[best]];
                const diff = time(row) - time(current);
                const order = diff !== 0 && !Number.isNaN(diff)
                    ? -diff
                    : lists[i].uuid.localeCompare(lists[best].uuid) || String(row.thread_uid).localeCompare(String(current.thread_uid));
                if (order < 0) best = i;
            }
            if (best === -1) break;
            items.push({mailbox_uuid: lists[best].uuid, ...lists[best].rows[positions[best]]});
            consumed[lists[best].uuid] = (consumed[lists[best].uuid] ?? 0) + 1;
            positions[best]++;
        }
        if (lists.some((list, i) => positions[i] < list.rows.length)) hasMore = true;

        return {
            items,
            has_more: hasMore,
            next_mailbox_offsets: advanceMailboxOffsets(mailboxOffsets, items),
            ...(warnings.length > 0 ? {warnings} : {}),
        };
    }

    /** Header fields of a fetched message, without its body. */
    private emailFields(data: any, folderId?: string): Record<string, unknown> {
        return {
            uid: data.uid,
            ...(folderId === undefined ? {} : {folder_id: folderId, ref: `${data.uid ?? ""}@${folderId}`}),
            msg_id: data.msg_id,
            subject: data.subject || "(no subject)",
            from: formatAddresses(data.from),
            to: formatAddresses(data.to),
            cc: formatAddresses(data.cc),
            bcc: formatAddresses(data.bcc),
            reply_to: formatAddresses(data.reply_to),
            date: data.date,
            has_attachments: data.has_attachments,
            attachments: (data.attachments || []).map((att: any) => ({
                id: att.resource ? att.resource.split("/").pop() : String(att.part_id),
                filename: att.name,
                mime_type: att.mime_type || 'application/octet-stream',
                size: att.size || 0,
                url: att.resource || null,
            })),
            seen: data.seen,
            flagged: data.flagged,
            folder: data.folder,
            headers: pickHeaders(data.headers),
        };
    }

    async readEmail(
        mailboxUuid: string,
        folderId: string,
        messageId: string,
        options: { format?: "text" | "html"; maxLength?: number } = {},
    ): Promise<any> {
        const data = await this.fetchMessage(mailboxUuid, folderId, messageId);
        const format = options.format ?? "text";
        const fields = this.emailFields(data);
        // The whole result, not just the body, must stay under the text cap
        const budget = MAX_TEXT_LENGTH - JSON.stringify(fields).length - 128;
        const { text, isHtml, truncated } = this.messageBody(data, format, options.maxLength ?? 50_000, budget);
        return {
            ...fields,
            body_format: format === "html" && isHtml ? "html" : "text",
            untrusted_content: text,
            truncated,
        };
    }

    async downloadAttachment(
        mailboxUuid: string,
        folderId: string,
        messageId: string,
        attachmentId: string,
    ): Promise<DownloadedAttachment> {
        const url = `${API_BASE}${buildPath("mail", mailboxUuid, "folder", folderId, "message", messageId, "attachment", attachmentId)}`;

        const response = await this.fetchWithRetry(url, {
            headers: { Authorization: this.headers.Authorization },
        });

        if (!response.ok) {
            if (response.status === 404) {
                throw new Error(`Attachment ${attachmentId} not found for message ${messageId}`);
            }
            throw await errorFromResponse(response);
        }

        const filename = this.parseFilename(
            response.headers.get("content-disposition") || "",
            attachmentId,
        );

        const contentType = response.headers.get("content-type") || "application/octet-stream";
        const mimeType = contentType.split(";")[0].trim();

        const tooLarge = (size: string) =>
            new Error(`Attachment is ${size}, over the ${MAX_DOWNLOAD_SIZE / 1024 / 1024} MB limit for a tool result: open it in kMail instead`);
        // A missing or non-numeric content-length is unknown, not small
        const declared = response.headers.get("content-length");
        const contentLength = declared !== null && /^\d+$/.test(declared.trim()) ? Number(declared) : null;
        if (contentLength !== null && contentLength > MAX_DOWNLOAD_SIZE) {
            await response.body?.cancel().catch(() => undefined);
            throw tooLarge(`${contentLength} bytes`);
        }

        // Read as a stream and stop at the limit: content-length can be missing or wrong
        const chunks: Uint8Array[] = [];
        let size = 0;
        const reader = response.body?.getReader();
        while (reader) {
            const {done, value} = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_DOWNLOAD_SIZE) {
                await reader.cancel().catch(() => undefined);
                throw tooLarge("larger than the limit");
            }
            chunks.push(value);
        }
        const base64Content = Buffer.concat(chunks).toString("base64");

        return {
            filename,
            mime_type: mimeType,
            size,
            content: base64Content,
        };
    }

    private parseFilename(contentDisposition: string, fallback: string): string {
        // RFC 5987: filename*=charset'language'percent-encoded-value
        const starMatch = contentDisposition.match(/filename\*\s*=\s*([^;]+)/i);
        if (starMatch) {
            const raw = starMatch[1].trim();
            const encoded = raw.match(/^([^']*)'[^']*'(.+)$/);
            const decoded = decodeExtendedValue(encoded ? encoded[2] : raw, encoded ? encoded[1] : "utf-8");
            if (decoded) return decoded;
        }

        const quoted = contentDisposition.match(/filename\s*=\s*"((?:[^"\\]|\\.)*)"/i);
        if (quoted) return quoted[1].replace(/\\(.)/g, "$1").trim() || fallback;

        const bare = contentDisposition.match(/filename\s*=\s*([^;]+)/i);
        return bare ? bare[1].trim() || fallback : fallback;
    }

    async sendEmail(
        to: RecipientInput,
        subject: string,
        body: string,
        cc?: RecipientInput,
        bcc?: RecipientInput,
        attachments?: AttachmentInput[],
        mailboxUuid?: string,
        inReplyTo?: string,
        inReplyToUid?: string,
        references?: string,
        fromEmail?: string,
        fromName?: string,
        extra: DraftExtras = {},
    ): Promise<any> {
        const uuid = mailboxUuid || await this.getMailboxUuid();
        const draftInfo = await this.createDraft(to, subject, body, cc, bcc, uuid, inReplyTo, inReplyToUid, references, fromEmail, fromName, {...extra, attachments});
        return this.sendCreatedDraft(draftInfo.uuid, uuid);
    }

    /** Send a draft created a moment ago; on failure the error names the draft that stays in Drafts. */
    private async sendCreatedDraft(draftUuid: string, mailboxUuid: string): Promise<any> {
        try {
            return await this.sendDraft(draftUuid, 0, mailboxUuid, false);
        } catch (error) {
            const message = error instanceof Error ? error.message : "Send failed";
            // "<status> <code>: ..." is an answer from the API. Anything else (timeout, network error,
            // cancelled call) leaves it open whether the send went through.
            const status = Number(message.match(/^(\d{3}) /)?.[1]);
            const answered = status >= 400 && status < 500;
            const advice = answered
                ? `the draft ${draftUuid} stays in Drafts: retry with mail_send_draft instead of sending again`
                : `the mail may already have been sent: check the Sent folder before retrying; if it is not there, the draft ${draftUuid} stays in Drafts and mail_send_draft sends it`;
            throw new Error(`${message} (${advice})`, {cause: error});
        }
    }

    private async uploadAll(attachments: AttachmentInput[] | undefined, mailboxUuid: string): Promise<string[]> {
        const uuids: string[] = [];
        for (const attachment of attachments ?? []) {
            uuids.push(await this.uploadAttachment(attachment, mailboxUuid));
        }
        return uuids;
    }

    private parseInReplyToUid(inReplyToUid: string): { uid: string; folderId: string } {
        const atIndex = inReplyToUid.lastIndexOf("@");
        if (atIndex === -1) {
            throw new Error(
                `Invalid in_reply_to_uid format: ${inReplyToUid}. Expected format: 'UID@folder_id'`,
            );
        }
        return {
            uid: inReplyToUid.substring(0, atIndex),
            folderId: inReplyToUid.substring(atIndex + 1),
        };
    }

    private async resolveThreadingHeaders(
        mailboxUuid: string,
        inReplyToUid: string,
    ): Promise<{ inReplyTo: string; references: string }> {
        const { uid, folderId } = this.parseInReplyToUid(inReplyToUid);
        const sourceEmail = await this.fetchMessage(mailboxUuid, folderId, uid);
        return this.threadingFrom(sourceEmail, inReplyToUid);
    }

    private threadingFrom(sourceEmail: any, label: string): { inReplyTo: string; references: string } {
        const sourceMsgId = sourceEmail.msg_id;
        if (!sourceMsgId) {
            throw new Error(
                `Source message ${label} has no msg_id; cannot build threading headers`,
            );
        }

        // RFC 5322 3.6.4: References of the parent, else its In-Reply-To, plus its Message-ID
        const sourceRefs =
            headerValue(sourceEmail.headers, "references") ||
            headerValue(sourceEmail.headers, "in-reply-to");

        const refParts = sourceRefs.split(/\s+/).filter((r: string) => r.length > 0);
        if (!refParts.includes(sourceMsgId)) {
            refParts.push(sourceMsgId);
        }

        return {
            inReplyTo: sourceMsgId,
            references: refParts.join(" "),
        };
    }

    async createDraft(
        to: RecipientInput | undefined,
        subject: string,
        body: string,
        cc?: RecipientInput,
        bcc?: RecipientInput,
        mailboxUuid?: string,
        inReplyTo?: string,
        inReplyToUid?: string,
        references?: string,
        fromEmail?: string,
        fromName?: string,
        extra: DraftExtras = {},
    ): Promise<any> {
        const uuid = mailboxUuid || await this.getMailboxUuid();
        const mbInfo = await this.getMailboxInfo(uuid);

        // Everything that can throw runs before the first upload, so a failure wastes no upload
        let resolvedInReplyTo = inReplyTo || null;
        let resolvedReferences = references || inReplyTo || "";

        if (inReplyToUid && (!inReplyTo || !references)) {
            const threading = await this.resolveThreadingHeaders(uuid, inReplyToUid);
            if (!inReplyTo) {
                resolvedInReplyTo = threading.inReplyTo;
            }
            if (!references) {
                resolvedReferences = threading.references;
            }
        }

        const from = await this.resolveFrom(uuid, mbInfo, fromEmail, fromName);

        const toRecipients = this.parseRecipients(to);
        const ccRecipients = this.parseRecipients(cc);
        const bccRecipients = this.parseRecipients(bcc);
        const htmlBody = this.createHtmlBody(body, extra.bodyFormat, extra.quote);

        const attachmentUuids = await this.uploadAll(extra.attachments, uuid);

        const payload: any = {
            ...DRAFT_DEFAULTS,
            subject,
            body: htmlBody,
            from: {
                id: null,
                name: from.name,
                email: from.email,
            },
            to: toRecipients,
            cc: ccRecipients,
            bcc: bccRecipients,
            references: resolvedReferences,
            in_reply_to: resolvedInReplyTo,
            in_reply_to_uid: inReplyToUid || null,
            forwarded_uid: extra.forwardedUid || null,
            // Unverified: whether POST accepts attachments; the PUT below is the fallback
            attachments: attachmentUuids,
            identity_id: from.identityId,
        };

        let response: any;
        try {
            response = await this.apiRequest(buildPath("mail", uuid, "draft"), {
                method: "POST",
                body: JSON.stringify(payload),
            });
        } catch (error) {
            if (attachmentUuids.length === 0) throw error;
            throw new Error(`${error instanceof Error ? error.message : "Draft creation failed"} (${attachmentUuids.length} attachment upload(s) were left unused)`, {cause: error});
        }

        const draftUuid = response.data.uuid;
        payload.uuid = draftUuid;
        payload.uid = response.data.uid;
        const entry: DraftEntry = {
            payload,
            mailboxUuid: uuid,
            plain: {body, to, cc, bcc, local: true},
            quote: extra.quote,
        };
        this.draftsCache.set(draftUuid, entry);

        const returned = Array.isArray(response.data.attachments)
            ? response.data.attachments.map((a: any) => (typeof a === "string" ? a : a?.uuid))
            : [];
        if (attachmentUuids.length > 0 && !attachmentUuids.every((id) => returned.includes(id))) {
            try {
                await this.applyDraftUpdate(draftUuid, uuid, entry, {attachmentUuids, replaceAttachments: true});
            } catch (error) {
                // Do not leave a half-built draft behind
                await this.deleteDraft(draftUuid, uuid).catch(() => undefined);
                throw error;
            }
        }

        const result: any = {
            uuid: draftUuid,
            uid: response.data.uid,
            subject,
            body,
            to,
            cc,
            bcc,
            resolved_from: {
                email: from.email,
                name: from.name,
                identity_id: from.identityId,
            },
        };
        if (from.warnings.length > 0) {
            result.warnings = from.warnings;
        }
        return result;
    }

    /**
     * Load the draft from the API before every update or send, so an edit the
     * human made in kMail is not overwritten. With `strict` (a send) a failed
     * load is an error: nothing is mailed from a copy that may be out of date.
     * Otherwise a transient failure (timeout, 5xx, network) falls back to the
     * cached copy of a draft made by this process, which can replace edits made
     * in kMail since. The cache also keeps the text this process wrote, so a
     * result can tell it apart from text another party could have edited.
     *
     * Unverified: `GET /mail/<mailbox>/draft/<uuid>` is not in Infomaniak's
     * public OpenAPI. It is the path the client already uses for PUT and DELETE.
     */
    private async loadDraft(draftUuid: string, mailboxUuid: string, strict = false): Promise<DraftEntry> {
        const cached = this.draftsCache.get(draftUuid);
        let data: any;
        try {
            const response = await this.apiRequest(buildPath("mail", mailboxUuid, "draft", draftUuid));
            data = response.data;
        } catch (error) {
            const message = error instanceof Error ? error.message : "request failed";
            if (strict) {
                throw new Error(`Draft ${draftUuid} could not be loaded, so nothing was sent: ${message}`, {cause: error});
            }
            if (cached && !/^(401|403|404) /.test(message)) return cached;
            throw error;
        }
        if (!data || typeof data !== "object") {
            throw new Error(`Draft ${draftUuid} not found`);
        }

        const payload: any = {...DRAFT_DEFAULTS};
        for (const key of Object.keys(DRAFT_DEFAULTS)) {
            if (data[key] !== undefined) payload[key] = data[key];
        }
        // Message attachments carry `resource` (a path ending in the UUID) where draft attachments carry `uuid`
        const attachmentUuid = (a: any): string | undefined => {
            const value = typeof a === "string" ? a : typeof a?.uuid === "string" ? a.uuid
                : typeof a?.resource === "string" ? a.resource.split("/").filter(Boolean).pop() : undefined;
            return value && value.length > 0 ? value : undefined;
        };
        const rawAttachments: unknown[] = Array.isArray(data.attachments) ? data.attachments : [];
        payload.attachments = rawAttachments.map(attachmentUuid).filter((a): a is string => a !== undefined);
        if (payload.attachments.length < rawAttachments.length) {
            const lost = rawAttachments.length - payload.attachments.length;
            throw new Error(`Draft ${draftUuid} has ${lost} attachment(s) that cannot be identified, so it was not changed; open it in kMail`);
        }
        payload.uuid = draftUuid;

        if (!payload.from) {
            if (!this.mailboxes.length) await this.init();
            const from = await this.resolveFrom(mailboxUuid, await this.getMailboxInfo(mailboxUuid));
            payload.from = {id: null, name: from.name, email: from.email};
            payload.identity_id ??= from.identityId;
        }

        // The cached text only describes the body this process wrote; recipients always come from the API
        const unchanged = cached !== undefined && cached.payload.body === payload.body;
        const isHtml = typeof payload.body === "string" && /<[a-z][\s\S]*>/i.test(payload.body);
        const split = !unchanged && isHtml ? splitQuote(payload.body) : null;
        const entry: DraftEntry = {
            payload,
            mailboxUuid,
            plain: {
                body: unchanged
                    ? cached.plain.body
                    : isHtml ? htmlToText(split ? split.head : payload.body) : payload.body,
                local: unchanged && cached.plain.local !== false,
                to: recipientsToText(payload.to),
                cc: recipientsToText(payload.cc),
                bcc: recipientsToText(payload.bcc),
            },
            quote: unchanged ? cached.quote : split?.quote,
        };
        this.draftsCache.set(draftUuid, entry);
        return entry;
    }

    /** Mailbox for a draft call: explicit argument, then the cached draft's mailbox, then the primary. */
    private draftMailbox(draftUuid: string, mailboxUuid?: string): Promise<string> | string {
        return mailboxUuid || this.draftsCache.get(draftUuid)?.mailboxUuid || this.getMailboxUuid();
    }

    async updateDraft(
        draftUuid: string,
        options: DraftUpdate,
        mailboxUuid?: string,
    ): Promise<any> {
        const uuid = await this.draftMailbox(draftUuid, mailboxUuid);
        return this.applyDraftUpdate(draftUuid, uuid, await this.loadDraft(draftUuid, uuid), options);
    }

    private async applyDraftUpdate(draftUuid: string, uuid: string, cached: DraftEntry, options: DraftUpdate): Promise<any> {
        const payload = {...cached.payload};
        const plain = {...cached.plain};

        if (options.to !== undefined) {
            payload.to = this.parseRecipients(options.to);
            plain.to = options.to;
        }
        if (options.subject !== undefined) {
            payload.subject = options.subject;
        }
        if (options.body !== undefined) {
            // The quoted original of a reply or forward made here stays below the new text
            payload.body = this.createHtmlBody(options.body, options.bodyFormat, cached.quote);
            plain.body = options.body;
            plain.local = true;
        }
        if (options.cc !== undefined) {
            payload.cc = this.parseRecipients(options.cc);
            plain.cc = options.cc;
        }
        if (options.bcc !== undefined) {
            payload.bcc = this.parseRecipients(options.bcc);
            plain.bcc = options.bcc;
        }

        if (options.inReplyTo || options.inReplyToUid || options.references) {
            let inReplyTo = options.inReplyTo ?? payload.in_reply_to ?? null;
            let references = options.references ?? "";
            if (options.inReplyToUid && (!options.inReplyTo || !options.references)) {
                const threading = await this.resolveThreadingHeaders(uuid, options.inReplyToUid);
                if (!options.inReplyTo) inReplyTo = threading.inReplyTo;
                if (!options.references) references = threading.references;
            } else if (!references && inReplyTo) {
                references = inReplyTo;
            }
            payload.in_reply_to = inReplyTo;
            payload.references = references || payload.references;
            if (options.inReplyToUid) payload.in_reply_to_uid = options.inReplyToUid;
        }

        let warnings: string[] = [];
        if (options.fromEmail || options.fromName) {
            const from = await this.resolveFrom(uuid, await this.getMailboxInfo(uuid), options.fromEmail, options.fromName);
            payload.from = {id: null, name: from.name, email: from.email};
            payload.identity_id = from.identityId;
            warnings = from.warnings;
        }

        payload.action = "save";
        payload.uuid = draftUuid;
        payload.resource = `/api${buildPath("mail", uuid, "draft", draftUuid)}`;

        if (options.replaceAttachments) {
            payload.attachments = [...(options.attachmentUuids ?? [])];
        } else if (options.attachments !== undefined && options.attachments.length === 0 && !options.attachmentUuids?.length) {
            payload.attachments = [];
        } else {
            const added = options.attachmentUuids ?? await this.uploadAll(options.attachments, uuid);
            if (added.length > 0) {
                payload.attachments = [...(payload.attachments ?? []), ...added];
            }
        }

        const response = await this.apiRequest(buildPath("mail", uuid, "draft", draftUuid), {
            method: "PUT",
            body: JSON.stringify(payload),
        });

        payload.uid = response.data?.uid || payload.uid;
        this.draftsCache.set(draftUuid, {payload, mailboxUuid: uuid, plain, quote: cached.quote});

        return {
            uuid: draftUuid,
            uid: payload.uid,
            subject: payload.subject,
            // Text that came from kMail could be edited by anyone with access: it is third-party content
            ...(plain.local === false ? {untrusted_content: plain.body} : {body: plain.body}),
            to: plain.to,
            cc: plain.cc,
            bcc: plain.bcc,
            attachments: payload.attachments?.length ?? 0,
            ...(warnings.length > 0 ? {warnings} : {}),
        };
    }

    /**
     * Send a draft. The draft is loaded from the API first, so the version the
     * human sees in kMail is the one that goes out. `fresh: false` skips the
     * load for a draft this process created a moment ago.
     */
    async sendDraft(
        draftUuid: string,
        delay: number = 0,
        mailboxUuid?: string,
        fresh: boolean = true,
    ): Promise<any> {
        const uuid = await this.draftMailbox(draftUuid, mailboxUuid);
        const cached = fresh || !this.draftsCache.get(draftUuid)
            ? await this.loadDraft(draftUuid, uuid, true)
            : this.draftsCache.get(draftUuid)!;

        const payload = {...cached.payload};
        payload.action = "send";
        payload.delay = delay;
        payload.uuid = draftUuid;
        payload.resource = `/api${buildPath("mail", uuid, "draft", draftUuid)}`;

        const response = await this.apiRequest(buildPath("mail", uuid, "draft", draftUuid), {
            method: "PUT",
            body: JSON.stringify(payload),
        });

        this.draftsCache.delete(draftUuid);
        return {
            ...(response.data && typeof response.data === "object" ? response.data : {}),
            sent_to: {
                to: recipientsToText(payload.to),
                cc: recipientsToText(payload.cc),
                bcc: recipientsToText(payload.bcc),
            },
        };
    }

    /** `Name <addr>` with a quoted name when it holds special characters, so parseAddress reads it back. */
    private addressInput(entry: any): string {
        const name = typeof entry?.name === "string" ? entry.name.trim() : "";
        if (!name) return entry.email;
        return /^[\w .'-]+$/.test(name)
            ? `${name} <${entry.email}>`
            : `"${name.replace(/(["\\])/g, "\\$1")}" <${entry.email}>`;
    }

    private async ownAddresses(mailboxUuid: string): Promise<Set<string>> {
        const mb = await this.getMailboxInfo(mailboxUuid);
        return new Set(
            [mb.email, ...(Array.isArray(mb.aliases) ? mb.aliases : [])]
                .filter((e: unknown): e is string => typeof e === "string")
                .map((e) => e.toLowerCase()),
        );
    }

    private uniqueEntries(entries: any[], exclude: Set<string>): any[] {
        const seen = new Set(exclude);
        const result: any[] = [];
        for (const entry of entries) {
            const email = typeof entry?.email === "string" ? entry.email.toLowerCase() : "";
            if (!email || seen.has(email)) continue;
            seen.add(email);
            result.push(entry);
        }
        return result;
    }

    private sourceRef(folderId: string, messageId: string): string {
        return `${messageId.split("@")[0]}@${folderId}`;
    }

    private async draftOrSend(draft: any, mailboxUuid: string, send: boolean): Promise<any> {
        if (!send) return {...draft, sent: false};
        const sent = await this.sendCreatedDraft(draft.uuid, mailboxUuid);
        return {...draft, ...sent, sent: true};
    }

    /**
     * Reply to a message. Recipients come from its Reply-To (else From); with
     * `replyAll` the other To and Cc recipients are added as Cc. The mailbox's
     * own addresses are removed. Threading headers come from the source.
     * Creates a draft, or sends it when `send` is true.
     */
    async replyToEmail(
        mailboxUuid: string,
        folderId: string,
        messageId: string,
        body: string,
        options: { replyAll?: boolean; send?: boolean; quote?: boolean; bodyFormat?: "text" | "html"; fromEmail?: string; fromName?: string } = {},
    ): Promise<any> {
        const source = await this.fetchMessage(mailboxUuid, folderId, messageId);
        const own = await this.ownAddresses(mailboxUuid);
        const list = (value: any): any[] => (Array.isArray(value) ? value : []);

        const sender = list(source.reply_to).length ? list(source.reply_to) : list(source.from);
        let to = this.uniqueEntries(sender, own);
        if (to.length === 0) {
            // Replying to a message the mailbox sent: answer its recipients
            to = this.uniqueEntries(list(source.to), own);
        }
        if (to.length === 0) throw new Error("The message has no recipient to reply to");
        let cc: any[] = [];
        if (options.replyAll) {
            // After the fallback above, so a To recipient never also lands in Cc
            const others = [...list(source.to), ...list(source.cc)];
            cc = this.uniqueEntries(others, new Set([...own, ...to.map((e) => e.email.toLowerCase())]));
        }

        const ref = this.sourceRef(folderId, messageId);
        const threading = this.threadingFrom(source, ref);
        const subject = /^(re|aw|antw|sv|r)\s*:/i.test(source.subject ?? "") ? source.subject : `Re: ${source.subject ?? ""}`.trim();

        let quote: string | undefined;
        if (options.quote) {
            const original = this.messageBody(source, "text", 20_000);
            quote = `On ${source.date ?? "an earlier date"}, ${formatAddresses(source.from)} wrote:\n${original.text}`;
        }

        const draft = await this.createDraft(
            to.map((e) => this.addressInput(e)),
            subject,
            body,
            cc.length ? cc.map((e) => this.addressInput(e)) : undefined,
            undefined,
            mailboxUuid,
            threading.inReplyTo,
            ref,
            threading.references,
            options.fromEmail,
            options.fromName,
            {bodyFormat: options.bodyFormat, quote},
        );
        return this.draftOrSend(draft, mailboxUuid, options.send === true);
    }

    /**
     * Forward a message. The draft carries `forwarded_uid` and the original
     * text below the new body. Unverified: whether the API also attaches the
     * original attachments for `forwarded_uid`.
     */
    async forwardEmail(
        mailboxUuid: string,
        folderId: string,
        messageId: string,
        to: RecipientInput,
        body: string,
        options: { cc?: RecipientInput; send?: boolean; bodyFormat?: "text" | "html"; fromEmail?: string; fromName?: string } = {},
    ): Promise<any> {
        const source = await this.fetchMessage(mailboxUuid, folderId, messageId);
        const original = this.messageBody(source, "text", 20_000);
        const header = [
            "---------- Forwarded message ----------",
            `From: ${formatAddresses(source.from)}`,
            `Date: ${source.date ?? ""}`,
            `Subject: ${source.subject ?? ""}`,
            `To: ${formatAddresses(source.to)}`,
        ].join("\n");
        const subject = /^(fwd?|wg|tr|enc)\s*:/i.test(source.subject ?? "") ? source.subject : `Fwd: ${source.subject ?? ""}`.trim();

        // The third party's header lines and text go in as the escaped quote block, whatever the note's format
        const draft = await this.createDraft(
            to,
            subject,
            body,
            options.cc,
            undefined,
            mailboxUuid,
            undefined,
            undefined,
            undefined,
            options.fromEmail,
            options.fromName,
            {forwardedUid: this.sourceRef(folderId, messageId), bodyFormat: options.bodyFormat, quote: `${header}\n\n${original.text}`},
        );
        return this.draftOrSend(draft, mailboxUuid, options.send === true);
    }

    /**
     * Read the messages of a thread, oldest first. The `messages` list comes
     * from a list or search row; each message is read on its own. A message that
     * cannot be read (deleted or moved since the list call) is named in
     * `warnings` and the others are still returned. Body text is shared out so
     * the whole result fits: `maxLength` and the size cap cover all bodies, a
     * short message leaves its unused share to the longer ones, and each message
     * reports its own `truncated`.
     */
    async readThread(
        mailboxUuid: string,
        messages: Array<{ folder_id: string; uid: string }>,
        options: { maxLength?: number } = {},
    ): Promise<{ items: any[]; warnings?: string[] }> {
        const fetched: Array<any | undefined> = new Array(messages.length);
        const warnings: string[] = [];
        let next = 0;
        // A few messages at a time: each read has its own timeout and retry
        const worker = async () => {
            while (next < messages.length) {
                const index = next++;
                const {folder_id, uid} = messages[index];
                try {
                    fetched[index] = await this.fetchMessage(mailboxUuid, folder_id, uid);
                } catch (error) {
                    warnings.push(`Message ${uid}@${folder_id} could not be read: ${error instanceof Error ? error.message : "request failed"}`.slice(0, 300));
                }
            }
        };
        await Promise.all(Array.from({length: Math.min(THREAD_READ_CONCURRENCY, messages.length)}, worker));

        const loaded = fetched
            .map((data, index) => ({data, folderId: messages[index].folder_id, ref: `${messages[index].folder_id}/${messages[index].uid}`}))
            .filter((entry) => entry.data !== undefined);
        if (loaded.length === 0) throw new Error(`No message of the thread could be read: ${warnings.join("; ")}`.slice(0, 1000));

        const fieldsList = loaded.map((entry) => this.emailFields(entry.data, entry.folderId));
        const overhead = JSON.stringify(warnings).length + 256;
        const metadata = fieldsList.reduce((sum, fields) => sum + JSON.stringify(fields).length + 128, 0);
        const total = Math.max(0, Math.min(options.maxLength ?? 50_000, MAX_TEXT_LENGTH - metadata - overhead));

        // Each message wants its whole body; the shares are filled smallest need first
        const bodies = loaded.map((entry) => this.messageBody(entry.data, "text", total, total));
        const needs = bodies.map((body) => JSON.stringify(body.text).length - 2);
        const order = needs.map((_, i) => i).sort((a, b) => needs[a] - needs[b]);
        const share: number[] = new Array(needs.length).fill(0);
        let remaining = total;
        order.forEach((index, position) => {
            share[index] = Math.min(needs[index], Math.floor(remaining / (order.length - position)));
            remaining -= share[index];
        });

        const entries = loaded.map((entry, i) => {
            const text = capJsonString(bodies[i].text, share[i]);
            return {
                ref: entry.ref,
                email: {
                    ...fieldsList[i],
                    body_format: "text",
                    untrusted_content: text,
                    truncated: bodies[i].truncated || text.length < bodies[i].text.length,
                },
            };
        });
        // Oldest first by instant (offsets differ), then by folder and UID so the order is stable
        const time = (message: any) => (Number.isNaN(Date.parse(message.date)) ? Infinity : Date.parse(message.date));
        entries.sort((a, b) => time(a.email) - time(b.email) || a.ref.localeCompare(b.ref, "en", {numeric: true}));
        return {items: entries.map((entry) => entry.email), ...(warnings.length > 0 ? {warnings} : {})};
    }

    /** URL under `/1/mail_hostings/{hosting}/mailboxes/{mailbox}/` of the manager API. */
    private async managerMailboxUrl(mailboxUuid: string, ...segments: string[]): Promise<string> {
        const mb = await this.getMailboxInfo(mailboxUuid);
        if (!mb.hosting_id || !mb.mailbox) {
            throw new Error("Mailbox is missing hosting_id or mailbox name; cannot reach the manager API");
        }
        return `${MANAGER_API_V1_BASE}${buildPath("mail_hostings", mb.hosting_id, "mailboxes", mb.mailbox, ...segments)}`;
    }

    private autoReplyBase(mailboxUuid: string): Promise<string> {
        return this.managerMailboxUrl(mailboxUuid, "auto_reply", "model");
    }

    /**
     * Where the mailbox forwards mail (`GET /1/mail_hostings/{id}/mailboxes/{name}/forwarding_addresses`).
     * Read only: the check after a suspected account compromise.
     */
    async listForwarding(mailboxUuid: string): Promise<{
        is_enabled: unknown; addresses: Array<{ email: unknown; email_idn: unknown }>; has_dont_deliver: unknown; has_forward_spam: unknown;
        warnings?: string[]; raw?: unknown;
    }> {
        const response = await this.apiRequestFull(await this.managerMailboxUrl(mailboxUuid, "forwarding_addresses"));
        const data = response.data && typeof response.data === "object" ? response.data : {};
        // The OpenAPI spells the list `redirect_adresses`; the path parameter is `redirect_addresses`. Accept both.
        const list = Array.isArray(data.redirect_addresses) ? data.redirect_addresses
            : Array.isArray(data.redirect_adresses) ? data.redirect_adresses : undefined;
        const addresses = (list ?? []).map((a: any) => ({email: a?.email, email_idn: a?.email_idn}));
        return {
            is_enabled: data.is_enabled,
            addresses,
            has_dont_deliver: data.has_dont_deliver,
            has_forward_spam: data.has_forward_spam,
            ...(list === undefined && data.is_enabled
                ? {warnings: ["Forwarding is enabled but the response held no address list; do not conclude nothing is forwarded."], raw: data}
                : {}),
        };
    }

    /** Permanently remove every message in the Trash or Spam folder. */
    async purgeFolder(mailboxUuid: string, folder: "trash" | "spam"): Promise<any> {
        const response = await this.apiRequestFull(
            await this.managerMailboxUrl(mailboxUuid, "auth", "folders", folder),
            {method: "DELETE"},
        );
        return {folder, purged: response.data === true || response.data === undefined ? true : response.data};
    }

    async listAutoReplies(mailboxUuid: string): Promise<any[]> {
        const response = await this.apiRequestFull(await this.autoReplyBase(mailboxUuid));
        return Array.isArray(response.data) ? response.data : [];
    }

    async createAutoReply(mailboxUuid: string, fields: Record<string, unknown>): Promise<any> {
        const response = await this.apiRequestFull(await this.autoReplyBase(mailboxUuid), {
            method: "POST",
            body: JSON.stringify(fields),
        });
        return response.data;
    }

    async updateAutoReply(mailboxUuid: string, modelId: number, fields: Record<string, unknown>): Promise<any> {
        const base = await this.autoReplyBase(mailboxUuid);
        const response = await this.apiRequestFull(`${base}${buildPath(modelId)}`, {
            method: "PATCH",
            body: JSON.stringify(fields),
        });
        return {id: modelId, updated: response.data === true || response.data === undefined ? true : response.data};
    }

    async deleteAutoReply(mailboxUuid: string, modelId: number): Promise<any> {
        const base = await this.autoReplyBase(mailboxUuid);
        const response = await this.apiRequestFull(`${base}${buildPath(modelId)}`, {method: "DELETE"});
        return {id: modelId, deleted: response.data === true || response.data === undefined ? true : response.data};
    }

    async deleteDraft(
        draftUuid: string,
        mailboxUuid?: string,
    ): Promise<any> {
        const uuid = await this.draftMailbox(draftUuid, mailboxUuid);

        const response = await this.apiRequest(buildPath("mail", uuid, "draft", draftUuid), {
            method: "DELETE",
        });

        this.draftsCache.delete(draftUuid);
        return response.data;
    }

    async listDrafts(mailboxUuid?: string, limit: number = 50, offset: number = 0): Promise<any[]> {
        const uuid = mailboxUuid || await this.getMailboxUuid();
        return this.listEmails(uuid, await this.findFolderByRole(uuid, "DRAFT"), limit, offset);
    }

    private formatUids(messageIds: string[], folderId: string): string[] {
        return messageIds.map((id) => (id.includes("@") ? id : `${id}@${folderId}`));
    }

    async markEmails(
        mailboxUuid: string,
        folderId: string,
        messageIds: string[],
        read: boolean,
    ): Promise<any> {
        if (!messageIds || messageIds.length === 0) {
            throw new Error("At least one message_uid must be provided.");
        }

        const endpoint = read ? "seen" : "unseen";
        const uids = this.formatUids(messageIds, folderId);

        const response = await this.apiRequest(
            buildPath("mail", mailboxUuid, "message", endpoint),
            {
                method: "POST",
                body: JSON.stringify({ uids }),
            },
        );

        return {
            result: "success",
            marked: uids.length,
            read,
        };
    }

    async moveEmails(
        mailboxUuid: string,
        messageIds: string[],
        fromFolderId: string,
        toFolderId: string,
    ): Promise<any> {
        if (!messageIds || messageIds.length === 0) {
            throw new Error("At least one message_uid must be provided.");
        }

        const uids = this.formatUids(messageIds, fromFolderId);

        const response = await this.apiRequest(
            buildPath("mail", mailboxUuid, "message", "move"),
            {
                method: "POST",
                body: JSON.stringify({
                    uids,
                    to: toFolderId,
                    move_reactions: false,
                }),
            },
        );

        return {
            result: "success",
            moved: uids.length,
            to: toFolderId,
        };
    }

    async flagEmails(
        mailboxUuid: string,
        folderId: string,
        messageIds: string[],
        flagged: boolean,
    ): Promise<any> {
        if (!messageIds || messageIds.length === 0) {
            throw new Error("At least one message_uid must be provided.");
        }

        const endpoint = flagged ? "star" : "unstar";
        const uids = this.formatUids(messageIds, folderId);

        const response = await this.apiRequest(
            buildPath("mail", mailboxUuid, "message", endpoint),
            {
                method: "POST",
                body: JSON.stringify({ uids }),
            },
        );

        return {
            result: "success",
            flagged,
            [flagged ? "starred" : "unstarred"]: uids.length,
        };
    }

    private async findFolderByRole(mailboxUuid: string, role: string): Promise<string> {
        const folders = await this.cachedFolders(mailboxUuid);
        const folder = folders.find(
            (f: any) => f.role && f.role.toUpperCase() === role.toUpperCase(),
        );
        if (!folder) {
            throw new Error(`${role} folder not found`);
        }
        return folder.id;
    }

    async archiveEmails(
        mailboxUuid: string,
        folderId: string,
        messageIds: string[],
    ): Promise<any> {
        if (!messageIds || messageIds.length === 0) {
            throw new Error("At least one message_uid must be provided.");
        }

        const archiveFolderId = await this.findFolderByRole(mailboxUuid, "ARCHIVE");
        await this.moveEmails(mailboxUuid, messageIds, folderId, archiveFolderId);

        return {
            result: "success",
            archived: messageIds.length,
        };
    }

    async deleteEmails(
        mailboxUuid: string,
        folderId: string,
        messageIds: string[],
        permanent: boolean = false,
    ): Promise<any> {
        if (!messageIds || messageIds.length === 0) {
            throw new Error("At least one message_uid must be provided.");
        }

        if (permanent) {
            const uids = this.formatUids(messageIds, folderId);
            const response = await this.apiRequest(
                buildPath("mail", mailboxUuid, "message", "delete"),
                {
                    method: "POST",
                    body: JSON.stringify({
                        uids,
                        move_reactions: false,
                    }),
                },
            );

            return {
                result: "success",
                deleted: uids.length,
                permanent: true,
            };
        }

        const trashFolderId = String(await this.findFolderByRole(mailboxUuid, "TRASH"));
        // A ref carries its own folder; a bare UID belongs to folder_id
        const refs = this.formatUids(messageIds, folderId);
        const inTrash = refs.filter((ref) => ref.slice(ref.lastIndexOf("@") + 1) === trashFolderId);
        const toMove = refs.filter((ref) => !inTrash.includes(ref));
        if (toMove.length > 0) {
            await this.moveEmails(mailboxUuid, toMove, folderId, trashFolderId);
        }
        if (toMove.length === 0) {
            return {
                result: "skipped",
                deleted: 0,
                permanent: false,
                already_in_trash: inTrash.length,
                note: "These messages are already in Trash. Call again with permanent=true to delete them for good.",
            };
        }

        return {
            result: "success",
            deleted: toMove.length,
            permanent: false,
            ...(inTrash.length > 0
                ? {
                    already_in_trash: inTrash.length,
                    note: `${inTrash.length} message(s) were already in Trash and stayed there: ${inTrash.join(", ")}. Delete them with permanent=true only if that is intended.`,
                }
                : {}),
        };
    }
}
