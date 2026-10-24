// Where replays come from. Inside the console the shell posts {type: "avg:hello", apiBase, csrf, user, ns, params}
// after the iframe loads (docs/contracts/console-api.md §4); we then use /api/replay/list and /api/replay/run/{id}
// with the same session cookie. Standalone (vite preview): ?replay=<url-to-json>[&compare=<url>], or the bundled
// demo replays (exported from replay/fixtures, all mock, all watermarked SIMULATED).
import type { Narration } from "./engine/lanesNarration";
import type { TeamModel } from "./engine/recast";
import type { Replay } from "./engine/replay";
import { plainReplay, plainText, runName, runHeadline, stageLabel } from "./components/labels";

export interface Hello {
  type: "avg:hello";
  apiBase: string;
  csrf?: string;
  user?: { username: string; role: string };
  ns?: "real" | "mock";
  params?: Record<string, string>;
}

export type Ns = "real" | "mock";

export interface RunEntry {
  run_id: string;
  /** namespace the run lives in (shell mode lists both: real runs and the mock selftest) */
  ns?: Ns;
  finished?: boolean;
  cached?: boolean;
  /** a replay bundled with the theater (all SIMULATED), listed after the namespaces' runs */
  demo?: boolean;
  /** a scripted AI-SDLC scene (replay/scenes): an illustration, never a run */
  illustration?: boolean;
  stage?: string | null;
  ticket?: string | null;
  condition?: { V?: string; S?: string; W?: string } | null;
  source?: string | null;
  date?: string | null;
  outcome?: string | null;
  blinded?: boolean;
  label?: string;
  url: string;
}

let hello: Hello | null = null;
const listeners = new Set<(h: Hello) => void>();

export function installHelloListener(): void {
  window.addEventListener("message", (e: MessageEvent) => {
    if (e.origin !== window.location.origin) return;
    const d = e.data as Partial<Hello> | null;
    if (d && d.type === "avg:hello" && typeof d.apiBase === "string") {
      hello = d as Hello;
      listeners.forEach((fn) => fn(hello as Hello));
    }
  });
  // Ask the shell for (another) hello in case its load-time hello raced our listener.
  if (window.parent !== window) window.parent.postMessage({ type: "avg:ready" }, window.location.origin);
}

export function onHello(fn: (h: Hello) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function waitHello(ms: number): Promise<Hello | null> {
  if (hello) return Promise.resolve(hello);
  if (window.parent === window) return Promise.resolve(null);
  return new Promise((resolve) => {
    const off = onHello((h) => {
      off();
      window.clearTimeout(timer);
      resolve(h);
    });
    const timer = window.setTimeout(() => {
      off();
      resolve(null);
    }, ms);
  });
}

function nsQuery(ns: string | undefined): string {
  return ns ? `?ns=${encodeURIComponent(ns)}` : "";
}

export function runUrl(h: Hello, runId: string, ns?: Ns): string {
  return `${h.apiBase}/replay/run/${encodeURIComponent(runId)}${nsQuery(ns ?? h.ns)}`;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "same-origin", headers: { Accept: "application/json" } });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) msg = body.error;
    } catch {
      /* not JSON */
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

const NAMESPACES: Ns[] = ["real", "mock"];

/** Runs with a trace in both namespaces: real runs first (REAL), then the mock selftest (SIMULATED). */
export async function listRuns(h: Hello): Promise<RunEntry[]> {
  const lists = await Promise.all(NAMESPACES.map(async (ns) => {
    try {
      const body = await getJson<{ runs: Omit<RunEntry, "url">[] }>(`${h.apiBase}/replay/list${nsQuery(ns)}`);
      return (body.runs ?? []).map((r) => ({ ...r, ns, url: runUrl(h, r.run_id, ns) }));
    } catch (e) {
      if (ns === (h.ns ?? "mock")) throw e;
      return [];
    }
  }));
  return lists.flat();
}

export interface ExportResult {
  ns: Ns;
  exported: string[];
  fresh: string[];
  skipped_blinded: number;
  unfinished: string[];
  errors: Record<string, string>;
}

/** "Export new runs": replay.json for every finished run of a visible stage that has none yet, in both namespaces. */
export async function exportRuns(h: Hello): Promise<ExportResult[]> {
  const out: ExportResult[] = [];
  for (const ns of NAMESPACES) {
    const res = await fetch(`${h.apiBase}/replay/export${nsQuery(ns)}`, {
      method: "POST", credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json", "X-CSRF-Token": h.csrf ?? "" },
      body: "{}",
    });
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) msg = body.error;
      } catch {
        /* not JSON */
      }
      throw new Error(msg);
    }
    out.push((await res.json()) as ExportResult);
  }
  return out;
}

