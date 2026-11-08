export const MIN_QUERY_LENGTH = 2;

/** Letters with no Unicode decomposition, folded to ASCII. */
const FOLDED: Record<string, string> = { ß: "ss", æ: "ae", ø: "o", œ: "oe", ł: "l" };

/** Lowercases, folds ß æ ø œ ł, strips diacritics, and collapses whitespace. */
export function normalizeText(value: string): string {
    return value
        .normalize("NFD")
        .replace(/\p{M}+/gu, "")
        .toLowerCase()
        .replace(/[ßæøœł]/g, (c) => FOLDED[c] ?? c)
        .replace(/\s+/g, " ")
        .trim();
}

/** Collects every string inside a value (strings, arrays, nested objects); numbers are skipped. */
export function collectStrings(value: unknown, out: string[] = [], depth = 0): string[] {
    if (value === null || value === undefined || depth > 4) return out;
    if (typeof value === "string") {
        if (value.trim()) out.push(value);
    } else if (Array.isArray(value)) {
        for (const item of value) collectStrings(item, out, depth + 1);
    } else if (typeof value === "object") {
        for (const item of Object.values(value)) collectStrings(item, out, depth + 1);
    }
    return out;
}

/** Email addresses as strings: plain strings, or the address field of an email object (not its labels). */
export function emailStrings(value: unknown): string[] {
    const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
    const out: string[] = [];
    for (const item of list) {
        if (typeof item === "string") out.push(item);
        else if (item && typeof item === "object") {
            for (const key of ["value", "email", "address"]) {
                const v = (item as Record<string, unknown>)[key];
                if (typeof v === "string") out.push(v);
            }
        }
    }
    return out.filter((v) => v.trim() !== "");
}

/** Keys of `others` that hold searchable text, with the label a match is reported under. */
const OTHERS_TEXT_KEYS: Record<string, string> = {
    organization: "organization",
    organisation: "organization",
    company: "organization",
    nickname: "nickname",
    note: "notes",
    notes: "notes",
    address: "address",
    addresses: "address",
};

/**
 * Canonical digit form of a phone number. A leading +41 or 0041 becomes 0, so
 * "+41 79 123 45 67", "0041 79 123 45 67" and "079 123 45 67" are equal.
 * Other international prefixes keep their country code without + or 00.
 */
export function phoneDigits(value: string): string {
    const trimmed = value.trim();
    const digits = trimmed.replace(/\D/g, "");
    let international: string | null = null;
    if (trimmed.startsWith("+")) international = digits;
    else if (digits.startsWith("00")) international = digits.slice(2);
    if (international === null) return digits;
    return international.startsWith("41") ? `0${international.slice(2)}` : international;
}

const PHONE_QUERY = /^[+\d\s().\-/]+$/;

export function isPhoneQuery(query: string): boolean {
    return PHONE_QUERY.test(query) && query.replace(/\D/g, "").length >= 3;
}

/** Words shorter than this match only at the start of a word, never inside one. */
export const MIN_SUBSTRING_LENGTH = 3;

// Rank: 3 exact, 2 prefix (whole field or a word of it), 1 substring, 0 no match.
function scoreText(field: SearchField, needle: string): number {
    const haystack = field.text;
    if (haystack === needle) return 3;
    if (haystack.startsWith(needle)) return 2;
    if (field.words.some((word) => word.startsWith(needle))) return 2;
    return needle.length >= MIN_SUBSTRING_LENGTH && haystack.includes(needle) ? 1 : 0;
}

interface SearchField {
    label: string;
    text: string;
    /** `text` split into words once, when the index is built. */
    words: string[];
}

interface IndexedContact {
    contact: Record<string, any>;
    fields: SearchField[];
    phones: string[];
    nameWords: string[];
    sortKey: string;
}

function sortKeyOf(contact: Record<string, any>): string {
    const name = typeof contact.name === "string" ? contact.name.trim() : "";
    return normalizeText(name || [contact.lastname, contact.firstname].filter(Boolean).join(" "));
}

/** Final tie-break: contacts with equal keys keep a fixed order, so paging never skips or repeats. */
function compareIds(a: Record<string, any>, b: Record<string, any>): number {
    if (typeof a.id === "number" && typeof b.id === "number") return a.id - b.id;
    return String(a.id ?? "").localeCompare(String(b.id ?? ""));
}

function compareEntries(a: IndexedContact, b: IndexedContact): number {
    return a.sortKey.localeCompare(b.sortKey) || compareIds(a.contact, b.contact);
}

