// Talk video scenes. Each scene is a pure function of time: build() once, then render(tMs) for every frame, so the
// capture is deterministic and needs no real-time playback. Data comes from video/work/*.json (prepare.py), which is
// built from the scenario and the real run records; nothing here is typed in by hand except connective wording.
// The one label map (console/web/lib/labels.js, mounted at /labels/): the clip cards show plain words, never the codes
// (X-rename, V0·S0, P1, p1-0002…). Decision 2026-10-16, docs/DECISIONS.md "Plain words".
import { detectorLabel, outcomeLabel, plainCondition, runName, ticketLabel } from "/labels/labels.js";

const q = new URLSearchParams(location.search);
const stage = document.getElementById("stage");
const J = async (p) => { const r = await fetch(p); if (!r.ok) throw new Error(`${p}: ${r.status}`); return r.json(); };

function el(tag, attrs = {}, ...kids) {
  const n = tag === "svg" || attrs.svg ? document.createElementNS("http://www.w3.org/2000/svg", tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "svg" || v == null) continue;
    if (k === "style" && typeof v === "object") Object.assign(n.style, v);
    else if (k === "html") n.innerHTML = v;
    else n.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
}
const S = (tag, attrs = {}, ...kids) => el(tag, { ...attrs, svg: true }, ...kids);
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const ease = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);
const prog = (t, a, b) => ease(clamp((t - a) / Math.max(1, b - a)));
const sec = (s) => s * 1000;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** Opacity for an element shown from tin to tout (ms) with fades. */
function vis(t, tin, tout = Infinity, fade = 450) {
  if (t < tin || t > tout) return 0;
  return Math.min(clamp((t - tin) / fade), clamp((tout - t) / fade));
}
function show(node, t, tin, tout, { fade = 450, rise = 16 } = {}) {
  const o = vis(t, tin, tout, fade);
  node.style.opacity = o;
  node.style.translate = `0 ${(1 - o) * rise}px`;
  return o;
}

/** Subtitles: [[fromS, toS, text], ...] in one caption box. */
function captions(list) {
  const box = el("div", { class: "caption" });
  stage.append(box);
  let last = null;
  return (t) => {
    const c = list.find(([a, b]) => t >= sec(a) && t <= sec(b));
    if (!c) { box.style.opacity = 0; return; }
    if (last !== c) { box.textContent = c[2]; last = c; }
    box.style.opacity = vis(t, sec(c[0]), sec(c[1]), 300);
  };
}

function topbar(title, kicker, chips = []) {
  const n = el("div", { class: "topbar" }, el("div", {}, el("h1", {}, title), kicker ? el("div", { class: "kicker" }, kicker) : null),
    el("div", { style: { display: "flex", gap: "10px" } }, chips.map(([txt, cls]) => el("span", { class: `chip ${cls || ""}` }, txt))));
  stage.append(n);
  return n;
}

const firstSentence = (s, max = 96) => {
  const x = String(s).split(/(?<=\.)\s/)[0].trim();
  return x.length > max ? `${x.slice(0, max - 1).trim()}…` : x;
};
const lastSeg = (k) => k.split(/[.\[\]]+/).filter(Boolean).pop();
/** The contract fields a ticket names (totalCents, placedAt, channel…), read from the ticket texts. */
function ticketFields(scn) {
  const text = Object.values(scn.tickets).join(" ");
  const keys = new Set(scn.contracts.flatMap((c) => Object.keys(c.requires).map(lastSeg)));
  return new Set([...keys].filter((k) => new RegExp(`\\b${k}\\b`).test(text)));
}

