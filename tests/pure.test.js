import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256String } from "../src/hash.js";
import { isKebab, toKebab, levenshtein, closestMatch } from "../src/kebab.js";
import { countLeaves, countFeatures, formatCounter } from "../src/counters.js";
import {
  defaultMarkers,
  buildMarkerToStatus,
  parseCheckboxLine,
  renderCheckboxLine,
} from "../src/checkbox.js";
import { validateTree, validateIslands, ValidationError } from "../src/validation.js";

test("sha256String stable", () => {
  assert.equal(
    sha256String("hello"),
    "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  );
});

test("isKebab accepts good, rejects bad", () => {
  assert.ok(isKebab("foo-bar"));
  assert.ok(isKebab("foo"));
  assert.ok(isKebab("foo-1-bar"));
  assert.ok(!isKebab("Foo"));
  assert.ok(!isKebab("foo_bar"));
  assert.ok(!isKebab("-foo"));
  assert.ok(!isKebab("foo-"));
  assert.ok(!isKebab(""));
  assert.ok(!isKebab(null));
});

test("toKebab transforms", () => {
  assert.equal(toKebab("Hello World"), "hello-world");
  assert.equal(toKebab("OIDC Login Flow"), "oidc-login-flow");
  assert.equal(toKebab("foo__bar  baz"), "foo-bar-baz");
});

test("levenshtein basic", () => {
  assert.equal(levenshtein("kitten", "sitting"), 3);
  assert.equal(levenshtein("foo", "foo"), 0);
  assert.equal(levenshtein("", "abc"), 3);
});

test("closestMatch picks nearest", () => {
  assert.equal(closestMatch("oidc-login", ["oidc-login-flow", "csrf", "auth"]), "oidc-login-flow");
});

test("countLeaves: leaf node", () => {
  assert.deepEqual(countLeaves({ name: "f", status: "done", children: [] }), { total: 1, done: 1 });
  assert.deepEqual(countLeaves({ name: "f", status: "todo", children: [] }), { total: 1, done: 0 });
});

test("countLeaves: parent rolls up", () => {
  const f = {
    name: "p",
    status: "in_progress",
    children: [
      { name: "a", status: "done", children: [] },
      { name: "b", status: "todo", children: [] },
    ],
  };
  assert.deepEqual(countLeaves(f), { total: 2, done: 1 });
});

test("countFeatures sums across forest", () => {
  const features = [
    { name: "a", status: "done", children: [] },
    { name: "b", status: "todo", children: [{ name: "b1", status: "done", children: [] }] },
  ];
  assert.deepEqual(countFeatures(features), { total: 2, done: 2 });
});

test("formatCounter", () => {
  assert.equal(formatCounter(1, 3), "[1/3]");
});

test("parseCheckboxLine + render round-trip", () => {
  const markers = defaultMarkers();
  const mtos = buildMarkerToStatus(markers);
  const cases = [
    ["- [ ] todo-feature", "todo-feature", "todo", 0],
    ["- [/] in-progress-feature", "in-progress-feature", "in_progress", 0],
    ["- [-] blocked-feature", "blocked-feature", "blocked", 0],
    ["- [x] done-feature", "done-feature", "done", 0],
    ["  - [x] nested", "nested", "done", 2],
  ];
  for (const [line, name, status, indent] of cases) {
    const p = parseCheckboxLine(line, mtos);
    assert.ok(p, `parse failed: ${line}`);
    assert.equal(p.name, name);
    assert.equal(p.status, status);
    assert.equal(p.indent, indent);
    const r = renderCheckboxLine(name, status, markers, indent);
    assert.equal(r, line);
  }
});

test("parseCheckboxLine ignores non-checkbox", () => {
  const mtos = buildMarkerToStatus(defaultMarkers());
  assert.equal(parseCheckboxLine("# heading", mtos), null);
  assert.equal(parseCheckboxLine("plain text", mtos), null);
});

test("parseCheckboxLine flags unknown marker", () => {
  const mtos = buildMarkerToStatus(defaultMarkers());
  const r = parseCheckboxLine("- [?] foo", mtos);
  assert.ok(r);
  assert.equal(r.unknown, true);
  assert.equal(r.status, "todo");
});

test("parseCheckboxLine handles counter suffix", () => {
  const mtos = buildMarkerToStatus(defaultMarkers());
  const r = parseCheckboxLine("- [/] feature-a [1/2]", mtos);
  assert.ok(r);
  assert.equal(r.name, "feature-a");
  assert.equal(r.status, "in_progress");
});

test("validateTree happy path", () => {
  const t = {
    spec: "multi-user-auth",
    specPath: "docs/specs/x.md",
    specHash: "sha256:abc",
    features: [
      {
        name: "oidc-login-flow",
        source: "heading",
        originalHeading: "## OIDC Login",
        status: "todo",
        children: [],
      },
    ],
  };
  assert.equal(validateTree(t), t);
});

test("validateTree rejects bad kebab", () => {
  const t = {
    spec: "Multi User Auth",
    specPath: "x",
    specHash: "sha256:abc",
    features: [],
  };
  assert.throws(() => validateTree(t), ValidationError);
});

test("validateTree rejects duplicate top-level features", () => {
  const t = {
    spec: "ok",
    specPath: "x",
    specHash: "sha256:abc",
    features: [
      { name: "foo", source: "heading", originalHeading: "## A", status: "todo", children: [] },
      { name: "foo", source: "heading", originalHeading: "## B", status: "todo", children: [] },
    ],
  };
  assert.throws(() => validateTree(t), /duplicate/);
});

test("validateIslands happy path", () => {
  const isl = {
    generatedAt: "2026-05-18T00:00:00Z",
    islands: [
      {
        id: "isl_abc123",
        name: "auth-island",
        members: [{ spec: "auth", feature: "login" }],
        dependencies: [],
      },
    ],
  };
  assert.equal(validateIslands(isl), isl);
});

test("validateIslands rejects empty member list", () => {
  const isl = {
    generatedAt: "now",
    islands: [{ id: "isl_a", name: "x", members: [], dependencies: [] }],
  };
  assert.throws(() => validateIslands(isl), /members/);
});

test("validateIslands rejects bad id format", () => {
  const isl = {
    generatedAt: "now",
    islands: [
      { id: "bad", name: "x", members: [{ spec: "a", feature: "b" }], dependencies: [] },
    ],
  };
  assert.throws(() => validateIslands(isl), /id/);
});
