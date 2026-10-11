// Who an avatar is, read from its spec: the AI family (vendor / model line) of an agent, the emblem its role earns,
// the clothing group of a human, and the pose a frame is drawn in. Pure and deterministic.

export const PORTRAIT_W = 40;
export const PORTRAIT_H = 48;

export type AgentFamily = "anthropic" | "aws" | "kiro" | "aisdlc" | "avg" | "mock";

export type Emblem =
  | "wrench" | "shield" | "rocket" | "pulse" | "gear" | "check" | "magnifier" | "compass" | "setsquare" | "document"
  | "clipboard" | "book" | "scissors" | "nodes" | "code" | "chip";

export type HumanGroup = "dev" | "lead" | "product" | "architect" | "ops" | "governance";

/** One animation frame. Everything defaults to the neutral gallery portrait. */
export interface Pose {
  blink?: boolean;
  /** talking: the mouth alternates closed/open */
  mouth?: "closed" | "open";
  expression?: "neutral" | "happy" | "worried";
  look?: "ahead" | "down" | "up";
  /** typing at a keyboard: 0 none, 1 and 2 alternate hand positions */
  typing?: 0 | 1 | 2;
  /** idle breathing: 1 lifts the head one pixel */
  breath?: 0 | 1;
}

export function poseKey(p: Pose | undefined): string {
  if (!p) return "n";
  return [p.blink ? "b" : "", p.mouth === "open" ? "o" : "", p.expression ?? "", p.look ?? "", p.typing ?? 0,
    p.breath ?? 0].join(".");
}

export interface IdentitySpec {
  seed: string;
  role?: string | null;
  badge?: string | null;
  family?: string | null;
}

const FAMILY_ALIASES: Record<string, AgentFamily> = {
  anthropic: "anthropic", claude: "anthropic",
  aws: "aws", "aws-ai-dlc": "aws",
  kiro: "kiro",
  "ai-sdlc-io": "aisdlc", "ai-sdlc.io": "aisdlc", aisdlc: "aisdlc",
  "agents-vs-gates": "avg", avg: "avg",
  mock: "mock",
};

/**
 * The agent's family: explicit `family`, else the model id prefix of the seed ("aws:product-agent"), else the model
 * badge ("Mock" → mock, a Claude model → anthropic), else the experiment's own look ("avg").
 */
export function agentFamily(spec: IdentitySpec): AgentFamily {
  const explicit = (spec.family ?? "").toLowerCase().trim();
  if (FAMILY_ALIASES[explicit]) return FAMILY_ALIASES[explicit];
  const prefix = spec.seed.includes(":") ? spec.seed.split(":")[0].toLowerCase() : "";
  if (FAMILY_ALIASES[prefix]) return FAMILY_ALIASES[prefix];
  const badge = (spec.badge ?? "").toLowerCase();
  if (badge.includes("mock")) return "mock";
  if (/claude|opus|sonnet|haiku|fable/.test(badge)) return "anthropic";
  return "avg";
}

/** Lower-case words from the role and the seed's own name ("ai-sdlc-io:test-reviewer" → "test reviewer"). */
export function roleText(spec: IdentitySpec): string {
  const name = spec.seed.includes(":") ? spec.seed.slice(spec.seed.indexOf(":") + 1) : spec.seed;
  return `${name} ${spec.role ?? ""}`.toLowerCase().replace(/[_\-·/()'.]+/g, " ").replace(/\s+/g, " ").trim();
}

const EMBLEM_RULES: [RegExp, Emblem][] = [
  [/\bbug\b|\bfix\b/, "wrench"],
  [/secur|secops|complian|polic|guard/, "shield"],
  [/deploy|pipeline|release/, "rocket"],
  [/monitor|operations|observ|on call|incident/, "pulse"],
  [/devops|platform|infra|\bops\b/, "gear"],
  [/test|verif|quality|\bqa\b/, "check"],
  [/review/, "magnifier"],
  [/architect/, "compass"],
  [/design/, "setsquare"],
  [/spec|requirement|product|intent/, "document"],
  [/plan|task|delivery/, "clipboard"],
  [/research|context|gather/, "book"],
  [/simplif|refactor/, "scissors"],
  [/compos|supervis|orchestr|lead|coordinat/, "nodes"],
  [/general|default|custom/, "chip"],
  [/code|develop|coding|engineer/, "code"],
];

export function emblemFor(spec: IdentitySpec): Emblem {
  const t = roleText(spec);
  for (const [re, e] of EMBLEM_RULES) if (re.test(t)) return e;
  return "chip";
}

const GROUP_RULES: [RegExp, HumanGroup][] = [
  [/secur|polic|complian|govern/, "governance"],
  [/release|operator|on call|service owner|\bops\b|sre/, "ops"],
  [/architect/, "architect"],
  [/product|originator|owner|manager/, "product"],
  [/lead|platform|manager|code owner/, "lead"],
  [/engineer|develop|dev/, "dev"],
];

export function humanGroup(spec: IdentitySpec): HumanGroup {
  const t = roleText(spec);
  if (/code owner|tech lead|engineering manager|platform/.test(t)) return "lead";
  for (const [re, g] of GROUP_RULES) if (re.test(t)) return g;
  return "dev";
}