// ------------------------------------------------------------------------------------------------ scene: company
async function company() {
  const scn = await J("/data/scenario.json");
  const hot = ticketFields(scn);
  const D = sec(45);
  // opening title (0–5 s)
  const title = el("div", { class: "title-card" },
    el("div", { class: "eyebrow" }, "Agents vs. Gates"),
    el("h2", {}, "The AI-SDLC Governance Gap"),
    el("p", {}, "Does a coding agent break deployed consumers it cannot see — and which gate stops it?"));
  stage.append(title);

  const bar = topbar("Meridian Retail", "a fictional company · 100 % synthetic scenario (scenario/)", [["four services, four teams", ""]]);
  const svc = scn.services;
  const ordersName = "orders-service";
  const consumers = ["billing-service", "analytics-ingest", "web-storefront"];
  const pos = { [ordersName]: { x: 90, y: 420, w: 400, h: 190 } };
  consumers.forEach((c, i) => { pos[c] = { x: 720, y: 170 + i * 250, w: 430, h: 210 }; });

  const svg = S("svg", { width: 1920, height: 1080, class: "abs", style: "left:0;top:0" });
  stage.append(svg);
  const edges = consumers.map((c) => {
    const a = pos[ordersName], b = pos[c];
    const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + 60;
    const d = `M${x1},${y1} C${x1 + 120},${y1} ${x2 - 120},${y2} ${x2 - 8},${y2}`;
    const path = S("path", { d, fill: "none", stroke: "#5b6474", "stroke-width": 3 });
    const head = S("path", { d: `M${x2 - 18},${y2 - 9} L${x2 - 2},${y2} L${x2 - 18},${y2 + 9} Z`, fill: "#5b6474" });
    const contracts = scn.contracts.filter((k) => k.consumer === c && k.provider === ordersName).map((k) => k.contract);
    const label = S("text", { x: x2 - 24, y: y2 - 16, "text-anchor": "end", "font-size": 22,
      "font-family": "IBM Plex Sans", "font-weight": 600, fill: "#111827" },
    contracts.map((k, j) => S("tspan", { x: x2 - 24, dy: j ? -27 : 0 }, k)));
    const bg = S("rect", { fill: "#f6f7f9", rx: 4 });
    svg.append(path, head, bg, label);
    return { path, head, label, bg, len: 0 };
  });

  const card = (name, extra) => {
    const p = pos[name];
    const s = svc[name];
    const n = el("div", { class: "card", style: { left: `${p.x}px`, top: `${p.y}px`, width: `${p.w}px`, minHeight: `${p.h}px`, padding: "20px 24px" } },
      el("h3", {}, name), el("div", { class: "sub" }, `owner: ${s.owner} team`), extra);
    stage.append(n);
    return n;
  };
  const prov = svc[ordersName].provides || {};
  const orders = card(ordersName, el("div", { class: "sub", style: { marginTop: "14px", lineHeight: "1.45" } },
    `publishes ${(prov.events || []).map((e) => `${e.name} v${e.version}`).join(", ")}`, el("br"),
    `serves ${(prov.apis || []).map((a) => a.name).join(", ")} (GET /orders/{id})`));
  const fieldsOf = (c) => {
    const req = scn.contracts.filter((k) => k.consumer === c && k.provider === ordersName).flatMap((k) => Object.keys(k.requires).map(lastSeg));
    const uniq = [...new Set(req)];
    uniq.sort((a, b) => (hot.has(b) ? 1 : 0) - (hot.has(a) ? 1 : 0));
    const shown = uniq.slice(0, 5);
    return el("div", { class: "fields", style: { marginTop: "10px" } }, shown.map((f) => el("span", { class: `field ${hot.has(f) ? "hot" : ""}` }, f)),
      uniq.length > shown.length ? el("span", { class: "field" }, `+${uniq.length - shown.length}`) : null);
  };
  const cCards = consumers.map((c) => { const f = fieldsOf(c); return { node: card(c, f), fields: f }; });
  const reqNote = el("div", { class: "abs muted", style: { left: "720px", top: "136px", fontSize: "19px", width: "560px" } },
    "fields each consumer requires · bold: named in a ticket");
  stage.append(reqNote);

  const rules = el("div", { class: "card", style: { left: "1230px", top: "150px", width: "630px", padding: "6px 0" } },
    el("div", { style: { padding: "12px 16px 8px", fontSize: "24px", fontWeight: 600 } }, "Architecture rules · owner · CI check"),
    scn.rules.map((r) => el("div", { class: `rule ${/contract/i.test(r.enforced_by) ? "hot" : ""}` },
      el("div", { class: "id" }, r.id), el("div", { class: "txt" }, /contract/i.test(r.enforced_by) ? firstSentence(r.rule, 120) : firstSentence(r.rule, 70)),
      el("div", { class: "own" }, `${r.owner} · ${r.enforced_by}`))));
  stage.append(rules);
  const ruleRows = [...rules.querySelectorAll(".rule")];

  const a4 = scn.rules.find((r) => r.id === "ARCH-4");
  const cap = captions([
    [5.2, 13, `Meridian Retail is fictional. ${ordersName} belongs to the ${svc[ordersName].owner} team.`],
    [13, 22, "Three other teams depend on it: billing and analytics consume OrderPlaced; the storefront calls GET /orders/{id}."],
    [22, 31.5, "Each deployed consumer relies on specific fields. Bold: the fields the experiment's tickets rename or remove."],
    [31.5, 39, "Architecture rules have an owner and a check in CI."],
    [39, 45, a4 ? `${a4.id}: ${firstSentence(a4.rule)}` : "ARCH-4 protects deployed consumers."],
  ]);

  return {
    duration: D,
    render(t) {
      show(title, t, 0, sec(5), { rise: 0 });
      show(bar, t, sec(5), D);
      show(orders, t, sec(5.4), D);
      cCards.forEach((c, i) => {
        show(c.node, t, sec(8 + i * 1.2), D);
        c.fields.style.opacity = prog(t, sec(22 + i * 0.8), sec(23.2 + i * 0.8));
      });
      reqNote.style.opacity = prog(t, sec(23), sec(24.5));
      edges.forEach((e, i) => {
        if (!e.len) {
          e.len = e.path.getTotalLength();
          const bb = e.label.getBBox();
          Object.entries({ x: bb.x - 8, y: bb.y - 2, width: bb.width + 16, height: bb.height + 4 }).forEach(([k, v]) => e.bg.setAttribute(k, v));
        }
        const p = prog(t, sec(10 + i * 1.5), sec(12.5 + i * 1.5));
        e.path.setAttribute("stroke-dasharray", `${e.len}`);
        e.path.setAttribute("stroke-dashoffset", `${e.len * (1 - p)}`);
        e.head.style.opacity = p > 0.97 ? 1 : 0;
        const lo = prog(t, sec(12 + i * 1.5), sec(13 + i * 1.5));
        e.label.style.opacity = lo;
        e.bg.style.opacity = lo;
      });
      show(rules, t, sec(31.5), D);
      ruleRows.forEach((r, i) => { r.style.opacity = 0.25 + 0.75 * prog(t, sec(32 + i * 0.35), sec(32.6 + i * 0.35)); });
      cap(t);
    },
  };
}

