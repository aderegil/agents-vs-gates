import test from "node:test";
import assert from "node:assert/strict";
import { fmtElapsed, fmtCompact, cellLabel, cellKeyLabel, stageBadges, outcomeEntries, launchBody, validAmount, reasonFor, hhmm } from "./model.js";

test("fmtElapsed", () => {
  assert.equal(fmtElapsed(0), "0:00");
  assert.equal(fmtElapsed(125), "2:05");
  assert.equal(fmtElapsed(3725), "1:02:05");
  assert.equal(fmtElapsed(null), "—");
  assert.equal(fmtElapsed(-4), "0:00");
});

test("fmtCompact", () => {
  assert.equal(fmtCompact(800), "800");
  assert.equal(fmtCompact(52300), "52.3k");
  assert.equal(fmtCompact(1234567), "1.23M");
  assert.equal(fmtCompact(undefined), "—");
});

test("cell labels", () => {
  assert.equal(cellLabel({ ticket: "X-rename", visibility: "V0", spec: "S0", wording: "W1" }), "X-rename V0·S0·W1");
  assert.equal(cellLabel({ ticket: "X-rename", visibility: "V0", spec: "S0", wording: "W1", control: true }), "X-rename V0·S0·W1 control");
  assert.equal(cellKeyLabel("X-remove|V1|S0|W1|cc-sonnet"), "X-remove V1·S0·W1 cc-sonnet");
  assert.equal(cellKeyLabel(null), "—");
});

test("stage badges", () => {
  assert.deepEqual(stageBadges({ status: "running", in_manifest: true, blinding: "blinded" }), [["Running", "accent"], ["Blinded", "neutral"]]);
  assert.deepEqual(stageBadges({ status: "complete", in_manifest: true, blinding: "unblinded" }), [["Complete", "neutral"], ["Unblinded", "accent"]]);
  assert.deepEqual(stageBadges({ status: "not_in_manifest", in_manifest: false }), [["Not in manifest", "neutral"]]);
});

test("outcome entries sort by count then name", () => {
  assert.deepEqual(outcomeEntries({ b: 1, a: 1, c: 5 }), [["c", 5], ["a", 1], ["b", 1]]);
  assert.deepEqual(outcomeEntries(null), []);
});

test("launch body", () => {
  assert.deepEqual(launchBody({ stage: "P1", mode: "runs", amount: "8", workers: "2", unit: "" }), { workers: 2, stage: "P1", batch: 8 });
  assert.deepEqual(launchBody({ stage: "P1", mode: "minutes", amount: "20", workers: 1, unit: "cc-sonnet" }), { workers: 1, stage: "P1", max_minutes: 20, unit: "cc-sonnet" });
  assert.deepEqual(launchBody({ stage: "P1", mode: "runs", amount: "8", workers: 3 }, { calibrate: true }), { workers: 3, calibrate: true });
});

test("amount validation", () => {
  assert.ok(validAmount({ mode: "runs", amount: "8" }));
  assert.ok(!validAmount({ mode: "runs", amount: "8.5" }));
  assert.ok(!validAmount({ mode: "runs", amount: "0" }));
  assert.ok(!validAmount({ mode: "runs", amount: "5000" }));
  assert.ok(validAmount({ mode: "minutes", amount: "12.5" }));
  assert.ok(!validAmount({ mode: "minutes", amount: "" }));
});

test("button reasons", () => {
  const ok = { alive: false, guardReasons: [], stageRunnable: true, amountOk: true };
  assert.equal(reasonFor("batch", ok), null);
  assert.equal(reasonFor("batch", { ...ok, alive: true }), "A runner is already running");
  assert.equal(reasonFor("batch", { ...ok, guardReasons: ["Live smoke test not approved"] }), "Live smoke test not approved");
  assert.equal(reasonFor("stop", ok), "No runner is running");
  assert.equal(reasonFor("stop", { ...ok, alive: true }), null);
  assert.equal(reasonFor("dry", { ...ok, guardReasons: ["x"] }), null, "a dry run is always allowed");
  assert.equal(reasonFor("batch", { ...ok, stageRunnable: false }), "This stage is not run as a batch");
  assert.equal(reasonFor("batch", { ...ok, canWrite: false }), "Your role cannot launch runs");
  assert.equal(reasonFor("batch", { ...ok, amountOk: false }), "Enter a number of runs or minutes");
  assert.equal(reasonFor("calibrate", { ...ok, amountOk: false }), null);
});

test("hhmm is local time", () => {
  const d = new Date(2026, 9, 11, 14, 5);
  assert.equal(hhmm(d.toISOString()), "14:05");
  assert.equal(hhmm(null), "");
});
