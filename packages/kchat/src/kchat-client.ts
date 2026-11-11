import {AsyncLocalStorage} from "node:async_hooks";

type QueryValue = string | number | boolean | undefined;

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const MAX_ERROR_MESSAGE_LENGTH = 200;
const USER_CACHE_MS = 10 * 60 * 1000;
const MAX_CACHED_USERS = 1000;
const MAX_RETRY_AFTER_MS = 10_000;
/** Overall time one tool call may take, retries included, in milliseconds. */
export const CALL_DEADLINE_MS = 120_000;

const callSignal = new AsyncLocalStorage<AbortSignal>();

/**
 * Runs `fn` with one overall deadline. Every client request inside it stops when the deadline passes
 * or when `signal` (the SDK's cancellation signal for the tool call) aborts.
 */
export function withCallSignal<T>(signal: AbortSignal | undefined, fn: () => Promise<T>, deadlineMs = CALL_DEADLINE_MS): Promise<T> {
    const deadline = AbortSignal.timeout(deadlineMs);

    return callSignal.run(signal ? AbortSignal.any([signal, deadline]) : deadline, fn);
}
/**
 * Starts a load that several tool calls share outside the current call's signal, so only the
 * per-request timeout applies and one cancelled call cannot fail the others.
 */
function startShared<T>(load: () => Promise<T>): Promise<T> {
    return callSignal.exit(load);
}

/** Waits for a shared load, giving up early when the current call is cancelled or past its deadline. */
function awaitForCall<T>(shared: Promise<T>): Promise<T> {
    const call = callSignal.getStore();

    if (!call) return shared;

    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(call.reason);

        if (call.aborted) return onAbort();

        call.addEventListener("abort", onAbort, {once: true});
        shared.then(resolve, reject).finally(() => call.removeEventListener("abort", onAbort));
    });
}

/** Largest JSON response the client reads, in bytes. */
const MAX_JSON_BYTES = 20 * 1024 * 1024;

/** Largest file the client uploads or downloads, in bytes. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

export interface KchatClientOptions {
    /** Fetch implementation, injected by tests. */
    fetch?: typeof fetch;
    /** Delay before the single retry of a GET request, in milliseconds. */
    retryDelayMs?: number;
    /** How long the member channel list is reused across page calls, in milliseconds (default 30000, 0 disables). */
    channelCacheMs?: number;
}

const USERNAME_PATTERN = /^(?=.*[a-z0-9_-])[a-z0-9._-]{1,64}$/;

/** Strips a leading @, lowercases, and rejects anything that is not a kChat username. */
export function normalizeUsername(username: string): string {
    const name = username.trim().replace(/^@/, "").toLowerCase();

    if (!USERNAME_PATTERN.test(name)) {
        throw new Error("Invalid username: use letters, digits, dots, underscores, and hyphens");
    }

    return name;
}

export interface HistoryOptions {
    limit: number;
    page: number;
    /** Post ID: select posts that came before it. */
    before?: string;
    /** Post ID: select posts that came after it. */
    after?: string;
    /** Unix time in milliseconds: select posts modified after it; the only parameter sent when set. */
    since?: number;
}

export interface PostPage {
    posts: any[];
    has_next: boolean;
    next_post_id?: string;
    prev_post_id?: string;
}

/** Turns a PostList (posts keyed by ID, plus `order`) into an ordered array. */
export function toPostPage(list: any): PostPage {
    const byId: Record<string, any> = list?.posts ?? {};
    const order: string[] = Array.isArray(list?.order) ? list.order : Object.keys(byId);
    const page: PostPage = {
        posts: order.map((id) => byId[id]).filter((post) => post !== undefined),
        has_next: list?.has_next === true,
    };

    if (list?.next_post_id) page.next_post_id = list.next_post_id;
    if (list?.prev_post_id) page.prev_post_id = list.prev_post_id;

    return page;
}

const TEAM_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

export class KchatClient {
    private readonly baseUrl: string;
    private readonly teamName: string;
    private readonly headers: { Authorization: string; "Content-Type": string, "User-Agent": string };

    private teamId: Promise<string> | undefined;
    private currentUserId: Promise<string> | undefined;
    private readonly fetchImpl: typeof fetch;
    private readonly retryDelayMs: number;
    private readonly channelCacheMs: number;
    private readonly users = new Map<string, { at: number; user: any }>();
    private memberChannels: { at: number; channels: Promise<any[]> } | undefined;