// --------------------------------------------------------------------------------------------- scene: experiment
async function experiment() {
  const [summary, tl] = await Promise.all([J("/data/x1-summary.json"), J("/data/timeline.json")]);
  const units = Object.keys(summary.units || {});
  const D = sec(45);
  const T1 = sec(13), T2 = sec(27), T3 = sec(35.5);

  // part 1: conditions
  const head = topbar("The experiment", "one ticket, one agent, a clean workspace per run", [["Pilot X1 · exploratory", "accent"]]);
  const condCol = (x, title, rows) => {
    const n = el("div", { class: "card", style: { left: `${x}px`, top: "170px", width: "860px", padding: "22px 28px" } },
      el("div", { style: { fontSize: "30px", fontWeight: 600, marginBottom: "8px" } }, title),
      rows.map(([code, text, inX1]) => el("div", { style: { display: "grid", gridTemplateColumns: "90px 1fr 170px", alignItems: "center",
        padding: "14px 0", borderTop: "1px solid var(--linea)", opacity: inX1 ? 1 : 0.45 } },
        el("span", { style: { fontSize: "34px", fontWeight: 600, color: inX1 ? "var(--acento)" : "var(--tinta-2)" } }, code),
        el("span", { style: { fontSize: "27px" } }, text),
        el("span", { class: `chip ${inX1 ? "accent" : ""}`, style: { justifySelf: "end", fontSize: "18px" } }, inX1 ? "in pilot X1" : "main study"))));
    stage.append(n);
    return n;
  };
  const cv = condCol(80, "What the agent can see · V", [["V0", "only its own repo (orders-service)", true],
    ["V1", "its repo + the consumers' contracts", false], ["V2", "all four repos in its workspace", true]]);
  const cs = condCol(980, "What its spec says · S", [["S0", "the ticket + the service README", true],
    ["S1", "+ architecture prose", false], ["S2", "+ the rules ARCH-1…8 in the spec", false]]);
  const gate = el("div", { class: "card", style: { left: "80px", top: "560px", width: "1760px", padding: "22px 28px", fontSize: "27px", lineHeight: "1.45" } },
    el("div", { style: { fontSize: "30px", fontWeight: 600, marginBottom: "6px" } }, "The same gates judge every run"),
    el("div", {}, "CI on the pull request: typecheck, unit tests and ARCH-1…8. A failure blocks the PR and its output goes back to the agent for a repair."),
    el("div", { class: "muted" }, "A staging oracle runs the consumers' own tests on the PR. The agent never sees it: it measures real breaks."));
  stage.append(gate);
  const pilot = el("div", { class: "abs", style: { left: "80px", top: "820px", fontSize: "25px", color: "var(--tinta-2)" } },
    `Pilot X1: tickets X-rename and X-remove · V0 vs V2 · S0 · 10 runs per cell and unit · units: ${units.join(", ") || "—"}`);
  stage.append(pilot);

  // part 2: three workers in parallel (runner.log.jsonl)
  const runs = (tl.runs || []).filter((r) => r.end);
  const t0 = Math.min(...runs.map((r) => Date.parse(r.start)));
  const tEnd = Math.max(...runs.map((r) => Date.parse(r.end)));
  const workers = tl.workers.length ? tl.workers : [1];
  const G = { x: 220, y: 230, w: 1600, lane: 150 };
  const gantt = el("div", { class: "abs", style: { left: 0, top: 0, width: "1920px", height: "1080px" } });
  const gHead = el("div", { class: "topbar" }, el("div", {}, el("h1", {}, "Runs in parallel"),
    el("div", { class: "kicker" }, `Pilot X1 · ${runs.length} runs from the runner log · ${workers.length} workers, each in its own workspace`)),
  el("div", { class: "legend" }, el("span", {}, el("span", { class: "sw", style: { background: "var(--fail)" } }), "first attempt broke a consumer"),
    el("span", {}, el("span", { class: "sw", style: { background: "var(--linea-fuerte)" } }), "did not")));
  gantt.append(gHead);
  workers.forEach((w, i) => gantt.append(el("div", { class: "abs", style: { left: "80px", top: `${G.y + i * G.lane + 30}px`, fontSize: "26px", fontWeight: 600 } }, `worker ${w}`)));
  const bars = runs.map((r) => {
    const li = workers.indexOf(r.worker);
    const s = Date.parse(r.start), e = Date.parse(r.end);
    const x = G.x + ((s - t0) / (tEnd - t0)) * G.w;
    const w = Math.max(6, ((e - s) / (tEnd - t0)) * G.w - 3);
    const b = el("div", { class: "abs", style: { left: `${x}px`, top: `${G.y + li * G.lane}px`, height: "96px", width: "0px", borderRadius: "4px",
      background: "var(--linea)", border: "1.5px solid var(--linea-fuerte)", overflow: "hidden", whiteSpace: "nowrap", fontSize: "15px", padding: "6px 6px", lineHeight: "1.25" } },
    w > 120 ? el("div", { class: "mono" }, r.run_id) : null, w > 120 ? el("div", {}, `${r.ticket || ""} ${r.V || ""}`) : null);
    gantt.append(b);
    return { b, s, e, w, r };
  });
  const clockTxt = el("div", { class: "abs muted", style: { left: `${G.x}px`, top: `${G.y + workers.length * G.lane + 20}px`, fontSize: "24px" } });
  gantt.append(clockTxt);
  stage.append(gantt);

  // part 3 + 4: console stills (private console on a snapshot of results/real)
  const shotRc = el("div", { class: "shot" }, el("img", { src: "/shots/run-control.png", alt: "" }));
  const shotRs = el("div", { class: "shot" }, el("img", { src: "/shots/results-x1.png", alt: "" }));
  stage.append(shotRc, shotRs);

  const cap = captions([
    [0.3, 6.6, "The experiment varies what the agent can see (V) and what its spec says (S)."],
    [6.6, 13, "Then the same gates judge every run: CI on the pull request, and a hidden staging oracle."],
    [13.3, 20, "The runner works through a batch with three workers in parallel, each in a clean workspace."],
    [20, 27, "Pink: the agent's first attempt broke a deployed consumer, according to the staging oracle."],
    [27.3, 35.5, "Run Control launches the batches and follows them; the X1 pilot is always visible."],
    [35.5, 45, "Results recompute from the run records; the pilot's table is labelled exploratory."],
  ]);

  return {
    duration: D,
    render(t) {
      show(head, t, 0, T1);
      show(cv, t, sec(0.3), T1);
      show(cs, t, sec(1.2), T1);
      show(gate, t, sec(6.6), T1);
      show(pilot, t, sec(8), T1);
      gantt.style.opacity = vis(t, T1, T2, 450);
      const now = t0 + (tEnd - t0) * prog(t, T1 + sec(0.6), T2 - sec(2.5));
      let done = 0;
      for (const k of bars) {
        const vis_ = clamp((now - k.s) / Math.max(1, k.e - k.s));
        k.b.style.width = `${k.w * vis_}px`;
        k.b.style.opacity = now >= k.s ? 1 : 0;
        const finished = now >= k.e;
        if (finished) done += 1;
        k.b.style.background = finished && k.r.staging_break ? "var(--fail)" : finished ? "var(--linea-fuerte)" : "var(--linea)";
        k.b.style.color = finished && k.r.staging_break ? "#fff" : "var(--tinta)";
      }
      const hm = (ms) => `${Math.floor(ms / 3600000)}h ${String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0")}m`;
      clockTxt.textContent = `elapsed ${hm(now - t0)} of ${hm(tEnd - t0)} · ${done} of ${bars.length} runs finished`;
      const o1 = vis(t, T2, T3, 500);
      shotRc.style.opacity = o1;
      const s1 = 1 + 0.32 * prog(t, T2, T3);
      shotRc.style.transformOrigin = "690px 330px";
      shotRc.style.transform = `scale(${s1})`;
      shotRs.style.opacity = vis(t, T3, D + 1000, 500);
      shotRs.style.transformOrigin = "760px 420px";
      shotRs.style.transform = `scale(${1 + 0.22 * prog(t, T3, D)})`;
      cap(t);
    },
  };
}

