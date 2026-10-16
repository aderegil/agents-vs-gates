// node --test for the theater-1016 changes: focus dimming (what is not part of a beat loses light, and gets it back),
// the speech-bubble cap and fade, the 25% smaller avatars, the overlap rules of the QA sweep, and the compare
// lanes' timeline (the change, the gate's CI cell, the closing beats, the neutral variant).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { FOCUS_FADE_MS, FOCUS_MS, dimAmount, focusAlpha, focusAt, interactions } from "../src/engine/focus.ts";
import {
  COLUMN_MS, FINAL_MS, GATE_FAIL_MS, GATE_REPAIR_MS, MOVE_MS, RULE_BEAT_MS, cellOpacity, lanesAt, tokenState, totalMs,
} from "../src/engine/lanes.ts";
import { figureCollisions, textCollisions, type QaBox } from "../src/engine/overlap.ts";
import { BUBBLE_MS, type Bubble, type Replay } from "../src/engine/replay.ts";
import {
  ACTOR_W, ACTOR_W_V2, MAX_BUBBLES, bubbleAlpha, figureGridScale, shownBubbles,
} from "../src/engine/stagePolicy.ts";

const load = (rel: string): Replay => JSON.parse(readFileSync(new URL(`../public/${rel}`, import.meta.url), "utf8")) as Replay;
const gate = load("scenes/aisdlc-gate.json");

// ------------------------------------------------------------------------------------------------ focus
test("focus: during CI's verdict the tower is lit and the people who are not part of it are dimmed", () => {
  const verdict = gate.steps.find((s) => s.action === "ci_result")!;
  const t = verdict.t_ms + FOCUS_FADE_MS + 100;
  const f = focusAt(gate, t);
  assert.equal(f.level, 1);
  assert.equal(dimAmount(f, "place:ci-tower"), 0, "the tower is in the beat");
  assert.equal(dimAmount(f, "actor:ci"), 0);
  for (const other of ["actor:architect", "actor:release-manager", "place:product-desk", "place:desk-billing"]) {
    assert.equal(dimAmount(f, other), 1, `${other} is dimmed`);
    assert.ok(focusAlpha(f, other) < 0.5);
  }
});

test("focus: a handoff lights both ends (the agent and where the PR goes)", () => {
  const h = gate.steps.find((s) => s.action === "handoff")!;
  const f = focusAt(gate, h.t_ms + FOCUS_FADE_MS);
  assert.equal(dimAmount(f, `actor:${h.actor}`), 0);
  assert.equal(dimAmount(f, `place:${h.target}`), 0);
  assert.equal(dimAmount(f, "actor:architect"), 1);
});

test("focus: the light fades in and out (no flash) and the floor returns to normal when nothing happens", () => {
  const its = interactions(gate);
  assert.ok(its.length > 10);
  for (let i = 0; i + 1 < its.length; i++) {
    assert.ok(its[i].end <= its[i + 1].t + FOCUS_FADE_MS, "a beat hands over to the next one");
    assert.ok(its[i].end - its[i].t <= FOCUS_MS);
  }
  const first = its[0];
  assert.ok(focusAt(gate, first.t + FOCUS_FADE_MS / 2).level < 1, "fading in");
  // a quiet gap: after the last beat ends, nobody is dimmed
  const last = its[its.length - 1];
  const after = focusAt(gate, last.end + 1);
  assert.equal(after.level, 0);
  assert.equal(dimAmount(after, "actor:architect"), 0);
  assert.equal(focusAlpha(after, "actor:architect"), 1);
});

test("focus is a pure function of (replay, clock)", () => {
  for (let t = 0; t < 60_000; t += 333) {
    const a = focusAt(gate, t);
    const b = focusAt(gate, t);
    assert.equal(a.level, b.level);
    assert.deepEqual([...a.lit], [...b.lit]);
  }
});

