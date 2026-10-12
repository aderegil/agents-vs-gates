// node --test for engine/recast.ts and the v3 lifecycle scene: the sprint re-cast is the same run with another roster.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { canRecast, lifecycleLabel, recast, recastCitation, type TeamModel } from "../src/engine/recast.ts";
import type { Replay } from "../src/engine/replay.ts";
import { PACKET_MS, ownerView, ticketSheet, travels } from "../src/engine/scene.ts";

const PUB = new URL("../public/", import.meta.url);
const load = (name: string): Replay => JSON.parse(readFileSync(new URL(`demo/${name}`, PUB), "utf8")) as Replay;
const teams = (): TeamModel[] =>
  (JSON.parse(readFileSync(new URL("teams/index.json", PUB), "utf8")) as { models: TeamModel[] }).models;

test("only the simulated sprint can be re-cast; single-ticket runs say which lifecycle model they follow", () => {
  const sprint = load("m2b-sprint-f1.json");
  assert.ok(canRecast(sprint));
  const m1 = load("m1-xrename-v0s0-break-repair.json");
  assert.ok(!canRecast(m1));
  assert.equal(lifecycleLabel(m1), "Lifecycle model: Single-ticket harness (Agents vs. Gates)");
  assert.match(lifecycleLabel(sprint) ?? "", /^Lifecycle model: agents-vs-gates flow/);
});

test("re-cast keeps the run (steps, markers, scene) and only changes who plays each role", () => {
  const sprint = load("m2b-sprint-f1.json");
  for (const model of teams()) {
    const rc = recast(sprint, model);
    assert.deepEqual(rc.replay.steps, sprint.steps, model.id);
    assert.deepEqual(rc.replay.markers, sprint.markers, model.id);
    assert.deepEqual(rc.replay.scene, sprint.scene, model.id);
    assert.equal(rc.replay.meta.trace_sha256, sprint.meta.trace_sha256);
    assert.equal(rc.replay.meta.source, "mock", "a re-cast stays SIMULATED");
    for (const seat of rc.seats) {
      if (seat.member) assert.equal(seat.member.v21_role, seat.role, `${model.id}: ${seat.actor}`);
    }
    const missing = rc.replay.actors.filter((a) => a.recast_missing).map((a) => a.role);
    for (const role of missing) assert.ok(!model.members.some((m) => m.v21_role === role), `${model.id}: ${role}`);
    assert.match(lifecycleLabel(rc.replay) ?? "", /RE-CAST of the same simulated sprint — not a different run/);
    assert.ok(recastCitation(rc.replay)?.includes(model.name));
  }
  assert.deepEqual(recast(sprint, teams()[1]), recast(sprint, teams()[1]), "deterministic");
});

test("single-ticket DEFINE: the ticket sheet travels from Product when the task is assigned", () => {
  const r = load("m1-xrename-v0s0-break-repair.json");
  const sheet = ticketSheet(r);
  assert.ok(sheet);
  assert.equal(sheet.from, "product-desk");
  assert.equal(sheet.label, "ticket X-rename");
  assert.equal(sheet.t0, r.scene?.ticket_origin?.t_ms);
  assert.ok(travels(r).includes(sheet) || travels(r).some((t) => t.from === "product-desk"));
  assert.equal(ticketSheet(load("m2b-sprint-f1.json")), null, "the sprint has its own product people");
});

test("PRODUCTION impact: only the oracle's own words, only for failures", () => {
  const r = load("m1-xrename-v2-scope.json");
  const bill = r.scene?.consumers.find((c) => c.id === "billing-service");
  assert.ok(bill);
  const gen = bill.oracle["gen"];
  assert.equal(gen.status, "fail");
  const view = ownerView(r, bill, gen.t_ms + PACKET_MS);
  const msg = String(r.steps.find((s) => s.seq === gen.seq)?.detail?.["message"] ?? "");
  if (view.alert?.impact) assert.ok(msg.includes(view.alert.impact));
  const fin = ownerView(r, bill, bill.oracle["final"].t_ms + PACKET_MS);
  assert.equal(fin.alert?.impact, undefined);
});
