// node --test for the director (presenter slides, director's cut, compare sync). Pure logic, synthetic replays plus
// the bundled demos. Runs the TypeScript source directly (Node 24 type stripping).
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import {
  Conductor, alignMoments, approachAt, approachDuration, buildCut, buildSync, conditionDiff, currentSlide,
  cutClock, cutTime, findReadRuns, makeTimebase, montageAt, momentLabel, nextSlide, prevSlide, slides, syncAt,
  syncFromA, syncMomentAt, trackEvents, type Cut,
} from "../src/engine/director.ts";
import { duration, stateAt, type Replay, type ReplayMarker, type ReplayStep } from "../src/engine/replay.ts";

const DEMO = new URL("../public/demo/", import.meta.url);
const load = (name: string): Replay => JSON.parse(readFileSync(new URL(name, DEMO), "utf8")) as Replay;
const demos = readdirSync(DEMO).filter((f) => f.endsWith(".json") && f !== "index.json");

function step(t: number, actor: string, action: ReplayStep["action"], extra: Partial<ReplayStep> = {}): ReplayStep {
  return { t_ms: t, t_real_ms: t, seq: t, actor, action, ...extra };
}

function meta(id: string, cond: Replay["meta"]["condition"], dur: number): Replay["meta"] {
  return {
    run_id: id, source: "mock", unit: "mock", date: "2026-10-11", ticket: "X-rename", condition: cond, outcome: null,
    ticket_done: null, trace_sha256: id, schema: "replay/1", legend: "SIMULATED (mock agent) — not a real run",
    duration_ms: dur,
  };
}

const PLACES: Replay["places"] = [
  { id: "desk-orders", label: "Checkout · orders", kind: "desk", x: 0.1, y: 0.5 },
  { id: "ci-tower", label: "CI Tower", kind: "system", x: 0.6, y: 0.5 },
];
const ACTORS: Replay["actors"] = [
  { id: "a", role: "code_agent", actor_type: "agent", display_name: "A",
    avatar: { style: "agent", seed: "a", badge: "Mock" }, home: "desk-orders" },
  { id: "ci", role: "ci", actor_type: "system", display_name: "CI",
    avatar: { style: "system", seed: "ci", badge: null }, home: "ci-tower" },
];

function tiny(): Replay {
  return {
    meta: meta("t-1", {}, 10_000),
    places: PLACES,
    actors: ACTORS,
    steps: [
      step(0, "a", "work", { text: "Read · a.ts" }),
      step(1000, "a", "handoff", { text: "PR t-1", key: "pr_opened" }),
      step(2000, "ci", "check", { detail: { run_attempt: 0 } }),
      step(3000, "ci", "ci_result", { check: { id: "attempt-0", status: "fail" } }),
      step(7000, "ci", "ci_result", { check: { id: "attempt-1", status: "pass" } }),
    ],
    markers: [
      { t_ms: 1000, label: "PR opened", kind: "pr_opened" },
      { t_ms: 3000, label: "CI failed: ARCH-4", kind: "ci_fail" },
      { t_ms: 7000, label: "CI passed", kind: "ci_pass" },
    ],
  };
}

function toolStep(t: number, tool: string, path: string, done: boolean): ReplayStep {
  return step(t, "a", "work", {
    text: done ? `${path} …` : `${tool} · ${path}`,
    detail: done
      ? { event_type: "TOOL_CALL_COMPLETED", tool_name: tool, status: "success", output_summary: `${path} …` }
      : { event_type: "TOOL_CALL_STARTED", tool_name: tool, input_summary: path },
  });
}

const FILES = ["src/core/events.ts", "test/app.test.ts", "src/core/order.ts", "src/api/orders.ts",
  "contracts/consumers/analytics-ingest.json", "src/core/events.ts"];

/**
 * A ~16-minute synthetic run (compressed replay time, every gap ≤ 3 s) made of work cycles: a thought, six reads
 * (Read/Grep), an edit and a test run; key moments spread over the run like a real break-and-repair.
 */
