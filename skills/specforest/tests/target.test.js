import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTarget, resolveTargetNode } from "../src/target.js";

function tree() {
  return {
    spec: "auth",
    specPath: "docs/specs/auth.md",
    specHash: "sha256:abc",
    features: [
      {
        name: "auth-frontend",
        source: "heading",
        originalHeading: "## auth-frontend",
        status: "todo",
        children: [
          { name: "login-screen", source: "implied", originalHeading: null, status: "todo", children: [] },
          { name: "admin-ui", source: "implied", originalHeading: null, status: "todo", children: [] },
        ],
      },
      {
        name: "data-model",
        source: "heading",
        originalHeading: "## data-model",
        status: "todo",
        children: [
          { name: "users-table", source: "implied", originalHeading: null, status: "todo", children: [] },
        ],
      },
    ],
  };
}

test("parseTarget rejects empty / single-segment", () => {
  assert.ok(parseTarget("").error);
  assert.ok(parseTarget("auth").error);
});

test("parseTarget splits spec and segments", () => {
  const r = parseTarget("auth/auth-frontend/login-screen");
  assert.equal(r.spec, "auth");
  assert.deepEqual(r.segments, ["auth-frontend", "login-screen"]);
});

test("resolveTargetNode walks full path", () => {
  const t = tree();
  const r = resolveTargetNode(t, ["auth-frontend", "login-screen"]);
  assert.equal(r.node.name, "login-screen");
  assert.equal(r.topLevel.name, "auth-frontend");
  assert.equal(r.fullPath, "auth-frontend/login-screen");
});

test("resolveTargetNode resolves single segment to top-level", () => {
  const t = tree();
  const r = resolveTargetNode(t, ["auth-frontend"]);
  assert.equal(r.node.name, "auth-frontend");
  assert.equal(r.fullPath, "auth-frontend");
});

test("resolveTargetNode resolves single segment by leaf name", () => {
  const t = tree();
  const r = resolveTargetNode(t, ["login-screen"]);
  assert.equal(r.node.name, "login-screen");
  assert.equal(r.topLevel.name, "auth-frontend");
  assert.equal(r.fullPath, "auth-frontend/login-screen");
});

test("resolveTargetNode reports ambiguity", () => {
  const t = tree();
  t.features[1].children.push({ name: "login-screen", source: "implied", originalHeading: null, status: "todo", children: [] });
  const r = resolveTargetNode(t, ["login-screen"]);
  assert.equal(r.ambiguous, true);
  assert.equal(r.matches.length, 2);
});

test("resolveTargetNode returns hint on bad path", () => {
  const t = tree();
  const r = resolveTargetNode(t, ["auth-frontend", "lgoin-screen"]);
  assert.ok(r.error);
  assert.match(r.error, /path not found/);
  assert.match(r.error, /login-screen/);
});

test("resolveTargetNode returns hint on unknown top-level", () => {
  const t = tree();
  const r = resolveTargetNode(t, ["auth-frnotend", "login-screen"]);
  assert.ok(r.error);
  assert.match(r.error, /top-level feature not found/);
});
