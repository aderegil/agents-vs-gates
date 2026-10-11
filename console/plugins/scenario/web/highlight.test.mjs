import test from "node:test";
import assert from "node:assert/strict";
import { tokenize } from "./highlight.js";

const flat = (lines) => lines.map((l) => l.map((t) => t[1]).join(""));
const types = (line) => Object.fromEntries(line.filter((t) => t[0]).map((t) => [t[1], t[0]]));

test("round-trip: tokens always concatenate to the original text", () => {
  const samples = {
    ts: "import { x } from './a';\n/* c\n still */ const a = `t ${1}\nmore` + 'q\'s'; // end\nexport interface Order { id: string; n?: number }\n",
    json: '{\n  "a": [1, 2.5e3, -3],\n  "b": {"c": true, "d": null, "e": "x\\"y"}\n}\n',
    yaml: "# c\nname: x\nlist:\n  - { a: 1, b: \"q\" }\n  - plain # tail\nk: [a, b]\n",
    md: "# T\n\n- item `code` **bold** [l](u)\n| a | b |\n```ts\ncode\n```\n<!-- c -->\ntext\n",
  };
  for (const [lang, text] of Object.entries(samples)) {
    assert.deepEqual(flat(tokenize(lang, text)), text.replace(/\n$/, "").split("\n"), lang);
  }
});
test("ts: keywords, types, strings, numbers, comments", () => {
  const [l] = tokenize("ts", "export const total: number = Order.of('a', 42); // note");
  const t = types(l);
  assert.equal(t.export, "kw"); assert.equal(t.const, "kw"); assert.equal(t.number, "type"); assert.equal(t.Order, "type");
  assert.equal(t["'a'"], "str"); assert.equal(t["42"], "num"); assert.equal(t["// note"], "com");
});
test("ts: a keyword after a dot is a property, not a keyword", () => {
  const [l] = tokenize("ts", "obj.default = 1");
  assert.equal(types(l).default, undefined);
});
test("ts: block comments and template literals continue across lines", () => {
  const lines = tokenize("ts", "/* a\nb */ x\n`t\nu` y");
  assert.equal(lines[1][0][0], "com");
  assert.equal(lines[3][0][0], "str");
  assert.deepEqual(lines[3].slice(-1)[0], ["", " y"]);
});
test("json: keys vs string values", () => {
  const [l] = tokenize("json", '  "name": "x", "n": 3, "ok": true');
  const t = types(l);
  assert.equal(t['"name"'], "key"); assert.equal(t['"x"'], "str"); assert.equal(t["3"], "num"); assert.equal(t.true, "kw");
});
test("yaml: keys, flow mappings, comments", () => {
  const [a] = tokenize("yaml", "name: orders-service # c");
  assert.equal(types(a).name, "key"); assert.equal(types(a)["# c"], "com");
  const [b] = tokenize("yaml", "  - { service: orders-service, version: 3 }");
  assert.equal(types(b).service, "key"); assert.equal(types(b).version, "key"); assert.equal(types(b)["3"], "num");
});
test("md: headings, fences, inline code, bullets", () => {
  const lines = tokenize("md", "## H\n- a `b`\n```\nx: 1\n```");
  assert.equal(lines[0][0][0], "head");
  assert.equal(lines[1][0][0], "kw");
  assert.equal(types(lines[1])["`b`"], "code");
  assert.equal(lines[3][0][0], "code");
});
test("unknown language is plain text", () => {
  assert.deepEqual(tokenize("text", "a\n\nb"), [[["", "a"]], [], [["", "b"]]]);
});
