import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, stat, utimes, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { writeDefaultConfig, loadConfig } from "../src/config.js";
import { paths } from "../src/paths.js";
import { writeTree } from "../src/tree-io.js";
import { writeIslands } from "../src/islands-io.js";
import { sha256File } from "../src/hash.js";
import { writeState } from "../src/state.js";
import { cmdTree } from "../src/commands/tree.js";
import { cmdMark } from "../src/commands/mark.js";
import {
  extractSpecBlockFromCache,
  renderFullTreeAscii,
} from "../src/tree-cache.js";
import { defaultMarkers } from "../src/checkbox.js";

function collector() {
  return { buf: "", write(s) { this.buf += s; } };
}

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "sf-tree-cache-"));
  await writeDefaultConfig(root);
  const config = await loadConfig(root);
  const p = paths(root, config);
  await mkdir(p.specsDir, { recursive: true });
  await mkdir(p.treesDir, { recursive: true });
  await mkdir(p.outputDir, { recursive: true });
  return { root, config, p };
}

function tree(name, features) {
  return {
    spec: name,
    specPath: `docs/specs/${name}.md`,
    specHash: "sha256:" + "0".repeat(64),
    features,
  };
}

function feat(name, status, children = []) {
  return { name, source: "heading", originalHeading: `## ${name}`, status, children };
}

async function seedAuthDashboard(root, p) {
  await writeFile(path.join(p.specsDir, "auth.md"), "# auth\n", "utf8");
  await writeFile(path.join(p.specsDir, "dashboard.md"), "# dashboard\n", "utf8");
  const authHash = await sha256File(path.join(p.specsDir, "auth.md"));
  const dashHash = await sha256File(path.join(p.specsDir, "dashboard.md"));
  await writeTree(p.treesDir, tree("auth", [
    feat("login", "todo"),
    feat("logout", "done"),
  ]));
  await writeTree(p.treesDir, tree("dashboard", [
    feat("widget-grid", "in_progress", [feat("chart", "todo"), feat("table", "done")]),
  ]));
  await writeIslands(p.islands, {
    generatedAt: "2026-05-20T00:00:00Z",
    islands: [
      {
        id: "isl_aaaaaa",
        name: "auth-and-dashboard",
        members: [
          { spec: "auth", feature: "login" },
          { spec: "auth", feature: "logout" },
          { spec: "dashboard", feature: "widget-grid" },
        ],
        dependencies: [],
      },
    ],
  });
  await writeState(p.state, {
    lastSync: null,
    lastRender: null,
    specHashes: { auth: authHash, dashboard: dashHash },
    islandIdMap: {},
    orphanedProgress: {},
    lastClusteredStructure: null,
  });
}

test("tree first call creates cache file", async () => {
  const { root, p } = await setup();
  try {
    await seedAuthDashboard(root, p);
    const stdout = collector();
    const stderr = collector();
    const code = await cmdTree({ cwd: root, args: [], stdout, stderr });
    assert.equal(code, 0);
    const cache = await readFile(p.treeCache, "utf8");
    assert.ok(cache.startsWith("forest [2/4]"));
    assert.match(cache, /auth-and-dashboard/);
    assert.match(cache, /\[x\] logout/);
    assert.match(cache, /\[\/\] widget-grid/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tree second call reuses cache (mtime unchanged)", async () => {
  const { root, p } = await setup();
  try {
    await seedAuthDashboard(root, p);
    await cmdTree({ cwd: root, args: [], stdout: collector(), stderr: collector() });
    const past = new Date(Date.now() + 5000);
    await utimes(p.treeCache, past, past);
    const mtBefore = (await stat(p.treeCache)).mtimeMs;
    await cmdTree({ cwd: root, args: [], stdout: collector(), stderr: collector() });
    const mtAfter = (await stat(p.treeCache)).mtimeMs;
    assert.equal(mtAfter, mtBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tree --regenerate rewrites cache even when fresh", async () => {
  const { root, p } = await setup();
  try {
    await seedAuthDashboard(root, p);
    await cmdTree({ cwd: root, args: [], stdout: collector(), stderr: collector() });
    const future = new Date(Date.now() + 60000);
    await utimes(p.treeCache, future, future);
    const mtBefore = (await stat(p.treeCache)).mtimeMs;
    await cmdTree({ cwd: root, args: ["--regenerate"], stdout: collector(), stderr: collector() });
    const mtAfter = (await stat(p.treeCache)).mtimeMs;
    assert.ok(mtAfter < mtBefore, "regenerate should overwrite future-dated cache with now");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mark refreshes tree cache content", async () => {
  const { root, p } = await setup();
  try {
    await seedAuthDashboard(root, p);
    await cmdTree({ cwd: root, args: [], stdout: collector(), stderr: collector() });
    const before = await readFile(p.treeCache, "utf8");
    assert.match(before, /\[ \] login/);
    await cmdMark({ cwd: root, args: ["auth/login", "done"], stdout: collector(), stderr: collector() });
    const after = await readFile(p.treeCache, "utf8");
    assert.match(after, /\[x\] login/);
    assert.match(after, /forest \[3\/4\]/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("per-spec tree uses cache slice (no live re-render)", async () => {
  const { root, p } = await setup();
  try {
    await seedAuthDashboard(root, p);
    await cmdTree({ cwd: root, args: [], stdout: collector(), stderr: collector() });
    const past = new Date(Date.now() + 5000);
    await utimes(p.treeCache, past, past);
    const mtBefore = (await stat(p.treeCache)).mtimeMs;
    const stdout = collector();
    const code = await cmdTree({ cwd: root, args: ["auth"], stdout, stderr: collector() });
    assert.equal(code, 0);
    assert.match(stdout.buf, /auth-and-dashboard \/ auth \[1\/2\]/);
    assert.match(stdout.buf, /\[ \] login/);
    assert.match(stdout.buf, /\[x\] logout/);
    const mtAfter = (await stat(p.treeCache)).mtimeMs;
    assert.equal(mtAfter, mtBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stale cache (input newer than cache) triggers regen", async () => {
  const { root, p } = await setup();
  try {
    await seedAuthDashboard(root, p);
    await cmdTree({ cwd: root, args: [], stdout: collector(), stderr: collector() });
    const cacheMt = (await stat(p.treeCache)).mtimeMs;
    const future = new Date(cacheMt + 10000);
    await utimes(path.join(p.treesDir, "auth.json"), future, future);
    await cmdTree({ cwd: root, args: [], stdout: collector(), stderr: collector() });
    const mtAfter = (await stat(p.treeCache)).mtimeMs;
    assert.ok(mtAfter >= cacheMt, "cache should be rewritten");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("extracted spec view matches live single-spec render", async () => {
  const { root, config, p } = await setup();
  try {
    await seedAuthDashboard(root, p);
    const full = await renderFullTreeAscii({ config, p });
    const sliced = extractSpecBlockFromCache(full, "dashboard", config.checkboxMarkers);
    assert.ok(sliced);
    assert.match(sliced, /auth-and-dashboard \/ dashboard \[1\/2\]/);
    assert.match(sliced, /\[\/\] widget-grid/);
    assert.match(sliced, /\[ \] chart/);
    assert.match(sliced, /\[x\] table/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("extractSpecBlockFromCache returns null for unknown spec", () => {
  const cache = [
    "forest [0/1]",
    "└── solo [0/1]",
    "    └── lone",
    "        └── [ ] item",
  ].join("\n");
  const r = extractSpecBlockFromCache(cache, "missing", defaultMarkers());
  assert.equal(r, null);
});
