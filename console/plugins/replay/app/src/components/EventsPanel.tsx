// Side panel: the real event sequence, with CI output, diff stats and full messages expandable (spec 22.5 item 6).
import { useEffect, useMemo, useRef, useState } from "react";
import { eventSteps, type Replay, type ReplayStep } from "../engine/replay";
import { fmt } from "./Timeline";

interface Props {
  replay: Replay;
  applied: number;
  follow: boolean;
  onSeek: (t: number) => void;
}

const ACTION_LABEL: Record<string, string> = {
  assign: "Assign", work: "Work", speak: "Message", handoff: "Hand-off", check: "Check", ci_result: "CI result",
  gate_touch: "Gate touched", oracle: "Oracle", phase: "Phase", move: "Move",
};

function tone(s: ReplayStep): string {
  const st = s.check?.status;
  if (s.action === "gate_touch") return "fail";
  if (st === "fail" || st === "error") return "fail";
  if (st === "pass" && (s.action === "ci_result" || s.action === "oracle")) return "pass";
  return "neutral";
}

function Detail({ s }: { s: ReplayStep }) {
  const d = (s.detail ?? {}) as Record<string, unknown>;
  const rows: [string, string][] = [];
  const add = (k: string, v: unknown) => {
    if (v === null || v === undefined || v === "") return;
    rows.push([k, typeof v === "object" ? JSON.stringify(v) : String(v)]);
  };
  add("Event", d["event_type"]);
  add("Trace seq", s.seq);
  add("Phase", d["phase"]);
  add("Real time", fmt(s.t_real_ms));
  if (s.check) add("Check", `${s.check.id ?? ""} ${s.check.status ?? ""}${s.check.rule ? ` (${s.check.rule})` : ""}`);
  add("Tool", d["tool_name"]);
  add("Status", d["status"]);
  add("Interaction", d["interaction_type"]);
  add("Detector", d["detector"]);
  add("Path", d["path"]);
  add("Oracle state", d["state"]);
  if (d["hidden_from_agent"]) add("Visibility", "hidden from the agent");
  if (d["contradicts_ci"]) add("Contradicts CI", "yes — CI passed");
  const diff = d["diff"] as { files_changed?: number; lines_added?: number; lines_removed?: number } | undefined;
  if (diff) add("Diff", `${diff.files_changed ?? "?"} files · +${diff.lines_added ?? 0} −${diff.lines_removed ?? 0}`);
  if (Array.isArray(d["failed_checks"])) add("Failed checks", (d["failed_checks"] as string[]).join(", ") || "none");
  const long = (d["output"] as string | undefined) ?? (d["content"] as string | undefined) ??
    (s.text && s.text.length > 120 ? s.text : null);
  return (
    <div className="event__detail">
      <dl>
        {rows.map(([k, v]) => (
          <div key={k} className="kv">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {long && <pre>{long}</pre>}
    </div>
  );
}

export function EventsPanel({ replay, applied, follow, onSeek }: Props) {
  const items = useMemo(() => eventSteps(replay), [replay]);
  const actors = useMemo(() => new Map(replay.actors.map((a) => [a.id, a.display_name])), [replay]);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const listRef = useRef<HTMLOListElement>(null);
  let current = -1;
  for (const it of items) if (it.index < applied) current = it.index;

  useEffect(() => {
    if (!follow || current < 0) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${current}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [current, follow]);

  return (
    <aside className="events" aria-label="Events">
      <div className="events__head">
        <span>Events</span>
        <span className="muted num">{items.length}</span>
      </div>
      <ol ref={listRef} className="events__list">
        {items.map(({ step: s, index }) => {
          const isOpen = open.has(index);
          return (
            <li key={index} data-index={index}
              className={`event tone-${tone(s)} ${index === current ? "is-current" : ""} ${index < applied ? "" : "is-future"}`}>
              <div className="event__row">
                <button type="button" className="event__time num" onClick={() => onSeek(s.t_ms)}
                  title="Jump to this event">{fmt(s.t_ms)}</button>
                <button type="button" className="event__main" onClick={() => onSeek(s.t_ms)}>
                  <span className="event__who">{actors.get(s.actor) ?? s.actor}</span>
                  <span className="event__what">{ACTION_LABEL[s.action] ?? s.action}</span>
                  {s.text && <span className="event__text">{s.text}</span>}
                </button>
                <button type="button" className="event__toggle" aria-expanded={isOpen}
                  aria-label={isOpen ? "Collapse details" : "Expand details"}
                  onClick={() => {
                    const n = new Set(open);
                    if (isOpen) n.delete(index);
                    else n.add(index);
                    setOpen(n);
                  }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
                    style={{ transform: isOpen ? "rotate(90deg)" : undefined }} aria-hidden="true">
                    <path d="m9 6 6 6-6 6" />
                  </svg>
                </button>
              </div>
              {isOpen && <Detail s={s} />}
            </li>
          );
        })}
      </ol>
    </aside>
  );
}