// ------------------------------------------------------------------------------------- scenes around the theater
async function breakIntro() {
  const [f, scn] = await Promise.all([J("/data/facts.json"), J("/data/scenario.json")]);
  const b = f.break;
  const hot = ticketFields(scn);
  const needs = scn.contracts.filter((c) => c.provider === "orders-service")
    .map((c) => ({ c, keys: Object.keys(c.requires).map(lastSeg).filter((k) => hot.has(k) && new RegExp(`\\b${k}\\b`).test(b.ticket_text || "")) }))
    .filter((x) => x.keys.length);
  const D = sec(9);
  const card = el("div", { class: "title-card", style: { top: "190px" } },
    el("div", { class: "eyebrow" }, `A real run · ${b.run_id} · ${b.model || ""}`),
    el("h2", {}, `${b.ticket} · ${b.V} · ${b.S}`),
    el("p", {}, b.V === "V0" ? "The agent's workspace holds only orders-service. The other teams' code is not there." : ""),
    el("div", { class: "quote", style: { marginTop: "34px" } }, `“${b.ticket_text}”`),
    el("p", { style: { marginTop: "30px", fontSize: "28px" } }, "What it cannot see: ",
      needs.map((x, i) => el("span", {}, i ? " · " : "", el("strong", {}, x.c.consumer), ` requires ${x.keys.join(", ")} in ${x.c.contract}`))));
  stage.append(card);
  const cap = captions([[0.5, 9, "Next: its replay in the theater, director's cut (key moments at 1×, the rest compressed)."]]);
  return { duration: D, render(t) { show(card, t, 0, D + 1000); cap(t); } };
}

async function breakOutro() {
  const f = await J("/data/facts.json");
  const b = f.break;
  const D = sec(12);
  const gen = (b.ci || []).find((c) => c.attempt === 0) || {};
  const last = (b.ci || []).at(-1) || {};
  const broke = Object.entries(b.oracle_gen || {}).filter(([, v]) => !v.ok);
  const finalOk = Object.values(b.oracle_final || {}).every((v) => v.ok);
  const facts = [
    ["fail", `First attempt: CI blocked the pull request (${(gen.failing || []).map((x) => x.id).join(", ") || "—"})`,
      (gen.failing || []).flatMap((x) => x.output).map((l) => el("div", { class: "mono" }, l))],
    ["fail", `The other teams' tests on that first PR: ${broke.length} of ${Object.keys(b.oracle_gen || {}).length} consumers broke`,
      Object.entries(b.oracle_gen || {}).map(([k, v]) => el("div", {}, `${k}: ${v.head}`))],
    [last.ok ? "pass" : "fail", `Repair after reading CI's output (${b.repair_diff ? b.repair_diff.replace(".diff", "") : "—"}): CI ${last.ok ? "passed" : "failed"}`,
      (b.deprecated_lines || []).map((l) => el("div", { class: "mono" }, l))],
    [finalOk ? "pass" : "fail", `Final PR: ${finalOk ? "every consumer's tests pass" : "a consumer still fails"} · outcome ${b.outcome} · ticket ${b.ticket_done}`,
      [el("div", {}, `${b.turns} turns · ${b.minutes} min`)]],
  ];
  const head = topbar(`What the record of ${b.run_id} says`, "record.json · CI verdicts · oracle · diffs", [["REAL", "accent"]]);
  const box = el("div", { class: "card", style: { left: "80px", top: "170px", width: "1760px", padding: "8px 34px" } },
    facts.map(([k, t, d]) => el("div", { class: "fact" }, el("div", { class: `dot ${k}` }), el("div", {}, el("div", { class: "t" }, t), el("div", { class: "d" }, d)))));
  stage.append(box);
  const rows = [...box.querySelectorAll(".fact")];
  const cap = captions([
    [0.3, 6, `Blind to its consumers, the first attempt broke ${broke.length === 1 ? "one of them" : `${broke.length} of them`}; the CI contract check blocked the PR.`],
    [6, 12, (b.deprecated_lines || []).length ? "The repair kept the old fields as @deprecated aliases. CI passed." : `The repair ${last.ok ? "passed CI" : "did not pass CI"}.`],
  ]);
  return { duration: D, render(t) { show(head, t, 0, D + 1000); show(box, t, 0, D + 1000); rows.forEach((r, i) => show(r, t, sec(0.4 + i * 1.4), D + 1000)); cap(t); } };
}

