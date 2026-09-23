import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeDefaultConfig, loadConfig } from "../src/config.js";
import { paths } from "../src/paths.js";
import { writeTree } from "../src/tree-io.js";
import { cmdCi } from "../src/commands/ci.js";

// Coverage target: src/commands/ci.js's argument-validation and error paths
// (USAGE/--help, missing '--' target, malformed target, unknown spec, and a
// declined ambiguous target). Every one of these branches returns BEFORE
// `runCommand` is ever invoked, so none of these tests spawn a real child
// process — a placeholder token after `--` is never executed.

function collector() {
  return { buf: "", write(s) { this.buf += s; } };
}

const leaf = (name, status = "todo") => ({
  name, source: "heading", originalHeading: `## ${name}`, status, children: [],
});

async function ciProject() {
  const root = await mkdtemp(path.join(tmpdir(), "sf-ci-"));
  await writeDefaultConfig(root);
  const config = await loadConfig(root);
  const p = paths(root, config);
  await writeTree(p.treesDir, {
    spec: "auth",
    specPath: "docs/specs/auth.md",
    specHash: "sha256:x",
    features: [
      { name: "login", source: "heading", originalHeading: "## login", status: "todo", children: [leaf("form")] },
    ],
  });
  return { root, config, p };
}

async function ciAmbiguousProject() {
  const root = await mkdtemp(path.join(tmpdir(), "sf-ci-ambig-"));
  await writeDefaultConfig(root);
  const config = await loadConfig(root);
  const p = paths(root, config);
  await writeTree(p.treesDir, {
    spec: "auth",
    specPath: "docs/specs/auth.md",
    specHash: "sha256:x",
    features: [
      { name: "a", source: "heading", originalHeading: "## a", status: "todo", children: [leaf("dup")] },
      { name: "b", source: "heading", originalHeading: "## b", status: "todo", children: [leaf("dup")] },
    ],
  });
  return { root, config, p };
}

test("ci --help before the '--' separator writes USAGE to stdout and exits 0, without needing a target", async () => {
  const out = collector();
  const err = collector();
  const code = await cmdCi({ cwd: process.cwd(), args: ["--help"], stdin: null, stdout: out, stderr: err });
  assert.equal(code, 0);
  assert.equal(out.buf, "usage: specforest ci <spec>/<feature-path> -- <command> [args…]\n");
  assert.equal(err.buf, "");
});

test("ci -h (short flag) also writes USAGE to stdout and exits 0", async () => {
  const out = collector();
  const err = collector();
  const code = await cmdCi({ cwd: process.cwd(), args: ["-h"], stdin: null, stdout: out, stderr: err });
  assert.equal(code, 0);
  assert.match(out.buf, /^usage: specforest ci/);
});

test("ci with no bare target before '--' exits 1 with 'missing target' and USAGE on stderr", async () => {
  const out = collector();
  const err = collector();
  const code = await cmdCi({ cwd: process.cwd(), args: ["--", "noop"], stdin: null, stdout: out, stderr: err });
  assert.equal(code, 1);
  assert.equal(err.buf, "missing target\nusage: specforest ci <spec>/<feature-path> -- <command> [args…]\n");
  assert.equal(out.buf, "");
});

test("ci with a malformed target (no spec/feature slash) exits 1 with the parseTarget error", async () => {
  const out = collector();
  const err = collector();
  const code = await cmdCi({ cwd: process.cwd(), args: ["bogus", "--", "noop"], stdin: null, stdout: out, stderr: err });
  assert.equal(code, 1);
  assert.equal(err.buf, "bad target: bogus; expected <spec>/<feature-path>\n");
});

test("ci naming a spec with no tree JSON exits 1 with 'spec not found'", async () => {
  const { root } = await ciProject();
  try {
    const out = collector();
    const err = collector();
    const code = await cmdCi({ cwd: root, args: ["nospec/foo", "--", "noop"], stdin: null, stdout: out, stderr: err });
    assert.equal(code, 1);
    assert.equal(err.buf, "spec not found: nospec\n");
    assert.equal(out.buf, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ci on an ambiguous single-name target aborts with exit 1 when declined (non-interactive stdin)", async () => {
  const { root } = await ciAmbiguousProject();
  try {
    const out = collector();
    const err = collector();
    const code = await cmdCi({ cwd: root, args: ["auth/dup", "--", "noop"], stdin: null, stdout: out, stderr: err });
    assert.equal(code, 1);
    assert.match(err.buf, /ambiguous: "dup" matches 2 nodes:/);
    assert.match(err.buf, /auth\/a\/dup/);
    assert.match(err.buf, /auth\/b\/dup/);
    assert.match(err.buf, /aborted: ambiguous target\n$/);
    assert.equal(out.buf, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