export function canExport(h: Hello | null | undefined): boolean {
  return !!h?.user && ["owner", "operator", "presenter"].includes(h.user.role);
}

/** The AI-SDLC models of the Teams plugin (members mapped to v2.1 roles, with citations), for the sprint re-cast.
 * Inside the console: /api/teams; standalone: the copy bundled with the theater (teams/index.json). */
export async function loadTeams(h: Hello | null): Promise<TeamModel[]> {
  if (h) {
    const list = await getJson<{ models: { id: string }[] }>(`${h.apiBase}/teams`);
    return Promise.all(list.models.map((m) => getJson<TeamModel>(`${h.apiBase}/teams/${encodeURIComponent(m.id)}`)));
  }
  const body = await getJson<{ models: TeamModel[] }>("teams/index.json");
  return body.models;
}

/** Inside the console: the runs of both namespaces, then the bundled demos (e.g. the M2b sprint, which is not a run
 * under results/). */
export async function listAll(h: Hello): Promise<RunEntry[]> {
  const [runs, demos, scenes] = await Promise.all([listRuns(h), listDemos().catch(() => [] as RunEntry[]),
    listScenes().catch(() => [] as RunEntry[])]);
  return [...runs, ...demos.map((d) => ({ ...d, demo: true })), ...scenes];
}

export async function listDemos(): Promise<RunEntry[]> {
  const [body, scenes] = await Promise.all([getJson<{ runs: RunEntry[] }>("demo/index.json"),
    listScenes().catch(() => [] as RunEntry[])]);
  return [...body.runs.map((r) => ({ ...r, url: `demo/${r.url}` })), ...scenes];
}

/** The scripted AI-SDLC scenes (replay/scenes), one per public model: illustrations, never runs. */
export interface SceneIndex {
  label: string;
  axis: string[];
  axis_label: Record<string, string>;
  feature: string;
  premise: string;
  scenes: {
    id: string; url: string; title: string; short: string; source: string; date: string; stages: string[];
    rule: { axis: string; place: string; label: string }; blocks: { axis: string; place: string; label: string };
    ci_arch: boolean; outcome: { status: "caught" | "escapes"; axis: string; label: string }; duration_ms: number;
    columns: Record<string, { stages: string[]; artifacts: string[]; checks?: string[]; who: string[];
      t_ms: number | null }>;
  }[];
}

export function loadSceneIndex(): Promise<SceneIndex> {
  return getJson<SceneIndex>("scenes/index.json");
}

/** The lanes view's narration (?narration=1): the moments and their sentences, as data. */
export function loadLanesNarration(neutral: boolean): Promise<Narration> {
  return getJson<Narration>(neutral ? "narration/lanes-neutral.json" : "narration/lanes.json");
}

export async function listScenes(): Promise<RunEntry[]> {
  const idx = await loadSceneIndex();
  return idx.scenes.map((s) => ({ run_id: s.id, url: s.url, source: "illustration", demo: true, illustration: true,
    label: `ILLUSTRATION · ${s.title}` }));
}

/** A replay with its on-screen text in plain words (components/labels.ts: no codes on screen). */
export function loadReplay(url: string): Promise<Replay> {
  return getJson<Replay>(url).then(plainReplay);
}

export function navigateShell(plugin: string, params: Record<string, string>): void {
  if (window.parent !== window) {
    window.parent.postMessage({ type: "avg:navigate", plugin, params }, window.location.origin);
  }
}

/** "Real · Main test · run 2 · Rename two fields · Own repo · No rule" or "Simulated · Simulated run 14 · …": the
 * source, the run in words and what it is. No codes on screen (the run id stays in the option's value and title). */
export function runLabel(r: RunEntry): string {
  if (r.label) return plainText(r.label);
  const src = r.source === "mock" ? "Simulated" : "Real";
  const named = runName(r.run_id);
  const where = named !== r.run_id ? named : stageLabel(r.stage ?? null);
  return [src, where, runHeadline({ ticket: r.ticket, condition: r.condition })].filter(Boolean).join(" · ");
}