// ------------------------------------------------------------------------------------------- bubbles
const bub = (at: number, seq = at): { bubble: Bubble } => ({ bubble: { text: `b${at}`, at, seq, tone: "neutral" } });

test("bubble cap: at most two at once, the newest ones, oldest first", () => {
  assert.equal(MAX_BUBBLES, 2);
  const shown = shownBubbles([bub(300), bub(100), bub(500), bub(400)]);
  assert.deepEqual(shown.map((b) => b.bubble.at), [400, 500]);
  assert.deepEqual(shownBubbles([bub(7)]).map((b) => b.bubble.at), [7]);
});

test("bubbles fade in and out; gone after BUBBLE_MS", () => {
  const b = bub(1000).bubble;
  assert.equal(bubbleAlpha(b, 999), 0);
  assert.ok(bubbleAlpha(b, 1050) > 0 && bubbleAlpha(b, 1050) < 1);
  assert.equal(bubbleAlpha(b, 1000 + BUBBLE_MS / 2), 1);
  assert.ok(bubbleAlpha(b, 1000 + BUBBLE_MS - 100) < 0.5);
  assert.equal(bubbleAlpha(b, 1000 + BUBBLE_MS), 0);
});

// ------------------------------------------------------------------------------------------- avatars
test("avatars are 25% smaller than Avatars v2 and stay crisp (whole device pixels per grid pixel)", () => {
  assert.equal(ACTOR_W_V2, 124);
  assert.equal(ACTOR_W, 93);
  // across the floor's depth and the usual devices, the drawn size averages about 75% of v2's
  let now = 0;
  let before = 0;
  for (const device of [1, 1.5, 2]) {
    for (let s = 0.7; s <= 1.0001; s += 0.05) {
      const k = figureGridScale(s, 1, device);
      assert.ok(Number.isInteger(k) && k >= 1);
      now += k;
      before += Math.max(1, Math.round((ACTOR_W_V2 * s * device) / 40));
    }
  }
  const ratio = now / before;
  assert.ok(ratio > 0.65 && ratio < 0.85, `drawn size ratio ${ratio.toFixed(2)}`);
});

// ------------------------------------------------------------------------------------------- overlap
test("overlap rules: text over text of different owners counts, a name over its own figure does not", () => {
  const boxes: QaBox[] = [
    { kind: "figure", owner: "actor:a", x: 0, y: 0, w: 60, h: 80 },
    { kind: "name", owner: "actor:a", x: 0, y: 60, w: 60, h: 16 },
    { kind: "label", owner: "place:p", x: 50, y: 70, w: 60, h: 16 },
    { kind: "bubble", owner: "actor:b", x: 10, y: 10, w: 40, h: 30 },
    { kind: "travel", x: 0, y: 0, w: 200, h: 200 },
  ];
  const tt = textCollisions(boxes);
  assert.equal(tt.length, 1);
  assert.deepEqual([tt[0].a.owner, tt[0].b.owner], ["actor:a", "place:p"]);
  const tf = figureCollisions(boxes);
  assert.deepEqual(tf.map((p) => p.a.owner), ["actor:b"], "the other actor's bubble covers the figure");
});

// ------------------------------------------------------------------------------------------- lanes
const AXIS = ["intent", "spec", "plan", "tasks", "code", "review", "ci", "release", "production"];

test("lanes: same total length as before (the deck's poster frame at 50 s is the closing board)", () => {
  assert.equal(totalMs(AXIS.length), AXIS.length * 4600 + 13000);
  assert.equal(FINAL_MS, 13000);
  assert.equal(lanesAt(50_000, AXIS.length).beat, "final");
  assert.equal(lanesAt(AXIS.length * COLUMN_MS + 100, AXIS.length).beat, "rule");
  assert.equal(lanesAt(AXIS.length * COLUMN_MS + RULE_BEAT_MS + 100, AXIS.length).beat, "ci");
});

