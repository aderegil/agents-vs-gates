// node --test for the avatar painters and floor poses (Avatars v2): determinism (same seed → identical pixels, also
// across processes via pinned hashes), variety (every Teams member looks different), agent identity (family and role
// change the portrait), and no hidden randomness.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { PORTRAIT_H, PORTRAIT_W, agentFamily, emblemFor, humanGroup, poseKey, type Pose } from "../src/engine/identity.ts";
import { lastCiResult, poseFor, REACT_MS } from "../src/engine/motion.ts";
import { portraitHash, portraitPixels, type PortraitSpec } from "../src/engine/portrait.ts";
import { initialState, stateAt, type ActorView, type Replay } from "../src/engine/replay.ts";

const TEAMS = new URL("../../../teams/data/", import.meta.url);
interface Member { actor_type: "human" | "agent" | "system"; seed: string; role: string; v21_role: string | null }
const models = readdirSync(TEAMS).filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(new URL(f, TEAMS), "utf8")) as { id: string; members: Member[] });
// the same spec the Teams plugin builds (role = v21 role or the source role, family = model id)
const specs = (type: "human" | "agent"): PortraitSpec[] => models.flatMap((m) => m.members
  .filter((x) => x.actor_type === type)
  .map((x) => ({ style: type, seed: x.seed, role: x.v21_role || x.role, family: m.id })));

test("a portrait is a 40×48 grid with pixels in it", () => {
  const g = portraitPixels({ style: "human", seed: "architect", role: "architect" });
  assert.equal(g.w, PORTRAIT_W);
  assert.equal(g.h, PORTRAIT_H);
  let opaque = 0;
  for (let i = 3; i < g.data.length; i += 4) if (g.data[i]) opaque++;
  assert.ok(opaque > 900, `only ${opaque} opaque pixels`);
});

test("same seed → identical pixel hash (every Teams member, every pose)", () => {
  const poses: Pose[] = [{}, { blink: true }, { mouth: "open" }, { typing: 1, look: "down" }, { typing: 2, look: "down" },
    { expression: "happy" }, { expression: "worried" }, { breath: 1 }, { look: "up" }];
  for (const s of [...specs("human"), ...specs("agent")]) {
    for (const p of poses) assert.equal(portraitHash(s, p), portraitHash({ ...s }, { ...p }), `${s.seed} ${poseKey(p)}`);
  }
});

// re-pinned in theater-1016: shorter, wider necks (human head 2 px lower, neck 8–9 px; agent neck 10 px)
test("pinned hashes: the same seed paints the same pixels in every process", () => {
  assert.equal(portraitHash({ style: "human", seed: "architect", role: "architect" }), "ee4af653");
  assert.equal(portraitHash({ style: "agent", seed: "code-orders", role: "code_agent", badge: "Mock" }), "c089a702");
  assert.equal(portraitHash({ style: "agent", seed: "anthropic:claude-code", role: "code_agent", family: "anthropic" }), "1a543303");
});

test("the 25 Teams humans are 25 different portraits", () => {
  const hs = specs("human");
  assert.equal(hs.length, 25);
  assert.equal(new Set(hs.map((s) => portraitHash(s))).size, hs.length);
});

test("the 42 Teams agents are 42 different portraits", () => {
  const as = specs("agent");
  assert.equal(as.length, 42);
  assert.equal(new Set(as.map((s) => portraitHash(s))).size, as.length);
});

test("an agent's role and its family each change the portrait", () => {
  const base: PortraitSpec = { style: "agent", seed: "agent-x", role: "review_agent", family: "aws" };
  const roles = ["review_agent", "security reviewer", "devops_agent", "spec", "verifier", "bug fix", "architect", "deploy-agent"];
  const byRole = roles.map((role) => portraitHash({ ...base, role }));
  assert.equal(new Set(byRole).size, roles.length, "roles with different emblems must differ");
  const fams = ["anthropic", "aws", "kiro", "ai-sdlc-io", "agents-vs-gates", "mock"];
  const byFamily = fams.map((family) => portraitHash({ ...base, family }));
  assert.equal(new Set(byFamily).size, fams.length, "families must differ");
});

test("role emblems follow the role", () => {
  const e = (seed: string, role?: string) => emblemFor({ seed, role });
  assert.equal(e("ai-sdlc-io:code-reviewer", "review_agent"), "magnifier");
  assert.equal(e("ai-sdlc-io:security-reviewer", "review_agent"), "shield");
  assert.equal(e("devops-agent", "devops_agent"), "gear");
  assert.equal(e("kiro:spec", "requirements_agent"), "document");
  assert.equal(e("verifier", "verifier"), "check");
  assert.equal(e("ai-sdlc-io:tester-agent", "verifier"), "check");
  assert.equal(e("kiro:bug-fix", "requirements_agent"), "wrench");
  assert.equal(e("aws:architect-agent", "architect"), "compass");
  assert.equal(e("ai-sdlc-io:deploy-agent", "devops_agent"), "rocket");
  assert.equal(e("code-orders", "code_agent"), "code");
});

