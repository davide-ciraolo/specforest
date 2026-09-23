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
  regenAndWriteTreeCache,
  isTreeCacheStale,
} from "../src/tree-cache.js";
import { appendEvents } from "../src/timings-io.js";
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

test("renderFullTreeAscii annotates islands and feature nodes but never spec lines", async () => {
  const { root, config, p } = await setup();
  try {
    await seedAuthDashboard(root, p);
    await appendEvents(p.timings, [
      { ts: "2026-09-21T09:00:00.000Z", event: "start", target: "auth/login", source: "cli" },
      { ts: "2026-09-21T09:31:00.000Z", event: "ci", target: "auth/login", ms: 1872000, cmd: "npm test", exit: 0 },
      { ts: "2026-09-21T11:41:00.000Z", event: "stop", target: "auth/login", to: "done", source: "cli" },
    ]);
    const ascii = await renderFullTreeAscii({ config, p });
    const lines = ascii.split("\n");

    const islandLine = lines.find((l) => l.includes("auth-and-dashboard"));
    assert.match(islandLine, /auth-and-dashboard \[2\/4\]  2h 41m \(ci 31m 12s\)/);

    const specLine = lines.find((l) => l.trimStart().replace(/^[├└]── /, "") === "auth");
    assert.ok(specLine, "spec line must exist");
    assert.ok(specLine.trimEnd().endsWith("auth"), `spec line must carry no annotation: ${specLine}`);

    const leafLine = lines.find((l) => / login(\s|$)/.test(l));
    assert.match(leafLine, / login {2}2h 41m \(ci 31m 12s\)$/);

    // logout has no recorded time, so it keeps its original line exactly
    const otherLine = lines.find((l) => / logout(\s|$)/.test(l));
    assert.ok(otherLine.trimEnd().endsWith("logout"), `unrecorded leaf must not be annotated: ${otherLine}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("extractSpecBlockFromCache still counts leaves once parents carry annotations", () => {
  const cache = [
    "forest [1/2]",
    "└── auth-and-dashboard [1/2]  2h 41m",
    "    └── auth",
    "        └── [/] login [1/2]  2h 41m (ci 31m 12s)",
    "            ├── [x] form  2h 41m (ci 31m 12s)",
    "            └── [ ] validation",
  ].join("\n");
  const block = extractSpecBlockFromCache(cache, "auth", defaultMarkers());
  assert.match(block, /^auth-and-dashboard \/ auth \[1\/2\]$/m);
  assert.match(block, /\[x\] form/);
});

test("tree output is byte-identical when timings is disabled in config, even with a populated log (FIX 4)", async () => {
  const { root, p } = await setup();
  try {
    await seedAuthDashboard(root, p);
    const withTimings = collector();
    await cmdTree({ cwd: root, args: ["--print"], stdout: withTimings, stderr: collector() });

    await appendEvents(p.timings, [
      { ts: "2026-09-21T09:00:00.000Z", event: "start", target: "auth/login", source: "cli" },
      { ts: "2026-09-21T11:41:00.000Z", event: "stop", target: "auth/login", to: "done", source: "cli" },
    ]);
    // Edit the existing key in place — appending a second `timings:` key
    // would throw a duplicate-mapping-key YAMLException (js-yaml rejects
    // duplicate keys). Mirrors status.js's F5 test.
    const cfgPath = path.join(root, "specforest.config.yml");
    const rawCfg = await readFile(cfgPath, "utf8");
    await writeFile(cfgPath, rawCfg.replace("timings: true", "timings: false"), "utf8");

    const disabled = collector();
    const code = await cmdTree({ cwd: root, args: ["--regenerate", "--print"], stdout: disabled, stderr: collector() });
    assert.equal(code, 0);
    assert.equal(disabled.buf, withTimings.buf);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("per-spec tree live render includes timing annotations when no cache is present yet (FIX 5)", async () => {
  const { root, p } = await setup();
  try {
    await seedAuthDashboard(root, p);
    await appendEvents(p.timings, [
      { ts: "2026-09-21T09:00:00.000Z", event: "start", target: "auth/login", source: "cli" },
      { ts: "2026-09-21T11:41:00.000Z", event: "stop", target: "auth/login", to: "done", source: "cli" },
    ]);
    // No prior cmdTree call here on purpose: readTreeCache(p) must return null
    // so cmdTree's specArg branch cannot take the cache-slice shortcut and is
    // forced down the LIVE renderSingleSpecAscii path.
    const stdout = collector();
    const code = await cmdTree({ cwd: root, args: ["auth"], stdout, stderr: collector() });
    assert.equal(code, 0);
    assert.match(stdout.buf, / login {2}2h 41m$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tree --regenerate still renders and warns on stderr when the timings log is unreadable (FIX 6, EISDIR)", async () => {
  const { root, p } = await setup();
  try {
    await seedAuthDashboard(root, p);
    // Reproduces EISDIR: make the timings log path a directory instead of a
    // file, mirroring the fixture already used for the `status`/`ci`/`timings`
    // EISDIR regressions.
    await mkdir(p.timings, { recursive: true });

    const stdout = collector();
    const stderr = collector();
    const code = await cmdTree({ cwd: root, args: ["--regenerate", "--print"], stdout, stderr });
    assert.equal(code, 0);
    assert.match(stdout.buf, /^forest \[/);
    assert.match(stderr.buf, /warning: could not read timings log/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("extracted spec view matches live single-spec render, including timing annotations (FIX 7)", async () => {
  const { root, config, p } = await setup();
  try {
    await seedAuthDashboard(root, p);
    await appendEvents(p.timings, [
      { ts: "2026-09-21T09:00:00.000Z", event: "start", target: "auth/login", source: "cli" },
      { ts: "2026-09-21T11:41:00.000Z", event: "stop", target: "auth/login", to: "done", source: "cli" },
    ]);
    const full = await renderFullTreeAscii({ config, p });
    const sliced = extractSpecBlockFromCache(full, "auth", config.checkboxMarkers);
    assert.ok(sliced);

    const stdout = collector();
    const code = await cmdTree({ cwd: root, args: ["auth"], stdout, stderr: collector() });
    assert.equal(code, 0);
    assert.equal(stdout.buf.trimEnd(), sliced);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("isTreeCacheStale reacts to a newer timings log", async () => {
  const { root, config, p } = await setup();
  try {
    await seedAuthDashboard(root, p);
    await regenAndWriteTreeCache({ config, p });
    assert.equal(await isTreeCacheStale(p), false);
    await appendEvents(p.timings, [{ ts: "2026-09-21T09:00:00.000Z", event: "start", target: "auth/login", source: "cli" }]);
    // Deterministic instead of a sleep: filesystem mtime granularity can exceed a
    // short sleep on Windows. Advance ONLY the timings log rather than backdating
    // the cache — backdating the cache makes islands.json/state.json/the tree JSONs
    // newer than it as well, so the assertion below would pass even if p.timings
    // were absent from isTreeCacheStale's input list.
    const future = new Date(Date.now() + 60_000);
    await utimes(p.timings, future, future);
    assert.equal(await isTreeCacheStale(p), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("isTreeCacheStale detects an open timing interval even when no input mtime changed (FIX 3)", async () => {
  const { root, config, p } = await setup();
  try {
    await seedAuthDashboard(root, p);
    // Write the open interval BEFORE the cache is generated, so the cache's own
    // mtime ends up newer than p.timings — the plain mtime-input scan above
    // (which already includes p.timings in its `inputs` list) must NOT be able
    // to explain a `true` result here. Only the open-interval scan added by
    // FIX 3 can: it re-reads the log and checks `deriveTotals(...).open`
    // regardless of any file mtime.
    await appendEvents(p.timings, [
      { ts: "2026-09-21T09:00:00.000Z", event: "start", target: "auth/login", source: "cli" },
    ]);
    await regenAndWriteTreeCache({ config, p });
    // Passing `config` is load-bearing: isTreeCacheStale(p) alone only does the
    // mtime scan and would report `false` here.
    assert.equal(await isTreeCacheStale(p, config), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("isTreeCacheStale ignores an open interval left behind once timings is disabled (FIX 3, no-regression)", async () => {
  const { root, config, p } = await setup();
  try {
    await seedAuthDashboard(root, p);
    await appendEvents(p.timings, [
      { ts: "2026-09-21T09:00:00.000Z", event: "start", target: "auth/login", source: "cli" },
    ]);
    await regenAndWriteTreeCache({ config, p });

    // Edit the existing key in place — appending a second `timings:` key would
    // throw a duplicate-mapping-key YAMLException (js-yaml rejects duplicate
    // keys). Mirrors the FIX 4 / status.js F5 pattern.
    const cfgPath = path.join(root, "specforest.config.yml");
    const rawCfg = await readFile(cfgPath, "utf8");
    await writeFile(cfgPath, rawCfg.replace("timings: true", "timings: false"), "utf8");
    const disabledConfig = await loadConfig(root);
    assert.equal(disabledConfig.timings, false);

    // Without this negative case, the open-interval scan in FIX 3 would force a
    // regeneration on every single invocation of a `timings: false` project that
    // happens to carry a stale open interval from before timings was turned off.
    assert.equal(await isTreeCacheStale(p, disabledConfig), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("isTreeCacheStale ignores a fully closed timing log (FIX 3, no-regression)", async () => {
  const { root, config, p } = await setup();
  try {
    await seedAuthDashboard(root, p);
    await appendEvents(p.timings, [
      { ts: "2026-09-21T09:00:00.000Z", event: "start", target: "auth/login", source: "cli" },
      { ts: "2026-09-21T11:41:00.000Z", event: "stop", target: "auth/login", to: "done", source: "cli" },
    ]);
    await regenAndWriteTreeCache({ config, p });
    // A finished feature (no open interval) must not force a regeneration on
    // every call — only genuinely open intervals should.
    assert.equal(await isTreeCacheStale(p, config), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
