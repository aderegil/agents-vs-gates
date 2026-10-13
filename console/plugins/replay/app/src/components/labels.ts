// Plain words for the condition codes, as in the console (console/web/lib/labels.js, the source of truth): the code
// stays visible, the plain words say what it means.
export const PLAIN: Record<string, [string, string]> = {
  V0: ["Own repo", "The agent's workspace holds only its own repo (orders-service)."],
  V1: ["Own repo + contracts", "Its repo, plus the other teams' consumer contracts copied into it (CI checks them)."],
  V2: ["All four repos", "All four teams' repos are in its workspace."],
  S0: ["No rules", "Its spec is the ticket and the service README: nothing about architecture."],
  S1: ["Architecture prose", "The spec adds a prose description of the architecture, with no rule IDs and no consumers named."],
  S2: ["Rule in the spec", "The spec carries the rules ARCH-1…8, which name the consumers."],
  W2: ["Ticket asks not to break consumers", "The same rename, worded \"…without breaking existing consumers\"."],
};

export function plainCondition(c: { V?: string; S?: string; W?: string }): { text: string; title: string } {
  const codes = [c.V, c.S, c.W && c.W !== "W1" ? c.W : undefined].filter(Boolean) as string[];
  return {
    text: codes.map((k) => PLAIN[k]?.[0] ?? k).join(" · "),
    title: codes.map((k) => `${k}: ${PLAIN[k]?.[1] ?? k}`).join("\n"),
  };
}