test("lanes: the change moves one column per step, eased, and stops", () => {
  const n = AXIS.length;
  assert.equal(lanesAt(0, n).pos, 0);
  assert.equal(lanesAt(COLUMN_MS + MOVE_MS, n).pos, 1);
  const mid = lanesAt(COLUMN_MS + MOVE_MS / 2, n).pos;
  assert.ok(mid > 0 && mid < 1);
  assert.equal(lanesAt(totalMs(n), n).pos, n - 1);
  let prev = -1;
  for (let t = 0; t <= totalMs(n); t += 50) {
    const p = lanesAt(t, n).pos;
    assert.ok(p >= prev, "never goes back");
    prev = p;
  }
});

test("lanes: only the current column is fully lit; the closing beats light the rule cells, then CI", () => {
  const f = lanesAt(2 * COLUMN_MS + 10, AXIS.length);
  assert.equal(cellOpacity(f, 2, { rule: false, ci: false }), 1);
  assert.ok(cellOpacity(f, 1, { rule: false, ci: false }) < 1);
  assert.ok(cellOpacity(f, 5, { rule: false, ci: false }) <= 0.1);
  const rule = lanesAt(AXIS.length * COLUMN_MS + 10, AXIS.length);
  assert.equal(cellOpacity(rule, 2, { rule: true, ci: false }), 1);
  assert.ok(cellOpacity(rule, 4, { rule: false, ci: false }) < 0.5);
  const ci = lanesAt(AXIS.length * COLUMN_MS + RULE_BEAT_MS + 10, AXIS.length);
  assert.equal(cellOpacity(ci, 6, { rule: false, ci: true }), 1);
  assert.ok(cellOpacity(ci, 2, { rule: true, ci: false }) < 0.5);
  assert.equal(cellOpacity(lanesAt(50_000, AXIS.length), 3, { rule: false, ci: false }), 1);
});

test("lanes: in the gate lane the change fails ARCH-4 in CI, then comes back repaired", () => {
  const ci = AXIS.indexOf("ci");
  const lane = { gate: true, outcomeAxis: "ci", outcome: "caught" as const };
  const at = (t: number) => tokenState(lanesAt(t, AXIS.length), AXIS, lane, false);
  assert.equal(at(ci * COLUMN_MS - 1), "moving");
  assert.equal(at(ci * COLUMN_MS + MOVE_MS + GATE_FAIL_MS + 10), "fail");
  assert.equal(at(ci * COLUMN_MS + MOVE_MS + GATE_REPAIR_MS + 10), "repaired");
  assert.equal(at(50_000), "repaired");
  // the neutral variant keeps the gate lane's outcome
  assert.equal(tokenState(lanesAt(50_000, AXIS.length), AXIS, lane, true), "repaired");
});

test("lanes: vendor lanes show their scripted outcome, and no verdict at all in the neutral variant", () => {
  const esc = { gate: false, outcomeAxis: "production", outcome: "escapes" as const };
  const f = lanesAt(50_000, AXIS.length);
  assert.equal(tokenState(f, AXIS, esc, false), "escapes");
  assert.equal(tokenState(lanesAt(5 * COLUMN_MS, AXIS.length), AXIS, esc, false), "moving");
  for (let t = 0; t <= totalMs(AXIS.length); t += 500) {
    assert.equal(tokenState(lanesAt(t, AXIS.length), AXIS, esc, true), "neutral");
    assert.equal(tokenState(lanesAt(t, AXIS.length), AXIS, { ...esc, outcome: "caught", outcomeAxis: "review" }, true), "neutral");
  }
});

test("lanes component: neutral variant text stays honest (no per-vendor verdict words in the neutral path)", () => {
  const src = readFileSync(new URL("../src/components/ModelLanes.tsx", import.meta.url), "utf8");
  // the closing beats only claim what the scenes' data says: the rule is written down in every lane, only the gate
  // lane has a check in CI; "pipeline" is never used for the agentic workflow
  assert.match(src, /only the gate lane runs a check in CI/);
  assert.doesNotMatch(src, /pipeline/i);
});
