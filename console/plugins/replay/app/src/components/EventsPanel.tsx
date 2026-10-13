// Side panel: the real event sequence, with CI output, diff stats and full messages expandable (spec 22.5 item 6).
// It follows the stage: the current event is scrolled into view, highlighted and expanded (file, command, CI line,
// message) while it is current; the previous one folds back to one line. Scrolling the list by hand pauses the
// follow; "Follow" resumes it. Clicking an event seeks the stage there (and follows again).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { eventSteps, type Replay, type ReplayStep } from "../engine/replay";
import { fmt } from "./Timeline";

interface Props {
  replay: Replay;
  applied: number;
  /** the stage is playing (smooth scrolling); paused steps and seeks jump */
  playing: boolean;
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

function rowsOf(s: ReplayStep): [string, string][] {
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
  return rows;
}

/** The long text of a step: CI output, message content, or the step text when it is too long for the row. */
function longOf(s: ReplayStep, min = 120): string | null {
  const d = (s.detail ?? {}) as Record<string, unknown>;
  return (d["output"] as string | undefined) ?? (d["content"] as string | undefined) ??
    (d["input_summary"] as string | undefined) ?? (s.text && s.text.length > min ? s.text : null);
}

/** Everything about the step (manual expand). */
function Detail({ s }: { s: ReplayStep }) {
  const rows = rowsOf(s);
  const long = longOf(s);
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

/** What matters about the current step while the stage plays it: the file, command, CI line or message in full. */
function Current({ s }: { s: ReplayStep }) {
  const keep = new Set(["Tool", "Path", "Check", "Detector", "Diff", "Failed checks", "Visibility", "Contradicts CI",
    "Oracle state"]);
  const rows = rowsOf(s).filter(([k]) => keep.has(k));
  const full = longOf(s, 0);
  // the row already shows the step text (unclamped while current); add only what it does not say
  const long = full && full !== s.text ? full : null;
  if (!rows.length && !long) return null;
  return (
    <div className="event__detail event__detail--current">
      {rows.length > 0 && (
        <dl>
          {rows.map(([k, v]) => (
            <div key={k} className="kv">
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {long && <pre>{long}</pre>}
    </div>
  );
}

export function EventsPanel({ replay, applied, playing, onSeek }: Props) {
  const items = useMemo(() => eventSteps(replay), [replay]);
  const actors = useMemo(() => new Map(replay.actors.map((a) => [a.id, a.display_name])), [replay]);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [following, setFollowing] = useState(true);
  const listRef = useRef<HTMLOListElement>(null);
  /** scroll position we set ourselves (so our own scrolling does not count as the user's) */
  const ownScroll = useRef<{ until: number; top: number } | null>(null);
  const lastCurrent = useRef(-1);
  let current = -1;
  for (const it of items) if (it.index < applied) current = it.index;

  const scrollToCurrent = useCallback((smooth: boolean) => {
    const list = listRef.current;
    const el = list?.querySelector<HTMLElement>(`[data-index="${current}"]`);
    if (!list || !el) {
      if (list && current < 0) {
        ownScroll.current = { until: performance.now() + 600, top: 0 };
        list.scrollTo({ top: 0 });
      }
      return;
    }
    // keep the current event about a third of the way down, so the next ones are visible below it
    const top = Math.max(0, el.offsetTop - list.clientHeight / 3);
    ownScroll.current = { until: performance.now() + (smooth ? 900 : 120), top };
    list.scrollTo({ top, behavior: smooth ? "smooth" : "auto" });
  }, [current]);

  // follow the stage: after the current row expanded (layout), scroll it into place
  useLayoutEffect(() => {
    if (!following) return;
    const jump = Math.abs(current - lastCurrent.current) > 6 || !playing;
    lastCurrent.current = current;
    scrollToCurrent(!jump);
  }, [current, following, playing, scrollToCurrent]);

  // a scroll we did not cause pauses the follow
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const onUser = () => {
      const own = ownScroll.current;
      if (own && performance.now() < own.until) return;
      setFollowing(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(e.key)) onUser();
    };
    list.addEventListener("wheel", onUser, { passive: true });
    list.addEventListener("touchmove", onUser, { passive: true });
    list.addEventListener("keydown", onKey);
    const onDown = (e: PointerEvent) => {
      // dragging the scrollbar (the pointer lands right of the content box)
      if (e.offsetX > list.clientWidth) onUser();
    };
    list.addEventListener("pointerdown", onDown);
    return () => {
      list.removeEventListener("wheel", onUser);
      list.removeEventListener("touchmove", onUser);
      list.removeEventListener("keydown", onKey);
      list.removeEventListener("pointerdown", onDown);
    };
  }, []);

  const seek = (t: number) => {
    setFollowing(true);
    onSeek(t);
  };

  return (
    <aside className="events" aria-label="Events">
      <div className="events__head">
        <span>Events <span className="muted num">{items.length}</span></span>
        <button type="button" className={`follow ${following ? "is-on" : ""}`} aria-pressed={following}
          onClick={() => {
            setFollowing(true);
            scrollToCurrent(false);
          }}
          title={following ? "The list follows the stage (scroll it to look around)" : "Resume following the stage"}>
          <span className="follow__dot" aria-hidden="true" />
          {following ? "Following" : "Follow"}
        </button>
      </div>
      <ol ref={listRef} className="events__list" tabIndex={0}>
        {items.map(({ step: s, index }) => {
          const isOpen = open.has(index);
          const isCurrent = index === current;
          return (
            <li key={index} data-index={index} aria-current={isCurrent ? "step" : undefined}
              className={`event tone-${tone(s)} ${isCurrent ? "is-current" : ""} ${index < applied ? "" : "is-future"}`}>
              <div className="event__row">
                <button type="button" className="event__time num" onClick={() => seek(s.t_ms)}
                  title="Jump to this event">{fmt(s.t_ms)}</button>
                <button type="button" className="event__main" onClick={() => seek(s.t_ms)}>
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
              {isOpen ? <Detail s={s} /> : isCurrent ? <Current s={s} /> : null}
            </li>
          );
        })}
      </ol>
    </aside>
  );
}
