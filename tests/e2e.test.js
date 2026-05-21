import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, stat, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLI = path.resolve(__dirname, "..", "bin", "cli.js");

function run(args, { cwd, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => { stdout += b.toString("utf8"); });
    child.stderr.on("data", (b) => { stderr += b.toString("utf8"); });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (input != null) child.stdin.write(input);
    child.stdin.end();
  });
}

async function setupProject() {
  const root = await mkdtemp(path.join(tmpdir(), "specforest-e2e-"));
  const init = await run(["init"], { cwd: root });
  assert.equal(init.code, 0, `init failed: ${init.stderr}`);
  return root;
}

async function writeSpec(root, name, body) {
  const specsDir = path.join(root, "docs", "specs");
  await mkdir(specsDir, { recursive: true });
  await writeFile(path.join(specsDir, `${name}.md`), body, "utf8");
}

const TREE_AUTH = {
  spec: "auth",
  features: [
    { name: "login", source: "heading", originalHeading: "## login", status: "todo", children: [] },
    { name: "logout", source: "heading", originalHeading: "## logout", status: "todo", children: [] },
  ],
};

const TREE_DASHBOARD = {
  spec: "dashboard",
  features: [
    { name: "widget-grid", source: "heading", originalHeading: "## widget-grid", status: "todo", children: [] },
  ],
};

const ISLANDS_OK = {
  generatedAt: "2026-05-18T00:00:00Z",
  islands: [
    {
      id: "isl_aaaaaa",
      name: "auth-and-dashboard",
      members: [
        { spec: "auth", feature: "login" },
        { spec: "auth", feature: "logout" },
        { spec: "dashboard", feature: "widget-grid" },
      ],
      dependencies: [
        {
          from: { spec: "dashboard", feature: "widget-grid" },
          to: { spec: "auth", feature: "login" },
          kind: "explicit-ref",
          reason: "dashboard requires authenticated session",
        },
      ],
    },
  ],
};

test("init creates config, dirs, and resolved snapshot", async () => {
  const root = await setupProject();
  const cfg = await readFile(path.join(root, "specforest.config.yml"), "utf8");
  assert.match(cfg, /specsDir:\s*docs\/specs/);
  const s = await stat(path.join(root, ".specforest"));
  assert.ok(s.isDirectory());
  const resolved = await stat(path.join(root, ".specforest", "config.resolved.json"));
  assert.ok(resolved.isFile());
});

test("sync with no specs reports clean", async () => {
  const root = await setupProject();
  const r = await run(["sync"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /NEXT: clean/);
});

test("full ingest → islands → render → clean loop", async () => {
  const root = await setupProject();
  await writeSpec(root, "auth", "# Auth Spec\n\n## login\n\nUser login.\n\n## logout\n\nUser logout.\n");
  await writeSpec(root, "dashboard", "# Dashboard\n\n## widget-grid\n\nGrid of widgets, depends on [[auth]].\n");

  let r = await run(["sync"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /NEXT: ingest/);
  assert.match(r.stdout, /auth/);
  assert.match(r.stdout, /dashboard/);

  r = await run(["ingest", "auth"], { cwd: root, input: JSON.stringify(TREE_AUTH) });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /ingested: auth/);

  r = await run(["ingest", "dashboard"], { cwd: root, input: JSON.stringify(TREE_DASHBOARD) });
  assert.equal(r.code, 0, r.stderr);

  r = await run(["sync"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /NEXT: islands/);

  r = await run(["commit-islands"], { cwd: root, input: JSON.stringify(ISLANDS_OK) });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /committed 1 island/);

  r = await run(["sync"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /rendered:/);

  r = await run(["sync"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /NEXT: clean/);

  const forestMd = await readFile(path.join(root, "docs", "trees", "forest.md"), "utf8");
  assert.match(forestMd, /auth-and-dashboard/);
  const islandMd = await readFile(path.join(root, "docs", "trees", "auth-and-dashboard.md"), "utf8");
  assert.match(islandMd, /\[\[auth\]\]/);
  assert.match(islandMd, /\[\[dashboard\]\]/);
});

test("ingest rejects bad JSON and validation errors", async () => {
  const root = await setupProject();
  await writeSpec(root, "auth", "## login\n");

  let r = await run(["ingest", "auth"], { cwd: root, input: "{not json" });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /invalid JSON/);

  const badTree = { spec: "auth", features: [{ name: "Bad Name", source: "heading", status: "todo", children: [] }] };
  r = await run(["ingest", "auth"], { cwd: root, input: JSON.stringify(badTree) });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /validation error/);
});

test("commit-islands rejects when not every top-level feature is covered", async () => {
  const root = await setupProject();
  await writeSpec(root, "auth", "## login\n## logout\n");
  await writeSpec(root, "dashboard", "## widget-grid\n");
  await run(["ingest", "auth"], { cwd: root, input: JSON.stringify(TREE_AUTH) });
  await run(["ingest", "dashboard"], { cwd: root, input: JSON.stringify(TREE_DASHBOARD) });

  const partial = {
    generatedAt: "2026-05-18T00:00:00Z",
    islands: [
      {
        id: "isl_aaaaaa",
        name: "only-auth",
        members: [{ spec: "auth", feature: "login" }],
        dependencies: [],
      },
    ],
  };
  const r = await run(["commit-islands"], { cwd: root, input: JSON.stringify(partial) });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /missing from islands\.members/);
});

