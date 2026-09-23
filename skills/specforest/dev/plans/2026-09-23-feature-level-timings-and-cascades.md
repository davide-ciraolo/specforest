# Feature-Level Timings and Status Cascades Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Time feature nodes (not just leaves), cascade `done` downward to descendants, and record a timing event for every node whose status actually changes — without double-counting a parent's interval against its children's.

**Architecture:** Three layers change. (1) `timings.js` drops the `isLeaf` gate from `transitionEvent` and replaces the additive `aggregateTree` rule with the "descendants win" rule from spec §1.3. (2) `rollup.js` gains a downward `done` cascade and returns full paths on its ancestor changes. (3) `mark.js` / `implement.js` collect every changed node into one list and append all events in a single call.

**Tech Stack:** Node.js ≥18 ESM, `node:test` + `node:assert/strict`, no new dependencies.

**Spec:** `dev/specs/2026-09-21-feature-timings-design.md` §1.3, §2.1, §2.2, §2.4.

**Conventions to preserve:**
- Commands receive `stdout`/`stderr`/`stdin` by injection and return an exit code. Never touch `process.stdout` / `process.exit`.
- Timing failures warn on stderr and never fail the command.
- Event `target` is always the resolved full path `<spec>/<top>/…/<node>`, keyed off `tree.spec` (the as-stored casing), never the user-typed spec name.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/timings.js` | pure arithmetic | Modify: `transitionEvent` gate, `aggregateTree` rule |
| `src/rollup.js` | status propagation | Modify: `rollupAncestors` returns `fullPath`; add `cascadeDoneToDescendants` |
| `src/timings-io.js` | disk IO | Modify: add `recordTransitions` (plural, one append) |
| `src/commands/mark.js` | CLI | Modify: collect changes, cascade, single append |
| `src/commands/implement.js` | CLI | Modify: same collection path |
| `src/commands/ci.js` | CLI | Modify: drop the non-leaf warning |
| `tests/timings.test.js` | unit | Extend |
| `tests/io.test.js` | integration | Extend |

---

### Task 1: Drop the leaf gate from `transitionEvent`

**Files:**
- Modify: `src/timings.js` (the `transitionEvent` function, ~line 298)
- Modify: `src/timings-io.js` (`recordTransition`, remove the `isLeaf` computation)
- Test: `tests/timings.test.js`

- [ ] **Step 1: Write the failing test**

Add to `tests/timings.test.js`:

```js
test("transitionEvent records a node with children", () => {
  const ev = transitionEvent({
    isLeaf: false,
    from: "todo",
    to: "in_progress",
    source: "cli",
    target: "auth/login",
    ts: "2026-09-23T10:00:00.000Z",
  });
  assert.deepEqual(ev, {
    ts: "2026-09-23T10:00:00.000Z",
    event: "start",
    target: "auth/login",
    source: "cli",
  });
});

