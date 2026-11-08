import {canonicalTimeZone, classifyWallClock, convertWall, msToWall, wallParts, wallToMs} from "./dates.js";
import {AsyncLocalStorage} from "node:async_hooks";
import {randomBytes} from "node:crypto";
import {MAX_DAYS, findFreeSlots, type FreeSlot} from "./slots.js";
import {DATE_FORMATS, isValidDateInput} from "./schemas.js";

const API_BASE = "https://api.infomaniak.com";

export type Id = string | number;

export function toId(value: Id, label: string): string {
    const text = String(value).trim();
    if (!/^\d+$/.test(text)) {
        throw new Error(`Invalid ${label}: expected a numeric id`);
    }
    return text;
}

const REQUEST_TIMEOUT_MS = 30000;
/** One tool call, with all its requests and retries, stops after this long. */
export const TOOL_DEADLINE_MS = 90_000;

const callContext = new AsyncLocalStorage<{signal: AbortSignal}>();

/**
 * Runs one tool call under an overall deadline and the caller's cancellation signal: every request the
 * client makes inside `run` stops when either fires.
 */
export function withCallSignal<T>(cancel: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
    const signal = AbortSignal.any([AbortSignal.timeout(TOOL_DEADLINE_MS), ...(cancel ? [cancel] : [])]);

    return callContext.run({signal}, run);
}
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const MAX_ERROR_MESSAGE = 200;
const MAX_RETRY_AFTER_MS = 10_000;
const DEFAULT_CACHE_TTL_MS = 300_000;
const MAX_LISTING_PAGES = 20;
const LISTING_PARALLEL_PAGES = 4;
const LISTING_CACHE_TTL_MS = 60_000;
const MAX_LISTING_DAYS = 366;

export interface ClientOptions {
    /** Base delay before the one retry of a failed GET, in milliseconds (default 500). */
    retryDelayMs?: number;
    /** How long the profile, calendar list, and profile emails stay cached, in milliseconds (default 5 minutes, 0 disables). */
    cacheTtlMs?: number;
    /** kMeet host used for `withKmeet` events (default kmeet.infomaniak.com). */
    kmeetHostname?: string;
}

export interface CreateEventInput {
    title: string;
    start: string;
    end: string;
    description?: string;
    attendees?: string[];
    rrule?: string;
    calendarId?: Id;
    allDay?: boolean;
    notifyAttendees?: boolean;
    location?: string;
    remindersMinutes?: number[];
    private?: boolean;
    showAs?: ShowAs;
    timezone?: string;
    bookableResourceId?: string;
    /**
     * Create the event with a kMeet room through `POST /1/kmeet/rooms` (needs the kmeet token scope).
     * An event the room endpoint cannot carry (recurrence, location, reminders, a room, private, not busy)
     * gets a link generated locally instead.
     */
    withKmeet?: boolean;
    /** Lobby of the kMeet room (default on when people are invited). Needs the room endpoint. */
    kmeetLobby?: boolean;
    /** Password of the kMeet room. Needs the room endpoint. */
    kmeetPassword?: string;
}

export type ShowAs = "busy" | "free" | "tentative";

export interface UpdateEventInput {
    title?: string;
    start?: string;
    end?: string;
    description?: string;
    attendees?: string[];
    rrule?: string;
    calendarId?: Id;
    allDay?: boolean;
    notifyAttendees?: boolean;
    location?: string;
    remindersMinutes?: number[];
    private?: boolean;
    showAs?: ShowAs;
    timezone?: string;
    bookableResourceId?: string;
    /** Give the event a kMeet link generated locally when it has none. */
    withKmeet?: boolean;
}

/** Reads the address of a contact email entry, which the API may return as a string or an object. */
function emailOf(entry: unknown): string | undefined {
    if (typeof entry === "string") {
        return entry;
    }
    if (entry && typeof entry === "object") {
        const record = entry as Record<string, unknown>;
        const value = record.email ?? record.address ?? record.value;
        return typeof value === "string" ? value : undefined;
    }
    return undefined;
}

function alarmsFor(minutes: number[]): Array<{action: string; trigger: string}> {
    return [...new Set(minutes)].sort((a, b) => a - b).map(m => ({action: "DISPLAY", trigger: `-PT${m}M`}));
}

function requireTimeZone(timezone: string): string {
    const canonical = canonicalTimeZone(timezone);
    if (!canonical) {
        throw new Error(`Invalid timezone "${String(timezone).slice(0, 60)}": use an IANA name such as Europe/Zurich`);
    }
    return canonical;
}

export interface FindFreeSlotsInput {
    from: string;
    to: string;
    durationMinutes: number;
    dayStart?: string;
    dayEnd?: string;
    includeWeekends?: boolean;
    allDayBlocks?: boolean;
    calendarId?: Id;
    /**
     * Calendars whose events all count. Without it (and without `calendarId`) the calendars the user owns
     * count in full, and shared calendars only count events where the user is an attendee.
     */
    calendarIds?: Id[];
    /** Current time in milliseconds; only tests set it. */
    now?: number;
}

export class CalendarClient {
    private readonly token: string;
    private readonly headers: { Authorization: string; "Content-Type": string };
    private readonly retryDelayMs: number;
    private readonly cacheTtlMs: number;
    private readonly kmeetHostname: string;
    private readonly cache = new Map<string, {expires: number; value: Promise<any>}>();

    constructor(token: string, options: ClientOptions = {}) {
        this.token = token;
        this.retryDelayMs = options.retryDelayMs ?? 500;
        this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
        this.kmeetHostname = options.kmeetHostname ?? "kmeet.infomaniak.com";
        this.headers = {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
        };
    }

