// node --test for the theater's pure logic (spec 24): clock, time compression, step application, markers, sync.
// Runs the TypeScript source directly (Node 24 type stripping; replay.ts uses erasable syntax only).
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import {
  ReplayEngine, SPEEDS, WALK_MS, applyStep, bubbleVisible, duration, initialState, markerTone, nextStepTime,
  prevStepTime, stateAt, stepsUntil, syncAnchors, syncClock, walkProgress, type Replay, type ReplayStep,
} from "../src/engine/replay.ts";

const DEMO = new URL("../public/demo/", import.meta.url);
const load = (name: string): Replay => JSON.parse(readFileSync(new URL(name, DEMO), "utf8")) as Replay;
const demos = readdirSync(DEMO).filter((f) => f.endsWith(".json") && f !== "index.json");
const breakRepair = () => load("m1-xrename-v0s0-break-repair.json");

function step(t: number, actor: string, action: ReplayStep["action"], extra: Partial<ReplayStep> = {}): ReplayStep {
  return { t_ms: t, t_real_ms: t, seq: t, actor, action, ...extra };
}

function tiny(): Replay {
  return {
    meta: {
      run_id: "t-1", source: "mock", unit: "mock", date: "2026-10-11", ticket: "X", condition: {}, outcome: null,
      ticket_done: null, trace_sha256: "x", schema: "replay/1", legend: "SIMULATED (mock agent) — not a real run",
      duration_ms: 10_000,
    },
    places: [
      { id: "desk-orders", label: "Checkout · orders", kind: "desk", x: 0.1, y: 0.5 },
      { id: "review-table", label: "Review table", kind: "room", x: 0.4, y: 0.5 },
      { id: "ci-tower", label: "CI Tower", kind: "system", x: 0.6, y: 0.5 },
    ],
    actors: [
      { id: "a", role: "code_agent", actor_type: "agent", display_name: "A",
        avatar: { style: "agent", seed: "a", badge: "Mock" }, home: "desk-orders" },
      { id: "ci", role: "ci", actor_type: "system", display_name: "CI",
        avatar: { style: "system", seed: "ci", badge: null }, home: "ci-tower" },
    ],
    steps: [
      step(0, "a", "work", { text: "Read · a.ts" }),
      step(1000, "a", "move", { place: "review-table" }),
      step(1000, "a", "handoff", { text: "PR t-1", key: "pr_opened" }),
      step(2000, "ci", "check", { detail: { run_attempt: 0 } }),
      step(2500, "ci", "check", { check: { id: "ARCH-4", status: "fail", rule: "ARCH-4" }, text: "ARCH-4 FAIL x" }),
      step(3000, "ci", "ci_result", { check: { id: "attempt-0", status: "fail" }, narration: "CI failed: ARCH-4" }),
      step(6000, "ci", "check", { detail: { run_attempt: 1 } }),
      step(6500, "ci", "check", { check: { id: "ARCH-4", status: "pass", rule: "ARCH-4" } }),
      step(7000, "ci", "ci_result", { check: { id: "attempt-1", status: "pass" } }),
    ],
    markers: [
      { t_ms: 1000, label: "PR opened", kind: "pr_opened" },
      { t_ms: 3000, label: "CI failed: ARCH-4", kind: "ci_fail" },
      { t_ms: 7000, label: "CI passed", kind: "ci_pass" },
    ],
  };
}

test("speeds are 0.5×, 1×, 2×, 5×, 10×, 20× (keys 1–6)", () => {
  assert.deepEqual([...SPEEDS], [0.5, 1, 2, 5, 10, 20]);
});

test("clock applies exactly the steps with t_ms <= clock", () => {
  const r = tiny();
  assert.equal(stepsUntil(r, -1), 0);
  assert.equal(stepsUntil(r, 0), 1);
  assert.equal(stepsUntil(r, 1000), 3);
  assert.equal(stepsUntil(r, 2999), 5);
  assert.equal(stepsUntil(r, 99_999), r.steps.length);
  const e = new ReplayEngine(r);
  e.play();
  e.advance(1500); // 1× → clock 1500
  assert.equal(e.clock, 1500);
  assert.equal(e.state.applied, 3);
  e.setSpeed(2);
  e.advance(1000); // 2× → +2000
  assert.equal(e.clock, 3500);
  assert.equal(e.state.ci.result, "fail");
  e.setSpeed(3); // not a preset: ignored
  assert.equal(e.speed, 2);
});

test("advance does nothing while paused and stops at the end", () => {
  const e = new ReplayEngine(tiny());
  assert.equal(e.advance(5000), false);
  assert.equal(e.clock, 0);
  e.play();
  e.setSpeed(20);
  e.advance(10_000);
  assert.equal(e.clock, e.end);
  assert.equal(e.playing, false);
  e.play(); // play at the end restarts from 0
  assert.equal(e.clock, 0);
});

test("seek back rebuilds from 0 and equals incremental playback (deterministic)", () => {
  for (const name of demos) {
    const r = load(name);
    const e = new ReplayEngine(r);
    e.play();
    e.setSpeed(1);
    let t = 0;
    while (e.playing) {
      e.advance(333);
      t += 333;
      if (t % 3996 === 0) {
        const fresh = stateAt(r, e.clock);
        assert.deepEqual(JSON.parse(JSON.stringify(e.state)), JSON.parse(JSON.stringify(fresh)), name);
      }
    }
    const mid = r.markers[2]?.t_ms ?? 1000;
    e.seek(mid);
    assert.deepEqual(JSON.parse(JSON.stringify(e.state)), JSON.parse(JSON.stringify(stateAt(r, mid))), name);
  }
});