function longRun(minutes = 16): Replay {
  const end = minutes * 60_000;
  const steps: ReplayStep[] = [step(0, "flow", "phase", { detail: { to_phase: "implementation" } })];
  let t = 1000;
  steps.push(step(t, "flow", "assign", { text: "Rename the field" }));
  let cycle = 0;
  while (t < end - 30_000) {
    t += 2000;
    steps.push(step(t, "a", "speak", { text: "Looking around", detail: { thought: true } }));
    for (let i = 0; i < 6; i++) {
      const tool = i % 3 === 2 ? "Grep" : "Read";
      t += 2500;
      steps.push(toolStep(t, tool, FILES[(i + cycle) % FILES.length], false));
      t += 1500;
      steps.push(toolStep(t, tool, FILES[(i + cycle) % FILES.length], true));
    }
    t += 2000;
    steps.push(toolStep(t, "Edit", "src/core/events.ts", false));
    t += 1500;
    steps.push(toolStep(t, "Edit", "src/core/events.ts", true));
    t += 2000;
    steps.push(toolStep(t, "Bash", "npm test", false));
    t += 1500;
    steps.push(toolStep(t, "Bash", "npm test", true));
    cycle++;
  }
  steps.push(step(end - 1000, "flow", "phase", { text: "done" }));
  const at = (f: number) => steps[Math.round(f * (steps.length - 1))].t_ms;
  const markers: ReplayMarker[] = [
    { t_ms: 1000, label: "Task assigned: X-rename", kind: "task_assigned" },
    { t_ms: at(0.4), label: "PR opened · 2 files changed, +8 -8", kind: "pr_opened" },
    { t_ms: at(0.5), label: "CI failed: ARCH-4", kind: "ci_fail" },
    { t_ms: at(0.7), label: "Repair 1 pushed", kind: "repair" },
    { t_ms: at(0.8), label: "CI passed", kind: "ci_pass" },
    { t_ms: at(0.85), label: "Oracle (gen): 2 of 3 consumers fail", kind: "oracle" },
    { t_ms: at(0.9), label: "Oracle (final): all 3 consumers pass", kind: "oracle" },
    { t_ms: end - 1000, label: "End: fixed_code · ticket done", kind: "session_end" },
  ];
  return { meta: meta(`long-${minutes}`, { V: "V0", S: "S0", W: "W1" }, end), places: PLACES, actors: ACTORS, steps,
    markers };
}

function assertMonotonic(cut: Cut, label: string) {
  let prev = -Infinity;
  for (let p = 0; p <= cut.end; p += 37) {
    const r = cutClock(cut, p);
    assert.ok(r >= prev - 1e-6, `${label}: cutClock not monotonic at ${p}: ${r} < ${prev}`);
    prev = r;
  }
  assert.equal(cutClock(cut, cut.end), cut.sourceEnd, label);
  assert.equal(cutClock(cut, 0), 0, label);
  for (let i = 1; i < cut.segments.length; i++) {
    assert.equal(cut.segments[i].p0, cut.segments[i - 1].p1, `${label}: presentation gap at ${i}`);
    assert.equal(cut.segments[i].r0, cut.segments[i - 1].r1, `${label}: replay gap at ${i}`);
  }
}

// ------------------------------------------------------------------------------------------------ slides

test("slides: Start, every key moment in order, End; next / previous / current", () => {
  const s = slides(tiny());
  assert.deepEqual(s.map((x) => [x.t, x.label]), [
    [0, "Start"], [1000, "PR opened"], [3000, "CI failed: ARCH-4"], [7000, "CI passed"], [10_000, "End"],
  ]);
  assert.equal(s[2].tone, "fail");
  assert.equal(s[3].tone, "pass");
  assert.equal(nextSlide(s, 0), 1);
  assert.equal(nextSlide(s, 1000), 2);
  assert.equal(nextSlide(s, 2000), 2);
  assert.equal(nextSlide(s, 10_000), null);
  assert.equal(prevSlide(s, 3000), 1);
  assert.equal(prevSlide(s, 2000), 1); // mid-approach: back to where we came from
  assert.equal(prevSlide(s, 0), null);
  assert.equal(currentSlide(s, 0), 0);
  assert.equal(currentSlide(s, 2999.5), 2);
  assert.equal(currentSlide(s, 5000), 2);
});

test("slides: markers at the same time merge into one slide", () => {
  const r = tiny();
  r.markers.splice(2, 0, { t_ms: 3000, label: "Gate touched: D6", kind: "gate_touched" });
  const s = slides(r);
  assert.equal(s.length, 5);
  assert.equal(s[2].label, "CI failed: ARCH-4 · Gate touched: D6");
  for (const name of demos) {
    const d = slides(load(name));
    assert.equal(d[0].t, 0, name); // "Start", or the marker that sits at 0
    for (let i = 1; i < d.length; i++) assert.ok(d[i].t > d[i - 1].t, name);
  }
});

