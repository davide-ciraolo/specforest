import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { defaultMarkers } from "../src/checkbox.js";
import { writeRenderedOutputs, syncCheckboxes, buildForestStructure } from "../src/render.js";
import { renderForestAscii, renderSingleSpecAscii, markerFn } from "../src/ascii.js";
import { findCycles, transitiveDeps, findIslandForFeature } from "../src/graph.js";
import { writeTree } from "../src/tree-io.js";

async function tmp() {
  return mkdtemp(path.join(tmpdir(), "sf-render-"));
}

function sampleTree(name, features) {
  return {
    spec: name,
    specPath: `docs/specs/2026-${name}-design.md`,
    specHash: "sha256:" + "0".repeat(64),
    features,
  };
}

function feat(name, status, children = []) {
  return { name, source: "heading", originalHeading: `## ${name}`, status, children };
}

test("buildForestStructure groups features under each island/spec", () => {
  const treesBySpec = new Map([
    ["auth", sampleTree("auth", [feat("login", "todo"), feat("logout", "done")])],
    ["worker", sampleTree("worker", [feat("ctx-binding", "in_progress")])],
  ]);
  const islands = [
    {
      id: "isl_a",
      name: "auth-and-worker",
      members: [
        { spec: "auth", feature: "login" },
        { spec: "worker", feature: "ctx-binding" },
      ],
      dependencies: [],
    },
    {
      id: "isl_b",
      name: "logout-alone",
      members: [{ spec: "auth", feature: "logout" }],
      dependencies: [],
    },
  ];
  const built = buildForestStructure(islands, treesBySpec);
  assert.equal(built.islands.length, 2);
  const i1 = built.islands.find((i) => i.name === "auth-and-worker");
  assert.equal(i1.specs.length, 2);
  const authSpec = i1.specs.find((s) => s.spec === "auth");
  assert.equal(authSpec.tree.features.length, 1);
  assert.equal(authSpec.tree.features[0].name, "login");
});