async function stopIntro() {
  const f = await J("/data/facts.json");
  const s = f.stop;
  const D = sec(7);
  const card = el("div", { class: "title-card", style: { top: "260px" } },
    el("div", { class: "eyebrow" }, `The contrast · a real run · ${s.run_id}`),
    el("h2", {}, `${s.ticket} · ${s.V} · ${s.S}`),
    el("p", {}, s.V === "V2" ? "Same ticket, same agent. Now the other teams' repos are in its workspace." : ""));
  stage.append(card);
  const cap = captions([[0.5, 7, "Played at half speed: this run is short."]]);
  return { duration: D, render(t) { show(card, t, 0, D + 1000); cap(t); } };
}

function md(text) {
  // tiny Markdown subset for the agent's final message: paragraphs, - lists, 1. lists, **bold**, `code`
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");
  const out = [];
  let list = null;
  for (const raw of text.split(/\n/)) {
    const line = raw.trim();
    const ul = /^[-*] (.*)$/.exec(line), ol = /^\d+\. (.*)$/.exec(line);
    if (ul || ol) {
      const kind = ul ? "ul" : "ol";
      if (!list || list.kind !== kind) { if (list) out.push(`</${list.kind}>`); out.push(`<${kind}>`); list = { kind }; }
      out.push(`<li>${inline((ul || ol)[1])}</li>`);
      continue;
    }
    if (list) { out.push(`</${list.kind}>`); list = null; }
    if (line) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push(`</${list.kind}>`);
  return out.join("");
}

async function stopAnswer() {
  const [f, summary] = await Promise.all([J("/data/facts.json"), J("/data/x1-summary.json")]);
  const s = f.stop;
  const D = sec(16);
  const card = el("div", { class: "card answer" }, el("div", { class: "who" }, `${s.run_id} · the agent's final message, verbatim · outcome ${s.outcome} · ${s.turns} turns · ${s.minutes} min`),
    el("div", { html: md(s.final_message || "") }));
  stage.append(card);
  // fit: shrink the font until the card ends above the caption
  let fs = 25;
  while (card.getBoundingClientRect().bottom > 880 && fs > 15) { fs -= 1; card.style.fontSize = `${fs}px`; }
  const lines = [[0.3, 8, "It made no change. It named the consumers that would break and asked which option to take."]];
  const g = Object.values(summary.units || {}).map((u) => u[s.ticket]).find(Boolean);
  if (g && g[s.V] && g[s.V].n) {
    const c = g[s.V];
    lines.push([8, 16, `Not every ${s.V} run stopped: of ${c.n} ${s.ticket} ${s.V} runs so far, ${c.outcomes.no_change || 0} made no change and ${c.staging_break_gen.x} broke a consumer first.`]);
  }
  const cap = captions(lines);
  return { duration: D, render(t) { show(card, t, 0, D + 1000); cap(t); } };
}

// ------------------------------------------------------------------------------------------------ scene: results
async function results() {
  const s = await J("/data/x1-summary.json");
  const meta = s._video || {};
  const planned = meta.planned_by_unit || {};
  const plannedTotal = Object.values(planned).reduce((a, b) => a + b, 0);
  const rows = [];
  for (const [unit, tickets] of Object.entries(s.units || {})) for (const [ticket, g] of Object.entries(tickets)) rows.push({ unit, ticket, g });
  const pending = Object.keys(planned).filter((u) => !(u in (s.units || {})));
  const date = (meta.at || "").slice(0, 10);
  const head = topbar("Pilot X1 · first attempt broke a deployed consumer?", "staging oracle on the agent's first PR · V0 (orders-service only) vs V2 (all four repos) · S0",
    [[`DRAFT · ${s.runs} runs so far${plannedTotal ? ` of ${plannedTotal} planned` : ""}`, "draft"], ["exploratory", "accent"]]);
  const SQ = 50, GAP = 10, X0 = 520, X2 = 1210;
  const rowH = rows.length > 2 ? 190 : 250;
  const top = 230;
  const chart = el("div", { class: "abs", style: { left: 0, top: 0, width: "1920px", height: "1080px", whiteSpace: "nowrap" } });
  stage.append(chart);
  chart.append(el("div", { class: "abs", style: { left: `${X0}px`, top: "180px", fontSize: "26px", fontWeight: 600 } }, "V0 · only orders-service"),
    el("div", { class: "abs", style: { left: `${X2}px`, top: "180px", fontSize: "26px", fontWeight: 600 } }, "V2 · all four repos"));
  const squares = [];
  const fmtCI = (c) => (c && c.ci ? `95% CI ${c.ci[0].toFixed(2)}–${c.ci[1].toFixed(2)}` : "");
  rows.forEach((r, i) => {
    const y = top + 50 + i * rowH;
    chart.append(el("div", { class: "abs", style: { left: "80px", top: `${y}px`, width: "420px" } },
      el("div", { style: { fontSize: "32px", fontWeight: 600 } }, r.ticket), el("div", { class: "muted", style: { fontSize: "22px" } }, r.unit),
      el("div", { class: "muted", style: { fontSize: "19px", marginTop: "8px" } },
        r.g.fisher_staging_break == null ? "" : `Fisher p = ${r.g.fisher_staging_break.toPrecision(2)} (uncorrected)`)));
    for (const [V, X] of [["V0", X0], ["V2", X2]]) {
      const c = r.g[V] || { n: 0 };
      const sb = c.staging_break_gen || { x: 0, n: 0 };
      for (let k = 0; k < c.n; k++) {
        const col = k % 10, line = Math.floor(k / 10);
        const n = el("div", { class: "abs", style: { left: `${X + col * (SQ + GAP)}px`, top: `${y + line * (SQ + GAP)}px`, width: `${SQ}px`, height: `${SQ}px`,
          borderRadius: "6px", background: k < sb.x ? "var(--fail)" : "var(--linea)", border: k < sb.x ? "0" : "1.5px solid var(--linea-fuerte)" } });
        chart.append(n);
        squares.push({ n, order: i * 100 + (V === "V2" ? 50 : 0) + k });
      }
      const lines = Math.max(1, Math.ceil(c.n / 10));
      chart.append(el("div", { class: "abs", style: { left: `${X}px`, top: `${y + lines * (SQ + GAP) + 6}px`, fontSize: "26px" } },
        c.n ? el("span", {}, el("strong", {}, `${sb.x} of ${sb.n}`), el("span", { class: "muted" }, ` broke a consumer · ${fmtCI(sb)}`)) : el("span", { class: "muted" }, "no runs yet")));
    }
  });
  if (pending.length) {
    chart.append(el("div", { class: "abs muted", style: { left: "80px", top: `${top + 50 + rows.length * rowH}px`, fontSize: "24px" } },
      `Still to run: ${pending.map((u) => `${u} (${planned[u]} runs)`).join(", ")}.`));
  }
  chart.append(el("div", { class: "abs legend", style: { left: "80px", top: "880px" } },
    el("span", {}, el("span", { class: "sw", style: { background: "var(--fail)" } }), "one run: first attempt broke a consumer"),
    el("span", {}, el("span", { class: "sw", style: { background: "var(--linea)", border: "1.5px solid var(--linea-fuerte)" } }), "one run: it did not"),
    el("span", {}, `source: ${String(meta.source || "").split(" (")[0]} · ${date}`)));
  squares.sort((a, b) => a.order - b.order);

  const lines = [[0.3, 9, "Pilot X1 so far: did the agent's first attempt break a deployed consumer?"]];
  let t = 9;
  for (const r of rows) {
    const a = r.g.V0.staging_break_gen, b = r.g.V2.staging_break_gen;
    const txt = a.x === 0 && b.x === 0
      ? `${r.ticket} (${r.unit}): no run broke a consumer in either condition (${a.x} of ${a.n} V0, ${b.x} of ${b.n} V2).`
      : `${r.ticket} (${r.unit}): ${a.x} of ${a.n} runs broke a consumer in V0, ${b.x} of ${b.n} in V2.`;
    lines.push([t, t + 9, txt]);
    t += 9;
  }
  lines.push([t, t + 9, "Exploratory and incomplete: small samples, wide intervals, uncorrected p-values."]);
  t += 9;
  const D = sec(Math.max(45, t + 6));
  lines.push([t, D / 1000, `Draft · ${s.runs} runs so far${pending.length ? `; ${pending.join(", ")} still to run` : ""}. The confirmatory study (P1) is blinded.`]);
  const cap = captions(lines);
  return {
    duration: D,
    render(tt) {
      show(head, tt, 0, D + 1000);
      squares.forEach((q, i) => { const p = prog(tt, sec(1.5) + i * 70, sec(1.5) + i * 70 + 300); q.n.style.opacity = p; q.n.style.transform = `scale(${0.6 + 0.4 * p})`; });
      cap(tt);
    },
  };
}

// ------------------------------------------------------------------- deck clips (final data, video/prepare_clips.py)
const UNIT_NAME = { "cc-sonnet": "Claude Code · Sonnet", "cc-opus": "Claude Code · Opus", codex: "Codex" };

async function oneIntro() {
  const f = await J("/data/clip-facts.json");
  const b = f.one;
  const D = sec(10);
  // one ticket card, the way a team tracker shows it (Alfredo, 2026-10-19: less text, look like a ticket): the service,
  // a short title, the ticket's own two sentences, who it is assigned to and the condition as labels
  const event = (String(b.ticket_text || "").match(/\b(Order[A-Z]\w+)\b/) || [])[1];
  const lines = String(b.ticket_text || "").split(/(?<=\.)\s+/).filter(Boolean);
  const icon = (paths, size, stroke) => S("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke,
    "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round" }, paths.map((d) => S("path", { d })));
  const card = el("div", { class: "ticket" },
    el("div", { class: "meta" },
      el("span", { class: "type" }, icon(["M5 12.5l4.5 4.5L19 7.5"], 22, "#fff")),
      el("span", {}, "orders-service"),
      el("span", { class: "status" }, "To do")),
    el("h2", {}, `${ticketLabel(b.ticket)}${event ? ` in ${event}` : ""}`),
    el("div", { class: "label" }, "Description"),
    el("div", { class: "desc" }, lines.map((l) => el("div", {}, l))),
    el("div", { class: "foot" },
      el("div", {}, el("div", { class: "label" }, "Assignee"),
        el("div", { class: "who" }, el("span", { class: "avatar" },
          icon(["M12 8V4H8", "M6 8h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z", "M2 14h2", "M20 14h2", "M15 13v2", "M9 13v2"], 26, "#2563eb")),
        "Code agent")),
      el("div", {}, el("div", { class: "label" }, "Labels"),
        el("div", { class: "who" }, plainCondition(b.V, b.S).split(" · ").map((x) => el("span", { class: "tag" }, x))))));
  const note = el("div", { class: "unseen" },
    icon(["M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49",
      "M14.084 14.158a3 3 0 0 1-4.242-4.242", "M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143",
      "M2 2l20 20"], 38, "#5b6474"),
    el("span", {}, "Two other teams read these fields. The agent cannot see them."));
  stage.append(card, note);
  const cap = captions([[0.5, 10, "One real run of the experiment, from the ticket to a green CI."]]);
  return { duration: D, render(t) { show(card, t, 0, D + 1000); show(note, t, sec(2.5), D + 1000); cap(t); } };
}

