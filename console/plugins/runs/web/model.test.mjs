import test from "node:test";
import assert from "node:assert/strict";
import {
  parseDiff, diffStats, sideBySide, splitArch, isArch, inputSummary, groupTranscript, outcomeTone, ticketDoneTone,
  flagChips, filtersToQuery, applyFilters, conditionLabel, fmtBytes,
} from "./model.js";

const DIFF = [
  "diff --git a/src/core/events.ts b/src/core/events.ts",
  "index 1111111..2222222 100644",
  "--- a/src/core/events.ts",
  "+++ b/src/core/events.ts",
  "@@ -10,5 +10,6 @@ export interface OrderPlaced {",
  "   id: string;",
  "-  totalCents: number;",
  "-  currency: string;",
  "+  amountCents: number;",
  "+  amountCurrency: string;",
  "+  extra: string;",
  "   placedAt: string;",
  "@@ -40,2 +41,2 @@",
  " a",
  "-b",
  "+c",
  "diff --git a/docs/new.md b/docs/new.md",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/docs/new.md",
  "@@ -0,0 +1,2 @@",
  "+# New",
  "+",
  "\\ No newline at end of file",
  "diff --git a/img.png b/img.png",
  "Binary files a/img.png and b/img.png differ",
  "",
].join("\n");

test("parseDiff: files, hunks, line numbers", () => {
  const files = parseDiff(DIFF);
  assert.equal(files.length, 3);
  const f = files[0];
  assert.equal(f.path, "src/core/events.ts");
  assert.equal(f.hunks.length, 2);
  assert.equal(f.hunks[0].context, "export interface OrderPlaced {");
  const l = f.hunks[0].lines;
  assert.deepEqual(l.map((x) => x.type), ["ctx", "del", "del", "add", "add", "add", "ctx"]);
  assert.deepEqual([l[0].old, l[0].new], [10, 10]);
  assert.deepEqual([l[1].old, l[1].new], [11, null]);
  assert.deepEqual([l[3].old, l[3].new], [null, 11]);
  assert.deepEqual([l[6].old, l[6].new], [13, 14]);
  assert.equal(f.additions, 4);
  assert.equal(f.deletions, 3);
  assert.deepEqual(f.hunks[1].lines.map((x) => [x.old, x.new]), [[40, 41], [41, null], [null, 42]]);
  assert.equal(files[1].status, "added");
  assert.equal(files[1].path, "docs/new.md");
  assert.equal(files[1].hunks[0].lines.at(-1).type, "note");
  assert.ok(files[2].binary);
  assert.deepEqual(diffStats(files), { files: 3, additions: 6, deletions: 3 });
});

test("parseDiff keeps a context line whose leading space was stripped", () => {
  const files = parseDiff("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n a\n\n-b\n+c\n");
  assert.deepEqual(files[0].hunks[0].lines.map((x) => [x.type, x.old, x.new]), [["ctx", 1, 1], ["ctx", 2, 2], ["del", 3, null], ["add", null, 3]]);
});

test("parseDiff tolerates empty and garbage input", () => {
  assert.deepEqual(parseDiff(""), []);
  assert.deepEqual(parseDiff("hello\nworld"), []);
  assert.deepEqual(parseDiff(null), []);
});

test("sideBySide pairs removed and added lines", () => {
  const rows = sideBySide(parseDiff(DIFF)[0].hunks[0]);
  assert.equal(rows.length, 5);
  assert.equal(rows[1].left.text, "  totalCents: number;");
  assert.equal(rows[1].right.text, "  amountCents: number;");
  assert.equal(rows[3].left, null);
  assert.equal(rows[3].right.text, "  extra: string;");
  assert.equal(rows[0].left, rows[0].right);
});

test("splitArch bolds each ARCH-n", () => {
  assert.deepEqual(splitArch("ARCH-4 FAIL x; ARCH-12 ok"), [
    { text: "ARCH-4", arch: true }, { text: " FAIL x; ", arch: false }, { text: "ARCH-12", arch: true }, { text: " ok", arch: false }]);
  assert.deepEqual(splitArch("no rule"), [{ text: "no rule", arch: false }]);
  assert.deepEqual(splitArch(null), []);
  assert.ok(isArch("ARCH-7"));
  assert.ok(!isArch("typecheck"));
  assert.ok(!isArch("ARCH-"));
});

