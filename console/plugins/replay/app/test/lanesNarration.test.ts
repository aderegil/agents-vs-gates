// The lanes view with ?narration=1 (engine/lanesNarration.ts): the sentences set the clock, the event of a moment
// never comes before the sentence before it is done, one sentence at a time.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { tokenState } from "../src/engine/lanes.ts";
import {
  COLUMN_ZOOM, GAP_MS, POSTER_MS, TAIL_MS, cameraTransform, narratedAt, narratedOpacity, phraseMs, timeline,
  type Narration,
} from "../src/engine/lanesNarration.ts";

const NAR = JSON.parse(readFileSync(new URL("../public/narration/lanes-neutral.json", import.meta.url), "utf8")) as Narration;
const AXIS = JSON.parse(readFileSync(new URL("../public/scenes/index.json", import.meta.url), "utf8")).axis as string[];
const TL = timeline(NAR);
const gateTok = (t: number) => tokenState(narratedAt(t, TL, AXIS).frame, AXIS,
  { gate: true, outcomeAxis: "ci", outcome: "caught" }, true);

test("narration: fourteen sentences, each long enough to read, one at a time with a gap", () => {
  assert.equal(TL.cues.length, 14);
  assert.equal(TL.cues[0].start, POSTER_MS);
  for (const [i, c] of TL.cues.entries()) {
    assert.ok(c.end - c.start >= Math.max(2500, (c.text.split(/\s+/).length / 2) * 1000 + 800) - 1e-9, `sentence ${c.n}`);
    if (i > 0) assert.equal(c.start, TL.cues[i - 1].end + GAP_MS);
  }
  assert.equal(TL.total, TL.cues.at(-1)!.end + TAIL_MS);
  assert.ok(phraseMs("Red. Rule ARCH-4 blocks the merge.", 3000) >= 3000);
});

test("narration: the poster frame is the still table with an empty band", () => {
  const f = narratedAt(POSTER_MS / 2, TL, AXIS);
  assert.equal(f.frame.beat, "intro");
  assert.equal(f.caption.text, "");
  assert.deepEqual(f.camera, { s: 1, cx: 0.5, cy: 0.5 });
  assert.equal(narratedOpacity(f.frame, 8, { rule: false, ci: false }), 0.9);
});

test("narration: CI turns red only when 'Now CI' is done, and green only when the red sentence is done", () => {
  const ci = TL.cues.find((c) => c.n === 9)!, red = TL.cues.find((c) => c.n === 10)!, green = TL.cues.find((c) => c.n === 11)!;
  assert.equal(narratedAt(ci.end - 1, TL, AXIS).frame.gate, "idle");
  assert.notEqual(gateTok(ci.end - 1), "fail");
  assert.equal(gateTok(red.start), "fail");
  assert.equal(gateTok(red.end - 1), "fail");
  assert.equal(gateTok(green.start), "repaired");
  assert.equal(gateTok(TL.total), "repaired");
});

test("narration: the lit column follows the sentence; past columns stay readable, the future is faint", () => {
  const plan = TL.cues.find((c) => c.n === 4)!;
  const f = narratedAt(plan.start + 50, TL, AXIS).frame;
  assert.equal(f.now, AXIS.indexOf("plan"));
  assert.equal(narratedOpacity(f, AXIS.indexOf("intent"), { rule: false, ci: false }), 0.85);
  assert.equal(narratedOpacity(f, AXIS.indexOf("ci"), { rule: false, ci: false }), 0.25);
  const rel = TL.cues.find((c) => c.n === 12)!;
  assert.equal(narratedAt(rel.start + 10, TL, AXIS).frame.now, AXIS.indexOf("release"));
  assert.equal(narratedAt(rel.end - 10, TL, AXIS).frame.now, AXIS.indexOf("production"));
});

test("narration: the camera zooms on the column, on the gate's CI cell, and shows the whole table at the end", () => {
  const code = TL.cues.find((c) => c.n === 7)!;
  assert.equal(narratedAt(code.start + 5000, TL, AXIS).camera.s, COLUMN_ZOOM);
  const red = TL.cues.find((c) => c.n === 10)!;
  assert.ok(narratedAt(red.start + 2000, TL, AXIS).camera.s > COLUMN_ZOOM);
  assert.equal(narratedAt(TL.total, TL, AXIS).camera.s, 1);
  assert.equal(narratedAt(TL.total, TL, AXIS).frame.beat, "ci");
  // the transform never shows past the grid's edge and centres a grid smaller than its view
  const tr = cameraTransform({ s: 1.35, cx: 0.95, cy: 0.5 }, { W: 1000, H: 500 }, { w: 1000, h: 370 });
  assert.equal(tr.tx, 1000 - 1350);
  assert.ok(Math.abs(tr.ty - (500 - 370 * 1.35) / 2) < 1e-9);
});
