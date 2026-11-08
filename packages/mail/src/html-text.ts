import {HTML_ENTITIES} from "./html-entities.js";

const VOID_TAGS = new Set(["br", "hr", "img", "input", "meta", "link", "area", "base", "col", "embed", "source", "track", "wbr"]);
const DROP_TAGS = new Set(["script", "style", "head", "title", "template", "noscript", "svg", "object", "iframe"]);
// End tag may be left out: a following sibling of the same tag ends the element
const OPTIONAL_END_TAGS = new Set(["p", "li", "dt", "dd", "td", "th", "tr", "option"]);
const BLOCK_TAGS = new Set([
    "p", "div", "section", "article", "header", "footer", "table", "tr", "ul", "ol", "li", "blockquote",
    "h1", "h2", "h3", "h4", "h5", "h6", "pre", "form", "address", "dl", "dt", "dd", "center",
]);

const ENTITY_PATTERN = /&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi;
// Zero-width and soft-hyphen characters: newsletter preheaders repeat them to pad previews
const INVISIBLE_PATTERN = /[\u00ad\u200b-\u200f\u2060-\u2064\ufeff]/g;
// Elements whose content is raw text: they end only at their own end tag
const RAW_TEXT_TAGS = new Set(["script", "style", "title", "textarea", "noscript", "template"]);
// Longest HTML converted; the rest is cut so one mail cannot hold the process
const SKIPPED_RAW_TAGS = new Set(["script", "style", "title", "textarea"]);
const MAX_HTML_LENGTH = 1_000_000;
// Open elements tracked; deeper nesting is still read, only end-tag matching stops
const MAX_OPEN_DEPTH = 256;
const PRE_MARK_SPACE = "\ue000";
const PRE_MARK_TAB = "\ue001";

function decodeEntities(text: string): string {
    return text.replace(ENTITY_PATTERN, (match, entity: string) => {
        if (entity[0] === "#") {
            const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
            try {
                return Number.isFinite(code) ? String.fromCodePoint(code) : match;
            } catch {
                return match;
            }
        }
        return Object.hasOwn(HTML_ENTITIES, entity) ? HTML_ENTITIES[entity] : match;
    });
}

/** Remove every `open ... close` span in linear time; an unclosed span runs to the end. */
function stripSpans(text: string, open: string, close: string): string {
    let result = "";
    let from = 0;
    for (;;) {
        const start = text.indexOf(open, from);
        if (start === -1) return result + text.slice(from);
        result += text.slice(from, start);
        const end = text.indexOf(close, start + open.length);
        if (end === -1) return result;
        from = end + close.length;
    }
}

