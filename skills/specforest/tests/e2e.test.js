import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, stat, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readEvents } from "../src/timings-io.js";

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

async function ciProject() {
  const root = await setupProject();
  await writeSpec(root, "auth", "# Auth Spec\n\n## login\n\nUser login.\n\n## logout\n\nUser logout.\n");
  await writeSpec(root, "dashboard", "# Dashboard\n\n## widget-grid\n\nGrid of widgets, depends on [[auth]].\n");
  await run(["sync"], { cwd: root });
  await run(["ingest", "auth"], { cwd: root, input: JSON.stringify(TREE_AUTH) });
  await run(["ingest", "dashboard"], { cwd: root, input: JSON.stringify(TREE_DASHBOARD) });
  await run(["commit-islands"], { cwd: root, input: JSON.stringify(ISLANDS_OK) });
  await run(["render"], { cwd: root });
  return root;
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

test("verify prints NEXT: verify block, lists prereqs, does not mutate status", async () => {
  const root = await setupProject();
  await writeSpec(root, "auth", "## login\n## logout\n");
  await writeSpec(root, "dashboard", "## widget-grid\n");
  await run(["ingest", "auth"], { cwd: root, input: JSON.stringify(TREE_AUTH) });
  await run(["ingest", "dashboard"], { cwd: root, input: JSON.stringify(TREE_DASHBOARD) });
  await run(["commit-islands"], { cwd: root, input: JSON.stringify(ISLANDS_OK) });

  const r = await run(["verify", "dashboard/widget-grid"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /NEXT: verify/);
  assert.match(r.stdout, /target: dashboard\/widget-grid/);
  assert.match(r.stdout, /target-status: todo \(no change\)/);
  assert.match(r.stdout, /specs-to-read:/);
  assert.match(r.stdout, /docs\/specs\/dashboard\.md/);
  assert.match(r.stdout, /docs\/specs\/auth\.md/);
  assert.match(r.stdout, /prerequisites:/);
  assert.match(r.stdout, /auth\/login.*\[todo\].*not done/);
  assert.match(r.stdout, /VERDICT:/);

  // status must be unchanged
  const tree = JSON.parse(await readFile(path.join(root, ".specforest", "trees", "dashboard.json"), "utf8"));
  const wg = tree.features.find((f) => f.name === "widget-grid");
  assert.equal(wg.status, "todo", "verify must not mutate status");
});

test("verify accepts a done target and reports current status without change", async () => {
  const root = await setupProject();
  await writeSpec(root, "auth", "## login\n## logout\n");
  await writeSpec(root, "dashboard", "## widget-grid\n");
  await run(["ingest", "auth"], { cwd: root, input: JSON.stringify(TREE_AUTH) });
  await run(["ingest", "dashboard"], { cwd: root, input: JSON.stringify(TREE_DASHBOARD) });
  await run(["commit-islands"], { cwd: root, input: JSON.stringify(ISLANDS_OK) });
  await run(["mark", "auth/login", "done"], { cwd: root });

  const r = await run(["verify", "auth/login"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /NEXT: verify/);
  assert.match(r.stdout, /target-status: done \(no change\)/);

  const tree = JSON.parse(await readFile(path.join(root, ".specforest", "trees", "auth.json"), "utf8"));
  const login = tree.features.find((f) => f.name === "login");
  assert.equal(login.status, "done", "done status must survive verify");
});

test("verify with unknown feature errors with did-you-mean", async () => {
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

  const r = await run(["verify", "auth/lgoin"], { cwd: root });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /did you mean "auth\/login"/);
});

test("verify on a sub-feature reports the full path and leaves status unchanged", async () => {
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

  const r = await run(["verify", "auth/remember-me"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /target: auth\/login\/remember-me/);

  const out = JSON.parse(await readFile(path.join(root, ".specforest", "trees", "auth.json"), "utf8"));
  const login = out.features.find((f) => f.name === "login");
  const rm = login.children.find((c) => c.name === "remember-me");
  assert.equal(rm.status, "todo", "sub-feature status unchanged");
  assert.equal(login.status, "todo", "parent status unchanged");
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

test("ci wraps a command, records its time, and passes exit 0 through", async () => {
  const root = await ciProject();
  const r = await run(["ci", "auth/login", "--", process.execPath, "-e", "process.stdout.write('hi')"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /hi/);

  const { events } = await readEvents(path.join(root, ".specforest", "timings.jsonl"));
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "ci");
  assert.equal(events[0].target, "auth/login");
  assert.equal(events[0].exit, 0);
  assert.ok(typeof events[0].ms === "number" && events[0].ms >= 0);
  assert.match(events[0].cmd, /-e/);
});

test("ci records a failing command and propagates its exit code", async () => {
  const root = await ciProject();
  const r = await run(["ci", "auth/login", "--", process.execPath, "-e", "process.exit(3)"], { cwd: root });
  assert.equal(r.code, 3);

  const { events } = await readEvents(path.join(root, ".specforest", "timings.jsonl"));
  assert.equal(events.length, 1);
  assert.equal(events[0].exit, 3);
});

test("ci without a -- separator or without a command exits 1 and spawns nothing", async () => {
  const root = await ciProject();
  let r = await run(["ci", "auth/login"], { cwd: root });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /missing '--' separator/);

  r = await run(["ci", "auth/login", "--"], { cwd: root });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no command after '--'/);

  const { events } = await readEvents(path.join(root, ".specforest", "timings.jsonl"));
  assert.deepEqual(events, []);
});

test("ci on an unresolvable target exits 1 before spawning", async () => {
  const root = await ciProject();
  const r = await run(["ci", "auth/nope", "--", process.execPath, "-e", "process.stdout.write('ran')"], { cwd: root });
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.stdout, /ran/);
});

// Spec §1.3 keeps CI additive at every level, so a run aimed at a feature with
// children is charged to that feature rather than warned about and dropped.
test("ci on a non-leaf runs the command and records the run against the feature", async () => {
  const root = await ciProject();
  // Give `login` a child so it is no longer a leaf.
  const treePath = path.join(root, ".specforest", "trees", "auth.json");
  const tree = JSON.parse(await readFile(treePath, "utf8"));
  tree.features[0].children = [
    { name: "form", source: "implied", originalHeading: null, status: "todo", children: [] },
  ];
  await writeFile(treePath, JSON.stringify(tree, null, 2) + "\n", "utf8");

  const r = await run(["ci", "auth/login", "--", process.execPath, "-e", "process.stdout.write('ran')"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /ran/);
  assert.doesNotMatch(r.stderr, /no time recorded/);

  const { events } = await readEvents(path.join(root, ".specforest", "timings.jsonl"));
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "ci");
  assert.equal(events[0].target, "auth/login");
});

test("ci with timings disabled runs the command, notes it once, and records nothing", async () => {
  const root = await ciProject();
  // Appending a second `timings:` key would produce a duplicate YAML mapping key
  // (js-yaml throws) since `defaultConfigYaml()` already writes `timings: true` —
  // read-replace-write instead, mirroring `setTimingsFalse` in timings.test.js.
  const cfgPath = path.join(root, "specforest.config.yml");
  const rawCfg = await readFile(cfgPath, "utf8");
  await writeFile(cfgPath, rawCfg.replace("timings: true", "timings: false"), "utf8");

  const r = await run(["ci", "auth/login", "--", process.execPath, "-e", "process.stdout.write('ran')"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /ran/);
  assert.match(r.stderr, /timings: false/);

  const { events } = await readEvents(path.join(root, ".specforest", "timings.jsonl"));
  assert.deepEqual(events, []);
});

test("ci scans only its own args for --help; a wrapped command's --help runs normally", async () => {
  const root = await ciProject();
  const r = await run(["ci", "auth/login", "--", process.execPath, "-e", "process.stdout.write('ran')", "--help"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /ran/);
});

test("ci degrades to a stderr warning and still propagates exit code when appendEvents fails", async () => {
  const root = await ciProject();
  // Reproduces EISDIR: make the timings log path a directory instead of a file.
  await mkdir(path.join(root, ".specforest", "timings.jsonl"), { recursive: true });

  const r = await run(["ci", "auth/login", "--", process.execPath, "-e", "process.exit(3)"], { cwd: root });
  assert.equal(r.code, 3);
  assert.match(r.stderr, /could not record timing/);
});

test("ci round-trips awkward argv byte-identical through real spawn (empty string, trailing backslash, embedded quote, following arg)", async () => {
  const root = await ciProject();
  // stdio is "inherit" for the wrapped command, so we cannot capture argv via
  // stdout — the child writes it to a file instead, and we read it back.
  const outFile = path.join(root, "argv-dump.json");
  const script = "require('fs').writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))";
  const awkward = ["", "C:\\some path\\", 'a"b', "after"];

  const r = await run(["ci", "auth/login", "--", process.execPath, "-e", script, outFile, ...awkward], { cwd: root });
  assert.equal(r.code, 0, r.stderr);

  const dumped = JSON.parse(await readFile(outFile, "utf8"));
  assert.deepEqual(dumped, awkward);
});

test("ci records the actual wall-clock ms of the wrapped command", async () => {
  const root = await ciProject();
  // Busy-wait (not setTimeout) so the wrapped process's own wall-clock, not just
  // an event-loop delay, is what's being measured.
  const script = "const s=Date.now();while(Date.now()-s<200){}";
  const r = await run(["ci", "auth/login", "--", process.execPath, "-e", script], { cwd: root });
  assert.equal(r.code, 0, r.stderr);

  const { events } = await readEvents(path.join(root, ".specforest", "timings.jsonl"));
  assert.equal(events.length, 1);
  assert.ok(events[0].ms >= 200, `expected ms >= 200, got ${events[0].ms}`);
});

test("ci records ts as the start time of the wrapped command, not its end time", async () => {
  const root = await ciProject();
  const before = Date.now();
  // A 300ms busy-wait makes start-time and end-time clearly distinguishable: a
  // `ts` recorded at append-time (i.e. after the wait) would land well after
  // `before + 300ms`, whereas a `ts` recorded at spawn-time lands right after `before`.
  const script = "const s=Date.now();while(Date.now()-s<300){}";
  const r = await run(["ci", "auth/login", "--", process.execPath, "-e", script], { cwd: root });
  const after = Date.now();
  assert.equal(r.code, 0, r.stderr);

  const { events } = await readEvents(path.join(root, ".specforest", "timings.jsonl"));
  assert.equal(events.length, 1);
  const ts = Date.parse(events[0].ts);
  assert.ok(Number.isFinite(ts), "ts must parse");
  assert.ok(ts >= before, `ts ${ts} should be >= before ${before}`);
  assert.ok(ts <= after - 250, `ts ${ts} should be well before the 300ms busy-wait finished (after=${after})`);
});

test("ci records the resolved full path, not the abbreviated single-segment target", async () => {
  const root = await ciProject();
  const treePath = path.join(root, ".specforest", "trees", "auth.json");
  const tree = JSON.parse(await readFile(treePath, "utf8"));
  tree.features[0].children = [
    { name: "form", source: "implied", originalHeading: null, status: "todo", children: [] },
  ];
  await writeFile(treePath, JSON.stringify(tree, null, 2) + "\n", "utf8");

  const r = await run(["ci", "auth/form", "--", process.execPath, "-e", "process.stdout.write('ran')"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /ran/);

  const { events } = await readEvents(path.join(root, ".specforest", "timings.jsonl"));
  assert.equal(events.length, 1);
  assert.equal(events[0].target, "auth/login/form");
});

test("ci rejects a command argument containing a newline before spawning", async () => {
  const root = await ciProject();
  const r = await run(["ci", "auth/login", "--", process.execPath, "-e", "process.stdout.write('ran')\n"], { cwd: root });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /command arguments may not contain newlines/);
  assert.doesNotMatch(r.stdout, /ran/);

  const { events } = await readEvents(path.join(root, ".specforest", "timings.jsonl"));
  assert.deepEqual(events, []);
});

const FIXTURE_LOG = [
  { ts: "2026-09-18T09:12:00.000Z", event: "start", target: "auth/login", source: "cli" },
  { ts: "2026-09-18T09:31:00.000Z", event: "ci", target: "auth/login", ms: 48200, cmd: "npm test", exit: 0 },
  { ts: "2026-09-18T10:04:00.000Z", event: "stop", target: "auth/login", to: "blocked", source: "cli" },
  { ts: "2026-09-21T09:40:00.000Z", event: "start", target: "auth/login", source: "cli" },
  { ts: "2026-09-21T11:26:00.000Z", event: "stop", target: "auth/login", to: "done", source: "checkbox" },
  { ts: "2026-09-01T09:00:00.000Z", event: "start", target: "deleted-spec/gone", source: "cli" },
  { ts: "2026-09-01T10:00:00.000Z", event: "stop", target: "deleted-spec/gone", to: "done", source: "cli" },
].map((e) => JSON.stringify(e)).join("\n") + "\n";

test("timings with no target reports forest and island rollups plus an orphan note", async () => {
  const root = await ciProject();
  await writeFile(path.join(root, ".specforest", "timings.jsonl"), FIXTURE_LOG, "utf8");

  const r = await run(["timings"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^forest: 1 islands, \[0\/3\]/m);
  assert.match(r.stdout, /active 2h 38m/);
  assert.match(r.stdout, /ci 48\.2s/);
  assert.match(r.stdout, /coding 2h 37m/);
  assert.match(r.stdout, /lead 3d 2h/);
  assert.match(r.stdout, /auth-and-dashboard\s+active 2h 38m/);
  assert.match(r.stdout, /orphaned: 1 target/);
});

test("timings with a target reports lead, active, intervals, and ci runs", async () => {
  const root = await ciProject();
  await writeFile(path.join(root, ".specforest", "timings.jsonl"), FIXTURE_LOG, "utf8");

  const r = await run(["timings", "auth/login"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /auth\/login\s+\[todo\]/);
  assert.match(r.stdout, /lead\s+3d 2h/);
  assert.match(r.stdout, /active\s+2h 38m/);
  assert.match(r.stdout, /ci 48\.2s \(1 run\)/);
  assert.match(r.stdout, /intervals:/);
  assert.match(r.stdout, /2026-09-18 09:12 → 10:04\s+52m 00s\s+→ blocked\s+\(cli\)/);
  assert.match(r.stdout, /2026-09-21 09:40 → 11:26\s+1h 46m\s+→ done\s+\(checkbox\)/);
  assert.match(r.stdout, /ci runs:/);
  assert.match(r.stdout, /2026-09-18 09:31\s+48\.2s\s+exit 0\s+npm test/);
});

test("timings --json emits raw milliseconds", async () => {
  const root = await ciProject();
  await writeFile(path.join(root, ".specforest", "timings.jsonl"), FIXTURE_LOG, "utf8");

  let r = await run(["timings", "--json"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  let parsed = JSON.parse(r.stdout);
  // 52m + 1h46m of intervals. The ci run at 09:31 falls INSIDE the first interval,
  // so its 48.2s is already counted in active and must not be added again.
  assert.equal(parsed.forest.activeMs, 9480000);
  assert.equal(parsed.islands[0].name, "auth-and-dashboard");
  assert.equal(parsed.orphans.length, 1);

  r = await run(["timings", "auth/login", "--json"], { cwd: root });
  parsed = JSON.parse(r.stdout);
  assert.equal(parsed.target, "auth/login");
  assert.equal(parsed.ciMs, 48200);
  assert.equal(parsed.intervals.length, 2);
});

test("timings --orphans lists targets no longer in any tree", async () => {
  const root = await ciProject();
  await writeFile(path.join(root, ".specforest", "timings.jsonl"), FIXTURE_LOG, "utf8");

  const r = await run(["timings", "--orphans"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /deleted-spec\/gone/);
  assert.match(r.stdout, /active 1h 00m/);
});

test("timings with no log reports 'no time recorded' without error", async () => {
  const root = await ciProject();
  const r = await run(["timings"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  // The forest line used to print "active 0s   ci 0s   coding 0s   lead 0s"
  // while the island line beneath it already said "(no time recorded)". FIX 2
  // put both behind the single hasRecordedTime() rule, so the two now agree.
  assert.match(r.stdout, /^ {2}\(no time recorded\)$/m);
  assert.match(r.stdout, /^ {2}auth-and-dashboard {2}\(no time recorded\)$/m);
  assert.doesNotMatch(r.stdout, /orphaned/);
});

test("timings exits 0 with an explanation when the flag is off", async () => {
  const root = await ciProject();
  // Appending a second `timings:` key would produce a duplicate YAML mapping key
  // (js-yaml throws) since `defaultConfigYaml()` already writes `timings: true` —
  // read-replace-write instead, mirroring the `ci`-disabled test above.
  const cfgPath = path.join(root, "specforest.config.yml");
  const rawCfg = await readFile(cfgPath, "utf8");
  await writeFile(cfgPath, rawCfg.replace("timings: true", "timings: false"), "utf8");
  const r = await run(["timings"], { cwd: root });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /timings: false/);
});

// === Review-round regression + coverage tests (FIX 1 - FIX 8) ===

test("timings resolves a spec name case-insensitively without desyncing from lowercase-stored keys (FIX 1, regression)", async () => {
  const root = await ciProject();
  await writeFile(path.join(root, ".specforest", "timings.jsonl"), FIXTURE_LOG, "utf8");

  // readTree opens `${specName}.json`, which resolves case-insensitively on
  // Windows/macOS — but the events in timings.jsonl (and thus the totals map)
  // are always keyed off the lowercase-as-stored `tree.spec`. Before FIX 1 the
  // node-detail key was built from the user-typed spec string, so the
  // uppercase invocation looked up "AUTH/login" (miss) instead of "auth/login"
  // (hit): crash in text mode, silently-empty-but-exit-0 in --json mode.
  const lower = await run(["timings", "auth/login"], { cwd: root });
  const upper = await run(["timings", "AUTH/login"], { cwd: root });
  assert.equal(lower.code, 0, lower.stderr);
  assert.equal(upper.code, 0, upper.stderr);
  assert.match(upper.stdout, /active\s+2h 38m/);
  assert.match(upper.stdout, /ci 48\.2s \(1 run\)/);
  assert.match(upper.stdout, /intervals:/);

  const lowerJson = JSON.parse((await run(["timings", "auth/login", "--json"], { cwd: root })).stdout);
  const upperJson = JSON.parse((await run(["timings", "AUTH/login", "--json"], { cwd: root })).stdout);
  assert.equal(upperJson.activeMs, lowerJson.activeMs);
  assert.equal(upperJson.ciMs, lowerJson.ciMs);
  assert.equal(upperJson.intervals.length, lowerJson.intervals.length);
  assert.equal(upperJson.activeMs, 9480000);
});

test("timings degrades to a clean stderr message and exit 1 when the log path is unreadable (FIX 2, regression)", async () => {
  const root = await ciProject();
  // Reproduces EISDIR: make the timings log path a directory instead of a
  // file, mirroring the fixture already used for the `ci` EISDIR regression
  // test above.
  await mkdir(path.join(root, ".specforest", "timings.jsonl"), { recursive: true });

  const r = await run(["timings"], { cwd: root });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /could not read timings log/);
  assert.doesNotMatch(r.stderr, /at (Object|async|Module)|\.js:\d+:\d+/, "stderr must not contain a raw stack trace");
});

test("timings forest summary shows a ci percentage when ci time fits inside active time", async () => {
  const root = await ciProject();
  await writeFile(path.join(root, ".specforest", "timings.jsonl"), FIXTURE_LOG, "utf8");

  const r = await run(["timings"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /ci 48\.2s \(1%\)/);
});

test("timings --orphans reports 'no orphaned timing targets' in text mode when there are none", async () => {
  const root = await ciProject();
  const r = await run(["timings", "--orphans"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /no orphaned timing targets/);
});

test("timings --orphans --json emits a stripped-down orphan shape with no raw intervals/ciRuns", async () => {
  const root = await ciProject();
  await writeFile(path.join(root, ".specforest", "timings.jsonl"), FIXTURE_LOG, "utf8");

  const r = await run(["timings", "--orphans", "--json"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.orphans.length, 1);
  const orphan = parsed.orphans[0];
  assert.equal(orphan.target, "deleted-spec/gone");
  assert.equal(orphan.activeMs, 3600000);
  assert.equal(orphan.ciMs, 0);
  assert.ok(!("intervals" in orphan), "orphan JSON must not include raw intervals");
  assert.ok(!("ciRuns" in orphan), "orphan JSON must not include raw ciRuns");
});

const FIX5_LOG = [
  { ts: "2026-09-20T09:00:00.000Z", event: "start", target: "auth/login", source: "cli" },
  // ci run's raw ms (10m) exceeds the 20s interval that contains it — this is
  // the "ci run straddles/overruns its interval" case FIX 5 must suppress the
  // percentage for, while still showing the raw ci duration.
  { ts: "2026-09-20T09:00:10.000Z", event: "ci", target: "auth/login", ms: 600000, cmd: "npm test", exit: 0 },
  { ts: "2026-09-20T09:00:20.000Z", event: "stop", target: "auth/login", to: "done", source: "cli" },
].map((e) => JSON.stringify(e)).join("\n") + "\n";

test("timings suppresses the ci percentage when a ci run's raw duration exceeds its enclosing interval (FIX 5)", async () => {
  const root = await ciProject();
  await writeFile(path.join(root, ".specforest", "timings.jsonl"), FIX5_LOG, "utf8");

  const r = await run(["timings"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /active 20\.0s/);
  assert.match(r.stdout, /ci 10m 00s/);
  assert.doesNotMatch(r.stdout, /\(\d+%\)/);
});

test("timings prints an empty (not missing) forest when islands.json exists with zero islands (FIX 6)", async () => {
  const root = await setupProject();
  // No specs ingested at all: commit-islands enforces that every known
  // top-level feature is covered by exactly one island, so an "islands.json
  // with 0 islands" fixture is only valid when there are zero known features.
  const r0 = await run(["commit-islands"], { cwd: root, input: JSON.stringify({ generatedAt: "2026-05-18T00:00:00Z", islands: [] }) });
  assert.equal(r0.code, 0, r0.stderr);

  const r = await run(["timings"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^forest: 0 islands, \[0\/0\]/m);
  assert.doesNotMatch(r.stdout, /no islands\.json yet/);
});

test("timings still prints 'no islands.json yet' when islands.json was never committed (FIX 6, regression guard)", async () => {
  const root = await setupProject();
  const r = await run(["timings"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /no islands\.json yet/);
});

const FIX4_LOG = [
  { ts: "2026-09-20T09:00:00.000Z", event: "start", target: "auth/login/form", source: "cli" },
  { ts: "2026-09-20T09:20:00.000Z", event: "stop", target: "auth/login/form", to: "done", source: "cli" },
].map((e) => JSON.stringify(e)).join("\n") + "\n";

test("a non-leaf node with no timing records of its own shows a rollup note instead of empty detail sections (FIX 4)", async () => {
  const root = await ciProject();
  // Give `login` a child so it is no longer a leaf, mirroring the `ci`
  // non-leaf fixture pattern above.
  const treePath = path.join(root, ".specforest", "trees", "auth.json");
  const tree = JSON.parse(await readFile(treePath, "utf8"));
  tree.features[0].children = [
    { name: "form", source: "implied", originalHeading: null, status: "todo", children: [] },
  ];
  await writeFile(treePath, JSON.stringify(tree, null, 2) + "\n", "utf8");
  await writeFile(path.join(root, ".specforest", "timings.jsonl"), FIX4_LOG, "utf8");

  const r = await run(["timings", "auth/login"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /active\s+20m 00s/);
  assert.doesNotMatch(r.stdout, /intervals:/);
  assert.doesNotMatch(r.stdout, /ci runs:/);
  assert.match(r.stdout, /rolled up from descendants/i);
});

async function twoIslandProject() {
  const root = await setupProject();
  await writeSpec(root, "auth", "# Auth Spec\n\n## login\n\nUser login.\n");
  await writeSpec(root, "dashboard", "# Dashboard\n\n## widget-grid\n\nGrid of widgets.\n");
  await run(["sync"], { cwd: root });
  await run(["ingest", "auth"], {
    cwd: root,
    input: JSON.stringify({
      spec: "auth",
      features: [{ name: "login", source: "heading", originalHeading: "## login", status: "todo", children: [] }],
    }),
  });
  await run(["ingest", "dashboard"], {
    cwd: root,
    input: JSON.stringify({
      spec: "dashboard",
      features: [{ name: "widget-grid", source: "heading", originalHeading: "## widget-grid", status: "todo", children: [] }],
    }),
  });
  await run(["commit-islands"], {
    cwd: root,
    input: JSON.stringify({
      generatedAt: "2026-05-18T00:00:00Z",
      islands: [
        { id: "isl_bbbbbb", name: "auth-island", members: [{ spec: "auth", feature: "login" }], dependencies: [] },
        { id: "isl_cccccc", name: "dashboard-island", members: [{ spec: "dashboard", feature: "widget-grid" }], dependencies: [] },
      ],
    }),
  });
  await run(["render"], { cwd: root });
  return root;
}

const TWO_ISLAND_LOG = [
  { ts: "2026-09-20T09:00:00.000Z", event: "start", target: "auth/login", source: "cli" },
  { ts: "2026-09-20T09:12:00.000Z", event: "stop", target: "auth/login", to: "done", source: "cli" },
].map((e) => JSON.stringify(e)).join("\n") + "\n";

test("timings distinguishes per-island totals: real numbers for a touched island, '(no time recorded)' for an untouched one (FIX 8)", async () => {
  const root = await twoIslandProject();
  await writeFile(path.join(root, ".specforest", "timings.jsonl"), TWO_ISLAND_LOG, "utf8");

  const r = await run(["timings"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /auth-island\s+active 12m 00s/);
  assert.match(r.stdout, /dashboard-island\s+\(no time recorded\)/);
  assert.doesNotMatch(r.stdout, /dashboard-island\s+active/);

  const rj = await run(["timings", "--json"], { cwd: root });
  assert.equal(rj.code, 0, rj.stderr);
  const parsed = JSON.parse(rj.stdout);
  const authIsland = parsed.islands.find((i) => i.name === "auth-island");
  const dashIsland = parsed.islands.find((i) => i.name === "dashboard-island");
  assert.equal(authIsland.activeMs, 720000);
  assert.equal(dashIsland.activeMs, 0);
});

const OPEN_INTERVAL_LOG = [
  { ts: "2026-09-20T09:00:00.000Z", event: "start", target: "auth/login", source: "cli" },
].map((e) => JSON.stringify(e)).join("\n") + "\n";

test("an open (unclosed) interval marks '(running)' in the forest summary, the per-island line, and the node detail (FIX 8)", async () => {
  const root = await ciProject();
  await writeFile(path.join(root, ".specforest", "timings.jsonl"), OPEN_INTERVAL_LOG, "utf8");

  const r = await run(["timings"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  const forestRunningCount = (r.stdout.match(/\(running\)/g) || []).length;
  assert.ok(forestRunningCount >= 2, `expected >= 2 "(running)" markers (forest summary + island line), got ${forestRunningCount}:\n${r.stdout}`);

  const rn = await run(["timings", "auth/login"], { cwd: root });
  assert.equal(rn.code, 0, rn.stderr);
  assert.match(rn.stdout, /intervals:/);
  const nodeRunningCount = (rn.stdout.match(/\(running\)/g) || []).length;
  assert.ok(nodeRunningCount >= 2, `expected >= 2 "(running)" markers (lead line + interval row), got ${nodeRunningCount}:\n${rn.stdout}`);
});

test("status is byte-identical to before when no time is recorded", async () => {
  const root = await ciProject();
  const r = await run(["status"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "forest: 1 islands, [0/3]\n  auth-and-dashboard: [0/3] (2 specs)\n");
});

test("status appends a timing suffix to lines with recorded time", async () => {
  const root = await ciProject();
  await writeFile(path.join(root, ".specforest", "timings.jsonl"), FIXTURE_LOG, "utf8");
  const r = await run(["status"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^forest: 1 islands, \[0\/3\]  active 2h 38m \(ci 48\.2s \/ code 2h 37m\)$/m);
  assert.match(r.stdout, /^ {2}auth-and-dashboard: \[0\/3\] \(2 specs\)  active 2h 38m \(ci 48\.2s \/ code 2h 37m\)$/m);
});

test("status degrades to a stderr warning (not a stack trace) and still prints normal counters when the timings log is unreadable", async () => {
  const root = await ciProject();
  // Reproduces EISDIR: make the timings log path a directory instead of a
  // file, mirroring the fixture already used for the `ci`/`timings` EISDIR
  // regressions.
  await mkdir(path.join(root, ".specforest", "timings.jsonl"), { recursive: true });

  const r = await run(["status"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "forest: 1 islands, [0/3]\n  auth-and-dashboard: [0/3] (2 specs)\n");
  assert.match(r.stderr, /could not read timings log/);
});

test("status suppresses the suffix (not an all-zero one) when the only recorded ms is non-finite (F2)", async () => {
  const root = await ciProject();
  // `JSON.parse("1e999")` is `Infinity` — reachable from a real (unmutated)
  // log with no hand-editing. The raw JSON text must contain the literal
  // numeral `1e999`: building this via a JS object + JSON.stringify does NOT
  // reproduce it, because JSON.stringify(Infinity) serializes to `null`
  // (JSON has no Infinity literal) — that would silently test nothing.
  // deriveTotals's ci filter (`typeof e.ms === "number" && e.ms > 0`) lets a
  // parsed Infinity through, so an aggregate with activeMs === Infinity must
  // still suppress the suffix per spec §4.2 ("suppressed entirely when zero
  // recorded time") rather than print "active 0s (ci 0s / code 0s)".
  const log = '{"ts":"2026-09-18T09:31:00.000Z","event":"ci","target":"auth/login","ms":1e999,"cmd":"npm test","exit":0}\n';
  await writeFile(path.join(root, ".specforest", "timings.jsonl"), log, "utf8");

  const r = await run(["status"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "forest: 1 islands, [0/3]\n  auth-and-dashboard: [0/3] (2 specs)\n");
});

test("status marks '(running)' on both the forest and island lines for an open interval (F3)", async () => {
  const root = await ciProject();
  await writeFile(path.join(root, ".specforest", "timings.jsonl"), OPEN_INTERVAL_LOG, "utf8");

  const r = await run(["status"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  const runningCount = (r.stdout.match(/\(running\)/g) || []).length;
  assert.ok(runningCount >= 2, `expected >= 2 "(running)" markers (forest line + island line), got ${runningCount}:\n${r.stdout}`);
});

test("status suffixes only the touched island, leaving the untouched one bare, on a two-island forest (F4)", async () => {
  const root = await twoIslandProject();
  await writeFile(path.join(root, ".specforest", "timings.jsonl"), TWO_ISLAND_LOG, "utf8");

  const r = await run(["status"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^ {2}auth-island: \[0\/1\] \(1 spec\)  active 12m 00s \(ci 0s \/ code 12m 00s\)$/m);
  assert.match(r.stdout, /^ {2}dashboard-island: \[0\/1\] \(1 spec\)$/m);
  assert.doesNotMatch(r.stdout, /dashboard-island:.*active/);
});

test("status prints byte-identical output when timings is disabled in config, even with a populated log (F5)", async () => {
  const root = await ciProject();
  const cfgPath = path.join(root, "specforest.config.yml");
  const rawCfg = await readFile(cfgPath, "utf8");
  // Edit the existing key in place — appending a second `timings:` key would
  // throw a duplicate-mapping-key YAMLException, since `defaultConfigYaml()`
  // already writes `timings: true` (mirrors the same pattern used for `ci`
  // and `timings` disabled-flag tests above).
  await writeFile(cfgPath, rawCfg.replace("timings: true", "timings: false"), "utf8");
  await writeFile(path.join(root, ".specforest", "timings.jsonl"), FIXTURE_LOG, "utf8");

  const r = await run(["status"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "forest: 1 islands, [0/3]\n  auth-and-dashboard: [0/3] (2 specs)\n");
  assert.equal(r.stderr, "");
});

test("status surfaces per-line warnings for malformed timings.jsonl lines and still derives the suffix from the surviving lines (F6)", async () => {
  const root = await ciProject();
  const log = [
    "{not json",
    JSON.stringify({ ts: "nope", event: "start", target: "auth/login" }),
    JSON.stringify({ ts: "2026-09-18T09:00:00.000Z", event: "start", target: "auth/login", source: "cli" }),
    JSON.stringify({ ts: "2026-09-18T09:20:00.000Z", event: "stop", target: "auth/login", to: "done", source: "cli" }),
  ].join("\n") + "\n";
  await writeFile(path.join(root, ".specforest", "timings.jsonl"), log, "utf8");

  const r = await run(["status"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /warning: timings\.jsonl line 1: .*skipped/);
  assert.match(r.stderr, /warning: timings\.jsonl line 2: .*skipped/);
  assert.match(r.stdout, /active 20m 00s \(ci 0s \/ code 20m 00s\)/);
});

// === Write-site canonical-spec-name regressions (FIX 1) ===

// The write-site tests below type the spec in a case that differs from the
// stored `auth.json` / `dashboard.json`, which only resolves at all on a
// case-INSENSITIVE filesystem (Windows, default macOS). On a case-sensitive
// volume `readTree` simply returns null and the command exits 1 with "spec not
// found" — a different, already-covered path — so the assertions below would be
// meaningless there. Probe the real filesystem rather than guessing from
// `process.platform`: a case-sensitive volume mounted on macOS is a real setup.
const CASE_INSENSITIVE_FS = await (async () => {
  const probeDir = await mkdtemp(path.join(tmpdir(), "specforest-casefs-"));
  await writeFile(path.join(probeDir, "probe.json"), "{}", "utf8");
  try {
    await stat(path.join(probeDir, "PROBE.json"));
    return true;
  } catch {
    return false;
  }
})();
const skipCaseFs = CASE_INSENSITIVE_FS
  ? false
  : "filesystem is case-sensitive: `<SPEC>.json` cannot resolve to a lowercase tree file";

/** Give the (leaf) `auth/login` feature a `form` child so paths nest one deeper. */
async function addLoginChild(root) {
  const treePath = path.join(root, ".specforest", "trees", "auth.json");
  const tree = JSON.parse(await readFile(treePath, "utf8"));
  tree.features[0].children = [
    { name: "form", source: "implied", originalHeading: null, status: "todo", children: [] },
  ];
  await writeFile(treePath, JSON.stringify(tree, null, 2) + "\n", "utf8");
}

function timingsLog(root) {
  return path.join(root, ".specforest", "timings.jsonl");
}

test("ci records the canonical spec name when the spec is typed in another case (FIX 1)", { skip: skipCaseFs }, async () => {
  const root = await ciProject();

  const r = await run(["ci", "AUTH/login", "--", process.execPath, "-e", "process.stdout.write('ran')"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /ran/);

  const { events } = await readEvents(timingsLog(root));
  assert.equal(events.length, 1);
  // Every reader keys off `tree.spec` (lowercase-as-stored); a target recorded
  // as "AUTH/login" is invisible on the node and lands in the orphan bucket.
  assert.equal(events[0].target, "auth/login");
});

// The non-leaf notice is gone (spec §1.3 records the run instead), but the FIX 1
// guarantee it used to carry still holds: the run is charged to the canonical
// spec name, never the mixed-case one the user typed.
test("ci records a non-leaf run under the canonical spec when the spec is typed in another case (FIX 1)", { skip: skipCaseFs }, async () => {
  const root = await ciProject();
  await addLoginChild(root);

  const r = await run(["ci", "AUTH/login", "--", process.execPath, "-e", "process.stdout.write('ran')"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  const { events } = await readEvents(timingsLog(root));
  assert.equal(events.length, 1);
  assert.equal(events[0].target, "auth/login");
});

test("mark records and prints the canonical spec name when the spec is typed in another case (FIX 1)", { skip: skipCaseFs }, async () => {
  const root = await ciProject();
  await addLoginChild(root);

  const r = await run(["mark", "AUTH/login/form", "in_progress"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^marked auth\/login\/form → in_progress$/m);
  assert.match(r.stdout, /^rollup: auth\/login todo → in_progress$/m);

  // The cascaded parent event must be canonicalised too, not just the target.
  const { events } = await readEvents(timingsLog(root));
  assert.deepEqual(events.map((e) => e.target), ["auth/login/form", "auth/login"]);
});

test("implement resolves its island and records the canonical spec name when the spec is typed in another case (FIX 1)", { skip: skipCaseFs }, async () => {
  const root = await ciProject();
  await addLoginChild(root);

  const r = await run(["implement", "AUTH/login/form"], { cwd: root });
  // islands.json members always carry the canonical spec name, so a mixed-case
  // findIslandForFeature lookup misses and the command bails out with a
  // misleading "run `specforest sync` first".
  assert.doesNotMatch(r.stderr, /not present in any island/);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^target: auth\/login\/form$/m);
  assert.match(r.stdout, /^rollup: auth\/login todo → in_progress$/m);

  const { events } = await readEvents(timingsLog(root));
  assert.deepEqual(events.map((e) => e.target), ["auth/login/form", "auth/login"]);
});

test("implement walks the island graph from the canonical start key when the spec is typed in another case (FIX 1)", { skip: skipCaseFs }, async () => {
  const root = await ciProject();

  const r = await run(["implement", "DASHBOARD/widget-grid"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  // The adjacency map is keyed canonically; a mixed-case start key reaches
  // nothing and the prerequisites list comes back empty.
  assert.match(r.stdout, /^ {2}- auth\/login {2}\[todo\]/m);
  assert.doesNotMatch(r.stdout, /^ {2}\(none\)$/m);

  const { events } = await readEvents(timingsLog(root));
  assert.equal(events.length, 1);
  assert.equal(events[0].target, "dashboard/widget-grid");
});

// A non-finite `ms` is reachable from a real, unmutated log: `JSON.parse("1e999")`
// is `Infinity` and passes deriveTotals's `typeof ms === "number" && ms > 0`
// filter. The raw JSONL text must therefore carry the literal numeral `1e999` —
// building the fixture from a JS object and JSON.stringify'ing it does NOT
// reproduce it, because `JSON.stringify(Infinity)` serializes to `null`.
const NON_FINITE_LOG =
  '{"ts":"2026-09-18T09:31:00.000Z","event":"ci","target":"auth/login","ms":1e999,"cmd":"npm test","exit":0}\n';
const NON_FINITE_ORPHAN_LOG =
  '{"ts":"2026-09-18T09:31:00.000Z","event":"ci","target":"deleted-spec/gone","ms":1e999,"cmd":"npm test","exit":0}\n';

test("timings never prints a literal NaN percentage for a non-finite total (FIX 3)", async () => {
  const root = await ciProject();
  await writeFile(timingsLog(root), NON_FINITE_LOG, "utf8");

  const r = await run(["timings"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  // pct(Infinity, Infinity) escaped both guards: `whole <= 0` is false and
  // `Infinity > Infinity` is false, so it returned Math.round(NaN) → "(NaN%)".
  assert.doesNotMatch(r.stdout, /NaN/);
});

test("timings suppresses the forest and island lines (not an all-zero fabrication) when the only recorded ms is non-finite (FIX 2)", async () => {
  const root = await ciProject();
  await writeFile(timingsLog(root), NON_FINITE_LOG, "utf8");

  const r = await run(["timings"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  // `activeMs <= 0` is false for Infinity, so both lines fell through to the
  // real formatter and printed "active 0s   ci 0s   coding 0s   lead 0s" — a
  // fabricated measurement, and the opposite of what `status` does with the
  // very same log. hasRecordedTime() is the single shared suppression rule.
  assert.match(r.stdout, /^ {2}auth-and-dashboard {2}\(no time recorded\)$/m);
  assert.doesNotMatch(r.stdout, /active 0s/);
});

test("timings --orphans --json reports codingMs 0, not null, for a non-finite total (FIX 4)", async () => {
  const root = await ciProject();
  await writeFile(timingsLog(root), NON_FINITE_ORPHAN_LOG, "utf8");

  const r = await run(["timings", "--orphans", "--json"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.orphans.length, 1);
  // The leaf path computed Math.max(0, Infinity - Infinity) === NaN, and
  // JSON.stringify(NaN) is `null` — while the aggregate path's finish() guard
  // yields 0 for the very same data. The two must agree.
  assert.equal(parsed.orphans[0].codingMs, 0);
});

test("timings rejects --orphans combined with a target instead of silently ignoring the flag (FIX 5)", async () => {
  const root = await ciProject();
  await writeFile(timingsLog(root), FIXTURE_LOG, "utf8");

  const r = await run(["timings", "auth/login", "--orphans"], { cwd: root });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--orphans cannot be combined with a target/);
  // The node report must not be printed: a user who got one would reasonably
  // conclude there are no orphans.
  assert.equal(r.stdout, "");
});

test("timings does not swallow an unknown single-dash flag as a target (FIX 5)", async () => {
  const root = await ciProject();
  await writeFile(timingsLog(root), FIXTURE_LOG, "utf8");

  // `ci` already treats any `-…` argument as a flag; `timings` only skipped
  // `--…`, so `-v` was parsed as the target and rejected as "bad target: -v".
  const r = await run(["timings", "--json", "-v"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /bad target/);
  const parsed = JSON.parse(r.stdout);
  assert.ok("forest" in parsed, "expected the forest report, not a node report");
});

test("implement's already-done hint suggests a canonical, copy-pasteable mark command (FIX 1)", { skip: skipCaseFs }, async () => {
  const root = await ciProject();
  const m = await run(["mark", "auth/login", "done"], { cwd: root });
  assert.equal(m.code, 0, m.stderr);

  const r = await run(["implement", "AUTH/login"], { cwd: root });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /specforest mark auth\/login todo/);
});