function buildIndex(contact: Record<string, any>): IndexedContact {
    const raw: [string, unknown][] = [
        ["name", contact.name],
        ["name", contact.firstname],
        ["name", contact.lastname],
        ["name", [contact.firstname, contact.lastname].filter(Boolean).join(" ")],
        ["name", [contact.lastname, contact.firstname].filter(Boolean).join(" ")],
        ...emailStrings(contact.emails).map((v): [string, unknown] => ["emails", v]),
        ...collectStrings(contact.organization).map((v): [string, unknown] => ["organization", v]),
        ...collectStrings(contact.nickname).map((v): [string, unknown] => ["nickname", v]),
    ];
    const others = contact.others;
    if (others && typeof others === "object" && !Array.isArray(others)) {
        for (const [key, value] of Object.entries(others)) {
            const label = OTHERS_TEXT_KEYS[key.toLowerCase()];
            if (label) for (const v of collectStrings(value)) raw.push([label, v]);
        }
    }
    const fields = raw
        .filter((e): e is [string, string] => typeof e[1] === "string" && e[1].trim() !== "")
        .map(([label, text]) => {
            const normalized = normalizeText(text);
            return { label, text: normalized, words: normalized.split(/[\s@.,;:/_-]+/) };
        });
    return {
        contact,
        fields,
        phones: collectStrings(contact.phones).map(phoneDigits).filter((p) => p.length > 0),
        nameWords: [contact.firstname, contact.lastname]
            .filter((v): v is string => typeof v === "string" && v.trim() !== "")
            .flatMap((v) => normalizeText(v).split(" ")),
        sortKey: sortKeyOf(contact),
    };
}

// The index is built once per address-book array, so a cached book is normalized once.
const indexes = new WeakMap<object, IndexedContact[]>();

function indexOf(contacts: Record<string, any>[]): IndexedContact[] {
    let index = indexes.get(contacts);
    if (!index) {
        index = contacts.map(buildIndex);
        indexes.set(contacts, index);
    }
    return index;
}

function phoneScore(phones: string[], query: string): number {
    if (!isPhoneQuery(query)) return 0;
    const wanted = phoneDigits(query);
    let score = 0;
    for (const stored of phones) {
        if (stored === wanted) score = Math.max(score, 3);
        else if (stored.startsWith(wanted)) score = Math.max(score, 2);
        else if (stored.includes(wanted)) score = Math.max(score, 1);
        else if (wanted.length >= 9 && stored.length >= 9 && stored.slice(-9) === wanted.slice(-9)) {
            score = Math.max(score, 2);
        }
    }
    return score;
}

/** Query words: quotes and brackets dropped, punctuation trimmed from each word's ends. */
function queryWords(query: string): string[] {
    return normalizeText(query)
        .replace(/["'`“”‘’„«»()[\]{}<>]/g, " ")
        .split(/\s+/)
        .map((w) => w.replace(/^[\s.,;:/_-]+|[\s.,;:/_-]+$/g, ""))
        .filter(Boolean);
}

function scoreIndexed(entry: IndexedContact, query: string): number {
    const words = queryWords(query);
    let score = 0;
    if (words.length > 0 && entry.fields.length > 0) {
        score = Math.min(
            ...words.map((word) =>
                Math.max(0, ...entry.fields.map((f) => scoreText(f, word))),
            ),
        );
        // Words in any order that spell the whole name count as an exact hit.
        if (
            score > 0 &&
            words.length > 1 &&
            entry.nameWords.length === words.length &&
            [...entry.nameWords].sort().join(" ") === [...words].sort().join(" ")
        ) {
            score = 3;
        }
    }
    return Math.max(score, phoneScore(entry.phones, query));
}

/** Relevance of a contact for a query: 0 means no match. Every word must match some field. */
export function scoreContact(contact: Record<string, any>, query: string): number {
    return scoreIndexed(buildIndex(contact), query);
}

/** The fields (name, emails, phones, organization, nickname, address, notes) that explain a match. */
export function matchedOn(contact: Record<string, any>, query: string): string[] {
    const entry = buildIndex(contact);
    const words = queryWords(query);
    const labels = new Set<string>();
    for (const field of entry.fields) {
        if (words.some((word) => scoreText(field, word) > 0)) labels.add(field.label);
    }
    if (phoneScore(entry.phones, query) > 0) labels.add("phones");
    return [...labels];
}

/** Contacts sorted by name; the order is stable between calls, so paging never skips or repeats. */
const sorted = new WeakMap<object, Record<string, any>[]>();
export function sortContacts(contacts: Record<string, any>[]): Record<string, any>[] {
    let result = sorted.get(contacts);
    if (!result) {
        result = indexOf(contacts)
            .slice()
            .sort(compareEntries)
            .map((entry) => entry.contact);
        sorted.set(contacts, result);
    }
    return result;
}

/** Contacts matching the query, best matches first, ties in name order. */
export function searchContacts(contacts: Record<string, any>[], query: string): Record<string, any>[] {
    const trimmed = query.trim();
    if (normalizeText(trimmed).length < MIN_QUERY_LENGTH) {
        throw new Error(`query must be at least ${MIN_QUERY_LENGTH} characters`);
    }
    return indexOf(contacts)
        .map((entry) => ({ entry, score: scoreIndexed(entry, trimmed) }))
        .filter((hit) => hit.score > 0)
        .sort((a, b) => b.score - a.score || compareEntries(a.entry, b.entry))
        .map((hit) => hit.entry.contact);
}
