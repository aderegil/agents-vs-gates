// Plain words for the experiment's codes. The one label map is console/web/lib/labels.js (shared with the console
// plugins and the video cards); this file re-exports it and adds the theater's helpers. In the theater nothing on
// screen shows a code (X-rename, V0·S0, P1, p1-0002…): plain words only. Codes stay in the data and in tooltips.
import {
  conditionTitle, plainCondition, plainText, runName, stageLabel, ticketLabel,
} from "../../../../../web/lib/labels.js";
import type { Replay } from "../engine/replay.ts";

export * from "../../../../../web/lib/labels.js";

type Cond = { V?: string | null; S?: string | null; W?: string | null } | null | undefined;

/** Words for a run's condition ("Own repo · No rule"), with the long meaning for a title attribute. */
export function plainConditionOf(c: Cond): { text: string; title: string } {
  return { text: plainCondition(c?.V, c?.S, c?.W), title: conditionTitle(c?.V, c?.S, c?.W) };
}

/** "Rename two fields · Own repo · No rule": what a run is, in words (no run id, no codes). */
export function runHeadline(m: { ticket?: string | null; condition?: Cond; run_id?: string }): string {
  const cond = plainCondition(m.condition?.V, m.condition?.S, m.condition?.W);
  const what = m.ticket ? ticketLabel(m.ticket) : runName(m.run_id);
  return [what, cond].filter(Boolean).join(" · ");
}

/** Where a run comes from, in words: "Main test · run 2" (the stage's name when the id is not a run id). */
export function runSource(m: { run_id?: string; stage?: unknown }): string {
  const named = runName(m.run_id);
  if (named !== (m.run_id ?? "")) return named;
  return stageLabel(typeof m.stage === "string" ? m.stage : null) || named;
}

// detail fields the events panel prints as text
const DETAIL_TEXT = ["content", "output", "input_summary", "output_summary"] as const;

/**
 * The same replay with every piece of free text that reaches the screen in plain words: step text, subtitles,
 * marker labels, the title, the context sheet, the ticket's origin label and the text fields of the events panel.
 * Codes kept as data (meta.ticket, meta.condition, scene.spec, detail.detector…) stay: the engine and the tests read
 * them.
 */
export function plainReplay(r: Replay): Replay {
  const scene = r.scene ? { ...r.scene } : r.scene;
  if (scene?.context) scene.context = { ...scene.context, summary: plainText(scene.context.summary) };
  if (scene?.ticket_origin) {
    scene.ticket_origin = { ...scene.ticket_origin, label: plainText(scene.ticket_origin.label),
      title: plainText(scene.ticket_origin.title) };
  }
  return {
    ...r,
    meta: { ...r.meta, title: plainText(r.meta["title"] as string | undefined) },
    places: r.places.map((p) => ({ ...p, label: plainText(p.label), note: plainText(p.note) })),
    steps: r.steps.map((s) => {
      const out = { ...s, text: plainText(s.text), narration: plainText(s.narration) };
      if (s.caption !== undefined) out.caption = plainText(s.caption);
      if (s.detail) {
        const d = { ...s.detail };
        for (const k of DETAIL_TEXT) if (typeof d[k] === "string") d[k] = plainText(d[k] as string);
        out.detail = d;
      }
      return out;
    }),
    markers: r.markers.map((m) => ({ ...m, label: plainText(m.label) })),
    scene,
  };
}
