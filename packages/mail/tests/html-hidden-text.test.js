import { describe, it } from "node:test";
import assert from "node:assert";

const { htmlToText } = await import("../dist/html-text.js");

describe("htmlToText hidden content", () => {
    it("drops elements hidden by class, id, and tag.class rules in <style>", () => {
        const html = [
            "<style>.x, #y {display:none} p.z{visibility:hidden} .small{font-size:1px}</style>",
            '<p class="a x b">secret one</p><p id="y">secret two</p><p class="z">secret three</p>',
            '<span class="small">secret four</span><p class="a">visible</p>',
        ].join("");
        assert.strictEqual(htmlToText(html), "visible");
    });

    it("ignores rules inside @media blocks", () => {
        assert.strictEqual(htmlToText("<style>@media print{.x{display:none}}</style><p class=\"x\">shown</p>"), "shown");
    });

    it("drops transparent text and font sizes under 2px", () => {
        const html = [
            '<span style="color:transparent">t1</span>',
            '<span style="color: rgba(0,0,0,0)">t2</span>',
            '<span style="font-size:1px">t3</span>',
            '<span style="font-size:1pt">t4</span>',
            '<span style="font-size:12px">kept</span>',
            '<span style="font-size:2px">kept2</span>',
        ].join(" ");
        assert.strictEqual(htmlToText(html), "kept kept2");
    });

    it("ends a hidden element that has no end tag at its parent's end tag", () => {
        assert.strictEqual(htmlToText('<div><span style="display:none">secret<p>more</div><p>tail</p>'), "tail");
        assert.strictEqual(htmlToText("<p hidden>secret<p>visible"), "visible");
        assert.strictEqual(htmlToText('<ul><li hidden>secret<li>shown</ul><p>after</p>'), "- shown\n\nafter");
    });

    it("keeps nested elements of the same name balanced", () => {
        assert.strictEqual(htmlToText('<div><div style="display:none"><div>a</div>b</div>c</div>'), "c");
    });
});