async function oneOracle() {
  const f = await J("/data/clip-facts.json");
  const o = f.one.oracle_gen;
  const D = sec(20);
  const head = topbar("Meanwhile, on that first pull request", "the other teams' own tests · hidden from the agent", [["REAL", "accent"]]);
  const order = ["billing-service", "analytics-ingest", "web-storefront"].filter((k) => o[k]);
  const box = el("div", { class: "card", style: { left: "80px", top: "190px", width: "1760px", padding: "8px 34px" } },
    order.map((k) => el("div", { class: "fact" }, el("div", { class: `dot ${o[k].ok ? "pass" : "fail"}` }),
      el("div", {}, el("div", { class: "t" }, `${k}: ${o[k].tests}${o[k].impact ? ` · ${o[k].impact}` : ""}`),
        o[k].detail ? el("div", { class: "d" }, el("span", { class: "mono" }, o[k].detail)) : null))));
  stage.append(box);
  const rows = [...box.querySelectorAll(".fact")];
  const broke = order.filter((k) => !o[k].ok);
  const cap = captions([
    [0.3, 9, broke.includes("billing-service") ? "The billing team's own tests fail on that first PR: billing could not invoice the order."
      : `${broke.length} of ${order.length} teams' tests fail on that first PR.`],
    [9.5, 20, "The agent never sees these tests. What it gets back is CI's red build."]]);
  return { duration: D, render(t) { show(head, t, 0, D + 1000); show(box, t, 0, D + 1000); rows.forEach((r, i) => show(r, t, sec(0.5 + i * 1.6), D + 1000)); cap(t); } };
}