test("approach to the next moment takes ~2–4 s whatever the gap, and lands exactly", () => {
  assert.equal(approachDuration(0), 0);
  assert.equal(approachDuration(500), 1000);
  let prev = 0;
  for (const gap of [1000, 1500, 2000, 5000, 15_000, 60_000, 300_000, 900_000]) {
    const d = approachDuration(gap);
    assert.ok(d >= 2000 && d <= 4000, `gap ${gap}: ${d}`);
    assert.ok(d >= prev);
    prev = d;
  }
  assert.equal(approachAt(100, 900, 0, 2000), 100);
  assert.equal(approachAt(100, 900, 2000, 2000), 900);
  assert.equal(approachAt(100, 900, 9999, 2000), 900);

  const c = new Conductor(10_000);
  c.goTo(7000);
  assert.ok(c.moving && !c.playing);
  let frames = 0;
  while (c.approach) {
    c.tick(16);
    frames++;
  }
  const ms = frames * 16;
  assert.ok(ms >= approachDuration(7000) && ms < approachDuration(7000) + 16);
  assert.equal(c.p, 7000);
  assert.equal(c.moving, false); // pauses exactly at the moment
  c.goTo(1000); // behind: instant seek
  assert.equal(c.p, 1000);
  assert.equal(c.approach, null);
  c.speed = 2;
  c.play();
  c.tick(1000);
  assert.equal(c.p, 3000);
  c.tick(100_000);
  assert.equal(c.p, 10_000);
  assert.equal(c.playing, false);
});

// ------------------------------------------------------------------------------------------------ director's cut

test("read runs: ≥ 3 consecutive Read/Grep/Glob calls by one actor, broken by any other step", () => {
  const r = longRun(2);
  const runs = findReadRuns(trackEvents(r));
  assert.ok(runs.length >= 3);
  for (const run of runs) {
    assert.equal(run.events.filter((e) => e.started).length, 6);
    assert.ok(run.events.every((e) => e.readish && e.actor === "a"));
  }
  // two reads then an edit: no run
  const short = trackEvents({ ...r, steps: [toolStep(0, "Read", "x", false), toolStep(1, "Read", "y", false),
    toolStep(2, "Edit", "x", false), toolStep(3, "Read", "z", false)] });
  assert.equal(findReadRuns(short).length, 0);
});

test("director's cut of a 16-minute run lasts 60–90 s, keeps key moments at 1×, montages the reads", () => {
  const r = longRun(16);
  assert.ok(duration(r) >= 15 * 60_000);
  const cut = buildCut(r);
  assert.ok(cut.end >= 60_000 && cut.end <= 90_000, `cut ${cut.end}`);
  assert.ok(cut.factor > 1);
  assertMonotonic(cut, "long");
  for (const m of r.markers) {
    const p = cutTime(cut, m.t_ms);
    assert.equal(cutClock(cut, p), m.t_ms, m.label);
    // 1× around the moment
    const lo = Math.max(0, p - 1000);
    const hi = Math.min(cut.end, p + 1000);
    assert.ok(Math.abs(cutClock(cut, hi) - cutClock(cut, lo) - (hi - lo)) < 1e-3, `${m.label} not at 1×`);
  }
  const montages = cut.segments.filter((s) => s.kind === "montage");
  assert.ok(montages.length > 5, `montages: ${montages.length}`);
  for (const s of montages) {
    assert.ok(s.p1 - s.p0 <= 2000 + 1e-6 && s.p1 - s.p0 >= 800 - 1e-6, `montage ${s.p1 - s.p0} of ${montages.length}, factor ${cut.factor}, half ${cut.keyHalfMs}`);
    const m = montageAt(cut, (s.p0 + s.p1) / 2);
    assert.ok(m);
    assert.match(m.title, /^Montage · (\d+ (reads?|greps?)(, )?)+$/);
    // nothing invented: every path in the caption is an input_summary of the run
    for (const p of m.lines[0].replace(/, …$/, "").split(", ")) assert.ok(FILES.includes(p.replace(/…$/, "")), p);
    assert.ok(m.text.startsWith(`${m.title}: `));
  }
  assert.equal(montageAt(cut, 0), null);
  const first = montageAt(cut, (montages[0].p0 + montages[0].p1) / 2)!;
  assert.equal(first.title, "Montage · 4 reads, 2 greps");
});

