// node --test for engine/scene.ts: what the stage adds around the trace (exporter 2 `scene`), pure and deterministic.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { quietStep, type Replay } from "../src/engine/replay.ts";
import {
  BOUNCE_MS, CARD_MS, PACKET_MS, RELIEF_MS, SHEET_MS, architectSheets, cardAt, editsAt, fitnessLabel, glassFor,
  isDimmed, ownerView, readsAt, restingSheets, travels, travelsAt, trayCount,
} from "../src/engine/scene.ts";

const DEMO = new URL("../public/demo/", import.meta.url);
const load = (name: string): Replay => JSON.parse(readFileSync(new URL(name, DEMO), "utf8")) as Replay;

test("PR tray layout without a reviewer; unused places are dimmed", () => {
  const r = load("m1-xrename-v0s0-break-repair.json");
  assert.equal(r.scene?.layout, "pr-tray");
  assert.ok(r.places.some((p) => p.id === "pr-tray"));
  assert.ok(!r.places.some((p) => p.id === "review-table"));
  assert.equal(isDimmed(r, "product-desk"), true);
  assert.equal(isDimmed(r, "ci-tower"), false);
  const pr = r.steps.find((s) => s.key === "pr_opened");
  assert.ok(pr);
  assert.equal(trayCount(r, pr.t_ms - 1), 0);
  assert.equal(trayCount(r, pr.t_ms), 1);
  const repair = r.steps.find((s) => s.key === "repair");
  assert.ok(repair);
  assert.equal(trayCount(r, repair.t_ms), 2);
});

test("Maya's sheets: S0 only the fitness functions to CI; S2 also the rules to the agent's desk", () => {
  const s0 = load("m1-xrename-v0s0-break-repair.json");
  assert.deepEqual(architectSheets(s0).map((t) => t.to), ["ci-tower"]);
  const s2 = load("m1-xrename-v0s2-additive.json");
  const sheets = architectSheets(s2);
  assert.deepEqual(sheets.map((t) => t.to), ["desk-orders", "ci-tower"]);
  assert.match(sheets[0].label, /S2 rules$/);
  assert.equal(sheets[1].label, "ARCH-1…ARCH-8 · fitness functions");
  assert.equal(restingSheets(s2, sheets[0].t0 + SHEET_MS - 1).length, 0);
  assert.equal(restingSheets(s2, sheets[0].t0 + SHEET_MS).length, 2);
  assert.equal(fitnessLabel([]), "fitness functions");
});

test("travels: CI picks up the PR, the CI output envelope, an event packet per oracle result", () => {
  const r = load("m1-xrename-v0s0-break-repair.json");
  const all = travels(r);
  const kinds = all.map((t) => t.kind);
  assert.ok(kinds.includes("pickup"));
  assert.ok(kinds.includes("envelope"));
  const packets = all.filter((t) => t.kind === "packet");
  const oracleSteps = r.steps.filter((s) => s.action === "oracle");
  assert.equal(packets.length, oracleSteps.length);
  const billGen = packets.find((p) => p.to === "desk-billing" && p.state === "gen");
  assert.ok(billGen);
  assert.equal(billGen.status, "fail");
  assert.equal(billGen.label, "OrderPlaced");
  // a failing packet bounces back after arriving, then disappears
  assert.equal(travelsAt([billGen], billGen.t0 + PACKET_MS / 2)[0].progress, 0.5);
  assert.ok(travelsAt([billGen], billGen.t0 + PACKET_MS + BOUNCE_MS / 2)[0].progress > 1);
  assert.equal(travelsAt([billGen], billGen.t0 + PACKET_MS + BOUNCE_MS + 1).length, 0);
  const pass = packets.find((p) => p.status === "pass");
  assert.ok(pass);
  assert.equal(travelsAt([pass], pass.t0 + PACKET_MS + 1).length, 0, "a passing packet does not bounce");
  assert.deepEqual(travels(r), all, "deterministic");
});

