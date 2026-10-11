// Where replays come from. Inside the console the shell posts {type: "avg:hello", apiBase, csrf, user, ns, params}
// after the iframe loads (docs/contracts/console-api.md §4); we then use /api/replay/list and /api/replay/run/{id}
// with the same session cookie. Standalone (vite preview): ?replay=<url-to-json>[&compare=<url>], or the bundled
// demo replays (exported from replay/fixtures, all mock, all watermarked SIMULATED).
import type { Replay } from "./engine/replay";

export interface Hello {
  type: "avg:hello";
  apiBase: string;
  csrf?: string;
  user?: { username: string; role: string };
  ns?: "real" | "mock";
  params?: Record<string, string>;
}

export interface RunEntry {
  run_id: string;
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

function nsQuery(h: Hello): string {
  return h.ns ? `?ns=${encodeURIComponent(h.ns)}` : "";
}

export function runUrl(h: Hello, runId: string): string {
  return `${h.apiBase}/replay/run/${encodeURIComponent(runId)}${nsQuery(h)}`;
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

export async function listRuns(h: Hello): Promise<RunEntry[]> {
  const body = await getJson<{ runs: Omit<RunEntry, "url">[] }>(`${h.apiBase}/replay/list${nsQuery(h)}`);
  return (body.runs ?? []).map((r) => ({ ...r, url: runUrl(h, r.run_id) }));
}

export async function listDemos(): Promise<RunEntry[]> {
  const body = await getJson<{ runs: RunEntry[] }>("demo/index.json");
  return body.runs.map((r) => ({ ...r, url: `demo/${r.url}` }));
}

export function loadReplay(url: string): Promise<Replay> {
  return getJson<Replay>(url);
}

export function navigateShell(plugin: string, params: Record<string, string>): void {
  if (window.parent !== window) {
    window.parent.postMessage({ type: "avg:navigate", plugin, params }, window.location.origin);
  }
}

export function runLabel(r: RunEntry): string {
  if (r.label) return r.label;
  const c = r.condition ?? {};
  const cond = [c.V, c.S, c.W].filter(Boolean).join("·");
  return [r.run_id, r.ticket, cond, r.stage].filter(Boolean).join(" · ");
}