    /** Remembers a successful lookup for the cache TTL; failures are not remembered. */
    private cached<T>(key: string, load: () => Promise<T>, ttlMs = this.cacheTtlMs): Promise<T> {
        const call = callContext.getStore()?.signal;
        if (this.cacheTtlMs <= 0 || ttlMs <= 0) {
            return load();
        }
        const hit = this.cache.get(key);
        if (hit && hit.expires > Date.now()) {
            return this.raceCall(hit.value, call);
        }
        // The shared load runs outside any one call's signal, so one cancelled call cannot fail the others.
        const value = callContext.exit(load);
        this.cache.set(key, {expires: Date.now() + ttlMs, value});
        value.catch(() => {
            if (this.cache.get(key)?.value === value) {
                this.cache.delete(key);
            }
        });
        return this.raceCall(value, call);
    }

    /** Each caller waits for a shared load only as long as its own tool call lives. */
    private raceCall<T>(value: Promise<T>, call: AbortSignal | undefined): Promise<T> {
        if (!call) {
            return value;
        }
        return new Promise<T>((resolve, reject) => {
            const abort = () => reject(new Error(`Calendar lookup failed: ${this.callFailure(call)}`));
            if (call.aborted) {
                abort();
                return;
            }
            call.addEventListener("abort", abort, {once: true});
            value.then(
                result => {
                    call.removeEventListener("abort", abort);
                    resolve(result);
                },
                error => {
                    call.removeEventListener("abort", abort);
                    reject(error);
                }
            );
        });
    }

    private async describeError(response: Response): Promise<Error> {
        let code = "";
        let message = "";
        try {
            const text = await response.text();
            const body = JSON.parse(text);
            const error = body?.error;
            if (typeof error === "string") {
                code = error;
            } else if (error) {
                code = String(error.code ?? "");
                message = String(error.description ?? error.message ?? "");
            }
        } catch {
            // The body is not JSON: report the status only.
        }
        const detail = [code, message.slice(0, MAX_ERROR_MESSAGE)].filter(Boolean).join(": ");
        return new Error(`${response.status}${detail ? ` ${detail}` : ""}`.slice(0, MAX_ERROR_MESSAGE + 20));
    }

    private retryDelay(response: Response): number {
        const header = response.headers?.get("retry-after");
        if (header && (response.status === 429 || response.status === 503)) {
            const seconds = Number(header);
            const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
            if (Number.isFinite(ms) && ms >= 0) {
                return Math.min(ms, MAX_RETRY_AFTER_MS);
            }
        }
        return this.retryDelayMs;
    }

