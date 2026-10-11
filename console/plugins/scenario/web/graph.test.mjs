import test from "node:test";
import assert from "node:assert/strict";
import { layoutGraph, edgePath } from "./graph.js";

const nodes = [
  { id: "svc:a", kind: "service", label: "a" }, { id: "svc:b", kind: "service", label: "b" }, { id: "svc:c", kind: "service", label: "c" },
  { id: "api:x", kind: "api", label: "x" }, { id: "evt:E", kind: "event", label: "E" }, { id: "evt:F", kind: "event", label: "F" },
];
const edges = [
  { from: "svc:a", to: "evt:E", type: "provides" }, { from: "evt:E", to: "svc:b", type: "consumes" },
  { from: "svc:c", to: "api:x", type: "provides" }, { from: "api:x", to: "svc:a", type: "dependsOn" },
];

test("every node appears exactly once", () => {
  const { left, right } = layoutGraph(nodes, edges);
  assert.deepEqual([...left, ...right].sort(), nodes.map((n) => n.id).sort());
});
test("deterministic", () => {
  assert.deepEqual(layoutGraph(nodes, edges), layoutGraph(nodes.slice().reverse(), edges.slice().reverse()));
});
test("isolated nodes go last, nothing is dropped", () => {
  const { right } = layoutGraph(nodes, edges);
  assert.equal(right[right.length - 1], "evt:F");
});
test("edgePath is a cubic between the two points", () => {
  assert.match(edgePath(10, 20, 300, 80), /^M10 20C.* 300 80$/);
});