test("director's cut is deterministic and within 60–90 s for 5–20 minute runs", () => {
  for (const minutes of [5, 10, 16, 20]) {
    const r = longRun(minutes);
    const a = buildCut(r);
    const b = buildCut(r);
    assert.deepEqual(a, b);
    assert.ok(a.end >= 60_000 && a.end <= 90_000, `${minutes} min → ${a.end}`);
    assertMonotonic(a, `${minutes} min`);
  }
});

test("short runs (< 90 s) are never stretched: the demos' cut is at most their own length", () => {
  for (const name of demos) {
    const r = load(name);
    if (duration(r) >= 90_000) continue; // the M2b sprint demo is long by nature
    const cut = buildCut(r);
    assert.ok(cut.end <= duration(r) + 1e-6, `${name}: ${cut.end} > ${duration(r)}`);
    assert.equal(cut.factor, 1, name);
    assertMonotonic(cut, name);
    for (let p = 0; p < cut.end; p += 500) {
      const t = cutClock(cut, p);
      assert.ok(t <= p + (duration(r) - cut.end) + 1e-6);
    }
  }
  // a short run with a long read run: only the montage shortens it
  const r = longRun(1.5);
  const cut = buildCut(r);
  assert.ok(cut.end < duration(r));
  assert.ok(cut.segments.every((s) => s.kind === "montage" || Math.abs((s.p1 - s.p0) - (s.r1 - s.r0)) < 1e-6));
});

test("cutTime inverts cutClock and the scene at a moment is the same through the cut", () => {
  const r = longRun(16);
  const cut = buildCut(r);
  for (let t = 0; t <= duration(r); t += 7919) {
    const p = cutTime(cut, t);
    const back = cutClock(cut, p);
    assert.ok(Math.abs(back - t) < 1e-3, `${t} → ${p} → ${back}`);
  }
  const ci = r.markers.find((m) => m.kind === "ci_fail")!;
  const tb = makeTimebase(r, null, { cut: true });
  const p = tb.slides.find((s) => s.label === ci.label)!.t;
  assert.deepEqual(stateAt(r, tb.at(p).a), stateAt(r, ci.t_ms));
});

// ------------------------------------------------------------------------------------------------ compare

test("alignment by kind and order: first CI result meets first CI result, extra moments are one-sided", () => {
  const a = load("m1-xrename-v0s0-break-repair.json"); // task, PR, CI fail, repair, CI pass, oracle ×2, end
  const b = load("m1-xrename-v0s2-additive.json"); // task, PR, CI pass, oracle ×2, end
  const pairs = alignMoments(a.markers, b.markers);
  const show = pairs.map((p) => `${p.a === null ? "-" : a.markers[p.a].kind}/${p.b === null ? "-" : b.markers[p.b].kind}`);
  assert.deepEqual(show, [
    "task_assigned/task_assigned", "pr_opened/pr_opened", "ci_fail/ci_pass", "repair/-", "ci_pass/-",
    "oracle/oracle", "oracle/oracle", "session_end/session_end",
  ]);
  // the other way round: B's extra moments are B-only
  const rev = alignMoments(b.markers, a.markers);
  assert.equal(rev.filter((p) => p.a === null).length, 2);
  // a moment kind missing on one side (gate touched) does not shift the rest
  const g = load("m1-xremove-v1-gate.json");
  const pg = alignMoments(g.markers, a.markers);
  assert.equal(pg.filter((p) => p.a !== null && p.b !== null).length, a.markers.length);
  assert.equal(pg.filter((p) => p.b === null).map((p) => g.markers[p.a!].kind).join(), "gate_touched");
});

