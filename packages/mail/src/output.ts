/** Longest text block a tool returns, in characters. */
export const MAX_TEXT_LENGTH = 100_000;

export interface Page<T = unknown> {
    items: T[];
    has_more: boolean;
    next_offset?: number;
    truncated?: boolean;
    [key: string]: unknown;
}

/** Options for `toTextResult`. */
export interface TextResultOptions {
    /** Also return the value as `structuredContent`. */
    structured?: boolean;
    /**
     * Offset of the first item of a page. With it, items that do not fit are
     * dropped from the end and the page resumes right after the last kept one.
     * Without it a page cannot resume, so its text is cut instead of its items.
     */
    offset?: number;
    /** Fields that resume a page after the kept items (default: `next_offset`). */
    resume?: (kept: unknown[]) => Record<string, unknown>;
    /** Largest serialized result; defaults to MAX_TEXT_LENGTH. */
    maxLength?: number;
}

/** Length of a string once JSON-escaped, without the quotes. */
function escapedLength(text: string): number {
    return JSON.stringify(text).length - 2;
}

/** Cut a string so that its JSON-escaped form is at most `max` characters. */
export function capJsonString(text: string, max: number): string {
    if (text.length <= max && escapedLength(text) <= max) return text;
    let low = 0;
    let high = Math.min(text.length, max);
    while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (escapedLength(text.slice(0, mid)) <= max) low = mid;
        else high = mid - 1;
    }
    return text.slice(0, low);
}

/** Cut a string to `max` characters and say so. */
export function capText(text: string, max: number): { text: string; truncated: boolean } {
    return text.length > max ? {text: text.slice(0, max), truncated: true} : {text, truncated: false};
}

/** Copy of `value` with strings cut to `stringMax` and arrays and objects cut to `countMax` entries. */
function shrinkValue(value: unknown, stringMax: number, countMax: number): unknown {
    if (typeof value === "string") return capJsonString(value, stringMax);
    if (Array.isArray(value)) return value.slice(0, countMax).map((v) => shrinkValue(v, stringMax, countMax));
    if (value && typeof value === "object") {
        const entries = Object.entries(value);
        const out: Record<string, unknown> = {};
        for (const [key, entry] of entries.slice(0, countMax)) {
            out[key] = shrinkValue(entry, stringMax, countMax);
            if (Array.isArray(entry) && entry.length > countMax) out[`${key}_omitted`] = entry.length - countMax;
        }
        if (entries.length > countMax) out._omitted_keys = entries.length - countMax;
        return out;
    }
    return value;
}

/**
 * Cut the largest values until the serialized value fits: first long strings
 * (fields such as `untrusted_content` are shortened, never removed), then long
 * arrays and objects, keeping their first entries and a count of the rest.
 */
function shrinkToFit(value: any, max: number): any {
    let stringMax = Math.max(1000, max / 4);
    let countMax = 1000;
    for (;;) {
        const candidate: any = shrinkValue(value, stringMax, countMax);
        if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) candidate.truncated = true;
        if (JSON.stringify(candidate).length <= max) return candidate;
        if (stringMax > 20) stringMax = Math.floor(stringMax / 2);
        else if (countMax > 1) countMax = Math.floor(countMax / 2);
        else return {truncated: true};
    }
}

/**
 * Serialize a tool result as one compact JSON text block of at most
 * MAX_TEXT_LENGTH characters, measured after `JSON.stringify`. A page with a
 * known offset loses items from the end and resumes after the last kept one
 * (`truncated` and `has_more` are set); at least one item stays, and a single
 * oversized item has its long text fields cut. Anything else is shrunk by
 * cutting long strings, arrays, and objects. The result is always valid JSON.
 */
export function toTextResult(value: unknown, structured: boolean | TextResultOptions = false, extra: TextResultOptions = {}) {
    const options: TextResultOptions = typeof structured === "object" ? structured : {...extra, structured};
    const max = options.maxLength ?? MAX_TEXT_LENGTH;
    let text = JSON.stringify(value);
    let output: any = value;
    if (text.length > max) {
        const items = (value as Page)?.items;
        if (Array.isArray(items) && options.offset !== undefined) {
            let kept = items.length;
            const build = () => {
                const slice = items.slice(0, kept);
                return {
                    ...(value as Page),
                    items: slice,
                    truncated: true,
                    has_more: true,
                    ...(options.resume ? options.resume(slice) : {next_offset: options.offset! + slice.length}),
                };
            };
            let page = build();
            while (JSON.stringify(page).length > max && kept > 1) {
                kept--;
                page = build();
            }
            output = JSON.stringify(page).length > max ? shrinkToFit(page, max) : page;
        } else {
            output = shrinkToFit(value, max);
        }
        text = JSON.stringify(output);
    }
    return {
        content: [{type: "text" as const, text}],
        ...(options.structured ? {structuredContent: output as Record<string, unknown>} : {}),
    };
}

/** Build a page. `has_more` is true when the API returned a full page. */
export function toPage<T>(items: T[], offset: number, limit: number): Page<T> {
    const hasMore = items.length >= limit;
    return {items, has_more: hasMore, ...(hasMore ? {next_offset: offset + items.length} : {})};
}
