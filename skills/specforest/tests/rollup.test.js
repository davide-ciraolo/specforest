import { test } from "node:test";
import assert from "node:assert/strict";
import { rollupNodeStatus, rollupAncestors } from "../src/rollup.js";

function leaf(name, status) {
  return { name, source: "implied", originalHeading: null, status, children: [] };
}

function branch(name, status, children) {
  return { name, source: "heading", originalHeading: `## ${name}`, status, children };
}

test("rollupNodeStatus: leaf keeps its status", () => {
  assert.equal(rollupNodeStatus(leaf("x", "todo")), "todo");
  assert.equal(rollupNodeStatus(leaf("x", "done")), "done");
});

test("rollupNodeStatus: all done → done", () => {
  const n = branch("p", "todo", [leaf("a", "done"), leaf("b", "done")]);
  assert.equal(rollupNodeStatus(n), "done");
});

test("rollupNodeStatus: any blocked → blocked", () => {
  const n = branch("p", "todo", [leaf("a", "done"), leaf("b", "blocked")]);
  assert.equal(rollupNodeStatus(n), "blocked");
});

test("rollupNodeStatus: any done/in_progress mixed → in_progress", () => {
  assert.equal(rollupNodeStatus(branch("p", "todo", [leaf("a", "done"), leaf("b", "todo")])), "in_progress");
  assert.equal(rollupNodeStatus(branch("p", "todo", [leaf("a", "in_progress"), leaf("b", "todo")])), "in_progress");
});

test("rollupNodeStatus: all todo → todo", () => {
  assert.equal(rollupNodeStatus(branch("p", "in_progress", [leaf("a", "todo"), leaf("b", "todo")])), "todo");
});

test("rollupAncestors: propagates through 2 levels", () => {
  const target = leaf("login-screen", "done");
  const af = branch("auth-frontend", "todo", [target, leaf("admin-ui", "done")]);
  const tree = { spec: "auth", features: [af] };
  const changes = rollupAncestors(tree, target);
  assert.equal(af.status, "done");
  assert.equal(changes.length, 1);
  assert.equal(changes[0].name, "auth-frontend");
});

test("rollupAncestors: no change when ancestor already correct", () => {
  const target = leaf("a", "done");
  const p = branch("p", "done", [target]);
  const tree = { spec: "s", features: [p] };
  const changes = rollupAncestors(tree, target);
  assert.equal(changes.length, 0);
});

test("rollupAncestors: blocked overrides done at parent", () => {
  const target = leaf("a", "blocked");
  const p = branch("p", "done", [target, leaf("b", "done")]);
  const tree = { spec: "s", features: [p] };
  rollupAncestors(tree, target);
  assert.equal(p.status, "blocked");
});
