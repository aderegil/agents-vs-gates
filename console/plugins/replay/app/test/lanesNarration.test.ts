// The lanes view with ?narration=1 (engine/lanesNarration.ts), round 2: A sentences come before their event, D
// sentences after their subject is on screen, one at a time, slow enough to read; the camera is there first.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { tokenState } from "../src/engine/lanes.ts";
import {
  CAM_MS, COLUMN_ZOOM, END_HOLD_MS, GAP_MS, MOVE_MS, SHOWN_MS, WATCH_MS, cameraTransform, narratedAt, narratedOpacity,
  phraseMs, timeline, type Narration,
} from "../src/engine/lanesNarration.ts";

const NAR = JSON.parse(readFileSync(new URL("../public/narration/lanes-neutral.json", import.meta.url), "utf8")) as Narration;
const AXIS = JSON.parse(readFileSync(new URL("../public/scenes/index.json", import.meta.url), "utf8")).axis as string[];
const TL = timeline(NAR, AXIS);
const cue = (n: number) => TL.cues.find((c) => c.n === n)!;
const gateTok = (t: number) => tokenState(narratedAt(t, TL, AXIS).frame, AXIS,
  { gate: true, outcomeAxis: "ci", outcome: "caught" }, true);

test("narration: every sentence long enough to read, one at a time, generic words", () => {
  assert.equal(TL.cues.length, 14);
  for (const [i, c] of TL.cues.entries()) {
    assert.ok(c.end - c.start >= Math.max(3000, (c.text.split(/\s+/).length / 1.8) * 1000 + 1000) - 1e-9, `sentence ${c.n}`);
    if (i > 0) assert.ok(c.start >= TL.cues[i - 1].end + GAP_MS - 1e-9, `gap before ${c.n}`);
    assert.doesNotMatch(c.text, /totalCents|placedAt|amountCents|createdAt|OrderPlaced|Meridian/);
  }
  assert.equal(phraseMs("Red. Rule ARCH-4 blocks the merge."), 4333.333333333333);
  assert.equal(NAR.subtitle, "One small change · a field that other teams read");
});

test("narration: an A sentence's event starts when it ends, then two seconds with an empty band", () => {
  for (const c of TL.cues.filter((x) => x.type === "A")) {
    assert.equal(c.action, c.end, `sentence ${c.n}`);
    const next = TL.cues[TL.cues.indexOf(c) + 1];
    if (next) assert.ok(next.start >= c.end + WATCH_MS - 1e-9, `quiet after ${c.n}`);
  }
  // the change reaches INTENT…CODE only after its sentence
  const spec = cue(3);
  assert.ok(narratedAt(spec.end - 1, TL, AXIS).frame.pos <= AXIS.indexOf("intent") + 1e-9);
  assert.equal(narratedAt(spec.end + MOVE_MS, TL, AXIS).frame.pos, AXIS.indexOf("spec"));
  // RELEASE then PRODUCTION after sentence 12
  const rel = cue(12);
  assert.ok(narratedAt(rel.end - 1, TL, AXIS).frame.pos <= AXIS.indexOf("ci") + 1e-9);
  assert.equal(narratedAt(rel.end + 2 * MOVE_MS, TL, AXIS).frame.pos, AXIS.indexOf("production"));
});

test("narration: red is on screen before 'Red.' and green before 'The agent fixes…'", () => {
  const red = cue(10), green = cue(11), ci = cue(9);
  assert.notEqual(gateTok(ci.end - 1), "fail");
  assert.ok(red.start - red.action >= SHOWN_MS - 1e-9);
  assert.equal(gateTok(red.start - SHOWN_MS), "fail");
  assert.equal(narratedAt(red.start - SHOWN_MS, TL, AXIS).gateFade, 1);
  assert.ok(green.start - green.action >= SHOWN_MS - 1e-9);
  assert.equal(gateTok(green.start - SHOWN_MS), "repaired");
  assert.equal(gateTok(TL.total), "repaired");
});

test("narration: the camera is in place before each sentence; the poster and the close are the whole table", () => {
  for (const c of TL.cues) {
    const a = narratedAt(c.start, TL, AXIS).camera, b = narratedAt(c.start - 1, TL, AXIS).camera;
    assert.deepEqual(a, b, `camera still at sentence ${c.n}`);
  }
  assert.equal(narratedAt(cue(7).start, TL, AXIS).camera.s, COLUMN_ZOOM);
  const first = narratedAt(0, TL, AXIS);
  assert.equal(first.frame.beat, "intro");
  assert.equal(first.caption.text, "");
  const last = narratedAt(TL.total, TL, AXIS);
  assert.equal(last.frame.beat, "final");
  assert.equal(last.caption.text, "");
  assert.deepEqual(last.camera, { s: 1, cx: 0.5, cy: 0.5 });
  assert.ok(TL.total - TL.cues.at(-1)!.end >= CAM_MS + END_HOLD_MS);
  assert.equal(narratedOpacity(last.frame, 4, { rule: false, ci: false }), 0.5);
  assert.equal(narratedOpacity(last.frame, 6, { rule: false, ci: true }), 1);
});

test("narration: the names stay on the left; the cut shows only when stops are out of view", () => {
  const view = { W: 1864, H: 745, left: 233 }, grid = { w: 1864, h: 596 };
  const wide = cameraTransform({ s: 1, cx: 0.5, cy: 0.5 }, view, grid);
  assert.equal(wide.tx, 0);
  assert.equal(wide.cut, 0);
  const atIntent = cameraTransform({ s: COLUMN_ZOOM, cx: 0.2, cy: 0.5 }, view, grid);
  assert.ok(Math.abs(atIntent.tx - (233 - COLUMN_ZOOM * 233)) < 1e-9);
  assert.equal(atIntent.cut, 0);
  const atCi = cameraTransform({ s: COLUMN_ZOOM, cx: 0.75, cy: 0.5 }, view, grid);
  assert.equal(atCi.cut, 1);
  assert.ok(atCi.tx >= view.W - COLUMN_ZOOM * grid.w - 1e-9);
});