test("transitionEvent still ignores a non-crossing transition", () => {
  assert.equal(
    transitionEvent({ isLeaf: false, from: "todo", to: "done", source: "cli", target: "auth/login", ts: "2026-09-23T10:00:00.000Z" }),
    null,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/timings.test.js`
Expected: FAIL — first test gets `null` instead of the event object.

- [ ] **Step 3: Remove the gate**

In `src/timings.js`, delete the `if (!isLeaf) return null;` line. Keep the `isLeaf` parameter in the destructured signature so existing callers do not break, but stop reading it:

```js
export function transitionEvent({ from, to, source, target, ts }) {
  const wasIn = from === "in_progress";
  const isIn = to === "in_progress";
  if (wasIn === isIn) return null;
  return isIn
    ? { ts, event: "start", target, source }
    : { ts, event: "stop", target, to, source };
}
```

In `src/timings-io.js`, delete the `const isLeaf = ...` line and stop passing `isLeaf` to `transitionEvent`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/`
Expected: the two new tests PASS. Any existing test asserting "a non-leaf target writes nothing" now fails — delete those assertions, the spec amendment reverses them (§2.1).

---

### Task 2: Replace the aggregation rule with "descendants win"

**Files:**
- Modify: `src/timings.js` (`emptyAgg`, `addOwn`, `addAgg`, `aggregateTree`, ~lines 147-220)
- Test: `tests/timings.test.js`

**Spec §1.3 rule.** For each node:

```
descendantsTimed = any descendant recorded at least one interval
node.ciMs        = ownCiMs + Σ descendant.ciMs
node.activeMs    = Σ descendant.activeMs
                 + (descendantsTimed ? ownCiMs : ownIntervalMs + ownCiOutsideMs)
node.codingMs    = max(0, activeMs − ciMs)
```

`deriveTotals` currently returns a per-target `activeMs` that already folds in the out-of-interval CI. To apply the rule, `aggregateTree` needs the two parts separately. Add them to the per-target totals in `deriveTotals`:

- `intervalMs` — the sum over `intervals` only (what the existing `for (const iv of intervals)` loop accumulates).
- `ciOutsideMs` — the out-of-interval CI remainder (what the existing `if (!inside) t.activeMs += runMs` adds).

Keep `activeMs = intervalMs + ciOutsideMs` so the leaf path and every existing consumer are byte-identical.

- [ ] **Step 1: Write the failing test**

Add to `tests/timings.test.js`:

```js
const T0 = "2026-09-23T10:00:00.000Z";
const T1 = "2026-09-23T10:10:00.000Z";
const T2 = "2026-09-23T10:30:00.000Z";
const TREE = {
  spec: "auth",
  features: [
    {
      name: "login",
      status: "done",
      children: [
        { name: "form", status: "done", children: [] },
        { name: "validation", status: "done", children: [] },
      ],
    },
  ],
};

test("aggregateTree does not double-count a parent's spanning interval", () => {
  // The §2.4 cascade shape: parent spans [T0,T2], leaves partition it.
  const events = [
    { ts: T0, event: "start", target: "auth/login/form", source: "cli" },
    { ts: T0, event: "start", target: "auth/login", source: "cli" },
    { ts: T1, event: "stop", target: "auth/login/form", to: "done", source: "cli" },
    { ts: T1, event: "start", target: "auth/login/validation", source: "cli" },
    { ts: T2, event: "stop", target: "auth/login/validation", to: "done", source: "cli" },
    { ts: T2, event: "stop", target: "auth/login", to: "done", source: "cli" },
  ];
  const agg = aggregateTree(TREE, deriveTotals(events));
  const login = agg.get("auth/login");
  assert.equal(login.activeMs, 30 * 60 * 1000, "parent equals the elapsed span, not twice it");
  assert.equal(login.leadMs, 30 * 60 * 1000);
});

test("aggregateTree counts a parent's own interval when no leaf is timed", () => {
  const events = [
    { ts: T0, event: "start", target: "auth/login", source: "cli" },
    { ts: T2, event: "stop", target: "auth/login", to: "done", source: "cli" },
  ];
  const agg = aggregateTree(TREE, deriveTotals(events));
  assert.equal(agg.get("auth/login").activeMs, 30 * 60 * 1000);
});

test("aggregateTree keeps parent CI additive alongside timed leaves", () => {
  const events = [
    { ts: T0, event: "start", target: "auth/login/form", source: "cli" },
    { ts: T0, event: "start", target: "auth/login", source: "cli" },
    { ts: T1, event: "stop", target: "auth/login/form", to: "done", source: "cli" },
    { ts: T1, event: "stop", target: "auth/login", to: "done", source: "cli" },
    { ts: T2, event: "ci", target: "auth/login", ms: 5000, cmd: "make check", exit: 0 },
  ];
  const agg = aggregateTree(TREE, deriveTotals(events));
  const login = agg.get("auth/login");
  assert.equal(login.ciMs, 5000, "parent CI counts");
  assert.equal(login.activeMs, 10 * 60 * 1000 + 5000, "leaf interval + parent CI, parent interval suppressed");
  assert.equal(login.codingMs, 10 * 60 * 1000);
});

test("aggregateTree is unchanged for a leaf", () => {
  const events = [
    { ts: T0, event: "start", target: "auth/login/form", source: "cli" },
    { ts: T1, event: "stop", target: "auth/login/form", to: "done", source: "cli" },
  ];
  const agg = aggregateTree(TREE, deriveTotals(events));
  assert.equal(agg.get("auth/login/form").activeMs, 10 * 60 * 1000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/timings.test.js`
Expected: the first test FAILS reporting `3600000` (twice the span). The third FAILS on `activeMs`.

- [ ] **Step 3: Implement the rule**

In `deriveTotals`, split the two components onto the per-target totals object:

```js
const t = {
  activeMs: 0,
  intervalMs: 0,
  ciOutsideMs: 0,
  ciMs: 0,
  codingMs: 0,
  leadMs: 0,
  firstStart: null,
  lastEnd: null,
  open: false,
  intervals,
  ciRuns: [],
};
for (const iv of intervals) {
  t.intervalMs += iv.ms;
  if (iv.open) t.open = true;
}
t.activeMs = t.intervalMs;
```

and in the `ci` loop replace `if (!inside) t.activeMs += runMs;` with:

```js
if (!inside) {
  t.ciOutsideMs += runMs;
  t.activeMs += runMs;
}
```

In the aggregate half, `emptyAgg` gains `ownIntervalMs`, `ownCiOutsideMs`, `ownCiMs`, and `descIntervalCount`. Replace `addOwn` / `addAgg` / `aggregateTree`'s combination step with:

```js
function addOwn(acc, t) {
  acc.ownIntervalMs += t.intervalMs || 0;
  acc.ownCiOutsideMs += t.ciOutsideMs || 0;
  acc.ownCiMs += t.ciMs;
  acc.ciMs += t.ciMs;
  if (t.open) acc.open = true;
  acc.intervalCount += t.intervals ? t.intervals.length : 0;
  acc.ciRunCount += t.ciRuns ? t.ciRuns.length : 0;
  spanIn(acc, t.firstStart, t.lastEnd);
}

function addAgg(acc, a) {
  acc.activeMs += a.activeMs;
  acc.ciMs += a.ciMs;
  acc.descIntervalCount += a.intervalCount;
  if (a.open) acc.open = true;
  acc.intervalCount += a.intervalCount;
  acc.ciRunCount += a.ciRunCount;
  spanIn(acc, a.firstStart, a.lastEnd);
}
```

Note `addOwn` no longer touches `acc.activeMs` — the own contribution is decided in `finish`, after the children are known. `aggregateTree` must therefore call `addOwn` and every `addAgg` **before** `finish`, which it already does. Then:

```js
function finish(acc) {
  // Spec §1.3: descendants win. A node's own interval spans its descendants'
  // by construction under the §2.4 cascades, so adding both double-counts.
  // CI never overlaps — it is attributed to one target — so it stays additive.
  acc.activeMs += acc.descIntervalCount > 0
    ? acc.ownCiMs
    : acc.ownIntervalMs + acc.ownCiOutsideMs;
  const coding = acc.activeMs - acc.ciMs;
  acc.codingMs = Number.isFinite(coding) ? Math.max(0, coding) : 0;
  acc.leadMs =
    acc.firstStart !== null && acc.lastEnd !== null ? Math.max(0, acc.lastEnd - acc.firstStart) : 0;
  return acc;
}
```

Update the `aggregateTree` doc comment to describe the descendants-win rule and cite spec §1.3.

- [ ] **Step 4: Run the full suite**

Run: `node --test tests/`
Expected: all new tests PASS and every pre-existing timings test still passes (leaf behaviour is unchanged by construction).

---

### Task 3: Add the downward `done` cascade and full paths to rollup

**Files:**
- Modify: `src/rollup.js`
- Test: `tests/timings.test.js` (pure functions, no temp dirs needed)

- [ ] **Step 1: Write the failing test**

```js
import { cascadeDoneToDescendants, rollupAncestors } from "../src/rollup.js";

test("cascadeDoneToDescendants marks every descendant done and reports crossings", () => {
  const node = {
    name: "login",
    status: "done",
    children: [
      { name: "form", status: "in_progress", children: [] },
      { name: "validation", status: "todo", children: [] },
      { name: "nested", status: "todo", children: [{ name: "deep", status: "in_progress", children: [] }] },
    ],
  };
  const changes = cascadeDoneToDescendants(node, "login");
  assert.equal(node.children[0].status, "done");
  assert.equal(node.children[1].status, "done");
  assert.equal(node.children[2].children[0].status, "done");
  assert.deepEqual(
    changes.map((c) => [c.fullPath, c.from, c.to]),
    [
      ["login/form", "in_progress", "done"],
      ["login/validation", "todo", "done"],
      ["login/nested", "todo", "done"],
      ["login/nested/deep", "in_progress", "done"],
    ],
  );
});

test("cascadeDoneToDescendants is idempotent", () => {
  const node = { name: "login", status: "done", children: [{ name: "form", status: "done", children: [] }] };
  assert.deepEqual(cascadeDoneToDescendants(node, "login"), []);
});

test("rollupAncestors reports the ancestor's full path", () => {
  const leaf = { name: "form", status: "in_progress", children: [] };
  const tree = {
    spec: "auth",
    features: [{ name: "login", status: "todo", children: [leaf] }],
  };
  const changes = rollupAncestors(tree, leaf);
  assert.deepEqual(changes.map((c) => [c.fullPath, c.from, c.to]), [["login", "todo", "in_progress"]]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/timings.test.js`
Expected: FAIL — `cascadeDoneToDescendants` is not exported; `rollupAncestors` changes have no `fullPath`.

- [ ] **Step 3: Implement**

Add to `src/rollup.js`:

```js
/**
 * Spec §2.4: marking a node `done` marks every descendant `done`. Returns one
 * entry per descendant whose status actually changed, so the caller can record
 * a timing event for each. Pre-order, parents before their own children.
 *
 * `basePath` is the node's own full path within the spec (no spec prefix); the
 * caller adds `<spec>/`.
 */
export function cascadeDoneToDescendants(node, basePath) {
  const changes = [];
  const walk = (n, segs) => {
    for (const c of n.children || []) {
      const path = [...segs, c.name];
      if (c.status !== "done") {
        changes.push({ node: c, name: c.name, fullPath: path.join("/"), from: c.status, to: "done" });
        c.status = "done";
      }
      walk(c, path);
    }
  };
  walk(node, basePath.split("/"));
  return changes;
}
```

In `rollupAncestors`, build each ancestor's full path from the `path` array `findPathFromRoot` already produces, and include it alongside the existing `name` (keep `name` — `mark.js` prints it):

```js
export function rollupAncestors(tree, targetNode) {
  const path = findPathFromRoot(tree, targetNode);
  if (!path || path.length <= 1) return [];
  const changes = [];
  for (let i = path.length - 2; i >= 0; i--) {
    const ancestor = path[i];
    const before = ancestor.status;
    const after = rollupNodeStatus(ancestor);
    if (before !== after) {
      ancestor.status = after;
      changes.push({
        node: ancestor,
        name: ancestor.name,
        fullPath: path.slice(0, i + 1).map((n) => n.name).join("/"),
        from: before,
        to: after,
      });
    }
  }
  return changes;
}
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/`
Expected: PASS. Check `mark.js`'s existing `rollup: ...` stdout line still compiles — it reads `r.name`, which is retained.

---

### Task 4: Add `recordTransitions` (plural, single append)

**Files:**
- Modify: `src/timings-io.js`
- Test: `tests/io.test.js`

- [ ] **Step 1: Write the failing test**

```js
test("recordTransitions writes every crossing in one append", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "rt-"));
  const log = path.join(dir, "timings.jsonl");
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
});

test("recordTransitions writes nothing when disabled", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "rt-"));
  const log = path.join(dir, "timings.jsonl");
  assert.deepEqual(
    await recordTransitions({ enabled: false, timingsPath: log, changes: [{ fullPath: "a/b", from: "todo", to: "in_progress" }], source: "cli" }),
    [],
  );
  await assert.rejects(readFile(log, "utf8"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/io.test.js`
Expected: FAIL — `recordTransitions` is not exported.

- [ ] **Step 3: Implement**

Add to `src/timings-io.js`. All changes share one timestamp: they are one logical event, and distinct timestamps would let a cascade's parent `stop` sort before its child's.

```js
/**
 * Spec §2.4: append one event per status change that crossed the `in_progress`
 * boundary, in a single append so a crash cannot leave a half-written cascade.
 * `changes` entries carry `fullPath` already prefixed with `<spec>/`.
 */
export async function recordTransitions({ enabled, timingsPath, changes, source, ts = new Date().toISOString() }) {
  if (!enabled) return [];
  if (!Array.isArray(changes) || changes.length === 0) return [];
  const stamp = typeof ts === "string" && Number.isFinite(Date.parse(ts)) ? ts : new Date().toISOString();
  const events = [];
  for (const c of changes) {
    const ev = transitionEvent({ from: c.from, to: c.to, source, target: c.fullPath, ts: stamp });
    if (ev) events.push(ev);
  }
  if (events.length === 0) return [];
  await appendEvents(timingsPath, events);
  return events;
}
```

Keep the existing `recordTransition` (singular) exported — `implement.js` is migrated in Task 6 and the checkbox path in `sync-helpers.js` still uses `transitionEvent` directly.

- [ ] **Step 4: Run tests**

Run: `node --test tests/`
Expected: PASS.

---

### Task 5: Wire the cascade into `mark`

**Files:**
- Modify: `src/commands/mark.js:55-83`
- Test: `tests/io.test.js`

- [ ] **Step 1: Write the failing test**

Drive the real CLI in a temp project (follow the existing harness in `tests/io.test.js`; reuse its project-scaffold helper rather than writing a new one).

```js
test("marking a leaf in_progress starts both leaf and parent", async () => {
  const proj = await scaffold(); // tree: auth/login{form,validation}, timings enabled
  await cli(proj, ["mark", "auth/login/form", "in_progress"]);
  const evs = await readLog(proj);
  assert.deepEqual(
    evs.map((e) => [e.event, e.target]),
    [["start", "auth/login/form"], ["start", "auth/login"]],
  );
});

test("marking a feature done stops it, stops in-progress leaves, and marks all leaves done", async () => {
  const proj = await scaffold();
  await cli(proj, ["mark", "auth/login/form", "in_progress"]);
  await cli(proj, ["mark", "auth/login", "done"]);
  const evs = await readLog(proj);
  const tail = evs.slice(2).map((e) => [e.event, e.target]);
  assert.deepEqual(tail, [["stop", "auth/login/form"], ["stop", "auth/login"]]);
  const tree = await readTreeJson(proj, "auth");
  assert.equal(tree.features[0].children[0].status, "done");
  assert.equal(tree.features[0].children[1].status, "done", "untouched leaf is marked done too");
});

test("marking the last leaf done promotes and stops the parent", async () => {
  const proj = await scaffold();
  await cli(proj, ["mark", "auth/login/form", "in_progress"]);
  await cli(proj, ["mark", "auth/login/form", "done"]);
  await cli(proj, ["mark", "auth/login/validation", "in_progress"]);
  await cli(proj, ["mark", "auth/login/validation", "done"]);
  const evs = await readLog(proj);
  const last = evs[evs.length - 1];
  assert.equal(last.event, "stop");
  assert.equal(last.target, "auth/login");
  const tree = await readTreeJson(proj, "auth");
  assert.equal(tree.features[0].status, "done");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/io.test.js`
Expected: FAIL — only the leaf event is written; the untouched leaf is not marked done.

- [ ] **Step 3: Implement**

Replace the mutate-and-record block in `mark.js` (currently lines 55-79) with an ordered collection. Order matters and follows spec §2.4: descendants, then the target, then ancestors.

```js
const canonicalSpec = tree.spec;
const previousStatus = resolved.node.status;
const changes = [];

// Spec §2.4: descendants first, so a `done` cascade closes their intervals
// before the parent's own stop is recorded.
if (state === "done") {
  changes.push(...cascadeDoneToDescendants(resolved.node, resolved.fullPath));
}
if (previousStatus !== state) {
  resolved.node.status = state;
  changes.push({ node: resolved.node, fullPath: resolved.fullPath, from: previousStatus, to: state });
} else {
  resolved.node.status = state;
}
const rolled = rollupAncestors(tree, resolved.node);
changes.push(...rolled);

await writeTree(p.treesDir, tree);
try {
  await recordTransitions({
    enabled: config.timings,
    timingsPath: p.timings,
    changes: changes.map((c) => ({ ...c, fullPath: `${canonicalSpec}/${c.fullPath}` })),
    source: "cli",
  });
} catch (e) {
  stderr.write(`warning: could not record timing: ${e.message}\n`);
}
```

Keep the existing comment above the `recordTransitions` call explaining why the append precedes `regenAndWriteTreeCache`. Import `cascadeDoneToDescendants` from `../rollup.js` and `recordTransitions` from `../timings-io.js`.

Also report the cascade on stdout, after the existing `marked …` line and before the rollup lines:

```js
for (const c of changes) {
  if (c.node === resolved.node) continue;
  if (rolled.includes(c)) continue;
  stdout.write(`cascade: ${canonicalSpec}/${c.fullPath} ${c.from} → ${c.to}\n`);
}
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/`
Expected: PASS.

---

### Task 6: Wire the same collection into `implement`

**Files:**
- Modify: `src/commands/implement.js` (the `if (!noMark && targetNode.status !== "in_progress")` block)
- Test: `tests/io.test.js`

`implement` only ever sets `in_progress`, so there is no `done` cascade here — only the target plus rolled-up ancestors.

- [ ] **Step 1: Write the failing test**

```js
test("implement on a feature with children starts the feature", async () => {
  const proj = await scaffold();
  await cli(proj, ["implement", "auth/login"]);
  const evs = await readLog(proj);
  assert.deepEqual(evs.map((e) => [e.event, e.target]), [["start", "auth/login"]]);
});

test("implement on a leaf starts the leaf and its parent", async () => {
  const proj = await scaffold();
  await cli(proj, ["implement", "auth/login/form"]);
  const evs = await readLog(proj);
  assert.deepEqual(
    evs.map((e) => [e.event, e.target]),
    [["start", "auth/login/form"], ["start", "auth/login"]],
  );
});

test("implement --no-mark still writes nothing", async () => {
  const proj = await scaffold();
  await cli(proj, ["implement", "auth/login", "--no-mark"]);
  await assert.rejects(readFile(logPath(proj), "utf8"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/io.test.js`
Expected: FAIL — the first test's log is empty (the old `isLeaf` gate is gone, but the parent event from rollup is still unrecorded in the second test).

- [ ] **Step 3: Implement**

```js
let rolled = [];
if (!noMark && targetNode.status !== "in_progress") {
  const previousStatus = targetNode.status;
  targetNode.status = "in_progress";
  rolled = rollupAncestors(ownTree, targetNode);
  await writeTree(p.treesDir, ownTree);
  const changes = [
    { node: targetNode, fullPath, from: previousStatus, to: "in_progress" },
    ...rolled,
  ];
  try {
    await recordTransitions({
      enabled: config.timings,
      timingsPath: p.timings,
      changes: changes.map((c) => ({ ...c, fullPath: `${canonicalSpec}/${c.fullPath}` })),
      source: "cli",
    });
  } catch (e) {
    stderr.write(`warning: could not record timing: ${e.message}\n`);
  }
  try { await regenAndWriteTreeCache({ config, p, stderr }); } catch {}
}
```

Note the existing `fullTarget` local (`${canonicalSpec}/${fullPath}`) becomes unused by the timing call — check whether anything else reads it before deleting it.

- [ ] **Step 4: Run tests**

Run: `node --test tests/`
Expected: PASS.

---

### Task 7: Drop the non-leaf warning from `ci`

**Files:**
- Modify: `src/commands/ci.js`
- Test: `tests/ci.test.js`

Spec §1.3 makes CI additive at every level, so a `ci` run aimed at a feature is now charged to that feature.

- [ ] **Step 1: Write the failing test**

```js
test("ci on a feature with children records the run", async () => {
  const proj = await scaffold();
  const res = await cli(proj, ["ci", "auth/login", "--", process.execPath, "-e", "0"]);
  assert.equal(res.code, 0);
  assert.ok(!/sub-features/.test(res.stderr), "no non-leaf warning");
  const evs = await readLog(proj);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].event, "ci");
  assert.equal(evs[0].target, "auth/login");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/ci.test.js`
Expected: FAIL — stderr carries `has sub-features — running the command, no time recorded` and the log is empty.

- [ ] **Step 3: Implement**

Delete the `else if (!isLeaf) { ... }` branch and the `isLeaf` computation it guards, so the `ci` event is appended for any resolved target. Leave every other guard (`timings` disabled, missing `--`, unresolvable target) exactly as is.

- [ ] **Step 4: Run tests**

Run: `node --test tests/`
Expected: PASS. Delete or invert any pre-existing `ci.test.js` assertion that expects the warning.

---

### Task 8: Full-suite regression and SKILL.md

**Files:**
- Modify: `SKILL.md`
- Test: all

- [ ] **Step 1: Run the whole suite**

Run: `node --test tests/`
Expected: all tests pass. Baseline before this plan was 220 passing; the count should rise, and none should have been deleted except the leaf-gate assertions Tasks 1 and 7 explicitly reverse.

- [ ] **Step 2: Document the cascade in `SKILL.md`**

In the Implement flow section, after the `mark … done` step, add:

```markdown
Marking a feature `done` also marks all of its sub-features `done`. Marking the
last outstanding sub-feature `done` promotes the parent automatically. Marking a
sub-feature `in_progress` promotes its parent to `in_progress`. Timing follows
status, so you do not need to mark parents by hand.
```

Also add `ci` and `timings` to the `## When to invoke` list — an agent driving specforest currently never learns they exist, which is the workflow gap that produced zero coding time in the first place:

```markdown
- Running tests / lint / format / typecheck for a feature → wrap it: `ci <spec>/<feature> -- <command>`. This is what separates CI time from coding time.
- "how long did X take" / "show timings" / `/specforest-timings` → **Timings flow**: `timings [<spec>/<feature>]`.
```

- [ ] **Step 3: Verify the examples in `SKILL.md` still match the CLI**

Run: `node bin/cli.js timings --help` (or the no-arg form) and confirm the documented invocation matches.

---

## Out of scope

- Checkbox adoption does not cascade (spec §2.4 scope boundary). It gains non-leaf recording only.
- No backfill of historical logs. Existing `timings.jsonl` files keep their meaning; the aggregation change alters only how parents are summed.
