import { useEffect, useMemo, useState } from "react";
import "./App.css";
import { Player } from "./components/Player";
import type { Replay } from "./engine/replay";
import {
  canExport, exportRuns, listDemos, listRuns, loadReplay, navigateShell, onHello, runLabel, waitHello, type Hello,
  type RunEntry,
} from "./data";

/** The run the shell asked for (params.run, params.ns), else the first visible real run, else the first visible one. */
function pickRun(list: RunEntry[], want?: string, wantNs?: string): RunEntry | undefined {
  return list.find((r) => r.run_id === want && (!wantNs || r.ns === wantNs)) ?? list.find((r) => r.run_id === want)
    ?? list.find((r) => !r.blinded && r.source !== "mock") ?? list.find((r) => !r.blinded);
}

type Source = { kind: "shell"; hello: Hello } | { kind: "url" } | { kind: "demo" };

function App() {
  const query = useMemo(() => new URLSearchParams(window.location.search), []);
  const [source, setSource] = useState<Source | null>(null);
  const [runs, setRuns] = useState<RunEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [compareUrl, setCompareUrl] = useState<string | null>(query.get("compare"));
  const [replay, setReplay] = useState<Replay | null>(null);
  const [compare, setCompare] = useState<Replay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("Loading…");
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function onExport(h: Hello) {
    setExporting(true);
    setNotice(null);
    try {
      const res = await exportRuns(h);
      const parts = res.map((r) => `${r.ns}: ${r.exported.length} exported`
        + (r.unfinished.length ? `, ${r.unfinished.length} not finished` : "")
        + (r.skipped_blinded ? `, ${r.skipped_blinded} blinded (not exported)` : "")
        + (Object.keys(r.errors).length ? `, ${Object.keys(r.errors).length} failed` : ""));
      setNotice(`Export new runs · ${parts.join(" · ")}`);
      setRuns(await listRuns(h));
    } catch (e) {
      setError(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExporting(false);
    }
  }

  // Decide where replays come from: ?replay=<url>, the console shell (avg:hello), or the bundled demos.
  useEffect(() => {
    let cancelled = false;
    const direct = query.get("replay");
    if (direct) {
      setSource({ kind: "url" });
      setRuns([{ run_id: direct, url: direct, label: direct.split("/").pop() ?? direct }]);
      setSelected(direct);
      return;
    }
    waitHello(1500).then(async (h) => {
      if (cancelled) return;
      try {
        if (h) {
          setSource({ kind: "shell", hello: h });
          const list = await listRuns(h);
          if (cancelled) return;
          setRuns(list);
          const want = h.params?.run;
          const first = pickRun(list, want, h.params?.ns);
          setSelected(first ? first.url : null);
          if (!list.length) setStatus("No runs with a trace yet.");
          else if (want && !list.some((r) => r.run_id === want)) setError(`Run ${want} has no trace in this namespace.`);
        } else {
          setSource({ kind: "demo" });
          const list = await listDemos();
          if (cancelled) return;
          setRuns(list);
          setSelected(list[0]?.url ?? null);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [query]);

  // Later avg:hello messages (shell navigate with a new run) re-select.
  useEffect(() => onHello((h) => {
    setSource({ kind: "shell", hello: h });
    listRuns(h).then((list) => {
      setRuns(list);
      const want = h.params?.run;
      const hit = want ? pickRun(list, want, h.params?.ns) : undefined;
      if (hit) setSelected(hit.url);
    }).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }), []);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setError(null);
    loadReplay(selected)
      .then((r) => !cancelled && setReplay(r))
      .catch((e) => !cancelled && setError(`Cannot load replay: ${e instanceof Error ? e.message : String(e)}`));
    return () => {
      cancelled = true;
    };
  }, [selected]);

  useEffect(() => {
    if (!compareUrl) {
      setCompare(null);
      return;
    }
    let cancelled = false;
    loadReplay(compareUrl)
      .then((r) => !cancelled && setCompare(r))
      .catch((e) => !cancelled && setError(`Cannot load comparison: ${e instanceof Error ? e.message : String(e)}`));
    return () => {
      cancelled = true;
    };
  }, [compareUrl]);

  const option = (r: RunEntry) => (
    <option key={r.url} value={r.url} disabled={r.blinded}>
      {runLabel(r)}{r.blinded ? " — blinded" : ""}
    </option>
  );
  const real = runs.filter((r) => r.source !== "mock");
  const mock = runs.filter((r) => r.source === "mock");
  const shellHello = source?.kind === "shell" ? source.hello : null;
  const picker = (
    <>
      <label className="picker">
        <span className="sr-only">Run</span>
        <select value={selected ?? ""} onChange={(e) => setSelected(e.target.value || null)} aria-label="Run to replay">
          {!selected && <option value="">Select a run…</option>}
          {real.length > 0 && mock.length > 0 ? (
            <>
              <optgroup label="Real runs">{real.map(option)}</optgroup>
              <optgroup label="Simulated (mock agent)">{mock.map(option)}</optgroup>
            </>
          ) : runs.map(option)}
        </select>
      </label>
      {shellHello && canExport(shellHello) && (
        <button type="button" className="btn btn--quiet" disabled={exporting} onClick={() => onExport(shellHello)}
          title="Write replay.json for every finished run of a visible stage that has none yet (real and mock). Blinded stages are never exported.">
          {exporting ? "Exporting…" : "Export new runs"}
        </button>
      )}
    </>
  );

  const comparePicker = runs.length > 1 ? (
    <label className="picker picker--compare">
      <span className="sr-only">Compare with</span>
      <select value={compareUrl ?? ""} onChange={(e) => setCompareUrl(e.target.value || null)}
        aria-label="Compare with another run">
        <option value="">Compare…</option>
        {runs.filter((r) => r.url !== selected && !r.blinded).map((r) => (
          <option key={r.url} value={r.url}>{runLabel(r)}</option>
        ))}
      </select>
    </label>
  ) : null;

  if (!replay) {
    return (
      <div className="empty-state">
        <div className="empty-state__box">
          <h1>Replay Theater</h1>
          {runs.length > 0 && picker}
          <p className={error ? "error" : "muted"}>{error ?? status}</p>
          {source?.kind === "demo" && !runs.length && (
            <p className="muted small">Standalone: open with <code>?replay=&lt;url-to-replay.json&gt;</code>.</p>
          )}
        </div>
      </div>
    );
  }

  const shell = source?.kind === "shell" ? source : null;
  return (
    <>
      {error && <div className="banner-error" role="alert">{error}</div>}
      {notice && !error && (
        <div className="banner-note" role="status">
          {notice}
          <button type="button" className="banner-note__close" onClick={() => setNotice(null)} aria-label="Dismiss">×</button>
        </div>
      )}
      <Player
        key={replay.meta.trace_sha256}
        replay={replay}
        compare={compare}
        picker={picker}
        comparePicker={comparePicker}
        onCloseCompare={() => setCompareUrl(null)}
        onOpenInExplorer={shell ? () => navigateShell("runs", {
          run: replay.meta.run_id,
          ns: runs.find((r) => r.url === selected)?.ns ?? (replay.meta.source === "mock" ? "mock" : "real"),
        }) : undefined}
      />
    </>
  );
}

export default App;
