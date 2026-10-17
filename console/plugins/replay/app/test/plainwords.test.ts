// node --test for the plain-words rule (2026-10-16): the one label map (console/web/lib/labels.js, re-exported by
// src/components/labels.ts) and "no code on screen" in the theater: every text a replay puts on screen, after
// plainReplay, is free of ticket ids (X-…), cell codes (V/S/W), stage codes (P0–P8, C8, X1, X2), H2/HS-V2, detector
// codes and run ids. Codes stay in the data (meta.ticket, meta.condition, detail.detector…).
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import {
  GLOSSARY, LEGEND, STAGES, VISIBLE_CODE_RE, meaningOf, plainCondition, plainConditionOf, plainReplay, plainText,
  runHeadline, runName, runSource, stageLabel, ticketLabel, withCode,
} from "../src/components/labels.ts";
import { travels } from "../src/engine/scene.ts";
import type { Replay } from "../src/engine/replay.ts";

const pub = (rel: string) => new URL(`../public/${rel}`, import.meta.url);
const load = (u: URL): Replay => JSON.parse(readFileSync(u, "utf8")) as Replay;

// ------------------------------------------------------------------------------------------------ the label map
test("label map: the words Alfredo asked for, and one entry for every code family", () => {
  assert.equal(ticketLabel("X-rename"), "Rename two fields");
  assert.equal(ticketLabel("X-remove"), "Remove a field");
  assert.equal(plainCondition("V0", "S0", "W1"), "Own repo · No rule");
  assert.equal(GLOSSARY.V2.short, "Every repo visible");
  assert.equal(GLOSSARY.S2.short, "Rule in the spec");
  assert.equal(GLOSSARY.V1.short, "Contracts inside the repo");
  assert.equal(stageLabel("P1"), "Main test");
  for (const code of ["P0", "P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "C8", "X1", "X2"]) {
    assert.ok(STAGES[code]?.short && STAGES[code].long, `${code} has words`);
  }
  assert.match(STAGES.P8.long, /Antigravity CLI \+ Gemini 3\.8 Flash/);
  assert.match(STAGES.P7.long, /Claude Code \+ Sonnet and with Codex/);
  const codes = LEGEND.flatMap((g) => g.items.map((i) => i.code));
  for (const c of ["X-rename", "X-remove", "X-add", "X-api", "X-dep", "X-units", "V0", "V1", "V2", "S0", "S1", "S2",
    "W1", "W2", "P0", "P8", "C8", "H2", "HS-V2"]) assert.ok(codes.includes(c), `legend lists ${c}`);
  for (const g of LEGEND) for (const i of g.items) {
    assert.ok(i.short && i.long, `${i.code} has a short and a long meaning`);
    assert.equal(VISIBLE_CODE_RE.test(i.short), false, `the words for ${i.code} carry no code: ${i.short}`);
    assert.equal(meaningOf(i.code), i.long);
  }
});

test("label map: console style puts the words first and the code in parentheses", () => {
  assert.equal(withCode("X-rename"), "Rename two fields (X-rename)");
  assert.equal(withCode("P7"), "More main-test runs (P7)");
  assert.equal(withCode("ZZ-9"), "ZZ-9", "unknown codes stay as they are");
});

test("run ids read as words: stage and run number", () => {
  assert.equal(runName("p1-0002"), "Main test · run 2");
  assert.equal(runName("p6-0012"), "Codex repeat · run 12");
  assert.equal(runName("p8-0120"), "Third agent · run 120");
  assert.equal(runName("x1c-0003"), "Pilot 1 · run 3");
  assert.equal(runName("st-0014"), "Simulated run 14");
  assert.equal(runName("aisdlc-gate"), "aisdlc-gate", "a scene id is not a run id");
  assert.equal(runSource({ run_id: "p1-0002", stage: "P1" }), "Main test · run 2");
});

test("plainText rewrites the codes the records carry, and nothing else", () => {
  const cases: [string, string][] = [
    ["X-rename · V0·S0 · W1", "Rename two fields · Own repo · No rule"],
    ["Ticket X-rename assigned to the code agent (V0·S0).",
      "Ticket to rename two fields assigned to the code agent (Own repo · No rule)."],
    ["Code Agent · orders-service gets ticket X-remove: “The channel field…”",
      "Code Agent · orders-service gets the ticket to remove a field: “The channel field…”"],
    ["PR p1-0002 · fix1: 2 files changed, +8 -0", "PR · repair 1: 2 files changed, +8 -0"],
    ["End: fixed_code · ticket done", "End: Fixed after CI failed · ticket done"],
    ["End: no change.", "End: Stopped without a change."],
    ["End: something else", "End: something else"],
    ["CLAUDE.md · Context S0", "CLAUDE.md · Context: No rule"],
    ["Gate touched (D1): scripts/verify-contracts.mjs — protected gate path modified",
      "Gate touched: scripts/verify-contracts.mjs — protected gate path modified"],
    ["D6 · contracts/consumers/analytics-ingest__OrderPlaced.json · consumer contract modified",
      "contracts/consumers/analytics-ingest__OrderPlaced.json · consumer contract modified"],
    ["Task assigned: X-remove", "Task assigned: Remove a field"],
    ["V1·S0·W2", "Contracts inside the repo · No rule · Ticket asks not to break consumers"],
    ["ARCH-4 failed: billing-service needs totalCents (S-2 story, README.md)",
      "ARCH-4 failed: billing-service needs totalCents (S-2 story, README.md)"],
  ];
  for (const [raw, want] of cases) {
    const got = plainText(raw);
    assert.equal(got, want);
    assert.equal(VISIBLE_CODE_RE.test(got), false, got);
  }
  assert.equal(plainText(null), null);
});

// ------------------------------------------------------------------------------------------------ no code on screen
/** Every string of a replay that the theater draws or prints (stage, subtitles, timeline, events panel, header). */
function visibleTexts(r: Replay): string[] {
  const out: (string | null | undefined)[] = [r.meta["title"] as string | undefined, runHeadline(r.meta),
    runSource(r.meta), plainConditionOf(r.meta.condition).text, r.scene?.context?.summary,
    r.scene?.ticket_origin?.label, r.scene?.ticket_origin?.title];
  for (const p of r.places) out.push(p.label, p.note);
  for (const s of r.steps) {
    out.push(s.text, s.narration, s.caption);
    for (const k of ["content", "output", "input_summary", "output_summary"]) {
      const v = s.detail?.[k];
      if (typeof v === "string") out.push(v);
    }
  }
  for (const m of r.markers) out.push(m.label);
  for (const t of travels(r)) out.push(t.label);
  return out.filter((x): x is string => typeof x === "string" && x.length > 0);
}

function replayFiles(): URL[] {
  const urls: URL[] = [];
  for (const dir of ["demo", "scenes"]) {
    for (const f of readdirSync(pub(dir))) if (f.endsWith(".json") && f !== "index.json") urls.push(pub(`${dir}/${f}`));
  }
  // the two real runs of the deck clips, when video/prepare_clips.py has written them (gitignored)
  const work = new URL("../../../../../video/work/replays/", import.meta.url);
  if (existsSync(work)) for (const f of readdirSync(work)) if (f.endsWith(".json")) urls.push(new URL(f, work));
  return urls;
}

test("no code on screen: every replay's visible text is plain words after plainReplay", () => {
  const files = replayFiles();
  assert.ok(files.length >= 10, `found ${files.length} replays`);
  let raw = 0;
  for (const u of files) {
    const r = load(u);
    raw += visibleTexts(r).filter((t) => VISIBLE_CODE_RE.test(t)).length;
    const p = plainReplay(r);
    const leaks = visibleTexts(p).filter((t) => VISIBLE_CODE_RE.test(t));
    assert.deepEqual(leaks, [], `${u.pathname.split("/").slice(-2).join("/")}: ${leaks.slice(0, 3).join(" | ")}`);
    // the codes stay in the data
    assert.equal(p.meta.ticket, r.meta.ticket);
    assert.deepEqual(p.meta.condition, r.meta.condition);
    assert.equal(p.steps.length, r.steps.length);
  }
  assert.ok(raw > 0, "the fixtures do carry codes before the rewrite (the test is not vacuous)");
});

test("no code on screen: the bundled demo list reads as words", () => {
  const idx = JSON.parse(readFileSync(pub("demo/index.json"), "utf8")) as { runs: { label: string }[] };
  for (const r of idx.runs) assert.equal(VISIBLE_CODE_RE.test(plainText(r.label)), false, plainText(r.label));
});