    constructor(token: string, teamName: string, options: KchatClientOptions = {}) {
        this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
        this.retryDelayMs = options.retryDelayMs ?? 500;
        this.channelCacheMs = options.channelCacheMs ?? 30_000;

        if (!TEAM_NAME_PATTERN.test(teamName)) {
            throw new Error("Invalid kChat team name: use letters, digits, and hyphens only");
        }

        this.teamName = teamName;
        this.baseUrl = `https://${teamName}.kchat.infomaniak.com/api/v4`;
        this.headers = {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "User-Agent": "kChat MCP Server"
        };
    }

    /** Builds an API URL: every path segment is encoded, the query goes through URLSearchParams. */
    private url(segments: string[], query?: Record<string, QueryValue>): string {
        const path = segments.map((segment) => encodeURIComponent(segment)).join("/");
        const params = new URLSearchParams();

        for (const [key, value] of Object.entries(query ?? {})) {
            if (value !== undefined) {
                params.set(key, String(value));
            }
        }

        const search = params.toString();

        return `${this.baseUrl}/${path}${search ? `?${search}` : ""}`;
    }

    /** Milliseconds to wait before a retry: Retry-After (capped at 10 s) on 429 and 503, else the backoff. */
    private retryDelay(response: Response | undefined, attempt: number): number {
        const header = response && (response.status === 429 || response.status === 503)
            ? response.headers.get("retry-after")
            : null;

        if (header) {
            const seconds = Number(header);
            const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();

            if (Number.isFinite(ms)) {
                return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
            }
        }

        return this.retryDelayMs * attempt;
    }

    /** The system code of a network failure (for example ENOTFOUND), or a timeout note; never the URL. */
    private networkErrorDetail(error: unknown): string {
        if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
            return `timed out after ${REQUEST_TIMEOUT_MS / 1000} s`;
        }

        const code = (error as { cause?: { code?: unknown } } | undefined)?.cause?.code;

        if (typeof code === "string" && /^[A-Z0-9_]{2,40}$/.test(code)) {
            return code;
        }

