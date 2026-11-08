export const MAX_TEXT_CHARS = 100_000;

type Json = Record<string, any>;

export function projectAttendee(attendee: any): Json {
    return {
        address: attendee?.address,
        name: attendee?.name,
        state: attendee?.state,
        organizer: attendee?.organizer === true ? true : undefined,
    };
}

function compact(value: Json): Json {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== null));
}

const CALENDAR_FIELDS = ["id", "name", "color", "default", "is_owner", "readonly", "writable", "permission", "type"];

/** Calendar record without share lists and user addresses. Unverified: the API field names are undocumented. */
export function projectCalendar(calendar: any): Json {
    if (!calendar || typeof calendar !== "object") {
        return {value: calendar};
    }
    return compact(Object.fromEntries(CALENDAR_FIELDS
        .filter(field => ["string", "number", "boolean"].includes(typeof calendar[field]))
        .map(field => [field, calendar[field]])));
}

const RESOURCE_FIELDS = ["uuid", "name", "type", "capacity", "seats", "size"];

/** Resource record without permission data or user lists. Unverified: the API field names are undocumented. */
export function projectResource(resource: any): Json {
    if (!resource || typeof resource !== "object") {
        return {value: resource};
    }
    return compact(Object.fromEntries(RESOURCE_FIELDS
        .filter(field => ["string", "number", "boolean"].includes(typeof resource[field]))
        .map(field => [field, resource[field]])));
}

/** Short record for lists. Free text from third parties stays out of it. */
export function projectEventSummary(event: any): Json {
    if (!event || typeof event !== "object") {
        return {value: event};
    }
    return compact({
        id: event.id,
        calendar_id: event.calendar_id,
        calendar_name: event.calendar_name,
        title: event.title,
        start: event.start,
        end: event.end,
        timezone_start: event.timezone_start,
        fullday: event.fullday,
        rrule: event.rrule || undefined,
        freebusy: event.freebusy,
        bookable_resource_name: event.bookable_resource_name,
        my_state: event.my_state,
        is_organizer: event.is_organizer,
        attendees: Array.isArray(event.attendees) ? event.attendees.map(projectAttendee).map(compact) : undefined,
    });
}

/** Full record. Text that outside inviters control sits in `untrusted_content`. */
export function projectEventDetail(event: any): Json {
    if (!event || typeof event !== "object") {
        return {value: event};
    }
    const untrusted = compact({description: event.description || undefined, location: event.location || undefined});
    return compact({
        ...projectEventSummary(event),
        private: event.private,
        color: event.color,
        alarms: event.alarms,
        meet_room_url: event.meet_room_url || undefined,
        bookable_resource_id: event.bookable_resource_id,
        untrusted_content: Object.keys(untrusted).length > 0 ? untrusted : undefined,
    });
}

const size = (value: unknown): number => JSON.stringify(value).length;
const MIN_CUT = 40;
const MARKER = "…";
const MAX_CUTS = 20;
const FREE_TEXT_KEYS = new Set(["description", "location", "comment", "notes"]);
const PROTECTED_KEYS = new Set(["id", "untrusted_content", "truncated", "shortened"]);

type Path = Array<string | number>;
type Visit = (holder: any, key: string | number, path: Path) => void;

function walk(value: any, path: Path, visit: Visit): void {
    if (value === null || typeof value !== "object") {
        return;
    }
    for (const key of Object.keys(value)) {
        const next = [...path, Array.isArray(value) ? Number(key) : key];
        visit(value, Array.isArray(value) ? Number(key) : key, next);
        walk(value[key], next, visit);
    }
}

/** `attendees[2].name` for a path of keys and indexes. */
function pathName(path: Path): string {
    return path.map((part, index) => (typeof part === "number" ? `[${part}]` : `${index > 0 ? "." : ""}${part}`)).join("").slice(0, 60);
}

/** Text that outside parties write: cut first because the model can still read the start of it. */
function isFreeText(path: Path): boolean {
    return path.includes("untrusted_content") || FREE_TEXT_KEYS.has(String(path[path.length - 1]));
}

/** Cuts strings, longest first, until `excess` characters are gone. Returns what is still to remove. */
function cutStrings(root: any, excess: number, accept: (path: Path) => boolean, cuts: Set<string>): number {
    const leaves: Array<{holder: any; key: string | number; path: Path; length: number}> = [];
    walk(root, [], (holder, key, path) => {
        const text = holder[key];
        if (typeof text === "string" && text.length > MIN_CUT && accept(path)) {
            leaves.push({holder, key, path, length: text.length});
        }
    });
    leaves.sort((a, b) => b.length - a.length);
    for (const leaf of leaves) {
        if (excess <= 0) {
            break;
        }
        const length = Math.max(MIN_CUT, leaf.length - excess - 1);
        leaf.holder[leaf.key] = leaf.holder[leaf.key].slice(0, length - 1) + MARKER;
        excess -= leaf.length - length;
        cuts.add(pathName(leaf.path));
    }
    return excess;
}

