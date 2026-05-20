import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { writeDefaultConfig, loadConfig } from "../src/config.js";
import { paths } from "../src/paths.js";
import { writeState, readState } from "../src/state.js";
import { writeTree, readTree } from "../src/tree-io.js";
import { sha256File } from "../src/hash.js";
import { cmdRehash } from "../src/commands/rehash.js";

function collector() {
  return {
    buf: "",
    write(s) {
      this.buf += s;
    },
  };
}

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "sf-rehash-"));
  await writeDefaultConfig(root);
  const config = await loadConfig(root);
  const p = paths(root, config);
  await mkdir(p.specsDir, { recursive: true });
  await mkdir(p.treesDir, { recursive: true });
  return { root, config, p };
}

function tree(name, hash) {
  return {
    spec: name,
    specPath: `docs/specs/${name}.md`,
    specHash: hash,
    features: [
      {
        name: "feat-a",
        source: "heading",
        originalHeading: "## feat-a",
        status: "in_progress",
        children: [],
      },
    ],
  };
}

test("rehash patches drifted state + tree hashes, preserves features/status", async () => {
  const { root, p } = await setup();
  try {
    const specPath = path.join(p.specsDir, "alpha.md");
    await writeFile(specPath, "# alpha\n## feat-a\n", "utf8");
    const staleHash = "sha256:" + "0".repeat(64);
    await writeState(p.state, {
      lastSync: null,
      lastRender: null,
      specHashes: { alpha: staleHash },
      islandIdMap: {},
      orphanedProgress: {},
      lastClusteredStructure: null,
    });
    await writeTree(p.treesDir, tree("alpha", staleHash));

    const stdout = collector();
    const stderr = collector();
    const code = await cmdRehash({ cwd: root, args: [], stdout, stderr });

    assert.equal(code, 0);
    const realHash = await sha256File(specPath);
    const state = await readState(p.state);
    assert.equal(state.specHashes.alpha, realHash);
    const t = await readTree(p.treesDir, "alpha");
    assert.equal(t.specHash, realHash);
    assert.equal(t.features[0].name, "feat-a");
    assert.equal(t.features[0].status, "in_progress");
    assert.match(stdout.buf, /APPLY/);
    assert.match(stdout.buf, /updated 1 spec hash/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rehash --dry-run reports but writes nothing", async () => {
  const { root, p } = await setup();
  try {
    const specPath = path.join(p.specsDir, "alpha.md");
    await writeFile(specPath, "# alpha\n", "utf8");
    const staleHash = "sha256:" + "1".repeat(64);
    await writeState(p.state, {
      lastSync: null,
      lastRender: null,
      specHashes: { alpha: staleHash },
      islandIdMap: {},
      orphanedProgress: {},
      lastClusteredStructure: null,
    });
    await writeTree(p.treesDir, tree("alpha", staleHash));

    const stateMtimeBefore = (await stat(p.state)).mtimeMs;
    const treeMtimeBefore = (await stat(path.join(p.treesDir, "alpha.json"))).mtimeMs;

    const stdout = collector();
    const stderr = collector();
    const code = await cmdRehash({ cwd: root, args: ["--dry-run"], stdout, stderr });

    assert.equal(code, 0);
    assert.match(stdout.buf, /DRY RUN/);
    assert.match(stdout.buf, /dry run — no files written/);
    assert.equal((await stat(p.state)).mtimeMs, stateMtimeBefore);
    assert.equal((await stat(path.join(p.treesDir, "alpha.json"))).mtimeMs, treeMtimeBefore);
    const state = await readState(p.state);
    assert.equal(state.specHashes.alpha, staleHash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rehash warns on orphan state hash but still updates live ones", async () => {
  const { root, p } = await setup();
  try {
    const specPath = path.join(p.specsDir, "alpha.md");
    await writeFile(specPath, "# alpha\n", "utf8");
    const staleHash = "sha256:" + "2".repeat(64);
    await writeState(p.state, {
      lastSync: null,
      lastRender: null,
      specHashes: { alpha: staleHash, ghost: "sha256:" + "9".repeat(64) },
      islandIdMap: {},
      orphanedProgress: {},
      lastClusteredStructure: null,
    });
    await writeTree(p.treesDir, tree("alpha", staleHash));

    const stdout = collector();
    const stderr = collector();
    const code = await cmdRehash({ cwd: root, args: [], stdout, stderr });

    assert.equal(code, 0);
    assert.match(stderr.buf, /WARNING.*ghost/);
    const realHash = await sha256File(specPath);
    const state = await readState(p.state);
    assert.equal(state.specHashes.alpha, realHash);
    assert.equal(state.specHashes.ghost, "sha256:" + "9".repeat(64));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rehash no-op when hashes already match", async () => {
  const { root, p } = await setup();
  try {
    const specPath = path.join(p.specsDir, "alpha.md");
    await writeFile(specPath, "# alpha\n", "utf8");
    const realHash = await sha256File(specPath);
    await writeState(p.state, {
      lastSync: null,
      lastRender: null,
      specHashes: { alpha: realHash },
      islandIdMap: {},
      orphanedProgress: {},
      lastClusteredStructure: null,
    });
    await writeTree(p.treesDir, tree("alpha", realHash));

    const stateMtimeBefore = (await stat(p.state)).mtimeMs;
    const stdout = collector();
    const stderr = collector();
    const code = await cmdRehash({ cwd: root, args: [], stdout, stderr });

    assert.equal(code, 0);
    assert.match(stdout.buf, /nothing to do/);
    assert.equal((await stat(p.state)).mtimeMs, stateMtimeBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rehash updates state even when tree file is missing", async () => {
  const { root, p } = await setup();
  try {
    const specPath = path.join(p.specsDir, "alpha.md");
    await writeFile(specPath, "# alpha\n", "utf8");
    const staleHash = "sha256:" + "3".repeat(64);
    await writeState(p.state, {
      lastSync: null,
      lastRender: null,
      specHashes: { alpha: staleHash },
      islandIdMap: {},
      orphanedProgress: {},
      lastClusteredStructure: null,
    });

    const stdout = collector();
    const stderr = collector();
    const code = await cmdRehash({ cwd: root, args: [], stdout, stderr });

    assert.equal(code, 0);
    const realHash = await sha256File(specPath);
    const state = await readState(p.state);
    assert.equal(state.specHashes.alpha, realHash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