async function oneOutro() {
  const f = await J("/data/clip-facts.json");
  const b = f.one;
  const D = sec(18);
  const first = (b.ci || []).find((c) => c.attempt === 0) || {};
  const last = (b.ci || []).at(-1) || {};
  const finalOk = Object.values(b.oracle_final || {}).every((v) => v.ok);
  const facts = [
    ["fail", `First pull request: CI blocked it (${(first.failing || []).map((x) => x.id).join(", ")})`,
      (first.failing || []).flatMap((x) => x.lines).map((l) => el("div", { class: "mono" }, l))],
    [last.ok ? "pass" : "fail", `Repair after reading CI's output: CI ${last.ok ? "passed" : "failed"}`,
      (b.deprecated_lines || []).map((l) => el("div", { class: "mono" }, l))],
    [finalOk ? "pass" : "fail", `Final pull request: ${finalOk ? "every team's tests pass" : "a team's tests still fail"}`,
      [el("div", {}, `${outcomeLabel(b.outcome)} · ticket ${String(b.ticket_done || "").replace(/_/g, " ")} · ${b.turns} turns · ${b.minutes} min`)]],
  ];
  const head = topbar("What the run's record says", `${runName(b.run_id)} · CI verdicts · the other teams' tests · diffs`, [["REAL", "accent"]]);
  const box = el("div", { class: "card", style: { left: "80px", top: "170px", width: "1760px", padding: "8px 34px" } },
    facts.map(([k, t, d]) => el("div", { class: "fact" }, el("div", { class: `dot ${k}` }), el("div", {}, el("div", { class: "t" }, t), el("div", { class: "d" }, d)))));
  stage.append(box);
  const rows = [...box.querySelectorAll(".fact")];
  const cap = captions([[0.3, 9, "The repair kept the old names as @deprecated aliases. CI passed."],
    [9, 18, "CI's contract check stopped the break before the merge; the agent fixed it on its own."]]);
  return { duration: D, render(t) { show(head, t, 0, D + 1000); show(box, t, 0, D + 1000); rows.forEach((r, i) => show(r, t, sec(0.4 + i * 1.5), D + 1000)); cap(t); } };
}

async function codexIntro() {
  const f = await J("/data/clip-facts.json");
  const x = f.codex;
  const D = sec(10);
  const card = el("div", { class: "title-card", style: { top: "220px" } },
    el("div", { class: "eyebrow" }, `A real run · ${runName(x.run_id)} · ${UNIT_NAME[x.unit] || x.unit} (${x.model})`),
    el("h2", {}, `${ticketLabel(x.ticket)} · ${plainCondition(x.V, x.S)}`),
    el("p", {}, "The other teams' contracts are copied into its repo, and CI checks them."),
    el("div", { class: "quote", style: { marginTop: "34px" } }, `“${x.ticket_text}”`));
  stage.append(card);
  const cap = captions([[0.5, 10, "Codex, with the other teams' contracts inside its own repo."]]);
  return { duration: D, render(t) { show(card, t, 0, D + 1000); cap(t); } };
}