/** Keeps the first half of the largest array and counts what it left out in `<key>_omitted`. */
function halveLargestArray(root: any, cuts: Set<string>): boolean {
    let best: {holder: any; key: string | number; path: Path; bytes: number} | undefined;
    walk(root, [], (holder, key, path) => {
        const child = holder[key];
        if (Array.isArray(child) && child.length > 1) {
            const bytes = size(child);
            if (!best || bytes > best.bytes) {
                best = {holder, key, path, bytes};
            }
        }
    });
    if (!best) {
        return false;
    }
    const array: any[] = best.holder[best.key];
    const keep = Math.ceil(array.length / 2);
    best.holder[best.key] = array.slice(0, keep);
    if (!Array.isArray(best.holder)) {
        const omittedKey = `${String(best.key)}_omitted`;
        best.holder[omittedKey] = (best.holder[omittedKey] ?? 0) + array.length - keep;
    }
    cuts.add(`${pathName(best.path)} (first ${keep} kept)`.slice(0, 80));
    return true;
}

/** Last resort: removes the largest property that is not an identifier or third-party text. */
function dropLargestProperty(root: any, cuts: Set<string>): boolean {
    let best: {holder: any; key: string | number; path: Path; bytes: number} | undefined;
    walk(root, [], (holder, key, path) => {
        if (!Array.isArray(holder) && !PROTECTED_KEYS.has(String(key)) && !path.includes("untrusted_content")) {
            const bytes = size(holder[key]);
            if (!best || bytes > best.bytes) {
                best = {holder, key, path, bytes};
            }
        }
    });
    if (!best) {
        return false;
    }
    delete best.holder[best.key];
    cuts.add(`${pathName(best.path)} (removed)`);
    return true;
}

/**
 * Shrinks one record until its JSON fits `budget` characters, and adds what it changed to `cuts`.
 * Order: text that third parties write (cut with a "…" marker), then long arrays (the first half stays
 * and `<key>_omitted` counts the rest), then any other long text, then the largest remaining property.
 * `id` and `untrusted_content` keys are never removed.
 */
export function shrinkToFit<T>(value: T, budget: number, cuts: Set<string> = new Set()): T {
    const copy = structuredClone(value);
    const excess = () => size(copy) - budget;
    if (excess() > 0) {
        cutStrings(copy, excess(), isFreeText, cuts);
    }
    for (let round = 0; round < 200 && excess() > 0 && halveLargestArray(copy, cuts); round++) {
        // Each round halves the largest array.
    }
    if (excess() > 0) {
        cutStrings(copy, excess(), () => true, cuts);
    }
    for (let round = 0; round < 200 && excess() > 0 && dropLargestProperty(copy, cuts); round++) {
        // Each round removes one property.
    }
    return copy;
}

/**
 * Serializes `structured` so the final JSON text fits `limit`. A list drops
 * trailing items and resumes right after the last item it returned
 * (`has_more`, `next_offset`); when even the first item does not fit, its long
 * text is cut instead, so a page is never empty while `has_more` is true.
 * A single record is cut the same way. Sets `truncated: true` when it cut.
 */
export function capResult(structured: Json, limit = MAX_TEXT_CHARS): {structured: Json; text: string} {
    let text = JSON.stringify(structured);
    if (text.length <= limit) {
        return {structured, text};
    }
    let current: Json = {...structured, truncated: true};
    if (Array.isArray(current.warnings) && current.warnings.length > 10) {
        current.warnings = [...current.warnings.slice(0, 10), `${current.warnings.length - 10} more warnings left out`];
    }
    // Room for the `shortened` list that names what was cut.
    const reserve = Math.min(1600, Math.floor(limit / 10));
    const cuts = new Set<string>();
    if (Array.isArray(current.items)) {
        const all: any[] = current.items;
        const offset: number = current.offset ?? 0;
        const base = size({...current, items: [], has_more: true, next_offset: Number.MAX_SAFE_INTEGER});
        let used = base;
        let count = 0;
        for (const item of all) {
            const next = used + size(item) + (count > 0 ? 1 : 0);
            if (next > limit) {
                break;
            }
            used = next;
            count++;
        }
        let items = all.slice(0, count);
        if (count === 0 && all.length > 0) {
            items = [shrinkToFit(all[0], limit - base - reserve, cuts)];
            count = 1;
        }
        const dropped = count < all.length;
        current = {...current, items};
        if (dropped) {
            current.has_more = true;
            current.next_offset = offset + count;
        }
    } else if (current.event) {
        const rest = size({...current, event: {}});
        current = {...current, event: shrinkToFit(current.event, limit - rest - reserve, cuts)};
    }
    if (cuts.size > 0) {
        current.shortened = [...cuts].slice(0, MAX_CUTS);
    }
    text = JSON.stringify(current);
    if (text.length > limit && current.shortened) {
        delete current.shortened;
        text = JSON.stringify(current);
    }
    if (text.length > limit) {
        throw new Error("The result is too large to return; use a smaller limit or a narrower request");
    }
    return {structured: current, text};
}

export function result(structured: Json) {
    const {structured: shaped, text} = capResult(structured);
    return {content: [{type: "text" as const, text}], structuredContent: shaped};
}