test("groupTranscript pairs calls with results and splits sessions", () => {
  const ev = [
    { ts: "t1", session: "gen", kind: "text", text: "hi" },
    { ts: "t2", session: "gen", kind: "tool_call", id: "a", name: "Bash", input: { command: "npm test\nmore" } },
    { ts: "t3", session: "gen", kind: "tool_call", id: "b", name: "Edit", input: { file_path: "src/x.ts" } },
    { ts: "t4", session: "gen", kind: "tool_result", id: "b", status: "success", output: "ok-b" },
    { ts: "t5", session: "gen", kind: "tool_result", id: "a", status: "error", output: "bad-a" },
    { ts: "t6", session: "gen", kind: "final", text: "done", num_turns: 3 },
    { ts: "t7", session: "fix1", kind: "text", text: "again" },
    { ts: "t8", session: "fix1", kind: "tool_result", id: "zz", status: "denied", output: "no" },
  ];
  const g = groupTranscript(ev);
  assert.deepEqual(g.map((x) => x.session), ["gen", "fix1"]);
  assert.deepEqual(g[0].items.map((x) => x.type), ["text", "tool", "tool", "final"]);
  assert.equal(g[0].items[1].summary, "npm test");
  assert.equal(g[0].items[1].result.status, "error");
  assert.equal(g[0].items[2].result.output, "ok-b");
  assert.equal(g[0].items[3].turns, 3);
  assert.equal(g[1].items[1].type, "result");
  assert.equal(groupTranscript(null).length, 0);
});

test("inputSummary", () => {
  assert.equal(inputSummary("Read", { file_path: "a/b.ts" }), "a/b.ts");
  assert.equal(inputSummary("Grep", { pattern: "foo" }), "foo");
  assert.equal(inputSummary("X", { a: 1 }), '{"a":1}');
  assert.equal(inputSummary("X", null), "{}");
  assert.ok(inputSummary("X", { zzz: "y".repeat(300) }).endsWith("…"));
});

test("tones", () => {
  assert.equal(outcomeTone("passed_first_ci"), "pass");
  assert.equal(outcomeTone("still_failing"), "fail");
  assert.equal(outcomeTone("fixed_with_gate_flag"), "warn");
  assert.equal(outcomeTone("whatever"), "neutral");
  assert.equal(ticketDoneTone("done"), "pass");
  assert.equal(ticketDoneTone("not_done"), "fail");
  assert.equal(ticketDoneTone("deprecated"), "neutral");
});

test("flag chips", () => {
  assert.deepEqual(flagChips({}), []);
  const c = flagChips({ contaminated: true, token_exposed: true, detectors: 1, infra: "timeout" });
  assert.deepEqual(c.map((x) => x.text), ["contaminated", "token exposed", "1 detector", "infra: timeout"]);
  assert.equal(flagChips({ detectors: 3 })[0].text, "3 detectors");
});

test("filters", () => {
  assert.deepEqual(filtersToQuery({ stage: "P1", ticket: "", V: "V0", q: " " && "x" }), { stage: "P1", V: "V0", q: "x" });
  const rows = [
    { run_id: "p1-0001", stage: "P1", ticket: "X-rename", visibility: "V0", spec: "S0", wording: "W1", unit: "mock", status: "done", cell: "X-rename|V0|S0|W1|mock" },
    { run_id: "p1-0002", stage: "P1", ticket: "X-remove", visibility: "V1", spec: "S2", wording: "W1", unit: "mock", status: "done", cell: "X-remove|V1|S2|W1|mock" },
  ];
  assert.equal(applyFilters(rows, { ticket: "X-remove" }).length, 1);
  assert.equal(applyFilters(rows, { V: "V0", S: "S0" })[0].run_id, "p1-0001");
  assert.equal(applyFilters(rows, { q: "0002" })[0].run_id, "p1-0002");
  assert.equal(applyFilters(rows, { q: "x-re" }).length, 2);
  assert.equal(applyFilters(rows, {}).length, 2);
  assert.equal(conditionLabel(rows[0]), "X-rename V0·S0·W1");
  assert.equal(fmtBytes(2048), "2.0 kB");
  assert.equal(fmtBytes(12), "12 B");
});
