import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseMarkdown, parseInline, plain } from "./md-parse.js";

const kinds = (blocks) => blocks.map((b) => b.t);

test("headings, paragraphs, rule, setext", () => {
  const b = parseMarkdown("# Title #\n\nOne line\nsame paragraph\n\n---\n\nSub\n===\n\n###### six");
  assert.deepEqual(kinds(b), ["h", "p", "hr", "h", "h"]);
  assert.equal(b[0].level, 1);
  assert.deepEqual(b[0].c, ["Title"]);
  assert.deepEqual(b[1].c, ["One line\nsame paragraph"]);
  assert.equal(b[3].level, 1);
  assert.equal(b[4].level, 6);
});

test("fenced code keeps its text and language, and nothing inside is parsed", () => {
  const b = parseMarkdown("```ts\nconst a = 1; // **not bold**\n# not a heading\n```\nafter");
  assert.deepEqual(kinds(b), ["code", "p"]);
  assert.equal(b[0].lang, "ts");
  assert.equal(b[0].text, "const a = 1; // **not bold**\n# not a heading");
  const open = parseMarkdown("~~~\nunclosed");
  assert.equal(open[0].text, "unclosed");
});

test("nested lists, ordered start, task items, lazy continuation", () => {
  const b = parseMarkdown("- a\n  - a1\n  - a2\n- b\ncontinued\n\n3. three\n4. four\n\n- [x] done\n- [ ] todo");
  assert.deepEqual(kinds(b), ["list", "list", "list"]);
  const [ul, ol, tasks] = b;
  assert.equal(ul.ordered, false);
  assert.equal(ul.items.length, 2);
  assert.deepEqual(kinds(ul.items[0].c), ["p", "list"]);
  assert.equal(ul.items[0].c[1].items.length, 2);
  assert.deepEqual(ul.items[1].c[0].c, ["b\ncontinued"]);
  assert.equal(ol.ordered, true);
  assert.equal(ol.start, 3);
  assert.deepEqual(tasks.items.map((i) => i.task), [true, false]);
  assert.deepEqual(tasks.items[1].c[0].c, ["todo"]);
});

test("ordered item with a two-space nested bullet list", () => {
  const b = parseMarkdown("1. step\n  - detail\n2. next");
  assert.equal(b.length, 1);
  assert.equal(b[0].items.length, 2);
  assert.deepEqual(kinds(b[0].items[0].c), ["p", "list"]);
});

test("GFM table with alignment, escaped pipes and code spans with pipes", () => {
  const b = parseMarkdown("| ID | Rule | n |\n|:---|:---:|---:|\n| `a|b` | x \\| y | 3 |\n| short |");
  assert.equal(b[0].t, "table");
  assert.deepEqual(b[0].align, ["left", "center", "right"]);
  assert.equal(b[0].rows.length, 2);
  assert.deepEqual(b[0].rows[0][0], [{ t: "code", text: "a|b" }]);
  assert.deepEqual(b[0].rows[0][1], ["x | y"]);
  assert.deepEqual(b[0].rows[1][2], []);
});

test("block quote parses its inside as blocks", () => {
  const b = parseMarkdown("> **Note**\n> - item");
  assert.equal(b[0].t, "quote");
  assert.deepEqual(kinds(b[0].c), ["p", "list"]);
});

test("inline: code, strong, em, del, links, autolinks, escapes, breaks", () => {
  assert.deepEqual(parseInline("a `x*y*` b"), ["a ", { t: "code", text: "x*y*" }, " b"]);
  assert.deepEqual(parseInline("**bold** and *em* and ~~gone~~"),
    [{ t: "strong", c: ["bold"] }, " and ", { t: "em", c: ["em"] }, " and ", { t: "del", c: ["gone"] }]);
  assert.deepEqual(parseInline("***both***"), [{ t: "strong", c: [{ t: "em", c: ["both"] }] }]);
  assert.deepEqual(parseInline("snake_case_name stays"), ["snake_case_name stays"]);
  assert.deepEqual(parseInline("2 * 3 * 4"), ["2 * 3 * 4"]);
  assert.deepEqual(parseInline("[spec](docs/a.md) [web](https://x.dev/a_(b))"),
    [{ t: "link", href: "docs/a.md", c: ["spec"] }, " ", { t: "link", href: "https://x.dev/a_(b)", c: ["web"] }]);
  assert.deepEqual(parseInline("see https://lucide.dev, then"), ["see ", { t: "link", href: "https://lucide.dev", c: ["https://lucide.dev"] }, ", then"]);
  assert.deepEqual(parseInline("<mailto:a@b.c>"), [{ t: "link", href: "mailto:a@b.c", c: ["a@b.c"] }]);
  assert.deepEqual(parseInline("\\*not em\\*"), ["*not em*"]);
  assert.deepEqual(parseInline("line  \nnext"), ["line", { t: "br" }, "next"]);
  assert.deepEqual(parseInline("![diagram](d.png)"), [{ t: "img", alt: "diagram", src: "d.png" }]);
  assert.equal(plain(parseInline("**a** `b` [c](d)")), "a b c");
});

test("raw HTML is kept as text; comment blocks are dropped (inside fences they are kept)", () => {
  assert.deepEqual(parseMarkdown("<script>alert(1)</script>")[0].c, ["<script>alert(1)</script>"]);
  assert.deepEqual(kinds(parseMarkdown("<!-- CANARY-x -->\n# T\n<!--\nmulti\n-->\nend")), ["h", "p"]);
  assert.equal(parseMarkdown("```\n<!-- kept -->\n```")[0].text, "<!-- kept -->");
});

test("every Markdown file of the scenario and docs parses without throwing", () => {
  const root = new URL("../../../", import.meta.url);
  const files = ["README.md", "PREREGISTRATION.md", "docs/REVIEW-CHECKLIST.md", "docs/DECISIONS.md",
    "scenario/context/orders-service/S2.md", "docs/USING.md"];
  for (const f of files) {
    let text;
    try { text = readFileSync(new URL(f, root), "utf8"); } catch { continue; }
    const b = parseMarkdown(text);
    assert.ok(b.length > 0, f);
  }
});
