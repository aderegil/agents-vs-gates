// node --test console/plugins/teams/web/avatar.test.mjs
// avatar.js is GENERATED from console/plugins/replay/app/src/avatar-lib.ts (`npm run build` in that app). These checks
// fail when it is stale or hand-edited: it must paint the same pinned pixels as the theater's tests, and every Teams
// member must get its own portrait.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { agentFamily, emblemFor, portraitHash, renderAvatar, PORTRAIT_W, PORTRAIT_H } from "./avatar.js";

const DATA = new URL("../data/", import.meta.url);
const members = readdirSync(DATA).filter((f) => f.endsWith(".json")).flatMap((f) => {
  const m = JSON.parse(readFileSync(new URL(f, DATA), "utf8"));
  return m.members.map((x) => ({ ...x, model: m.id }));
});

test("avatar.js exports the shared avatar API", () => {
  for (const fn of [renderAvatar, portraitHash, agentFamily, emblemFor]) assert.equal(typeof fn, "function");
  assert.equal(PORTRAIT_W, 40);
  assert.equal(PORTRAIT_H, 48);
});

test("avatar.js paints the pinned pixels of the theater (it is up to date)", () => {
  assert.equal(portraitHash({ style: "human", seed: "architect", role: "architect" }), "ee4af653");
  assert.equal(portraitHash({ style: "agent", seed: "code-orders", role: "code_agent", badge: "Mock" }), "c089a702");
  assert.equal(portraitHash({ style: "agent", seed: "anthropic:claude-code", role: "code_agent", family: "anthropic" }), "1a543303");
});

test("every human and agent in the Teams data has a distinct portrait", () => {
  const people = members.filter((m) => m.actor_type !== "system");
  const hashes = people.map((m) => portraitHash({ style: m.actor_type, seed: m.seed, role: m.v21_role || m.role, family: m.model }));
  assert.equal(people.length, 67);
  assert.equal(new Set(hashes).size, people.length);
});