test("mark updates status and tree renders new state", async () => {
  const root = await setupProject();
  await writeSpec(root, "auth", "## login\n## logout\n");
  await writeSpec(root, "dashboard", "## widget-grid\n");
  await run(["ingest", "auth"], { cwd: root, input: JSON.stringify(TREE_AUTH) });
  await run(["ingest", "dashboard"], { cwd: root, input: JSON.stringify(TREE_DASHBOARD) });
  await run(["commit-islands"], { cwd: root, input: JSON.stringify(ISLANDS_OK) });
  await run(["sync"], { cwd: root });

  const r = await run(["mark", "auth/login", "done"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /marked auth\/login → done/);

  const tree = JSON.parse(await readFile(path.join(root, ".specforest", "trees", "auth.json"), "utf8"));
  const login = tree.features.find((f) => f.name === "login");
  assert.equal(login.status, "done");

  const t = await run(["tree", "auth"], { cwd: root });
  assert.equal(t.code, 0, t.stderr);
  assert.match(t.stdout, /login/);
});

test("mark rejects invalid state and unknown feature with did-you-mean", async () => {
  const root = await setupProject();
  await writeSpec(root, "auth", "## login\n");
  await run(["ingest", "auth"], { cwd: root, input: JSON.stringify({
    spec: "auth",
    features: [{ name: "login", source: "heading", originalHeading: "## login", status: "todo", children: [] }],
  }) });

  let r = await run(["mark", "auth/login", "wat"], { cwd: root });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /invalid state/);

  r = await run(["mark", "auth/lgoin", "done"], { cwd: root });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /feature not found/);
  assert.match(r.stderr, /did you mean "auth\/login"/);
});