test("agent family: explicit, seed prefix, model badge, default", () => {
  assert.equal(agentFamily({ seed: "x", family: "kiro" }), "kiro");
  assert.equal(agentFamily({ seed: "aws:product-agent" }), "aws");
  assert.equal(agentFamily({ seed: "ai-sdlc-io:code-agent" }), "aisdlc");
  assert.equal(agentFamily({ seed: "code-orders", badge: "Mock" }), "mock");
  assert.equal(agentFamily({ seed: "code-orders", badge: "Sonnet" }), "anthropic");
  assert.equal(agentFamily({ seed: "code-orders" }), "avg");
});

test("human clothing group follows the role", () => {
  assert.equal(humanGroup({ seed: "anthropic:engineer", role: "engineer" }), "dev");
  assert.equal(humanGroup({ seed: "aws:architects", role: "architect" }), "architect");
  assert.equal(humanGroup({ seed: "release-manager", role: "release_manager" }), "ops");
  assert.equal(humanGroup({ seed: "anthropic:security-lead", role: "policy_owner" }), "governance");
  assert.equal(humanGroup({ seed: "product-owner", role: "product_owner" }), "product");
  assert.equal(humanGroup({ seed: "tech-lead", role: "tech_lead" }), "lead");
});

test("painting never calls Math.random", () => {
  const original = Math.random;
  Math.random = () => { throw new Error("Math.random used"); };
  try {
    for (const s of [...specs("human").slice(0, 5), ...specs("agent").slice(0, 5)]) portraitPixels(s, { typing: 1 });
  } finally {
    Math.random = original;
  }
});

test("pose frames differ from the neutral portrait", () => {
  for (const s of [{ style: "human", seed: "architect" }, { style: "agent", seed: "code-orders", badge: "Mock" }] as PortraitSpec[]) {
    const n = portraitHash(s);
    for (const p of [{ blink: true }, { mouth: "open" }, { typing: 1 }, { expression: "happy" }, { expression: "worried" }, { breath: 1 }] as Pose[]) {
      assert.notEqual(portraitHash(s, p), n, `${s.seed} ${poseKey(p)}`);
    }
    assert.notEqual(portraitHash(s, { typing: 1 }), portraitHash(s, { typing: 2 }), "typing alternates hands");
  }
});

// ------------------------------------------------------------------------------------------- floor poses
function view(extra: Partial<ActorView> = {}): ActorView {
  return { place: "desk", from: "desk", movedAt: -Infinity, bubble: null, activeAt: -Infinity, gateMark: null, ...extra };
}

test("poses are a pure function of (id, view, clock): same input, same pose", () => {
  for (let t = 0; t < 20_000; t += 137) {
    assert.deepEqual(poseFor("code-orders", view(), t, false, null), poseFor("code-orders", view(), t, false, null));
  }
});

test("idle characters breathe and blink; typing while working; mouth moves while talking", () => {
  const breaths = new Set<number | undefined>();
  let blinks = 0;
  for (let t = 0; t < 10_000; t += 20) {
    const p = poseFor("architect", view(), t, false, null);
    breaths.add(p.breath);
    if (p.blink) blinks++;
  }
  assert.deepEqual([...breaths].sort(), [0, 1]);
  assert.ok(blinks > 0 && blinks < 40, `blinks ${blinks}`);
  const working = poseFor("a", view({ bubble: { text: "Edit · a.ts", at: 1000, seq: 1, tone: "code" }, activeAt: 1000 }), 1200, false, null);
  assert.ok(working.typing === 1 || working.typing === 2);
  const talking = new Set<string | undefined>();
  for (let t = 1000; t < 1800; t += 40) {
    talking.add(poseFor("a", view({ bubble: { text: "I'll look at the event.", at: 1000, seq: 1, tone: "neutral" } }), t, false, null).mouth);
  }
  assert.ok(talking.has("open") && talking.has("closed"));
  assert.equal(poseFor("a", view(), 500, true, null).typing, undefined, "no typing while walking");
});

test("characters react to the latest CI verdict for REACT_MS", () => {
  const replay = JSON.parse(readFileSync(new URL("../public/demo/m1-xrename-v0s0-break-repair.json", import.meta.url), "utf8")) as Replay;
  const fail = replay.markers.find((m) => m.kind === "ci_fail")!;
  const pass = replay.markers.find((m) => m.kind === "ci_pass")!;
  const at = (t: number) => lastCiResult({ replay, state: stateAt(replay, t) });
  assert.equal(lastCiResult({ replay, state: initialState(replay) }), null);
  assert.deepEqual(at(fail.t_ms + 10), { at: fail.t_ms, result: "fail" });
  assert.deepEqual(at(pass.t_ms + 10), { at: pass.t_ms, result: "pass" });
  assert.equal(poseFor("x", view(), fail.t_ms + 100, false, at(fail.t_ms + 100)).expression, "worried");
  assert.equal(poseFor("x", view(), pass.t_ms + 100, false, at(pass.t_ms + 100)).expression, "happy");
  assert.equal(poseFor("x", view(), fail.t_ms + REACT_MS + 1, false, at(fail.t_ms + REACT_MS + 1)).expression, undefined);
});