function attributes(source: string): Record<string, string> {
    const result: Record<string, string> = {};
    const pattern = /([^\s=/"'<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    for (const match of source.matchAll(pattern)) {
        result[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
    }
    return result;
}

/** True when a CSS declaration list hides text from a human reader. */
function isHiddenStyle(css: string): boolean {
    const style = css.toLowerCase().replace(/\s+/g, "").replace(/!important/g, "");
    const fontSize = style.match(/(?:^|;)font-size:(\d*\.?\d+)(px|pt|em|rem|%)?(?:;|$)/);
    return (
        /display:none/.test(style) ||
        /visibility:hidden/.test(style) ||
        /(^|;)opacity:0(\.0+)?(;|$)/.test(style) ||
        // 0, or under 2px (1.5pt is 2px); relative units below 0.1 are as unreadable
        (fontSize !== null && (fontSize[2] === "em" || fontSize[2] === "rem" || fontSize[2] === "%"
            ? Number(fontSize[1]) < (fontSize[2] === "%" ? 10 : 0.1)
            : Number(fontSize[1]) < (fontSize[2] === "pt" ? 1.5 : 2))) ||
        /(max-height|max-width|height|width):0(px|pt|em|%)?(;|$)/.test(style) && /overflow:hidden/.test(style) ||
        /(^|;)(left|right|top|bottom|text-indent):-\d{3,}/.test(style) ||
        /(^|;)margin(-left|-top)?:-\d{4,}/.test(style) ||
        /(^|;)clip:rect\((?:[01](?:px)?,?){4}\)/.test(style) ||
        /(^|;)clip-path:inset\(100%/.test(style) ||
        /(^|;)color:(#fff|#ffffff|white|rgb\(255,255,255\)|transparent|rgba\(\d+,\d+,\d+,0(\.0+)?\))(;|$)/.test(style)
    );
}

/** Rules `selector{declarations}` of a stylesheet, found in one linear pass; at-rules are skipped. */
function styleRules(css: string): Array<{ selector: string; body: string }> {
    const rules: Array<{ selector: string; body: string }> = [];
    const n = css.length;
    let i = 0;
    while (i < n) {
        while (i < n && /\s/.test(css[i])) i++;
        if (i >= n) break;
        const atRule = css[i] === "@";
        let j = i;
        while (j < n && css[j] !== "{" && css[j] !== "}" && css[j] !== ";") j++;
        if (j >= n) break;
        if (css[j] === "}" || css[j] === ";") {
            i = j + 1;
            continue;
        }
        if (atRule) {
            // Block at-rule such as @media: skip the whole balanced block
            let depth = 1;
            j++;
            while (j < n && depth > 0) {
                if (css[j] === "{") depth++;
                else if (css[j] === "}") depth--;
                j++;
            }
            i = j;
            continue;
        }
        let end = j + 1;
        while (end < n && css[end] !== "}" && css[end] !== "{") end++;
        rules.push({selector: css.slice(i, j), body: css.slice(j + 1, end)});
        i = end + 1;
    }
    return rules;
}

/** Class and id names that `<style>` rules hide (simple `.class` and `#id` selectors; `@media` blocks are ignored). */
function hiddenSelectors(source: string): { classes: Set<string>; ids: Set<string> } {
    const classes = new Set<string>();
    const ids = new Set<string>();
    const opening = /<style\b/gi;
    const closing = /<\/style\s*>/gi;
    for (;;) {
        const start = opening.exec(source);
        if (!start) break;
        const tagEnd = source.indexOf(">", start.index);
        if (tagEnd === -1) break;
        closing.lastIndex = tagEnd + 1;
        const end = closing.exec(source);
        if (!end) break;
        opening.lastIndex = end.index + end[0].length;
        const css = stripSpans(source.slice(tagEnd + 1, end.index), "/*", "*/");
        for (const rule of styleRules(css)) {
            if (!isHiddenStyle(rule.body)) continue;
            for (const selector of rule.selector.split(",")) {
                const simple = selector.trim().match(/^(?:[a-z][a-z0-9]*)?([.#])([\w-]+)$/i);
                if (simple) (simple[1] === "." ? classes : ids).add(simple[2]);
            }
        }
    }
    return {classes, ids};
}

/** True for elements a human reader cannot see: hidden, zero-size, transparent, or white text. */
function isHidden(attrs: Record<string, string>, hiddenBy: { classes: Set<string>; ids: Set<string> }): boolean {
    if ("hidden" in attrs || attrs["aria-hidden"] === "true") return true;
    if (attrs.id && hiddenBy.ids.has(attrs.id)) return true;
    if ((attrs.class ?? "").split(/\s+/).some((name) => name && hiddenBy.classes.has(name))) return true;
    return isHiddenStyle(attrs.style ?? "");
}

/**
 * Convert an HTML mail body to readable text. Link targets stay as
 * `text (url)`. Scripts, styles, comments, and hidden or white-on-white
 * elements are dropped: a human reader never sees them, so they can only
 * carry text meant for the model.
 */
export function htmlToText(html: string): string {
    return htmlToTextResult(html).text;
}

/** Remove every `<name ...>...</name>` element, content included; an unclosed one runs to the end. */
function removeElements(text: string, name: string): string {
    const opening = new RegExp(`<${name}\\b`, "gi");
    const closing = new RegExp(`</${name}\\s*>`, "gi");
    let result = "";
    let from = 0;
    for (;;) {
        opening.lastIndex = from;
        const start = opening.exec(text);
        if (!start) return result + text.slice(from);
        result += text.slice(from, start.index);
        const tagEnd = text.indexOf(">", start.index);
        if (tagEnd === -1) return result;
        closing.lastIndex = tagEnd + 1;
        const end = closing.exec(text);
        if (!end) return result;
        from = end.index + end[0].length;
    }
}

/** Same as `htmlToText`, and reports whether the input was cut at the length limit. */
export function htmlToTextResult(html: string): { text: string; truncated: boolean } {
    // Comments, data: URIs, and script/style contents are dropped before the length cap, so they cannot use up the limit
    const stripped = stripSpans(stripSpans(html, "<!--", "-->"), "<![CDATA[", "]]>")
        .replace(/data:[^\s"'<>)]*/gi, "data:");
    const hiddenBy = hiddenSelectors(stripped);
    const withoutRaw = removeElements(removeElements(stripped, "script"), "style");
    let source = withoutRaw;
    let truncated = false;
    if (source.length > MAX_HTML_LENGTH) {
        truncated = true;
        source = source.slice(0, MAX_HTML_LENGTH);
        // Never end inside a tag
        const lastOpen = source.lastIndexOf("<");
        if (lastOpen > source.lastIndexOf(">")) source = source.slice(0, lastOpen);
    }
    // Attribute text stops at the next "<", so an unclosed tag cannot make later tags rescan the input
    const tagPattern = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^'"<>])*)>/g;

    let out = "";
    // Elements being skipped: tag name, nesting depth of that same tag, and how many ancestors were open
    let skip: { tag: string; depth: number; openAncestors: number } | null = null;
    // Raw-text element inside a skipped element: only its own end tag counts
    let rawUntil: string | null = null;
    // Open elements, so a hidden element with no end tag stops at its parent's end tag
    const open: string[] = [];
    // Per open element: how many open elements up to it keep whitespace (pre, white-space:pre*)
    const preCounts: number[] = [];
    const links: Array<{ href: string | null; start: number }> = [];
    let last = 0;

    const addText = (text: string) => {
        if (skip) return;
        let decoded = decodeEntities(text).replace(INVISIBLE_PATTERN, "");
        if (preCounts.length > 0 && preCounts[preCounts.length - 1] > 0) {
            decoded = decoded.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ")
                .replace(/ /g, PRE_MARK_SPACE).replace(/\t/g, PRE_MARK_TAB);
            out += decoded;
        } else {
            out += decoded.replace(/[\s\u00a0]+/g, " ");
        }
    };
    const newline = () => {
        if (!skip) out += "\n";
    };

    for (const match of source.matchAll(tagPattern)) {
        addText(source.slice(last, match.index));
        last = (match.index ?? 0) + match[0].length;
        const closing = match[1] === "/";
        const tag = match[2].toLowerCase();
        const attrs = closing ? {} : attributes(match[3]);
        const selfClosing = match[3].trimEnd().endsWith("/") || VOID_TAGS.has(tag);

        if (skip) {
            if (rawUntil) {
                if (closing && tag === rawUntil) rawUntil = null;
                continue;
            }
            if (!closing && !selfClosing && tag !== skip.tag && SKIPPED_RAW_TAGS.has(tag)) {
                rawUntil = tag;
                continue;
            }
            if (tag === skip.tag && !selfClosing) {
                if (!closing && skip.depth === 1 && OPTIONAL_END_TAGS.has(tag)) {
                    // A new <p>, <li>... closes the previous one: the hidden element ends here
                    skip = null;
                } else {
                    const raw = RAW_TEXT_TAGS.has(tag) && tag !== "noscript" && tag !== "template";
                    // Raw text holds no elements: only its own end tag counts
                    if (raw && !closing) continue;
                    skip.depth = raw ? 0 : skip.depth + (closing ? -1 : 1);
                    if (skip.depth === 0) skip = null;
                    continue;
                }
            } else if (closing && !RAW_TEXT_TAGS.has(skip.tag) && open.lastIndexOf(tag) !== -1 && open.lastIndexOf(tag) < skip.openAncestors) {
                // The parent ends while the hidden element is still open: it ends with the parent
                open.length = preCounts.length = open.lastIndexOf(tag);
                skip = null;
                if (BLOCK_TAGS.has(tag)) newline();
                continue;
            } else {
                continue;
            }
        }
        if (!closing && !selfClosing && (DROP_TAGS.has(tag) || isHidden(attrs, hiddenBy))) {
            skip = {tag, depth: 1, openAncestors: open.length};
            continue;
        }
        if (!closing && selfClosing && isHidden(attrs, hiddenBy)) continue;
        if (!selfClosing) {
            if (closing) {
                const index = open.lastIndexOf(tag);
                if (index !== -1) open.length = preCounts.length = index;
            } else if (open.length < MAX_OPEN_DEPTH) {
                const keepsSpace = tag === "pre" || /white-space:\s*pre/i.test(attrs.style ?? "");
                open.push(tag);
                preCounts.push((preCounts[preCounts.length - 1] ?? 0) + (keepsSpace ? 1 : 0));
            }
        }

        if (tag === "br") {
            newline();
        } else if (tag === "hr") {
            out += "\n---\n";
        } else if (tag === "a") {
            if (closing) {
                const link = links.pop();
                if (link?.href) {
                    const label = out.slice(link.start).trim();
                    const href = link.href;
                    if (label !== href && !(href.startsWith("mailto:") && href.slice(7) === label)) {
                        out += ` (${href})`;
                    }
                }
            } else {
                const href = (attrs.href ?? "").trim();
                links.push({href: /^(https?:|mailto:)/i.test(href) ? decodeEntities(href) : null, start: out.length});
            }
        } else if (tag === "li" && !closing) {
            out += out === "" || out.endsWith("\n") ? "- " : "\n- ";
        } else if (BLOCK_TAGS.has(tag) || tag === "td" || tag === "th") {
            if (tag === "td" || tag === "th") {
                if (closing) out += " ";
            } else {
                newline();
            }
        }
    }
    addText(source.slice(last));

    const text = out
        .split("\n")
        .map((line) => line.replace(/[ \t]+/g, " ").trim())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
        .replaceAll(PRE_MARK_SPACE, " ")
        .replaceAll(PRE_MARK_TAB, "\t");
    return {text, truncated};
}
