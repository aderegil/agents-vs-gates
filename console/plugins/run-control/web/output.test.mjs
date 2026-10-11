import test from "node:test";
import assert from "node:assert/strict";
import { lineKind } from "./model.js";

test("runner output lines get a kind", () => {
  assert.equal(lineKind("=== 2026-10-11T17:46:37+00:00 spawn: python -m harness.runner --calibrate"), "spawn");
  assert.equal(lineKind("p0-0005  started  X-rename V0·S2·W1  worker 1"), "start");
  assert.equal(lineKind("  p0-0005 [gen] Read src\core\events.ts"), "tool");
  assert.equal(lineKind("  p0-0005 [fix1] says: CI failed, I will keep the old field"), "say");
  assert.equal(lineKind("  p0-0005 [gen]   -> denied"), "fail");
  assert.equal(lineKind("p0-0005  turns=9  duration=151s  tokens=2,319"), "done");
  assert.equal(lineKind("p1-0003  infrastructure failure (rate_limit)"), "warn");
  assert.equal(lineKind("stopped: usage limit until 14:00"), "warn");
  assert.equal(lineKind("P0: 5 runs; per run avg tokens 2,700"), "");
});