test("compare sync: both runs reach every shared moment together; the side lacking a moment holds", () => {
  const a = load("m1-xrename-v0s0-break-repair.json");
  const b = load("m1-xrename-v0s2-additive.json");
  for (const [x, y] of [[a, b], [b, a]]) {
    const sync = buildSync(x, y);
    // monotonic, continuous, ends together
    let prev = { a: 0, b: 0 };
    for (let j = 0; j <= sync.end; j += 50) {
      const at = syncAt(sync, j);
      assert.ok(at.a >= prev.a - 1e-6 && at.b >= prev.b - 1e-6, `j ${j}`);
      prev = at;
    }
    assert.deepEqual(syncAt(sync, sync.end), { a: duration(x), b: duration(y) });
    for (const m of sync.moments) {
      const at = syncAt(sync, m.j);
      if (m.a) assert.equal(at.a, m.a.t_ms, m.a.label);
      if (m.b) assert.equal(at.b, m.b.t_ms, m.b.label);
    }
    // one-sided moments: the other side does not move around them
    for (const m of sync.moments.filter((mm) => !mm.a || !mm.b)) {
      const before = syncAt(sync, m.j - 1000);
      const after = syncAt(sync, m.j + 1000);
      if (m.a) assert.equal(after.b, before.b, `${m.a.label}: B should hold`);
      if (m.b) assert.equal(after.a, before.a, `${m.b.label}: A should hold`);
    }
    // seeking pane A lands on the first joint time that shows it
    for (const t of [0, 5000, 27_000, duration(x)]) assert.ok(Math.abs(syncAt(sync, syncFromA(sync, t)).a - t) < 1e-3);
  }
  const sync = buildSync(a, b);
  const ci = sync.moments.find((m) => m.a?.kind === "ci_fail")!;
  assert.equal(ci.b?.kind, "ci_pass");
  assert.equal(momentLabel(ci), "CI failed: ARCH-4  ↔  CI passed");
  assert.equal(momentLabel(syncMomentAt(sync, ci.j + 10)!), "CI failed: ARCH-4  ↔  CI passed");
  const repair = sync.moments.find((m) => m.a?.kind === "repair")!;
  assert.match(momentLabel(repair), /^Repair 1 pushed.*\(A only\)$/);
});

test("compare timebase: presenter slides and director's cut drive both panes", () => {
  const a = longRun(16);
  const b = longRun(10);
  b.markers = b.markers.filter((m) => m.kind !== "ci_fail" && m.kind !== "repair");
  const tb = makeTimebase(a, b, { cut: true });
  assert.ok(tb.end >= 60_000 && tb.end <= 90_000, `compare cut ${tb.end}`);
  let prev = { a: 0, b: 0 as number | null };
  for (let p = 0; p <= tb.end; p += 41) {
    const at = tb.at(p);
    assert.ok(at.a >= prev.a - 1e-6 && (at.b ?? 0) >= (prev.b ?? 0) - 1e-6, `p ${p}`);
    prev = at;
  }
  assert.deepEqual(tb.at(tb.end), { a: duration(a), b: duration(b) });
  // each slide lands both panes on their moment
  for (const s of tb.slides) {
    const m = tb.momentAt(s.t);
    if (s.kind !== "moment" || !m) continue;
    const at = tb.at(s.t);
    if (m.a) assert.equal(at.a, m.a.t_ms, s.label);
    if (m.b) assert.equal(at.b, m.b.t_ms, s.label);
  }
  // plain compare (no cut): A plays at 1× between shared moments
  const plain = makeTimebase(load("m1-xrename-v0s0-break-repair.json"), load("m1-xunits-v0s0-oracle.json"), { cut: false });
  assert.equal(plain.at(500).a, 500);
  assert.equal(plain.fromA(500), 500);
});

test("single timebase: identity without the cut, slides re-timed with it", () => {
  const r = load("m1-xremove-v1-gate.json");
  const plain = makeTimebase(r, null, { cut: false });
  assert.equal(plain.end, duration(r));
  assert.deepEqual(plain.at(1234), { a: 1234, b: null });
  assert.equal(plain.momentAt(36_500)?.a?.label, "CI failed: ARCH-4");
  const long = longRun(16);
  const cut = makeTimebase(long, null, { cut: true });
  assert.equal(cut.slides.length, slides(long).length);
  for (const s of cut.slides) assert.ok(s.t >= 0 && s.t <= cut.end);
});

test("condition diff highlights what differs between two runs", () => {
  const a = load("m1-xrename-v0s0-break-repair.json");
  const b = load("m1-xrename-v0s2-additive.json");
  const d = conditionDiff(a, b);
  assert.deepEqual(d.map((x) => [x.key, x.a, x.b, x.differs]), [
    ["ticket", "X-rename", "X-rename", false], ["V", "V0", "V0", false], ["S", "S0", "S2", true],
    ["W", "W1", "W1", false],
  ]);
  const g = conditionDiff(load("m1-xremove-v1-gate.json"), a);
  assert.deepEqual(g.filter((x) => x.differs).map((x) => x.key), ["ticket", "V"]);
});
