// Pure layout for the catalog graph: services on the left, contracts (APIs and events) on the right, ordered with a
// few barycenter sweeps so related nodes sit near each other. Deterministic: same input, same output.

/** layoutGraph(nodes, edges) → { left: [id…], right: [id…] }  (every node appears exactly once) */
export function layoutGraph(nodes, edges, sweeps = 6) {
  const left = nodes.filter((n) => n.kind === "service").map((n) => n.id).sort();
  const kindRank = { api: 0, event: 1 };
  let right = nodes.filter((n) => n.kind !== "service")
    .sort((a, b) => (kindRank[a.kind] - kindRank[b.kind]) || a.label.localeCompare(b.label)).map((n) => n.id);
  const nbrs = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    if (nbrs.has(e.from) && nbrs.has(e.to)) { nbrs.get(e.from).push(e.to); nbrs.get(e.to).push(e.from); }
  }
  const bary = (id, order) => {
    const idx = nbrs.get(id).map((x) => order.indexOf(x)).filter((i) => i >= 0);
    return idx.length ? idx.reduce((a, b) => a + b, 0) / idx.length : Infinity;
  };
  const reorder = (arr, other) => {
    const keyed = arr.map((id, i) => ({ id, i, b: bary(id, other) }));
    keyed.sort((a, b) => (a.b === b.b ? a.i - b.i : a.b - b.b));
    return keyed.map((k) => k.id);
  };
  let L = left;
  for (let s = 0; s < sweeps; s++) {
    right = reorder(right, L);
    L = reorder(L, right);
  }
  return { left: L, right };
}

/** Cubic path between two points on the left/right columns. */
export function edgePath(x1, y1, x2, y2) {
  const dx = Math.max(40, Math.abs(x2 - x1) * 0.45);
  const s = x2 >= x1 ? 1 : -1;
  return `M${x1} ${y1}C${x1 + s * dx} ${y1} ${x2 - s * dx} ${y2} ${x2} ${y2}`;
}