        return error instanceof Error ? error.name : "network error";
    }

    /** The message for a call that was cancelled or ran out of time. */
    private abortMessage(call: AbortSignal): string {
        const reason = call.reason as { name?: string } | undefined;

        return reason?.name === "TimeoutError"
            ? `kChat request failed: tool call timed out after ${CALL_DEADLINE_MS / 1000} s`
            : "kChat request failed: cancelled";
    }

    private sleep(ms: number, call: AbortSignal | undefined): Promise<void> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                call?.removeEventListener("abort", onAbort);
                resolve();
            }, ms);
            const onAbort = () => {
                clearTimeout(timer);
                reject(new Error(this.abortMessage(call as AbortSignal)));
            };

            call?.addEventListener("abort", onAbort, {once: true});
        });
    }

    /** Sends a request; a GET or a read-only POST (`retry`) is retried once, never after a timeout. */
    private async send(url: string, init: RequestInit, retry = false): Promise<Response> {
        const attempts = init.method === "GET" || retry ? 2 : 1;
        const call = callSignal.getStore();

        for (let attempt = 1; ; attempt++) {
            let response: Response | undefined;

            if (call?.aborted) throw new Error(this.abortMessage(call));

            const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);

            try {
                response = await this.fetchImpl(url, {...init, signal: call ? AbortSignal.any([call, timeout]) : timeout});
            } catch (error) {
                if (call?.aborted) throw new Error(this.abortMessage(call));

                const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");

                if (timedOut || attempt >= attempts) {
                    throw new Error(`kChat request failed: ${this.networkErrorDetail(error)}`);
                }
            }

            if (response && (response.ok || attempt >= attempts || !RETRY_STATUSES.has(response.status))) {
                return response;
            }

            const delay = this.retryDelay(response, attempt);

            await response?.body?.cancel();
            await this.sleep(delay, call);
        }
    }

    /** Reads a response body as bytes and cancels the stream once it passes `cap`. */
    private async readBytes(response: Response, cap: number, what: string): Promise<Uint8Array> {
        const declared = response.headers.get("content-length");

        if (declared !== null && /^\d+$/.test(declared) && Number(declared) > cap) {
            await response.body?.cancel();
            throw new Error(`${what} is larger than ${cap / 1024 / 1024} MB`);
        }

        const chunks: Uint8Array[] = [];
        let total = 0;
        const reader = response.body?.getReader();

        while (reader) {
            const {done, value} = await reader.read();

            if (done) break;

            total += value.length;

            if (total > cap) {
                await reader.cancel();
                throw new Error(`${what} is larger than ${cap / 1024 / 1024} MB`);
            }

            chunks.push(value);
        }

        const bytes = new Uint8Array(total);
        let offset = 0;

        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
        }

        return bytes;
    }

    private async request(
        method: "GET" | "POST" | "PUT" | "DELETE",
        segments: string[],
        options: { query?: Record<string, QueryValue>; body?: unknown; retry?: boolean } = {},
    ): Promise<any> {
        const response = await this.requestRaw(method, segments, options);
        const bytes = await this.readBytes(response, MAX_JSON_BYTES, "kChat response");

        return JSON.parse(new TextDecoder().decode(bytes));
    }

    /** Like request, but returns the checked Response so the caller can read a binary body. */
    private async requestRaw(
        method: "GET" | "POST" | "PUT" | "DELETE",
        segments: string[],
        options: { query?: Record<string, QueryValue>; body?: unknown; form?: FormData; retry?: boolean } = {},
    ): Promise<Response> {
        const init: RequestInit = {method, headers: this.headers};

        if (options.form) {
            // fetch sets the multipart Content-Type with its boundary.
            const {"Content-Type": _contentType, ...headers} = this.headers;
            init.headers = headers;
            init.body = options.form;
        } else if (options.body !== undefined) {
            init.body = JSON.stringify(options.body);
        }

        const response = await this.send(this.url(segments, options.query), init, options.retry);

        if (!response.ok) {
            throw await this.toError(response);
        }

        return response;
    }

    /** Status, API error code, and at most 200 characters of the API message; never the full body. */
    private async toError(response: Response): Promise<Error> {
        let code = "";
        let message = response.statusText;

        try {
            const body = JSON.parse(new TextDecoder().decode(await this.readBytes(response, 64 * 1024, "Error body"))) as { id?: unknown; message?: unknown };
            code = typeof body.id === "string" ? body.id : "";
            message = typeof body.message === "string" ? body.message : message;
        } catch {
            // body is not JSON; keep the status text
        }

        const detail = message.slice(0, MAX_ERROR_MESSAGE_LENGTH);

        return new Error(`${response.status} ${code ? `${code}: ` : ""}${detail}`.trim());
    }

    async getTeamByName(): Promise<any> {
        return this.request("GET", ["teams", "name", this.teamName]);
    }

    /** Resolves the team ID once; a failed lookup is not cached. */
    async getTeamId(): Promise<string> {
        if (!this.teamId) {
            const load: Promise<string> = startShared(() => this.getTeamByName()).then((team) => {
                if (typeof team?.id !== "string" || !team.id) {
                    throw new Error(`kChat team not found: ${this.teamName}`);
                }

                return team.id as string;
            });

            this.teamId = load;
            load.catch(() => {
                if (this.teamId === load) this.teamId = undefined;
            });
        }

        return awaitForCall(this.teamId);
    }

    /** Resolves the ID of the user the token belongs to once; a failed lookup is not cached. */
    async getCurrentUserId(): Promise<string> {
        if (!this.currentUserId) {
            const load: Promise<string> = startShared(() => this.getCurrentUser()).then((user) => {
                if (typeof user?.id !== "string" || !user.id) {
                    throw new Error("kChat did not return the current user");
                }

                return user.id as string;
            });

            this.currentUserId = load;
            load.catch(() => {
                if (this.currentUserId === load) this.currentUserId = undefined;
            });
        }

        return awaitForCall(this.currentUserId);
    }

    /** Public channels of the team. */
    async getChannels(limit: number, page: number): Promise<any> {
        const teamId = await this.getTeamId();

        return this.request("GET", ["teams", teamId, "channels"], {
            query: {per_page: Math.min(limit, 100), page},
        });
    }

    /** All channels the user belongs to in the team, most recently active first; reused for a short time. */
    private async getMemberChannels(fresh = false): Promise<any[]> {
        const cached = this.memberChannels;

        if (!fresh && cached && Date.now() - cached.at < this.channelCacheMs) {
            return awaitForCall(cached.channels);
        }

        const teamId = await this.getTeamId();
        const channels = startShared(() => this.request("GET", ["users", "me", "teams", teamId, "channels"]))
            .then((list: any[]) => [...list].sort((a, b) =>
                Number(b.last_post_at ?? 0) - Number(a.last_post_at ?? 0) || String(a.id).localeCompare(String(b.id))));

        this.memberChannels = {at: Date.now(), channels};
        channels.catch(() => {
            if (this.memberChannels?.channels === channels) this.memberChannels = undefined;
        });

        return awaitForCall(channels);
    }

    /** One channel by ID. */
    async getChannel(channel_id: string): Promise<any> {
        return this.request("GET", ["channels", channel_id]);
    }

    /** The channels the user belongs to, for resolving channel names (reused for a short time). */
    async listMemberChannels(): Promise<any[]> {
        return this.getMemberChannels();
    }

    /** Marks a channel as read for the current user. */
    async markChannelRead(channel_id: string): Promise<void> {
        const user_id = await this.getCurrentUserId();

        await this.request("POST", ["channels", "members", user_id, "view"], {body: {channel_id}});
    }

    /** One page of the members of a channel. */
    async getChannelMembers(channel_id: string, limit: number, page: number): Promise<any[]> {
        return this.request("GET", ["channels", channel_id, "members"], {
            query: {per_page: Math.min(limit, 200), page},
        });
    }

    /** One page of the messages the current user saved (flagged) in the team. */
    async getSavedPosts(limit: number, page: number): Promise<PostPage> {
        const [teamId, userId] = await Promise.all([this.getTeamId(), this.getCurrentUserId()]);

        return toPostPage(await this.request("GET", ["users", userId, "posts", "flagged"], {
            query: {team_id: teamId, per_page: Math.min(limit, 200), page},
        }));
    }

    /** Channels the user belongs to in the team: public, private, group messages, and DMs. The API does not page. */
    async getMyChannels(limit: number, page: number): Promise<{ channels: any[]; total: number }> {
        const channels = await this.getMemberChannels();

        return {channels: channels.slice(page * limit, (page + 1) * limit), total: channels.length};
    }

    async postMessage(channel_id: string, text: string, thread_id: string | undefined, file_ids?: string[]): Promise<any> {
        return this.request("POST", ["posts"], {
            body: {channel_id, root_id: thread_id, message: text, ...(file_ids?.length ? {file_ids} : {})},
        });
    }

    async addReaction(post_id: string, emoji_name: string): Promise<any> {
        const user_id = await this.getCurrentUserId();

        return this.request("POST", ["reactions"], {body: {user_id, post_id, emoji_name}});
    }

    async removeReaction(post_id: string, emoji_name: string): Promise<any> {
        const user_id = await this.getCurrentUserId();

        return this.request("DELETE", ["users", user_id, "posts", post_id, "reactions", emoji_name]);
    }

    async getReactions(post_id: string): Promise<any[]> {
        return this.request("GET", ["posts", post_id, "reactions"]);
    }

    /** The pinned posts of a channel, in display order. */
    async getPinnedPosts(channel_id: string): Promise<PostPage> {
        return toPostPage(await this.request("GET", ["channels", channel_id, "pinned"]));
    }

    /** One page of channel posts as an array in display order, with the paging fields of the API. */
    async getPostForChannel(channel_id: string, options: HistoryOptions): Promise<PostPage> {
        // The API forbids since together with before, after, page, and per_page.
        const list = await this.request("GET", ["channels", channel_id, "posts"], {
            query: options.since === undefined
                ? {
                    per_page: Math.min(options.limit, 200),
                    page: options.page,
                    before: options.before,
                    after: options.after,
                }
                : {since: options.since},
        });

        return toPostPage(list);
    }

    /** Searches messages in the team (terms support from:user and in:channel). */
    async searchPosts(
        terms: string, isOrSearch: boolean, limit: number, page: number, timeZoneOffset?: number,
    ): Promise<PostPage> {
        const teamId = await this.getTeamId();
        const list = await this.request("POST", ["teams", teamId, "posts", "search"], {
            retry: true,
            body: {
                terms,
                is_or_search: isOrSearch,
                page,
                per_page: Math.min(limit, 200),
                ...(timeZoneOffset === undefined ? {} : {time_zone_offset: timeZoneOffset}),
            },
        });

        return toPostPage(list);
    }

    /** Unread and mention counts for the team, or for one channel. */
    async getUnread(channel_id?: string): Promise<any> {
        if (channel_id) {
            return this.request("GET", ["users", "me", "channels", channel_id, "unread"]);
        }

        const teamId = await this.getTeamId();

        return this.request("GET", ["users", "me", "teams", teamId, "unread"]);
    }

    /** Unread state per channel: member channels (read fresh, not from the cache) with their membership counts (messages read, mentions). */
    async getUnreadChannels(): Promise<Array<{ channel: any; member: any }>> {
        const [teamId, userId, channels] = await Promise.all([
            this.getTeamId(), this.getCurrentUserId(), this.getMemberChannels(true),
        ]);
        const members: any[] = await this.request("GET", ["users", userId, "teams", teamId, "channels", "members"]);
        const byChannel = new Map<string, any>(members.map((member) => [String(member.channel_id), member]));

        return channels.flatMap((channel) => {
            const member = byChannel.get(String(channel.id));

            return member ? [{channel, member}] : [];
        });
    }

    /** Public channels of the team plus the user's own channels (private, group, DM) whose name matches. */
    async searchChannels(term: string): Promise<any[]> {
        const teamId = await this.getTeamId();
        const [found, mine] = await Promise.all([
            this.request("POST", ["teams", teamId, "channels", "search"], {body: {term}, retry: true}) as Promise<any[]>,
            this.getMemberChannels(),
        ]);
        const needle = term.toLowerCase();
        const matches = mine.filter((channel) =>
            String(channel.name ?? "").toLowerCase().includes(needle)
            || String(channel.display_name ?? "").toLowerCase().includes(needle));
        const seen = new Set<string>();

        return [...found, ...matches].filter((channel) => !seen.has(channel.id) && seen.add(channel.id));
    }

    async searchUsers(term: string, limit: number): Promise<any[]> {
        const team_id = await this.getTeamId();

        return this.request("POST", ["users", "search"], {body: {term, team_id, limit: Math.min(limit, 100)}, retry: true});
    }

    /** Loads a post and refuses when it was written by someone else. */
    private async getOwnPost(post_id: string): Promise<any> {
        const [post, me] = await Promise.all([this.getPost(post_id), this.getCurrentUserId()]);

        if (post.user_id !== me) {
            throw new Error("You can only change your own messages");
        }

        return post;
    }

    async editPost(post_id: string, message: string): Promise<any> {
        await this.getOwnPost(post_id);

        return this.request("PUT", ["posts", post_id, "patch"], {body: {message}});
    }

    async deletePost(post_id: string): Promise<any> {
        await this.getOwnPost(post_id);

        return this.request("DELETE", ["posts", post_id]);
    }

    async pinPost(post_id: string, pinned: boolean): Promise<any> {
        return this.request("POST", ["posts", post_id, pinned ? "pin" : "unpin"]);
    }

    /** Metadata of the files attached to a post. */
    async getPostFiles(post_id: string): Promise<any[]> {
        return this.request("GET", ["posts", post_id, "files", "info"]);
    }

    /**
     * Downloads a file; refuses files above 5 MB. An image above the cap comes back as its
     * preview rendition instead (`preview: true`).
     */
    async downloadFile(file_id: string): Promise<{ bytes: Uint8Array; mimeType: string; preview: boolean }> {
        const info = await this.request("GET", ["files", file_id, "info"]);
        const infoMime = String(info.mime_type || "");

        // A missing or non-numeric size is unknown, not small: the stream below enforces the cap either way.
        const size = Number(info.size);
        const tooLarge = Number.isFinite(size) && size > MAX_FILE_BYTES;

        if (tooLarge && infoMime.startsWith("image/")) {
            const response = await this.requestRaw("GET", ["files", file_id, "preview"]);

            return {
                bytes: await this.readBytes(response, MAX_FILE_BYTES, "Preview"),
                mimeType: response.headers.get("content-type")?.split(";")[0].trim() || "image/jpeg",
                preview: true,
            };
        }

        if (tooLarge) {
            throw new Error(`File is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
        }

        const response = await this.requestRaw("GET", ["files", file_id]);
        const bytes = await this.readBytes(response, MAX_FILE_BYTES, "File");

        return {
            bytes,
            mimeType: infoMime || response.headers.get("content-type") || "application/octet-stream",
            preview: false,
        };
    }

    /** Uploads a file to a channel and returns its file info; attach it to a post with file_ids. */
    async uploadFile(channel_id: string, filename: string, bytes: Uint8Array): Promise<any> {
        if (bytes.length > MAX_FILE_BYTES) {
            throw new Error(`File is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
        }

        const form = new FormData();
        form.set("files", new Blob([bytes as BlobPart]), filename);

        const response = await this.requestRaw("POST", ["files"], {form, query: {channel_id, filename}});
        const uploaded = JSON.parse(new TextDecoder().decode(await this.readBytes(response, MAX_JSON_BYTES, "kChat response"))) as { file_infos?: any[] };
        const info = uploaded.file_infos?.[0];

        if (!info) {
            throw new Error("kChat did not return the uploaded file");
        }

        return info;
    }

    async getPost(post_id: string): Promise<any> {
        return this.request("GET", ["posts", post_id]);
    }

    /** One page of a thread, oldest first: perPage posts after `fromPost` (direction down); the API applies `fromPost` only with `fromCreateAt`. */
    async getThread(thread_id: string, options: { limit: number; fromPost?: string; fromCreateAt?: number }): Promise<PostPage> {
        const page = toPostPage(await this.request("GET", ["posts", thread_id, "thread"], {
            query: {perPage: Math.min(options.limit, 200), fromPost: options.fromPost, fromCreateAt: options.fromPost ? options.fromCreateAt : undefined, direction: "down"},
        }));

        page.posts.sort((a, b) => Number(a.create_at ?? 0) - Number(b.create_at ?? 0) || String(a.id).localeCompare(String(b.id)));

        return page;
    }

    async getUsers(limit: number, page: number): Promise<any> {
        const team_id = await this.getTeamId();

        return this.request("GET", ["users"], {
            query: {per_page: Math.min(limit, 200), page, in_team: team_id, active: true},
        });
    }

    /** Resolves user IDs with POST /users/ids in batches of 100 and a 10 minute cache, keyed by ID. */
    async getUsersByIds(ids: string[]): Promise<Map<string, any>> {
        const now = Date.now();
        const found = new Map<string, any>();
        const missing: string[] = [];

        for (const id of new Set(ids)) {
            const cached = this.users.get(id);

            if (cached && now - cached.at < USER_CACHE_MS) {
                found.set(id, cached.user);
            } else {
                missing.push(id);
            }
        }

        for (let start = 0; start < missing.length; start += 100) {
            const users: any[] = await this.request("POST", ["users", "ids"], {body: missing.slice(start, start + 100), retry: true});

            for (const user of users) {
                if (typeof user?.id !== "string") continue;

                if (this.users.size >= MAX_CACHED_USERS) this.users.delete(this.users.keys().next().value as string);

                this.users.set(user.id, {at: now, user});
                found.set(user.id, user);
            }
        }

        return found;
    }

    async getUser(user_id: string): Promise<any> {
        return this.request("GET", ["users", user_id]);
    }

    async getCurrentUser(): Promise<any> {
        return this.request("GET", ["users", "me"]);
    }

    /** Looks a user up by username and checks that the API returned that user. */
    async getUserByUsername(username: string): Promise<any> {
        const name = normalizeUsername(username);
        const user = await this.request("GET", ["users", "username", name]);

        if (typeof user?.id !== "string" || !user.id || String(user.username).toLowerCase() !== name) {
            throw new Error(`User not found: ${name}`);
        }

        return user;
    }

    async createDirectChannel(userIds: [string, string]): Promise<any> {
        const channel = await this.request("POST", ["channels", "direct"], {body: userIds});

        this.memberChannels = undefined;

        return channel;
    }

    /** Opens (or reuses) the group message channel with the given users plus the current user and posts to it. */
    async sendGroupMessage(user_ids: string[], text: string): Promise<any> {
        const me = await this.getCurrentUserId();
        const channel = await this.request("POST", ["channels", "group"], {body: [...new Set([me, ...user_ids])]});

        this.memberChannels = undefined;

        return this.postMessage(channel.id, text, undefined);
    }

    async sendDirectMessage(to_user_id: string, text: string): Promise<any> {
        const currentUserId = await this.getCurrentUserId();
        const channel = await this.createDirectChannel([currentUserId, to_user_id]);

        return this.postMessage(channel.id, text, undefined);
    }
}
