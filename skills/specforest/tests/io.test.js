import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { defaultConfig, loadConfig, writeDefaultConfig, validateConfig } from "../src/config.js";
import { paths } from "../src/paths.js";
import { readState, writeState, emptyState, updateState } from "../src/state.js";
import { findSpecs, specNameFromRel } from "../src/glob.js";
import { acquireLock, releaseLock } from "../src/lock.js";
import {
  writeTree,
  readTree,
  archiveTree,
  collectStatuses,
  applyStatuses,
  isSubFeatureName,
  findParentTopLevel,
} from "../src/tree-io.js";
import { reconcileIds, newIslandId, readIslands, writeIslands } from "../src/islands-io.js";
import { recordTransitions } from "../src/timings-io.js";

async function tmpProject() {
  return mkdtemp(path.join(tmpdir(), "sf-test-"));
}

test("defaultConfig validates", () => {
  assert.ok(validateConfig(defaultConfig()));
});

test("loadConfig errors when missing", async () => {
  const dir = await tmpProject();
  try {
    await assert.rejects(loadConfig(dir), /ENOENT_CONFIG|not found/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeDefaultConfig then loadConfig roundtrip", async () => {
  const dir = await tmpProject();
  try {
    const r = await writeDefaultConfig(dir);
    assert.equal(r.created, true);
    const c = await loadConfig(dir);
    assert.equal(c.specsDir, "docs/specs");
    assert.equal(c.maxDepth, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeDefaultConfig idempotent", async () => {
  const dir = await tmpProject();
  try {
    await writeDefaultConfig(dir);
    const r = await writeDefaultConfig(dir);
    assert.equal(r.created, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("paths derives all keys", () => {
  const c = defaultConfig();
  const p = paths("/proj", c);
  assert.ok(p.specsDir.includes("docs/specs") || p.specsDir.includes("docs\\specs"));
  assert.ok(p.hiddenDir.endsWith(".specforest"));
  assert.ok(p.treesDir.endsWith(path.join(".specforest", "trees")));
});

test("timings defaults to true and survives a config without the key", async () => {
  const dir = await tmpProject();
  try {
    await writeFile(
      path.join(dir, "specforest.config.yml"),
      "specsDir: docs/specs\noutputDir: docs/trees\nhiddenDir: .specforest\n",
      "utf8",
    );
    const c = await loadConfig(dir);
    assert.equal(c.timings, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("explicit timings: false in a config file survives the merge", async () => {
  const dir = await tmpProject();
  try {
    await writeFile(
      path.join(dir, "specforest.config.yml"),
      "specsDir: docs/specs\noutputDir: docs/trees\nhiddenDir: .specforest\ntimings: false\n",
      "utf8",
    );
    const c = await loadConfig(dir);
    assert.equal(c.timings, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("timings must be a boolean and can be disabled", async () => {
  const dir = await tmpProject();
  try {
    await writeDefaultConfig(dir);
    const c = await loadConfig(dir);
    assert.equal(c.timings, true);
    const p = paths("/proj", c);
    assert.ok(p.timings.endsWith(path.join(".specforest", "timings.jsonl")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  assert.throws(() => validateConfig({ ...defaultConfig(), timings: "yes" }), /timings must be a boolean/);
  assert.ok(validateConfig({ ...defaultConfig(), timings: false }));
});

test("state roundtrip", async () => {
  const dir = await tmpProject();
  try {
    const p = path.join(dir, "state.json");
    const empty = await readState(p);
    assert.deepEqual(empty, emptyState());
    empty.specHashes.foo = "sha256:abc";
    await writeState(p, empty);
    const read = await readState(p);
    assert.equal(read.specHashes.foo, "sha256:abc");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("updateState applies mutator", async () => {
  const dir = await tmpProject();
  try {
    const p = path.join(dir, "state.json");
    await updateState(p, (s) => {
      s.lastSync = "2026-05-18";
    });
    const r = await readState(p);
    assert.equal(r.lastSync, "2026-05-18");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("findSpecs walks dir and matches glob", async () => {
  const dir = await tmpProject();
  try {
    await mkdir(path.join(dir, "specs", "sub"), { recursive: true });
    await writeFile(path.join(dir, "specs", "a.md"), "# A");
    await writeFile(path.join(dir, "specs", "sub", "b.md"), "# B");
    await writeFile(path.join(dir, "specs", "skip.txt"), "ignore me");
    const found = await findSpecs(path.join(dir, "specs"), "**/*.md", []);
    assert.equal(found.length, 2);
    assert.deepEqual(
      found.map((f) => f.rel).sort(),
      ["a.md", "sub/b.md"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("findSpecs respects ignore", async () => {
  const dir = await tmpProject();
  try {
    await mkdir(path.join(dir, "specs"), { recursive: true });
    await writeFile(path.join(dir, "specs", "a.md"), "# A");
    await writeFile(path.join(dir, "specs", "drafts.md"), "# D");
    const found = await findSpecs(path.join(dir, "specs"), "**/*.md", ["drafts.md"]);
    assert.deepEqual(found.map((f) => f.rel), ["a.md"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("specNameFromRel strips ext", () => {
  assert.equal(specNameFromRel("2026-05-13-multi-user-auth-design.md"), "2026-05-13-multi-user-auth-design");
  assert.equal(specNameFromRel("sub/foo.md"), "foo");
});

test("lock acquire + release", async () => {
  const dir = await tmpProject();
  try {
    const lp = path.join(dir, "sync.lock");
    assert.equal(await acquireLock(lp), true);
    assert.equal(await acquireLock(lp), false);
    await releaseLock(lp);
    assert.equal(await acquireLock(lp), true);
    await releaseLock(lp);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function sampleTree(name) {
  return {
    spec: name,
    specPath: `docs/specs/${name}.md`,
    specHash: "sha256:" + "0".repeat(64),
    features: [
      {
        name: "feat-a",
        source: "heading",
        originalHeading: "## Feat A",
        status: "todo",
        children: [
          { name: "sub-a-1", source: "heading", originalHeading: "### Sub", status: "done", children: [] },
        ],
      },
      { name: "feat-b", source: "implied", originalHeading: null, status: "in_progress", children: [] },
    ],
  };
}

test("writeTree + readTree", async () => {
  const dir = await tmpProject();
  try {
    const treesDir = path.join(dir, "trees");
    const t = sampleTree("alpha");
    await writeTree(treesDir, t);
    const back = await readTree(treesDir, "alpha");
    assert.deepEqual(back, t);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("archiveTree moves the file", async () => {
  const dir = await tmpProject();
  try {
    const treesDir = path.join(dir, "trees");
    const archiveDir = path.join(dir, "archive");
    const t = sampleTree("alpha");
    await writeTree(treesDir, t);
    const dst = await archiveTree(treesDir, archiveDir, "alpha");
    assert.ok(dst);
    assert.equal(await readTree(treesDir, "alpha"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("collectStatuses + applyStatuses round-trip", () => {
  const t = sampleTree("a");
  const before = collectStatuses(t);
  assert.equal(before.get("feat-a"), "todo");
  assert.equal(before.get("sub-a-1"), "done");
  const t2 = sampleTree("a");
  t2.features[0].status = "todo";
  t2.features[0].children[0].status = "todo";
  applyStatuses(t2, before);
  assert.equal(t2.features[0].children[0].status, "done");
});

test("isSubFeatureName + findParentTopLevel", () => {
  const t = sampleTree("a");
  assert.equal(isSubFeatureName(t, "feat-a"), false);
  assert.equal(isSubFeatureName(t, "sub-a-1"), true);
  assert.equal(findParentTopLevel(t, "sub-a-1"), "feat-a");
});

test("reconcileIds: no previous islands assigns new", () => {
  const next = [{ id: "tmp", name: "alpha", members: [{ spec: "s", feature: "f" }], dependencies: [] }];
  const r = reconcileIds(next, null);
  assert.ok(r[0].id.startsWith("isl_"));
});

test("reconcileIds: reuses largest-overlap previous id", () => {
  const prev = {
    generatedAt: "x",
    islands: [
      { id: "isl_old1", name: "a", members: [{ spec: "s", feature: "x" }, { spec: "s", feature: "y" }], dependencies: [] },
      { id: "isl_old2", name: "b", members: [{ spec: "s", feature: "z" }], dependencies: [] },
    ],
  };
  const next = [
    { id: "tmp", name: "renamed-a", members: [{ spec: "s", feature: "x" }, { spec: "s", feature: "y" }], dependencies: [] },
    { id: "tmp", name: "renamed-b", members: [{ spec: "s", feature: "z" }], dependencies: [] },
  ];
  const r = reconcileIds(next, prev);
  assert.equal(r[0].id, "isl_old1");
  assert.equal(r[1].id, "isl_old2");
});

test("reconcileIds: ID retired when no overlap", () => {
  const prev = {
    generatedAt: "x",
    islands: [{ id: "isl_old1", name: "a", members: [{ spec: "s", feature: "x" }], dependencies: [] }],
  };
  const next = [{ id: "tmp", name: "fresh", members: [{ spec: "s", feature: "y" }], dependencies: [] }];
  const r = reconcileIds(next, prev);
  assert.notEqual(r[0].id, "isl_old1");
});

test("newIslandId format", () => {
  const id = newIslandId();
  assert.match(id, /^isl_[a-f0-9]{6}$/);
});

test("readIslands missing → null; writeIslands → readIslands", async () => {
  const dir = await tmpProject();
  try {
    const p = path.join(dir, "islands.json");
    assert.equal(await readIslands(p), null);
    const isl = {
      generatedAt: "2026-05-18T00:00:00Z",
      islands: [{ id: "isl_abc123", name: "x", members: [{ spec: "s", feature: "f" }], dependencies: [] }],
    };
    await writeIslands(p, isl);
    const back = await readIslands(p);
    assert.deepEqual(back, isl);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- recordTransitions (plural) — timings design §2.4 ---
//
// A cascade is one logical event: every crossing it produces must land in a
// single append, so a crash cannot leave a half-written cascade behind.

test("recordTransitions writes every crossing in one append", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "rt-"));
  const log = path.join(dir, "timings.jsonl");
  try {
    const written = await recordTransitions({
      enabled: true,
      timingsPath: log,
      changes: [
        { fullPath: "auth/login/form", from: "todo", to: "in_progress" },
        { fullPath: "auth/login", from: "todo", to: "in_progress" },
        { fullPath: "auth/other", from: "todo", to: "done" }, // no crossing
      ],
      source: "cli",
      ts: "2026-09-23T10:00:00.000Z",
    });
    assert.equal(written.length, 2);
    const lines = (await readFile(log, "utf8")).trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).target, "auth/login/form");
    assert.equal(JSON.parse(lines[1]).target, "auth/login");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recordTransitions writes nothing when disabled", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "rt-"));
  const log = path.join(dir, "timings.jsonl");
  try {
    assert.deepEqual(
      await recordTransitions({
        enabled: false,
        timingsPath: log,
        changes: [{ fullPath: "a/b", from: "todo", to: "in_progress" }],
        source: "cli",
      }),
      [],
    );
    await assert.rejects(readFile(log, "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