async function codexOutro() {
  const f = await J("/data/clip-facts.json");
  const x = f.codex;
  const D = sec(15);
  const broke = Object.entries(x.oracle_gen || {}).filter(([, v]) => !v.ok);
  const facts = [
    [x.ci_first_ok ? "pass" : "fail", `CI on the first pull request: ${x.ci_first_ok ? "passed" : "failed"}`, []],
    ["fail", "Gate flags: it edited files the gate depends on",
      (x.flags || []).map((g) => el("div", { class: "mono", title: g.detector }, `${g.path} · ${g.summary || detectorLabel(g.detector)}`))],
    [broke.length ? "fail" : "pass", broke.length ? broke.map(([k, v]) => `${k}: ${v.tests} · ${v.impact}`).join(" · ") : "every team's tests pass",
      broke.map(([, v]) => el("div", { class: "mono" }, v.detail))],
  ];
  const head = topbar("What the run's record says", `${runName(x.run_id)} · CI verdict · gate checks · the other teams' tests`, [["REAL", "accent"]]);
  const box = el("div", { class: "card", style: { left: "80px", top: "170px", width: "1760px", padding: "8px 34px" } },
    facts.map(([k, t, d]) => el("div", { class: "fact" }, el("div", { class: `dot ${k}` }), el("div", {}, el("div", { class: "t" }, t), el("div", { class: "d" }, d)))));
  stage.append(box);
  const rows = [...box.querySelectorAll(".fact")];
  const cap = captions([[0.3, 7.5, "CI passed after it edited the analytics contract and the script that checks contracts."],
    [7.5, 15, "The analytics team's own tests still fail. Green CI, broken consumer."]]);
  return { duration: D, render(t) { show(head, t, 0, D + 1000); show(box, t, 0, D + 1000); rows.forEach((r, i) => show(r, t, sec(0.4 + i * 1.5), D + 1000)); cap(t); } };
}

async function design() {
  const D = sec(30);
  const head = topbar("The experiment", "one ticket, one agent, a clean workspace per run · the same gates for every run", []);
  const condCol = (x, title, rows) => {
    const n = el("div", { class: "card", style: { left: `${x}px`, top: "170px", width: "860px", padding: "22px 28px" } },
      el("div", { style: { fontSize: "30px", fontWeight: 600, marginBottom: "8px" } }, title),
      // plain words only: the condition's short name (labels.js) and what it means; the code stays in data-code
      rows.map(([code, text]) => el("div", { "data-code": code, style: { padding: "12px 0", borderTop: "1px solid var(--linea)" } },
        el("div", { style: { fontSize: "30px", fontWeight: 600, color: "var(--acento)" } }, plainCondition(code)),
        el("div", { style: { fontSize: "25px" } }, text))));
    stage.append(n);
    return n;
  };
  const cv = condCol(80, "What the agent can see", [["V0", "only its own repo (orders-service)"],
    ["V1", "its repo + the other teams' contracts"], ["V2", "all four repos in its workspace"]]);
  const cs = condCol(980, "What its spec says", [["S0", "the ticket + the service README"],
    ["S1", "+ architecture prose"], ["S2", "+ the rules ARCH-1…8 in the spec"]]);
  const gate = el("div", { class: "card", style: { left: "80px", top: "560px", width: "1760px", padding: "22px 28px", fontSize: "27px", lineHeight: "1.45" } },
    el("div", { style: { fontSize: "30px", fontWeight: 600, marginBottom: "6px" } }, "The same gates judge every run"),
    el("div", {}, "CI on the pull request: typecheck, unit tests and ARCH-1…8. A failure blocks the PR and its output goes back to the agent."),
    el("div", { class: "muted" }, "The other teams' own tests run on the PR too. The agent never sees them: they measure real breaks."));
  stage.append(gate);
  const units = el("div", { class: "abs", style: { left: "80px", top: "820px", fontSize: "25px", color: "var(--tinta-2)" } },
    "Agents: Claude Code with Sonnet (some runs with Opus) and Codex (a repeat of the main runs). Each run starts from a clean workspace.");
  stage.append(units);
  const cap = captions([
    [0.3, 10, "The experiment varies what the agent can see and what its spec says."],
    [10, 20, "Then the same gates judge every run: CI on the pull request, and the other teams' own tests."],
    [20, 30, "Every number in the talk comes from these runs' records."],
  ]);
  return { duration: D, render(t) { show(head, t, 0, D + 1000); show(cv, t, sec(0.3), D + 1000); show(cs, t, sec(1.2), D + 1000);
    show(gate, t, sec(10), D + 1000); show(units, t, sec(14), D + 1000); cap(t); } };
}

const SCENES = { company, experiment, breakIntro, breakOutro, stopIntro, stopAnswer, results, oneIntro, oneOracle, oneOutro,
  codexIntro, codexOutro, design };

(async () => {
  try {
    await document.fonts.load("600 40px 'IBM Plex Sans'");
    await document.fonts.load("400 40px 'IBM Plex Sans'");
    await document.fonts.load("500 40px 'IBM Plex Sans'");
    const make = SCENES[q.get("s")];
    if (!make) throw new Error(`unknown scene ${q.get("s")}`);
    const scene = await make();
    await Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((r) => { i.onload = r; i.onerror = r; }))));
    scene.render(0);
    window.SCENE = scene;
    window.READY = true;
  } catch (e) {
    window.SCENE_ERROR = String(e && e.stack || e);
    stage.textContent = window.SCENE_ERROR;
  }
})();