    private networkFailure(error: unknown): string {
        if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
            return `timed out after ${REQUEST_TIMEOUT_MS / 1000} s`;
        }
        const code = (error as {cause?: {code?: unknown}} | undefined)?.cause?.code;
        return typeof code === "string" && /^[A-Z0-9_]{2,40}$/.test(code) ? code : "network error";
    }

    /** Why the tool call's own signal fired. */
    private callFailure(signal: AbortSignal): string {
        return (signal.reason as {name?: string} | undefined)?.name === "TimeoutError"
            ? `the tool call timed out after ${TOOL_DEADLINE_MS / 1000} s`
            : "the request was cancelled";
    }

    /** Waits `ms`, and stops early with `onAbort` when the tool call is cancelled or out of time. */
    private sleep(ms: number, signal: AbortSignal | undefined, onAbort: () => Error): Promise<void> {
        return new Promise((resolve, reject) => {
            const abort = () => {
                clearTimeout(timer);
                reject(onAbort());
            };
            const timer = setTimeout(() => {
                signal?.removeEventListener("abort", abort);
                resolve();
            }, ms);
            if (signal?.aborted) {
                abort();
            } else {
                signal?.addEventListener("abort", abort, {once: true});
            }
        });
    }

    /**
     * One retry. A GET retries network errors (not timeouts) and 429, 502, 503, 504. A write retries
     * only on 429, where the server rejected the request before running it. `Retry-After` is honored.
     */
    private async request(url: string, init: RequestInit = {}, action = "request"): Promise<any> {
        const method = init.method ?? "GET";
        const call = callContext.getStore()?.signal;
        const stopped = () => new Error(`Calendar ${action} failed: ${this.callFailure(call!)}`);
        const retryable = (status: number) => (method === "GET" ? RETRY_STATUSES.has(status) : status === 429);
        let response: Response | undefined;
        for (let attempt = 1; attempt <= 2; attempt++) {
            const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
            try {
                response = await fetch(url, {
                    ...init,
                    headers: this.headers,
                    signal: call ? AbortSignal.any([timeout, call]) : timeout,
                });
            } catch (error) {
                if (call?.aborted) {
                    throw stopped();
                }
                const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
                if (attempt === 2 || method !== "GET" || timedOut) {
                    throw new Error(`Calendar ${action} failed: ${this.networkFailure(error)}`);
                }
                await this.sleep(this.retryDelayMs, call, stopped);
                continue;
            }
            if (response.ok || attempt === 2 || !retryable(response.status)) {
                break;
            }
            const delay = this.retryDelay(response);
            await response.body?.cancel().catch(() => undefined);
            await this.sleep(delay, call, stopped);
        }
        if (!response!.ok) {
            const error = await this.describeError(response!);
            throw new Error(`Calendar ${action} failed: ${error.message}`);
        }
        if (response!.status === 204) {
            return {};
        }
        const text = await response!.text();
        if (!text.trim()) {
            return {};
        }
        try {
            return JSON.parse(text);
        } catch {
            throw new Error(`Calendar ${action} failed: the response is not valid JSON`);
        }
    }

    private eventUrl(eventId: Id, params?: URLSearchParams): string {
        const path = `${API_BASE}/1/calendar/pim/event/${encodeURIComponent(toId(eventId, "event_id"))}`;
        return params ? `${path}?${params}` : path;
    }

    /** Parses a caller-supplied date, naming the field and the accepted formats on failure. */
    private parseInput(value: string, timezone: string, field: string): string {
        if (!isValidDateInput(value)) {
            throw new Error(`Invalid ${field} "${String(value).slice(0, 40)}": use ${DATE_FORMATS}`);
        }
        return this.parseDate(value, timezone);
    }

    /** Rejects wall-clock times that do not exist in the zone; reports ambiguous ones. */
    private checkWallClock(value: string, field: string, timezone: string, warnings: string[]): void {
        if (this.isDateOnly(value) || /([zZ]|[+-]\d{2}:?\d{2})$/.test(value.trim())) {
            return;
        }
        const wall = this.parseDate(value, timezone);
        const kind = classifyWallClock(wall, timezone);
        if (kind === "gap") {
            throw new Error(`${field} "${value}" does not exist in ${timezone} (clock change); pick another time or add an offset`);
        }
        if (kind === "ambiguous") {
            warnings.push(`${field} "${value}" happens twice in ${timezone} (clock change); the calendar picks the occurrence`);
        }
    }

    private parseDate(date: string, timezone: string): string {
        const iso = date.trim().replace(" ", "T");

        if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
            return `${iso} 00:00:00`;
        }

        if (/([zZ]|[+-]\d{2}:?\d{2})$/.test(iso)) {
            const wallClock = new Intl.DateTimeFormat("en-CA", {
                timeZone: timezone,
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                hourCycle: "h23",
            }).format(new Date(iso));
            return wallClock.replace(", ", " ");
        }

        return new Date(`${iso}Z`).toISOString().replace("T", " ").slice(0, 19);
    }

    /** The profile time zone. A missing one is an error: guessing UTC would put events at the wrong hour. */
    private getProfileTimezone(profile: any): string {
        const name = profile?.data?.preferences?.timezone?.name;
        const canonical = typeof name === "string" ? canonicalTimeZone(name) : undefined;
        if (!canonical) {
            throw new Error("The account has no valid time zone setting; set one in your Infomaniak profile, or pass timezone");
        }
        return canonical;
    }

    async getCalendars(): Promise<any> {
        return this.cached("calendars", () => this.request(`${API_BASE}/1/calendar/pim/calendar`, {}, "calendar listing"));
    }

    async getDefaultCalendar(): Promise<any> {
        const calendars = await this.getCalendars();
        const list: any[] = calendars?.data?.calendars ?? [];
        const calendar = list.find((c: any) => c.default) ?? list[0];

        if (!calendar) {
            throw new Error("No calendar found for this account");
        }

        return calendar;
    }

    async getUserProfile(): Promise<any> {
        return this.cached("profile", () => this.request(`${API_BASE}/2/profile`, {}, "profile lookup"));
    }

    async getProfileEmails(): Promise<any> {
        return this.cached("profile-emails", () => this.request(`${API_BASE}/2/profile/emails`, {}, "profile email lookup"));
    }

    async getContacts(): Promise<any> {
        return this.request(`${API_BASE}/1/calendar/pim/contact/all?with=emails`, {}, "contact lookup");
    }

    async getBookableResources(): Promise<any> {
        try {
            return await this.listBookableResources();
        } catch {
            return {data: []};
        }
    }

    /** Lists bookable resources (rooms, equipment); errors are reported, unlike the label lookup. */
    async listBookableResources(): Promise<any> {
        return this.cached("resources", () => this.request(`${API_BASE}/1/calendar/pim/bookable-resources/all?with%5B%5D=permission`, {}, "resource listing"));
    }

    /** Forgets cached listings after a write, so the next listing shows it. */
    private forgetListings(): void {
        for (const key of this.cache.keys()) {
            if (key.startsWith("events:")) {
                this.cache.delete(key);
            }
        }
    }

    private async annotateBookableResources(events: any[]): Promise<any[]> {
        const resourceIds = new Set(
            events.map(event => event?.bookable_resource_id).filter(Boolean)
        );

        if (resourceIds.size === 0) {
            return events;
        }

        const resources = await this.getBookableResources();
        const nameByUuid = new Map<string, any>();
        for (const resource of resources?.data ?? []) {
            if (resource?.uuid) {
                nameByUuid.set(resource.uuid, resource.name);
            }
        }

        return events.map(event => event?.bookable_resource_id
            ? {...event, bookable_resource_name: nameByUuid.get(event.bookable_resource_id) ?? null}
            : event);
    }

    /** Adds `my_state` (the user's reply) and `is_organizer` (the user organizes it) to events that have attendees. */
    private async annotateOwn(events: any[]): Promise<any[]> {
        if (!events.some(event => Array.isArray(event?.attendees) && event.attendees.length > 0)) {
            return events;
        }
        let own: Set<string>;
        try {
            own = await this.ownAddresses(await this.getUserProfile());
        } catch {
            return events;
        }
        return events.map(event => {
            const attendees: any[] = Array.isArray(event?.attendees) ? event.attendees : [];
            if (attendees.length === 0) {
                return event;
            }
            const isOwn = (attendee: any) => own.has(String(attendee?.address ?? "").toLowerCase());
            const mine = attendees.find(isOwn);
            return {
                ...event,
                ...(typeof mine?.state === "string" ? {my_state: mine.state} : {}),
                is_organizer: attendees.some(attendee => attendee?.organizer === true && isOwn(attendee)),
            };
        });
    }

    /** One calendar's events for the range, all pages, remembered for a minute so paging through a result does not refetch. */
    private async fetchCalendarEvents(calendarId: Id, from: string, to: string, calendarName?: string): Promise<any[]> {
        const events = await this.cached(`events:${String(calendarId)}:${from}:${to}`, () => this.fetchAllPages(calendarId, from, to), LISTING_CACHE_TTL_MS);

        return calendarName === undefined ? events : events.map(event => ({...event, calendar_name: calendarName}));
    }

    private async fetchAllPages(calendarId: Id, from: string, to: string): Promise<any[]> {
        const fetchPage = (page?: number) => {
            const params = new URLSearchParams({calendar_id: String(calendarId), from, to});
            if (page !== undefined) {
                params.set("page", String(page));
            }
            return this.request(`${API_BASE}/1/calendar/pim/event?${params}`, {}, "event listing");
        };
        const first = await fetchPage();
        const events: any[] = [...(first.data ?? [])];
        // Unverified: the listing may page like other Infomaniak endpoints (`pages`, `page`).
        const pages = Number(first.pages);
        if (Number.isInteger(pages) && pages > 1) {
            if (pages > MAX_LISTING_PAGES) {
                throw new Error(`Calendar event listing has ${pages} pages; use a shorter date range`);
            }
            const rest: any[][] = [];
            for (let page = 2; page <= pages; page += LISTING_PARALLEL_PAGES) {
                const batch = Array.from({length: Math.min(LISTING_PARALLEL_PAGES, pages - page + 1)}, (_, index) => fetchPage(page + index));
                rest.push(...(await Promise.all(batch)).map(response => response.data ?? []));
            }
            events.push(...rest.flat());
        }

        return events;
    }

    /** Parses the range; a date-only `to` covers that whole day, so the query end is the next midnight. */
    private listingRange(from: string, to: string, timezone: string): {fromWall: string; toWall: string; queryToWall: string} {
        const fromWall = this.parseInput(from, timezone, "from");
        const toWall = this.parseInput(to, timezone, "to");
        const queryToWall = this.isDateOnly(to) ? msToWall(wallToMs(toWall) + 86_400_000) : toWall;
        if (fromWall > queryToWall) {
            throw new Error("from must not be after to");
        }
        if (wallToMs(queryToWall) - wallToMs(fromWall) > MAX_LISTING_DAYS * 86_400_000) {
            throw new Error(`The range is limited to ${MAX_LISTING_DAYS} days; use a shorter range`);
        }
        return {fromWall, toWall, queryToWall};
    }

    /** Sort key: the absolute moment of the event start, as a wall clock in `timezone`. */
    private startKey(event: any, timezone: string): number {
        try {
            const zone = event.timezone_start || timezone;
            return wallToMs(convertWall(this.parseDate(event.start, zone), zone, timezone));
        } catch {
            return Number.NaN;
        }
    }

    /**
     * Reads every calendar of the account (or one) for the range. A calendar that fails is reported in
     * `warnings`; the call only fails when no calendar could be read.
     */
    private async collectEvents(
        fromWall: string,
        toWall: string,
        calendarIds: Id[] | undefined,
        timezone: string,
        keep?: (calendar: any, event: any) => boolean,
    ): Promise<{events: any[]; warnings: string[]}> {
        const warnings: string[] = [];
        let events: any[];
        if (calendarIds && calendarIds.length === 1) {
            const id = toId(calendarIds[0], "calendar_id");
            let name: string | undefined;
            try {
                name = ((await this.getCalendars())?.data?.calendars ?? []).find((calendar: any) => String(calendar.id) === id)?.name;
            } catch {
                // The name is a convenience.
            }
            events = await this.fetchCalendarEvents(id, fromWall, toWall, name);
        } else {
            let calendars: any[] = (await this.getCalendars())?.data?.calendars ?? [];
            if (calendarIds) {
                const wanted = new Set(calendarIds.map(id => toId(id, "calendar_id")));
                calendars = calendars.filter(calendar => wanted.has(String(calendar.id)));
            }
            if (calendars.length === 0) {
                throw new Error("No calendar found for this account");
            }
            const settled = await Promise.allSettled(
                calendars.map(async calendar => {
                    const list = await this.fetchCalendarEvents(calendar.id, fromWall, toWall, calendar.name);
                    return keep ? list.filter(event => keep(calendar, event)) : list;
                }),
            );
            const lists: any[][] = [];
            settled.forEach((outcome, index) => {
                if (outcome.status === "fulfilled") {
                    lists.push(outcome.value);
                } else {
                    const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
                    warnings.push(`Calendar ${String(calendars[index].id)} could not be read and its events are missing: ${reason.slice(0, 120)}`);
                }
            });
            if (lists.length === 0) {
                const failure = settled.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
                throw failure?.reason instanceof Error ? failure.reason : new Error("Calendar event listing failed");
            }
            events = lists.flat();
        }
        const keyed = events.map(event => ({event, key: this.startKey(event, timezone)}));
        const byId = (a: any, b: any) => {
            const x = Number(a.event?.id);
            const y = Number(b.event?.id);
            return Number.isFinite(x) && Number.isFinite(y) && x !== y ? x - y : String(a.event?.id).localeCompare(String(b.event?.id));
        };
        keyed.sort((a, b) => {
            const byStart = Number.isFinite(a.key) && Number.isFinite(b.key)
                ? a.key - b.key
                : String(a.event.start).localeCompare(String(b.event.start));
            return byStart || byId(a, b);
        });

        return {events: keyed.map(entry => entry.event), warnings};
    }

    /**
     * Lists events in a range. Without `calendarId` it queries every calendar of the account and
     * tags each event with `calendar_name`, sorted by start.
     */
    async listEvents(from: string, to: string, calendarId?: Id): Promise<any> {
        const profile = await this.getUserProfile();
        const timezone = this.getProfileTimezone(profile);
        const {fromWall, queryToWall} = this.listingRange(from, to, timezone);

        const {events, warnings} = await this.collectEvents(fromWall, queryToWall, calendarId ? [calendarId] : undefined, timezone);

        return {
            result: "success",
            data: await this.annotateOwn(await this.annotateBookableResources(events)),
            ...(warnings.length > 0 ? {warnings} : {}),
        };
    }

    /**
     * Finds free gaps in the account's schedule (every calendar, or one) by subtracting events
     * from working hours. Wall-clock arithmetic in the profile time zone; own schedule only.
     * The search starts no earlier than `from` (including its time) and never in the past.
     */
    async findFreeSlots(options: FindFreeSlotsInput): Promise<{timezone: string; slots: FreeSlot[]; warnings?: string[]}> {
        const profile = await this.getUserProfile();
        const timezone = this.getProfileTimezone(profile);
        const {fromWall, toWall, queryToWall} = this.listingRange(options.from, options.to, timezone);
        const nowMs = Math.ceil((options.now ?? Date.now()) / 60_000) * 60_000;
        const nowWall = msToWall(wallParts(nowMs, timezone));

        if ((wallToMs(toWall.slice(0, 10) + " 00:00:00") - wallToMs(fromWall.slice(0, 10) + " 00:00:00")) / 86_400_000 + 1 > MAX_DAYS) {
            throw new Error(`The range is limited to ${MAX_DAYS} days`);
        }

        const own = await this.ownAddresses(profile);
        const explicit = [...(options.calendarIds ?? []), ...(options.calendarId ? [options.calendarId] : [])];
        const isOwnEvent = (event: any) => (Array.isArray(event?.attendees) ? event.attendees : [])
            .some((attendee: any) => own.has(String(attendee?.address ?? "").toLowerCase()));
        // Shared calendars hold other people's meetings: they only count when the user is on the event.
        const keep = explicit.length > 0 ? undefined : (calendar: any, event: any) => calendar?.is_owner !== false || isOwnEvent(event);
        const {events, warnings} = await this.collectEvents(fromWall, queryToWall, explicit.length > 0 ? explicit : undefined, timezone, keep);

        const rangeEnd = this.isDateOnly(options.to) ? queryToWall : toWall;
        if (nowWall >= rangeEnd) {
            warnings.push("The search range lies in the past, so no slots are offered; this does not mean the user is fully booked");
        }

        const busy: Array<{start: string; end: string}> = [];
        for (const event of events) {
            if (event.freebusy === "free" || (event.fullday && !options.allDayBlocks) || event.type === "task") {
                continue;
            }
            // Unverified: cancelled events may carry `status: "CANCELLED"`.
            const cancelled = String(event.status ?? "").toUpperCase() === "CANCELLED";
            const declined = (Array.isArray(event.attendees) ? event.attendees : []).some((attendee: any) =>
                own.has(String(attendee?.address ?? "").toLowerCase()) && String(attendee?.state ?? "").toUpperCase() === "DECLINED");
            if (cancelled || declined) {
                continue;
            }
            const eventZone = event.timezone_start || timezone;
            if (event.fullday) {
                // An all-day event blocks its own calendar days, whatever zone it is stored in.
                busy.push({start: this.parseDate(event.start, eventZone), end: this.parseDate(event.end, event.timezone_end || eventZone)});
                continue;
            }
            const start = convertWall(this.parseDate(event.start, eventZone), eventZone, timezone);
            const end = convertWall(this.parseDate(event.end, event.timezone_end || eventZone), event.timezone_end || eventZone, timezone);
            busy.push({start, end});
        }

        const slots = findFreeSlots({
            busy,
            from: fromWall.slice(0, 10),
            to: toWall.slice(0, 10),
            notBefore: fromWall > nowWall ? fromWall : nowWall,
            ...(this.isDateOnly(options.to) ? {} : {notAfter: toWall}),
            durationMinutes: options.durationMinutes,
            dayStart: options.dayStart ?? "09:00",
            dayEnd: options.dayEnd ?? "17:00",
            includeWeekends: options.includeWeekends ?? false,
        });

        return {timezone, slots, ...(warnings.length > 0 ? {warnings} : {})};
    }

    private async fetchEvent(eventId: Id): Promise<any> {
        return this.request(this.eventUrl(eventId), {}, "event retrieval");
    }

    async getEvent(eventId: Id): Promise<any> {
        const result = await this.fetchEvent(eventId);
        const [event] = await this.annotateOwn(await this.annotateBookableResources([result.data]));
        result.data = event;
        return result;
    }

    private isDateOnly(value: string): boolean {
        return /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
    }

    /** All-day events may start and end on the same day; timed events must end after they start. */
    private checkOrder(range: {start: string; end: string}, fullday: boolean): void {
        if (fullday ? range.start > range.end : range.start >= range.end) {
            throw new Error(fullday ? "start must not be after end" : "end must be after start");
        }
    }

    /** All-day events run from 00:00:00 of the first day to 23:59:59 of the last day (inclusive end date). */
    private allDayRange(start: string, end: string): {start: string; end: string} {
        return {start: `${start.slice(0, 10)} 00:00:00`, end: `${end.slice(0, 10)} 23:59:59`};
    }

    async createEvent(input: CreateEventInput): Promise<any> {
        const {title, start, end, description, attendees, rrule, calendarId} = input;
        const [calendar, profile] = await Promise.all([
            calendarId ? Promise.resolve({id: toId(calendarId, "calendar_id")}) : this.getDefaultCalendar(),
            this.getUserProfile(),
        ]);
        const timezone = input.timezone ? requireTimeZone(input.timezone) : this.getProfileTimezone(profile);
        const calendarAttendees = await this.buildAttendees(attendees, profile);

        const fullday = input.allDay ?? (this.isDateOnly(start) && this.isDateOnly(end));
        const warnings: string[] = [];
        let range = {start: this.parseInput(start, timezone, "start"), end: this.parseInput(end, timezone, "end")};
        if (fullday) {
            range = this.allDayRange(range.start, range.end);
        } else {
            this.checkWallClock(start, "start", timezone, warnings);
            this.checkWallClock(end, "end", timezone, warnings);
        }
        this.checkOrder(range, fullday);

        const kmeetOptions = input.kmeetLobby !== undefined || input.kmeetPassword !== undefined;
        let meetUrl: string | undefined;
        if (kmeetOptions && !input.withKmeet) {
            throw new Error("kmeet_lobby and kmeet_password need with_kmeet");
        }
        if (input.withKmeet) {
            if (fullday) {
                throw new Error("with_kmeet needs a start and end time, not whole days");
            }
            const unsupported = this.kmeetUnsupported(input);
            if (unsupported.length === 0) {
                return this.createKmeetEvent(input, {calendarId: calendar.id, range, timezone, attendees: calendarAttendees, warnings});
            }
            if (kmeetOptions) {
                throw new Error(`kmeet_lobby and kmeet_password cannot be combined with ${unsupported.join(", ")}`);
            }
            meetUrl = this.generateMeetUrl();
            warnings.push("The kMeet link was generated locally and sent as meet_room_url; lobby and password cannot be set for it");
        }

        const body: Record<string, any> = {
            title,
            start: range.start,
            end: range.end,
            description,
            freebusy: input.showAs ?? "busy",
            type: "event",
            calendar_id: calendar.id,
            fullday,
            private: input.private ?? false,
            ...(input.location ? {location: input.location} : {}),
            ...(input.remindersMinutes ? {alarms: alarmsFor(input.remindersMinutes)} : {}),
            ...(input.bookableResourceId ? {bookable_resource_id: input.bookableResourceId} : {}),
            ...(meetUrl ? {meet_room_url: meetUrl} : {}),
            timezone_start: timezone,
            timezone_end: timezone,
            attendees: calendarAttendees,
            notifyAttendees: input.notifyAttendees === true && calendarAttendees.length > 0,
        };

        if (rrule !== undefined) {
            body.rrule = rrule.replace(/^RRULE:/, "");
        }

        const result = await this.request(`${API_BASE}/1/calendar/pim/event`, {
            method: "POST",
            body: JSON.stringify(body),
        }, "event creation");
        this.forgetListings();
        return warnings.length > 0 ? {...result, warnings} : result;
    }

    /** Options that change the event and that `POST /1/kmeet/rooms` cannot carry; defaults do not count. */
    private kmeetUnsupported(input: CreateEventInput): string[] {
        return [
            ["rrule", Boolean(input.rrule)],
            ["location", Boolean(input.location)],
            ["reminders_minutes", (input.remindersMinutes?.length ?? 0) > 0],
            ["private", input.private === true],
            ["show_as", input.showAs !== undefined && input.showAs !== "busy"],
            ["bookable_resource_id", Boolean(input.bookableResourceId)],
        ].filter(([, changes]) => changes).map(([name]) => String(name));
    }

    /** A kMeet room needs no API call: its URL is the kMeet host plus a unique id. Unverified: the event field `meet_room_url` accepts such a link. */
    private generateMeetUrl(): string {
        return `https://${this.kmeetHostname}/${randomBytes(9).toString("base64url").replace(/[^a-zA-Z0-9]/g, "x")}`;
    }

    /**
     * Plans a kMeet conference, which adds a calendar event carrying the meeting URL.
     * Unverified: the endpoint is in the public OpenAPI, but no live call was made. Its schema lists
     * `options` as an array while its sample sends an object; the sample's shape is used.
     */
    private async createKmeetEvent(
        input: CreateEventInput,
        planned: {calendarId: Id; range: {start: string; end: string}; timezone: string; attendees: any[]; warnings: string[]},
    ): Promise<any> {
        if (input.title.length > 150 || (input.description?.length ?? 0) > 2000) {
            throw new Error("with_kmeet allows a title of at most 150 and a description of at most 2000 characters");
        }
        const invited = planned.attendees.some(attendee => attendee.organizer !== true);
        if (invited && input.notifyAttendees !== true) {
            throw new Error("kMeet may email attendees when it plans the conference; pass notify_attendees true to accept that, or leave attendees out");
        }

        const room = await this.request(`${API_BASE}/1/kmeet/rooms`, {
            method: "POST",
            body: JSON.stringify({
                calendar_id: Number(planned.calendarId),
                starting_at: planned.range.start,
                ending_at: planned.range.end,
                timezone: planned.timezone,
                hostname: this.kmeetHostname,
                title: input.title,
                ...(input.description ? {description: input.description} : {}),
                attendees: planned.attendees.map(attendee => ({
                    address: attendee.address,
                    organizer: attendee.organizer === true,
                    state: attendee.state,
                    ...(attendee.name ? {name: String(attendee.name).slice(0, 100)} : {}),
                })),
                options: {
                    subject: input.title,
                    start_audio_muted: false,
                    enable_recording: false,
                    enable_moderator_video: false,
                    start_audio_only: false,
                    // People who receive the link by forwarding can only get in through the lobby.
                    lobby_enabled: input.kmeetLobby ?? invited,
                    password_enabled: input.kmeetPassword !== undefined,
                    ...(input.kmeetPassword !== undefined ? {password: input.kmeetPassword} : {}),
                    e2ee_enabled: false,
                },
            }),
        }, "kMeet conference planning");
        this.forgetListings();

        const eventId = room?.data?.event_id;
        if (eventId === undefined || eventId === null) {
            return {...room, data: {title: input.title}, warnings: [...planned.warnings, "The conference was planned but the response named no event; look it up with calendar_list_events"]};
        }
        try {
            const created = await this.fetchEvent(eventId);
            return planned.warnings.length > 0 ? {...created, warnings: planned.warnings} : created;
        } catch {
            return {result: "success", data: {id: eventId, title: input.title}, warnings: [...planned.warnings, "The event was created but could not be read back; use calendar_get_event"]};
        }
    }

    async updateEvent(eventId: Id, input: UpdateEventInput = {}): Promise<any> {
        const {title, start, end, description, attendees, rrule, calendarId, notifyAttendees = false} = input;
        const existing = await this.fetchEvent(eventId);
        const event = existing.data;

        let calendar;
        if (calendarId) {
            calendar = {id: toId(calendarId, "calendar_id")};
        } else {
            calendar = {id: event.calendar_id};
        }

        const profile = await this.getUserProfile();
        if (notifyAttendees) {
            await this.requireOrganizerToNotify(event, profile, "the update email");
        }
        const profileZone = () => this.getProfileTimezone(profile);
        const oldStartZone = event.timezone_start || profileZone();
        const oldEndZone = event.timezone_end || profileZone();
        const timezoneStart = input.timezone ? requireTimeZone(input.timezone) : oldStartZone;
        const timezoneEnd = input.timezone ? timezoneStart : oldEndZone;

        let calendarAttendees = event.attendees || [];
        if (attendees !== undefined) {
            calendarAttendees = await this.buildAttendees(attendees, profile, event.attendees || []);
        }

        const wasFullday = event.fullday ?? false;
        const inferredAllDay = start !== undefined && end !== undefined && this.isDateOnly(start) && this.isDateOnly(end);
        const fullday = input.allDay ?? (inferredAllDay ? true : wasFullday);
        if (input.allDay === false && wasFullday && (start === undefined || end === undefined)) {
            throw new Error("start and end are required to turn an all-day event into a timed event");
        }

        const warnings: string[] = [];
        // A time zone change keeps the instant; all-day dates stay on their calendar day.
        const carry = (wall: string, from: string, to: string) => (wasFullday ? wall : convertWall(wall, from, to));
        const currentStart = carry(this.parseDate(event.start, oldStartZone), oldStartZone, timezoneStart);
        const currentEnd = carry(this.parseDate(event.end, oldEndZone), oldEndZone, timezoneEnd);
        const newStart = start ? this.parseInput(start, timezoneStart, "start") : currentStart;
        let newEnd: string;
        if (end) {
            newEnd = this.parseInput(end, timezoneEnd, "end");
        } else if (start) {
            // Moving only the start keeps the event's length.
            newEnd = msToWall(wallToMs(newStart) + (wallToMs(currentEnd) - wallToMs(currentStart)));
        } else {
            newEnd = currentEnd;
        }
        let range = {start: newStart, end: newEnd};
        if (fullday) {
            // Only dates the caller gave are normalized; stored values go back unchanged.
            const kindChanged = !wasFullday;
            range = {
                start: start || kindChanged ? `${range.start.slice(0, 10)} 00:00:00` : range.start,
                end: end || kindChanged ? `${range.end.slice(0, 10)} 23:59:59` : range.end,
            };
        } else {
            if (start) this.checkWallClock(start, "start", timezoneStart, warnings);
            if (end) this.checkWallClock(end, "end", timezoneEnd, warnings);
        }
        if (start || end || input.allDay !== undefined) {
            this.checkOrder(range, fullday);
        }

        let meetRoomUrl: string = event.meet_room_url || "";
        if (input.withKmeet && !meetRoomUrl) {
            meetRoomUrl = this.generateMeetUrl();
            warnings.push("The kMeet link was generated locally and sent as meet_room_url");
        }

        const result = await this.request(this.eventUrl(eventId), {
            method: "PUT",
            body: JSON.stringify({
                id: Number(toId(eventId, "event_id")),
                calendar_id: calendar.id,
                title: title ?? event.title,
                description: description ?? event.description ?? "",
                start: range.start,
                end: range.end,
                timezone_start: timezoneStart,
                timezone_end: timezoneEnd,
                freebusy: input.showAs ?? event.freebusy ?? "busy",
                type: event.type ?? "event",
                fullday,
                private: input.private ?? event.private ?? false,
                location: input.location ?? event.location ?? "",
                color: event.color ?? null,
                attendees: calendarAttendees,
                alarms: input.remindersMinutes ? alarmsFor(input.remindersMinutes) : (event.alarms || []),
                attachments: event.attachments || [],
                rrule: rrule !== undefined ? rrule.replace(/^RRULE:/, "") : (event.rrule || ""),
                meet_room_url: meetRoomUrl,
                bookable_resource_id: input.bookableResourceId === "" ? null : (input.bookableResourceId ?? event.bookable_resource_id),
                notifyAttendees: notifyAttendees,
                parent_updated: false,
                imip_request: notifyAttendees,
            }),
        }, "event update");
        this.forgetListings();
        return warnings.length > 0 ? {...result, warnings} : result;
    }

    async deleteEvent(eventId: Id, calendarId?: Id, notifyAttendees: boolean = false): Promise<any> {
        toId(eventId, "event_id");
        let calendar;
        const existing = (calendarId && !notifyAttendees) ? undefined : await this.fetchEvent(eventId);
        if (notifyAttendees) {
            await this.requireOrganizerToNotify(existing?.data, await this.getUserProfile(), "the cancellation");
        }
        if (calendarId) {
            calendar = {id: toId(calendarId, "calendar_id")};
        } else {
            // The event's own calendar, not the default one.
            calendar = {id: existing?.data?.calendar_id};
            if (calendar.id === undefined || calendar.id === null) {
                throw new Error("The event has no calendar_id; pass calendar_id");
            }
        }

        const params = new URLSearchParams({calendar_id: String(calendar.id)});

        const deleted = await this.request(this.eventUrl(eventId, params), {
            method: "DELETE",
            ...(notifyAttendees ? {
                body: JSON.stringify({notifyAttendees: true, imip_request: true}),
            } : {}),
        }, "event deletion");
        this.forgetListings();

        return deleted;
    }

    /**
     * Notifications go to every attendee, so only the organizer may send them. An event with no
     * organizer entry (no attendees) has nobody to notify and passes.
     */
    private async requireOrganizerToNotify(event: any, profile: any, action: string): Promise<void> {
        const organizer = (Array.isArray(event?.attendees) ? event.attendees : []).find((attendee: any) => attendee?.organizer === true);
        if (!organizer) {
            return;
        }
        const own = await this.ownAddresses(profile);
        if (!own.has(String(organizer.address ?? "").toLowerCase())) {
            throw new Error(`notify_attendees is for organizers only: ${organizer.address ? "another person organizes" : "someone else organizes"} this event, so ${action} would be sent in their name. Run again without notify_attendees`);
        }
    }

    /** Addresses that belong to the token owner: the profile email and the documented profile email list. */
    private async ownAddresses(profile: any): Promise<Set<string>> {
        const own = new Set<string>();
        if (profile?.data?.email) {
            own.add(String(profile.data.email).toLowerCase());
        }
        try {
            const emails = await this.getProfileEmails();
            for (const entry of Array.isArray(emails?.data) ? emails.data : []) {
                // The OpenAPI `Useremail` schema has a `checked` flag: an unverified address is not the user's yet.
                if (entry && typeof entry === "object" && (entry as Record<string, unknown>).checked === false) {
                    continue;
                }
                const address = emailOf(entry);
                if (address) {
                    own.add(address.toLowerCase());
                }
            }
        } catch {
            // Aliases are a convenience; the primary address still counts.
        }
        return own;
    }

    /**
     * Builds the attendee list. Without `existing` (create) the token owner is added as organizer.
     * With `existing` (update) attendees already on the event keep their stored state, new addresses
     * are added, omitted ones are removed, the existing organizer and the token owner's own entry stay,
     * and the token owner becomes organizer when the event has none. On create an empty list means no
     * attendees; on update it removes everyone except the organizer and the token owner's own entry.
     */
    private async buildAttendees(attendees: string[] | undefined, profile: any, existing?: any[]): Promise<any[]> {
        if (!attendees || (attendees.length === 0 && !(existing && existing.length > 0))) {
            return [];
        }

        const ownEmail = profile?.data?.email;
        if (!ownEmail) {
            throw new Error("The profile has no email address; the token needs the profile scope");
        }
        const own = String(ownEmail).toLowerCase();

        const [contacts, ownAddresses] = await Promise.all([
            this.getContacts().catch((error: unknown) => {
                console.error(`Contact lookup failed, attendees are sent without contact ids: ${error instanceof Error ? error.message : error}`);
                return {data: []};
            }),
            this.ownAddresses(profile),
        ]);
        const contactByEmail = new Map<string, any>();
        for (const contact of contacts?.data ?? []) {
            for (const email of contact.emails ?? []) {
                const address = emailOf(email);
                if (address) {
                    contactByEmail.set(address.toLowerCase(), contact);
                }
            }
        }

        const wanted = new Set(attendees.map(email => String(email).toLowerCase()));
        const result: any[] = [];
        const seen = new Set<string>();

        for (const attendee of existing ?? []) {
            const address = String(attendee?.address ?? "").toLowerCase();
            if (!address || seen.has(address)) {
                continue;
            }
            if (attendee.organizer === true || wanted.has(address) || ownAddresses.has(address)) {
                result.push(attendee);
                seen.add(address);
            }
        }

        for (const email of attendees) {
            const address = String(email).toLowerCase();
            if (seen.has(address) || ownAddresses.has(address)) {
                continue;
            }
            seen.add(address);
            const contact = contactByEmail.get(address);
            result.push({
                className: "Attendee",
                ...(contact ? {contactId: contact.id} : {}),
                address: email,
                state: "NEEDS-ACTION",
                name: contact?.name ?? email,
                organizer: false,
            });
        }

        if (attendees.length > 0 && !result.some(attendee => attendee?.organizer === true)) {
            // The owner may already be on the event under an alias address: promote that entry.
            const ownIndex = result.findIndex(attendee => ownAddresses.has(String(attendee?.address ?? "").toLowerCase()));
            if (ownIndex >= 0) {
                result[ownIndex] = {...result[ownIndex], organizer: true};
                return result;
            }
            const organizerContact = contactByEmail.get(own);
            result.push({
                className: "Attendee",
                ...(organizerContact ? {contactId: organizerContact.id} : {}),
                address: ownEmail,
                name: profile.data.display_name,
                organizer: true,
                state: "ACCEPTED",
            });
        }

        return result;
    }
}