test("implement prints NEXT block with prereqs, specs-to-read, and marks in_progress", async () => {
  const root = await setupProject();
  await writeSpec(root, "auth", "## login\n## logout\n");
  await writeSpec(root, "dashboard", "## widget-grid\n");
  await run(["ingest", "auth"], { cwd: root, input: JSON.stringify(TREE_AUTH) });
  await run(["ingest", "dashboard"], { cwd: root, input: JSON.stringify(TREE_DASHBOARD) });
  await run(["commit-islands"], { cwd: root, input: JSON.stringify(ISLANDS_OK) });

  const r = await run(["implement", "dashboard/widget-grid"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /NEXT: implement/);
  assert.match(r.stdout, /target: dashboard\/widget-grid/);
  assert.match(r.stdout, /specs-to-read:/);
  assert.match(r.stdout, /docs\/specs\/dashboard\.md/);
  assert.match(r.stdout, /docs\/specs\/auth\.md/);
  assert.match(r.stdout, /prerequisites:/);
  assert.match(r.stdout, /auth\/login.*\[todo\].*not done/);

  const tree = JSON.parse(await readFile(path.join(root, ".specforest", "trees", "dashboard.json"), "utf8"));
  const wg = tree.features.find((f) => f.name === "widget-grid");
  assert.equal(wg.status, "in_progress");
});

test("implement after sync (MDs rendered) preserves in_progress, then sync re-renders", async () => {
  // Regression: previously, post-write syncCheckboxes() reverted in_progress→todo
  // by reading the stale MD that was rendered before the mark.
  const root = await setupProject();
  await writeSpec(root, "auth", "## login\n## logout\n");
  await writeSpec(root, "dashboard", "## widget-grid\n");
  await run(["ingest", "auth"], { cwd: root, input: JSON.stringify(TREE_AUTH) });
  await run(["ingest", "dashboard"], { cwd: root, input: JSON.stringify(TREE_DASHBOARD) });
  await run(["commit-islands"], { cwd: root, input: JSON.stringify(ISLANDS_OK) });
  // render the MDs
  let r = await run(["sync"], { cwd: root });
  assert.match(r.stdout, /rendered:/);
  r = await run(["sync"], { cwd: root });
  assert.match(r.stdout, /NEXT: clean/);

  // now implement: status must persist as in_progress
  r = await run(["implement", "dashboard/widget-grid"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);

  const tree = JSON.parse(await readFile(path.join(root, ".specforest", "trees", "dashboard.json"), "utf8"));
  const wg = tree.features.find((f) => f.name === "widget-grid");
  assert.equal(wg.status, "in_progress", "implement must not get reverted by post-write checkbox sync");

  // running sync afterward must re-render the MD with the new state
  r = await run(["sync"], { cwd: root });
  assert.match(r.stdout, /rendered:|NEXT: clean/);
  const islandMd = await readFile(path.join(root, "docs", "trees", "auth-and-dashboard.md"), "utf8");
  assert.match(islandMd, /\[\/\]\s*widget-grid/, "rendered MD should show in_progress marker");
});

test("syncCheckboxes orphan from MD edit persists to state.json.orphanedProgress", async () => {
  const root = await setupProject();
  await writeSpec(root, "auth", "## login\n");
  await run(["ingest", "auth"], { cwd: root, input: JSON.stringify({
    spec: "auth",
    features: [{ name: "login", source: "heading", originalHeading: "## login", status: "todo", children: [] }],
  }) });
  await run(["commit-islands"], { cwd: root, input: JSON.stringify({
    generatedAt: "2026-05-18T00:00:00Z",
    islands: [{ id: "isl_aaaaaa", name: "auth", members: [{ spec: "auth", feature: "login" }], dependencies: [] }],
  }) });
  await run(["sync"], { cwd: root });

  // hand-edit MD to introduce a checkbox for a deleted/renamed feature
  const mdPath = path.join(root, "docs", "trees", "auth.md");
  let md = await readFile(mdPath, "utf8");
  md += "\n- [x] ghost-feature\n";
  await writeFile(mdPath, md, "utf8");

  // any command that runs syncCheckboxes should persist the orphan
  const r = await run(["sync"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);

  const state = JSON.parse(await readFile(path.join(root, ".specforest", "state.json"), "utf8"));
  const keys = Object.keys(state.orphanedProgress || {});
  assert.ok(keys.some((k) => k.endsWith("/ghost-feature")), `expected ghost-feature in orphanedProgress, got: ${JSON.stringify(keys)}`);
});

test("implement --no-mark leaves status untouched", async () => {
  const root = await setupProject();
  await writeSpec(root, "auth", "## login\n## logout\n");
  await writeSpec(root, "dashboard", "## widget-grid\n");
  await run(["ingest", "auth"], { cwd: root, input: JSON.stringify(TREE_AUTH) });
  await run(["ingest", "dashboard"], { cwd: root, input: JSON.stringify(TREE_DASHBOARD) });
  await run(["commit-islands"], { cwd: root, input: JSON.stringify(ISLANDS_OK) });

  const r = await run(["implement", "dashboard/widget-grid", "--no-mark"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /unchanged, --no-mark/);

  const tree = JSON.parse(await readFile(path.join(root, ".specforest", "trees", "dashboard.json"), "utf8"));
  const wg = tree.features.find((f) => f.name === "widget-grid");
  assert.equal(wg.status, "todo");
});

test("implement accepts sub-feature by single name and marks only the leaf in_progress", async () => {
  const root = await setupProject();
  await writeSpec(root, "auth", "## login\n");
  const tree = {
    spec: "auth",
    features: [
      {
        name: "login",
        source: "heading",
        originalHeading: "## login",
        status: "todo",
        children: [
          { name: "remember-me", source: "implied", originalHeading: null, status: "todo", children: [] },
        ],
      },
    ],
  };
  await run(["ingest", "auth"], { cwd: root, input: JSON.stringify(tree) });
  await run(["commit-islands"], {
    cwd: root,
    input: JSON.stringify({
      generatedAt: "2026-05-18T00:00:00Z",
      islands: [{ id: "isl_aaaaaa", name: "auth", members: [{ spec: "auth", feature: "login" }], dependencies: [] }],
    }),
  });

  const r = await run(["implement", "auth/remember-me"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /target: auth\/login\/remember-me/);

  const out = JSON.parse(await readFile(path.join(root, ".specforest", "trees", "auth.json"), "utf8"));
  const login = out.features.find((f) => f.name === "login");
  const rm = login.children.find((c) => c.name === "remember-me");
  assert.equal(rm.status, "in_progress");
  assert.equal(login.status, "in_progress", "parent should roll up to in_progress");
});

test("implement accepts full leaf path and rolls up ancestors", async () => {
  const root = await setupProject();
  await writeSpec(root, "auth", "## auth-frontend\n");
  const tree = {
    spec: "auth",
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
    ],
  };
  await run(["ingest", "auth"], { cwd: root, input: JSON.stringify(tree) });
  await run(["commit-islands"], {
    cwd: root,
    input: JSON.stringify({
      generatedAt: "2026-05-18T00:00:00Z",
      islands: [{ id: "isl_aaaaaa", name: "auth", members: [{ spec: "auth", feature: "auth-frontend" }], dependencies: [] }],
    }),
  });

  const r = await run(["implement", "auth/auth-frontend/login-screen"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /target: auth\/auth-frontend\/login-screen/);

  const out = JSON.parse(await readFile(path.join(root, ".specforest", "trees", "auth.json"), "utf8"));
  const af = out.features.find((f) => f.name === "auth-frontend");
  const ls = af.children.find((c) => c.name === "login-screen");
  assert.equal(ls.status, "in_progress");
  assert.equal(af.status, "in_progress");
});

test("mark on leaf rolls up parent: all-done → done, mixed → in_progress, any-blocked → blocked", async () => {
  const root = await setupProject();
  await writeSpec(root, "auth", "## auth-frontend\n");
  const tree = {
    spec: "auth",
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
    ],
  };
  await run(["ingest", "auth"], { cwd: root, input: JSON.stringify(tree) });
  await run(["commit-islands"], {
    cwd: root,
    input: JSON.stringify({
      generatedAt: "2026-05-18T00:00:00Z",
      islands: [{ id: "isl_aaaaaa", name: "auth", members: [{ spec: "auth", feature: "auth-frontend" }], dependencies: [] }],
    }),
  });

  // one done → parent in_progress
  let r = await run(["mark", "auth/auth-frontend/login-screen", "done"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  let out = JSON.parse(await readFile(path.join(root, ".specforest", "trees", "auth.json"), "utf8"));
  let af = out.features.find((f) => f.name === "auth-frontend");
  assert.equal(af.status, "in_progress");

  // all done → parent done
  r = await run(["mark", "auth/auth-frontend/admin-ui", "done"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  out = JSON.parse(await readFile(path.join(root, ".specforest", "trees", "auth.json"), "utf8"));
  af = out.features.find((f) => f.name === "auth-frontend");
  assert.equal(af.status, "done");

  // one blocked → parent blocked (overrides done)
  r = await run(["mark", "auth/auth-frontend/login-screen", "blocked"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  out = JSON.parse(await readFile(path.join(root, ".specforest", "trees", "auth.json"), "utf8"));
  af = out.features.find((f) => f.name === "auth-frontend");
  assert.equal(af.status, "blocked");
});

test("mark with invalid sub-path returns hint", async () => {
  const root = await setupProject();
  await writeSpec(root, "auth", "## login\n");
  const tree = {
    spec: "auth",
    features: [
      {
        name: "login",
        source: "heading",
        originalHeading: "## login",
        status: "todo",
        children: [
          { name: "remember-me", source: "implied", originalHeading: null, status: "todo", children: [] },
        ],
      },
    ],
  };
  await run(["ingest", "auth"], { cwd: root, input: JSON.stringify(tree) });

  const r = await run(["mark", "auth/login/rmember-me", "done"], { cwd: root });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /path not found/);
  assert.match(r.stderr, /did you mean "auth\/login\/remember-me"/);
});

test("ambiguous single-name target errors in non-TTY with list", async () => {
  const root = await setupProject();
  await writeSpec(root, "auth", "## a\n## b\n");
  const tree = {
    spec: "auth",
    features: [
      {
        name: "a",
        source: "heading",
        originalHeading: "## a",
        status: "todo",
        children: [
          { name: "dup", source: "implied", originalHeading: null, status: "todo", children: [] },
        ],
      },
      {
        name: "b",
        source: "heading",
        originalHeading: "## b",
        status: "todo",
        children: [
          { name: "dup", source: "implied", originalHeading: null, status: "todo", children: [] },
        ],
      },
    ],
  };
  await run(["ingest", "auth"], { cwd: root, input: JSON.stringify(tree) });

  const r = await run(["mark", "auth/dup", "done"], { cwd: root });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /ambiguous/);
  assert.match(r.stderr, /auth\/a\/dup/);
  assert.match(r.stderr, /auth\/b\/dup/);
});

test("status prints island counters", async () => {
  const root = await setupProject();
  await writeSpec(root, "auth", "## login\n## logout\n");
  await writeSpec(root, "dashboard", "## widget-grid\n");
  await run(["ingest", "auth"], { cwd: root, input: JSON.stringify(TREE_AUTH) });
  await run(["ingest", "dashboard"], { cwd: root, input: JSON.stringify(TREE_DASHBOARD) });
  await run(["commit-islands"], { cwd: root, input: JSON.stringify(ISLANDS_OK) });
  await run(["mark", "auth/login", "done"], { cwd: root });

  const r = await run(["status"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /forest:\s*1 islands.*\[1\/3\]/);
  assert.match(r.stdout, /auth-and-dashboard:\s*\[1\/3\]/);
});

test("scan reports stale and clean states", async () => {
  const root = await setupProject();
  await writeSpec(root, "auth", "## login\n");

  let r = await run(["scan"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  const stale = JSON.parse(r.stdout);
  assert.equal(stale.stale.length, 1);
  assert.equal(stale.stale[0].name, "auth");

  await run(["ingest", "auth"], { cwd: root, input: JSON.stringify({
    spec: "auth",
    features: [{ name: "login", source: "heading", originalHeading: "## login", status: "todo", children: [] }],
  }) });

  r = await run(["scan"], { cwd: root });
  const fresh = JSON.parse(r.stdout);
  assert.equal(fresh.stale.length, 0);
});

test("unknown command exits non-zero with help", async () => {
  const root = await setupProject();
  const r = await run(["bogus"], { cwd: root });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown command: bogus/);
});

test("spec collision in two folders is reported", async () => {
  const root = await setupProject();
  const a = path.join(root, "docs", "specs", "team-a");
  const b = path.join(root, "docs", "specs", "team-b");
  await mkdir(a, { recursive: true });
  await mkdir(b, { recursive: true });
  await writeFile(path.join(a, "auth.md"), "## login\n", "utf8");
  await writeFile(path.join(b, "auth.md"), "## sso\n", "utf8");

  const r = await run(["sync"], { cwd: root });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /spec name collisions/);
  assert.match(r.stderr, /auth/);
});

test("editing a spec marks it stale on next sync and progress survives rename-preserving ingest", async () => {
  const root = await setupProject();
  await writeSpec(root, "auth", "## login\n## logout\n");
  await run(["ingest", "auth"], { cwd: root, input: JSON.stringify(TREE_AUTH) });
  await run(["commit-islands"], {
    cwd: root,
    input: JSON.stringify({
      generatedAt: "2026-05-18T00:00:00Z",
      islands: [{
        id: "isl_aaaaaa", name: "auth",
        members: [{ spec: "auth", feature: "login" }, { spec: "auth", feature: "logout" }],
        dependencies: [],
      }],
    }),
  });
  await run(["mark", "auth/login", "done"], { cwd: root });

  // edit spec
  await writeSpec(root, "auth", "## login\n## logout\n## reset\n");
  const r = await run(["sync"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /NEXT: ingest/);

  // re-ingest with new feature; login progress must survive
  const extended = {
    spec: "auth",
    features: [
      ...TREE_AUTH.features,
      { name: "reset", source: "heading", originalHeading: "## reset", status: "todo", children: [] },
    ],
  };
  await run(["ingest", "auth"], { cwd: root, input: JSON.stringify(extended) });
  const tree = JSON.parse(await readFile(path.join(root, ".specforest", "trees", "auth.json"), "utf8"));
  const login = tree.features.find((f) => f.name === "login");
  assert.equal(login.status, "done", "progress must survive ingest");
});
