import { z } from "zod";

export const MAX_TEXT_CHARS = 100_000;

export const DEFAULT_FIELDS = [
    "id",
    "name",
    "firstname",
    "lastname",
    "organization",
    "nickname",
    "emails",
    "phones",
] as const;

/** Fields a caller may request; `others` carries organization, nickname, and other stored details. */
export const CONTACT_FIELDS = [
    "id",
    "name",
    "firstname",
    "lastname",
    "organization",
    "nickname",
    "emails",
    "phones",
    "others",
] as const;

/** One contact as returned by the list and search tools; unrequested fields are absent. */
export const contactItemSchema = z
    .object({
        id: z.unknown().optional().describe("Contact id (a number in the API)"),
        name: z.unknown().optional().describe("Display name"),
        firstname: z.unknown().optional().describe("First name"),
        lastname: z.unknown().optional().describe("Last name"),
        organization: z.unknown().optional().describe("Organization; usually a string"),
        nickname: z.unknown().optional().describe("Nickname; usually a string"),
        emails: z.unknown().optional().describe("Email addresses, as the API returns them"),
        phones: z.unknown().optional().describe("Phone numbers, as the API returns them"),
        others: z
            .unknown()
            .optional()
            .describe("Other stored details, only with fields: [others]; may hold third-party text"),
        matched_on: z
            .array(z.string())
            .optional()
            .describe("Search only: the fields that matched the query"),
    })
    .passthrough();

export const listOutputSchema = {
    items: z.array(contactItemSchema),
    has_more: z.boolean(),
    next_offset: z.number().int().optional(),
    total: z.number().int().optional(),
    truncated: z.boolean().optional(),
};

export interface ListPayload {
    items: Record<string, unknown>[];
    has_more: boolean;
    next_offset?: number;
    total?: number;
    truncated?: boolean;
}

const ORGANIZATION_KEYS = ["organization", "organisation", "company"];

/**
 * Keeps only the named fields of a contact record; absent fields are dropped.
 * A missing organization or nickname is filled from the same keys in `others`.
 */
export function projectContact(
    contact: Record<string, any>,
    fields: readonly string[] = DEFAULT_FIELDS,
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const others =
        contact.others && typeof contact.others === "object" && !Array.isArray(contact.others)
            ? (contact.others as Record<string, unknown>)
            : {};
    for (const field of fields) {
        let value = contact[field];
        if (value === undefined || value === null) {
            const keys = field === "organization" ? ORGANIZATION_KEYS : field === "nickname" ? ["nickname"] : [];
            for (const key of keys) {
                const found = Object.entries(others).find(([k]) => k.toLowerCase() === key)?.[1];
                if (found !== undefined && found !== null && found !== "") {
                    value = found;
                    break;
                }
            }
        }
        if (value !== undefined && value !== null) out[field] = value;
    }
    return out;
}

/** Cuts every string longer than `max` characters, at any depth. */
function cutStrings(value: unknown, max: number): unknown {
    if (typeof value === "string") {
        return value.length > max ? `${value.slice(0, max)}...` : value;
    }
    if (Array.isArray(value)) return value.map((v) => cutStrings(v, max));
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value).map(([k, v]) => [k, cutStrings(v, max)]),
        );
    }
    return value;
}

/** Keeps the first `n` entries of every array and object, at any depth, and notes how many were dropped. */
function trimDeep(value: unknown, n: number): unknown {
    if (Array.isArray(value)) {
        const kept = value.slice(0, n).map((v) => trimDeep(v, n));
        if (value.length > n) kept.push(`... ${value.length - n} more`);
        return kept;
    }
    if (value && typeof value === "object") {
        const entries = Object.entries(value);
        const out: Record<string, unknown> = {};
        for (const [k, v] of entries.slice(0, n)) out[k] = trimDeep(v, n);
        if (entries.length > n) out._more_keys = entries.length - n;
        return out;
    }
    return value;
}

/**
 * Shrinks one oversized item until `sizeOf(item)` fits: first cuts long strings, then
 * trims long arrays and objects, then drops `others`, and last keeps only id and name.
 */
function shrinkItem(item: Record<string, unknown>, sizeOf: (item: Record<string, unknown>) => number) {
    for (const max of [50_000, 12_500, 3_000, 800, 200, 50]) {
        const cut = cutStrings(item, max) as Record<string, unknown>;
        if (sizeOf(cut) <= MAX_TEXT_CHARS) return cut;
    }
    for (const n of [200, 50, 10, 3, 1]) {
        const cut = cutStrings(trimDeep(item, n), 200) as Record<string, unknown>;
        if (sizeOf(cut) <= MAX_TEXT_CHARS) return cut;
    }
    const { others: _others, ...rest } = item;
    const without = cutStrings(trimDeep(rest, 1), 200) as Record<string, unknown>;
    if (sizeOf(without) <= MAX_TEXT_CHARS) return without;
    return { id: item.id, name: cutStrings(item.name, 200) };
}

/**
 * Builds a list tool result: one compact JSON text block plus structuredContent.
 * The serialized payload never exceeds MAX_TEXT_CHARS. Trailing items that do
 * not fit are dropped, `next_offset` resumes right after the last returned
 * item, and `truncated: true` is set. When even the first item does not fit,
 * that item is returned with its long text fields cut, so paging always advances.
 */
export function listResult(
    items: Record<string, unknown>[],
    meta: { offset?: number; total?: number; has_more?: boolean } = {},
) {
    const offset = meta.offset ?? 0;
    const build = (page: Record<string, unknown>[], cut: boolean): ListPayload => {
        const count = page.length;
        const payload: ListPayload = {
            items: page,
            has_more: (meta.has_more ?? false) || count < items.length,
        };
        if (payload.has_more) payload.next_offset = offset + count;
        if (meta.total !== undefined) payload.total = meta.total;
        if (cut || count < items.length) payload.truncated = true;
        return payload;
    };
    const size = (payload: ListPayload) => JSON.stringify(payload).length;

    let payload = build(items, false);
    if (size(payload) > MAX_TEXT_CHARS) {
        let lo = 0;
        let hi = items.length;
        while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            if (size(build(items.slice(0, mid), false)) <= MAX_TEXT_CHARS) lo = mid;
            else hi = mid - 1;
        }
        if (lo > 0) {
            payload = build(items.slice(0, lo), false);
        } else {
            payload = build([shrinkItem(items[0], (item) => size(build([item], true)))], true);
        }
    }
    return {
        content: [{ type: "text" as const, text: JSON.stringify(payload) }],
        structuredContent: payload as unknown as Record<string, unknown>,
    };
}