test("code owners: worried when the first PR breaks their service, relieved when the final passes", () => {
  const r = load("m1-xrename-v0s0-break-repair.json");
  const bill = r.scene?.consumers.find((c) => c.id === "billing-service");
  assert.ok(bill?.owner?.fictional);
  const gen = bill.oracle["gen"];
  const fin = bill.oracle["final"];
  assert.equal(ownerView(r, bill, gen.t_ms - 1).alert, null);
  const hit = ownerView(r, bill, gen.t_ms + PACKET_MS);
  if (fin.t_ms > gen.t_ms) {
    assert.equal(hit.mood, "worried");
    assert.equal(hit.alert?.status, "fail");
    assert.equal(hit.alert?.state, "gen");
  }
  const relief = ownerView(r, bill, fin.t_ms + PACKET_MS);
  assert.equal(relief.mood, "relieved");
  assert.equal(relief.alert?.status, "pass");
  assert.equal(ownerView(r, bill, fin.t_ms + PACKET_MS + RELIEF_MS).mood, "neutral");
  const store = r.scene?.consumers.find((c) => c.id === "web-storefront");
  assert.ok(store);
  assert.equal(ownerView(r, store, store.oracle["gen"].t_ms + PACKET_MS).mood, "neutral");
});

test("V2: dotted read line only after the transcript shows a read; pink edit mark from the edit on", () => {
  const r = load("m1-xrename-v2-scope.json");
  assert.deepEqual(glassFor(r), { clear: true, v: "V2", contracts: false });
  const bill = r.scene?.consumers.find((c) => c.id === "billing-service");
  assert.ok(bill && bill.reads.length && bill.edits.length);
  assert.equal(readsAt(bill, bill.reads[0].t_ms - 1).count, 0);
  const at = readsAt(bill, bill.reads[0].t_ms);
  assert.equal(at.count, 1);
  assert.ok(at.flash);
  assert.match(at.last ?? "", /^billing-service\//);
  assert.deepEqual(editsAt(bill, bill.edits[0].t_ms - 1), []);
  assert.deepEqual(editsAt(bill, bill.edits[0].t_ms), ["billing-service/src/core/orderPlacedEvent.ts"]);
  const ana = r.scene?.consumers.find((c) => c.id === "analytics-ingest");
  assert.ok(ana);
  assert.equal(readsAt(ana, 1e9).count, 0, "no read, no line");
  assert.deepEqual(glassFor(load("m1-xremove-v1-gate.json")), { clear: false, v: "V1", contracts: true });
  assert.equal(glassFor(load("m1-xrename-v0s0-break-repair.json")).clear, false);
});

test("diff cards come from the run's diff and stay up for CARD_MS", () => {
  const r = load("m1-xrename-v0s0-diffs.json");
  const cards = r.scene?.diff_cards ?? [];
  assert.deepEqual(cards.map((c) => c.session), ["gen", "fix1"]);
  assert.ok(cards[0].lines.some((l) => l.op === "+" && l.text.includes("amountCents")));
  assert.ok(cards[1].lines.some((l) => l.text.includes("@deprecated")));
  assert.equal(cardAt(r, cards[0].t_ms - 1), null);
  assert.equal(cardAt(r, cards[0].t_ms)?.session, "gen");
  assert.equal(cardAt(r, cards[1].t_ms)?.session, "fix1");
  assert.equal(cardAt(r, cards[1].t_ms + CARD_MS), null);
});

test("CI says it once: check, CI result, oracle and the CI-output message are quiet (no speech bubble)", () => {
  const r = load("m1-xrename-v0s0-break-repair.json");
  for (const s of r.steps) {
    if (s.action === "check" || s.action === "ci_result" || s.action === "oracle") assert.ok(quietStep(s));
  }
  const fb = r.steps.find((s) => (s.detail ?? {})["feedback"] === "ci_output");
  assert.ok(fb && quietStep(fb));
  const fail = r.steps.find((s) => s.key === "ci_fail");
  assert.equal(fail?.caption, "CI blocks the pull request: ARCH-4 failed (1 of 10 checks). Its output goes back to Code Agent · orders-service.");
});