test("writeRenderedOutputs writes forest.md + island MDs", async () => {
  const dir = await tmp();
  try {
    const treesBySpec = new Map([
      ["auth", sampleTree("auth", [feat("login", "in_progress", [feat("oidc", "done"), feat("session", "todo")])])],
    ]);
    const islands = [
      {
        id: "isl_a",
        name: "auth-island",
        members: [{ spec: "auth", feature: "login" }],
        dependencies: [],
      },
    ];
    const r = await writeRenderedOutputs({
      outputDir: dir,
      archiveIslandsDir: path.join(dir, ".archive"),
      islands,
      treesBySpec,
      markers: defaultMarkers(),
      timestamp: "2026-05-18T00:00:00Z",
      previousIslandNames: [],
    });
    assert.equal(r.totals.total, 2);
    assert.equal(r.totals.done, 1);
    const forest = await readFile(path.join(dir, "forest.md"), "utf8");
    assert.match(forest, /# Forest/);
    assert.match(forest, /\[\[auth-island\]\]/);
    assert.match(forest, /\[1\/2\]/);
    const islandMd = await readFile(path.join(dir, "auth-island.md"), "utf8");
    assert.match(islandMd, /# auth-island/);
    assert.match(islandMd, /\[\/\] login \[1\/2\]/);
    assert.match(islandMd, /  - \[x\] oidc/);
    assert.match(islandMd, /  - \[ \] session/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeRenderedOutputs archives islands that disappeared", async () => {
  const dir = await tmp();
  try {
    await writeFile(path.join(dir, "old-island.md"), "# stale");
    const treesBySpec = new Map([
      ["auth", sampleTree("auth", [feat("login", "todo")])],
    ]);
    const islands = [
      {
        id: "isl_new",
        name: "new-island",
        members: [{ spec: "auth", feature: "login" }],
        dependencies: [],
      },
    ];
    await writeRenderedOutputs({
      outputDir: dir,
      archiveIslandsDir: path.join(dir, ".archive"),
      islands,
      treesBySpec,
      markers: defaultMarkers(),
      timestamp: "2026-05-18T00:00:00Z",
      previousIslandNames: ["old-island"],
    });
    const archived = await readdir(path.join(dir, ".archive"));
    assert.ok(archived.some((f) => f.startsWith("old-island-")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeRenderedOutputs empty islands → 'no specs yet'", async () => {
  const dir = await tmp();
  try {
    await writeRenderedOutputs({
      outputDir: dir,
      archiveIslandsDir: path.join(dir, ".archive"),
      islands: [],
      treesBySpec: new Map(),
      markers: defaultMarkers(),
      timestamp: "2026-05-18T00:00:00Z",
      previousIslandNames: [],
    });
    const forest = await readFile(path.join(dir, "forest.md"), "utf8");
    assert.match(forest, /no specs yet/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("syncCheckboxes updates tree JSON from MD edits", async () => {
  const dir = await tmp();
  try {
    const outputDir = path.join(dir, "out");
    const treesDir = path.join(dir, "trees");
    await mkdir(outputDir, { recursive: true });
    const tree = sampleTree("auth", [feat("login", "todo", [feat("oidc", "todo")])]);
    await writeTree(treesDir, tree);
    await writeFile(
      path.join(outputDir, "island.md"),
      [
        "# island",
        "",
        "## Features",
        "",
        "### From [[2026-auth-design]]",
        "- [/] login [0/1]",
        "  - [x] oidc",
        "",
      ].join("\n"),
      "utf8",
    );
    const r = await syncCheckboxes(outputDir, treesDir, defaultMarkers());
    assert.deepEqual(r.updated, ["auth"]);
    const raw = JSON.parse(await readFile(path.join(treesDir, "auth.json"), "utf8"));
    assert.equal(raw.features[0].status, "in_progress");
    assert.equal(raw.features[0].children[0].status, "done");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("syncCheckboxes flags orphans + warnings", async () => {
  const dir = await tmp();
  try {
    const outputDir = path.join(dir, "out");
    const treesDir = path.join(dir, "trees");
    await mkdir(outputDir, { recursive: true });
    await writeTree(treesDir, sampleTree("auth", [feat("login", "todo")]));
    await writeFile(
      path.join(outputDir, "island.md"),
      [
        "### From [[2026-auth-design]]",
        "- [x] login",
        "- [x] vanished",
        "- [?] login",
        "",
      ].join("\n"),
      "utf8",
    );
    const r = await syncCheckboxes(outputDir, treesDir, defaultMarkers());
    assert.ok(r.warnings.length >= 1);
    assert.ok(r.orphans.some((o) => o.key === "auth/vanished"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("renderForestAscii produces tree shape", () => {
  const treesBySpec = new Map([
    ["auth", sampleTree("auth", [feat("login", "done", [feat("oidc", "done")])])],
  ]);
  const islands = [
    {
      id: "isl_a",
      name: "auth-island",
      members: [{ spec: "auth", feature: "login" }],
      dependencies: [],
    },
  ];
  const built = buildForestStructure(islands, treesBySpec);
  const ascii = renderForestAscii(built, markerFn(defaultMarkers()));
  assert.match(ascii, /forest \[1\/1\]/);
  assert.match(ascii, /auth-island/);
  assert.match(ascii, /\[x\] login/);
  assert.match(ascii, /\[x\] oidc/);
});

test("renderSingleSpecAscii returns just one spec", () => {
  const treesBySpec = new Map([
    ["a", sampleTree("a", [feat("fa", "todo")])],
    ["b", sampleTree("b", [feat("fb", "done")])],
  ]);
  const islands = [
    { id: "isl_a", name: "i1", members: [{ spec: "a", feature: "fa" }], dependencies: [] },
    { id: "isl_b", name: "i2", members: [{ spec: "b", feature: "fb" }], dependencies: [] },
  ];
  const built = buildForestStructure(islands, treesBySpec);
  const ascii = renderSingleSpecAscii("a", built, markerFn(defaultMarkers()));
  assert.match(ascii, /^i1 \/ a/m);
  assert.ok(!ascii.includes("fb"));
});

test("findCycles detects A→B→A", () => {
  const isl = {
    id: "isl_x",
    name: "x",
    members: [{ spec: "s", feature: "a" }, { spec: "s", feature: "b" }],
    dependencies: [
      { from: { spec: "s", feature: "a" }, to: { spec: "s", feature: "b" }, kind: "semantic", reason: "" },
      { from: { spec: "s", feature: "b" }, to: { spec: "s", feature: "a" }, kind: "semantic", reason: "" },
    ],
  };
  const cycles = findCycles(isl);
  assert.ok(cycles.length >= 1);
});

test("transitiveDeps returns all reachable", () => {
  const isl = {
    id: "isl_x",
    name: "x",
    members: [
      { spec: "s", feature: "a" },
      { spec: "s", feature: "b" },
      { spec: "s", feature: "c" },
    ],
    dependencies: [
      { from: { spec: "s", feature: "a" }, to: { spec: "s", feature: "b" }, kind: "semantic", reason: "" },
      { from: { spec: "s", feature: "b" }, to: { spec: "s", feature: "c" }, kind: "semantic", reason: "" },
    ],
  };
  const r = transitiveDeps(isl, "s", "a");
  assert.deepEqual(r.reached.sort(), ["s/b", "s/c"]);
});

test("findIslandForFeature locates", () => {
  const islands = [
    { id: "isl_a", name: "i", members: [{ spec: "s", feature: "x" }], dependencies: [] },
  ];
  assert.equal(findIslandForFeature(islands, "s", "x").id, "isl_a");
  assert.equal(findIslandForFeature(islands, "s", "y"), null);
});