test("step application: moves, CI lights, results, bubbles, narration", () => {
  const r = tiny();
  const s = initialState(r);
  r.steps.slice(0, 6).forEach((st, i) => applyStep(s, st, i));
  assert.equal(s.actors.a.place, "review-table");
  assert.equal(s.actors.a.from, "desk-orders");
  assert.equal(walkProgress(s.actors.a, 1000), 0);
  assert.equal(walkProgress(s.actors.a, 1000 + WALK_MS), 1);
  assert.deepEqual(s.ci.lights, { "ARCH-4": "fail" });
  assert.equal(s.ci.result, "fail");
  assert.equal(s.ci.running, false);
  assert.equal(s.narration?.text, "CI failed: ARCH-4");
  // CI speaks once, through its lights and the subtitle: no speech bubble on the tower (quietStep)
  assert.equal(s.actors.ci.bubble, null);
  assert.equal(s.actors.a.bubble?.text, "PR t-1");
  assert.ok(bubbleVisible(s.actors.a, 1500));
  assert.ok(!bubbleVisible(s.actors.a, 60_000));
  applyStep(s, r.steps[6], 6); // CI run 2 starts: lights reset, running
  assert.deepEqual(s.ci.lights, {});
  assert.equal(s.ci.running, true);
  assert.equal(s.ci.result, null);
});

test("next / previous event", () => {
  const r = tiny();
  assert.equal(nextStepTime(r, 0), 1000);
  assert.equal(nextStepTime(r, 1000), 2000);
  assert.equal(nextStepTime(r, 7000), null);
  assert.equal(prevStepTime(r, 3000), 2500);
  assert.equal(prevStepTime(r, 2700), 2000);
  assert.equal(prevStepTime(r, 0), 0);
  const e = new ReplayEngine(r);
  e.next();
  assert.equal(e.clock, 1000);
  e.next();
  e.next();
  assert.equal(e.clock, 2500);
  e.prev();
  assert.equal(e.clock, 2000);
  assert.equal(e.state.applied, 4);
});

test("exported demos: time compression (gaps > 3 s became 1.5 s) and 40–90 s at 1×", () => {
  for (const name of demos) {
    const r = load(name);
    const d = duration(r);
    // hand-made fixture stories last 40–90 s; snapshots of mock harness runs (with record.json) run faster
    const fromRun = (r.scene?.sources ?? []).includes("record.json");
    // the M2b sprint (a whole multi-role flow) is long by nature: no duration bound for it
    const sprint = r.scene?.lifecycle_model?.kind === "sprint";
    if (!sprint) assert.ok(fromRun ? d >= 10_000 && d <= 90_000 : d >= 40_000 && d <= 90_000, `${name}: ${d}`);
    for (let i = 1; i < r.steps.length; i++) {
      const gap = r.steps[i].t_ms - r.steps[i - 1].t_ms;
      const real = r.steps[i].t_real_ms - r.steps[i - 1].t_real_ms;
      assert.ok(gap >= 0 && gap <= 3000, `${name} step ${i}: gap ${gap}`);
      if (real > 3000) assert.equal(gap, 1500, `${name} step ${i}: real gap ${real}`);
      else assert.equal(gap, real, `${name} step ${i}`);
    }
  }
});

test("markers: sorted, tones (cyan pass, pink fail), and a mock legend", () => {
  for (const name of demos) {
    const r = load(name);
    const t = r.markers.map((m) => m.t_ms);
    assert.deepEqual(t, [...t].sort((a, b) => a - b));
    assert.equal(r.meta.legend, "SIMULATED (mock agent) — not a real run");
  }
  const r = breakRepair();
  const tones = Object.fromEntries(r.markers.map((m) => [m.label, markerTone(m)]));
  assert.equal(tones["CI failed: ARCH-4"], "fail");
  assert.equal(tones["CI passed"], "pass");
  assert.equal(tones["Oracle (gen): 2 of 3 consumers fail"], "fail");
  assert.equal(tones["Oracle (final): all 3 consumers pass"], "pass");
  // at the end the scene shows the last CI verdict and the final oracle state
  const end = stateAt(r, duration(r));
  assert.equal(end.ci.result, "pass");
  assert.equal(end.staging.state, "final");
  assert.ok(Object.values(end.staging.results).every((v) => v === "pass"));
});

test("compare view syncs two runs by key moment", () => {
  const a = breakRepair();
  const b = load("m1-xunits-v0s0-oracle.json");
  const anchors = syncAnchors(a, b);
  assert.deepEqual(anchors[0], [0, 0]);
  for (let i = 1; i < anchors.length; i++) {
    assert.ok(anchors[i][0] > anchors[i - 1][0] && anchors[i][1] > anchors[i - 1][1]);
  }
  const ta = a.markers.find((m) => m.kind === "pr_opened")!.t_ms;
  const tb = b.markers.find((m) => m.kind === "pr_opened")!.t_ms;
  assert.equal(syncClock(anchors, ta), tb);
  const ea = duration(a);
  assert.equal(Math.round(syncClock(anchors, ea)), duration(b));
  const mid = syncClock(anchors, ta / 2);
  assert.ok(mid > 0 && mid < tb);
});
