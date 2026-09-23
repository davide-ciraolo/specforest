# Feature Timings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record how long each leaf feature took, split into CI time and coding time, and surface it in `timings`, `status`, and the ASCII `tree`.

**Architecture:** An append-only JSONL event log (`.specforest/timings.jsonl`) captures `start` / `stop` / `ci` events. Nothing is stored pre-computed — every figure is derived on read by pairing `start`/`stop` events into intervals. Two new modules split pure logic (`src/timings.js`) from filesystem access (`src/timings-io.js`), mirroring the existing `counters.js` / `tree-io.js` split. Write hooks go in the only three places that mutate feature status; read hooks go in the three reporting surfaces.

**Tech Stack:** Node.js ≥18, ESM, zero new dependencies. Tests use `node:test` + `node:assert/strict`.

**Binding spec:** [`dev/specs/2026-09-21-feature-timings-design.md`](../specs/2026-09-21-feature-timings-design.md). If this plan and the spec disagree, the spec wins.

**Working directory for every command in this plan:** the specforest package root — the directory containing `package.json`, `bin/`, `src/`, `tests/`. All file paths below are relative to it.

**Commit policy:** the repository owner requires explicit permission before every `git commit`. The commit step at the end of each task is written out for completeness, but **ask before running it**.

---

## Spec decisions resolved here

Three points where the spec's illustrative examples are looser than its normative text. These resolutions are binding for this plan:

1. **`formatDuration` is always two components.** §2.1 of the spec gives the signature as `"3d 2h" | "2h 41m" | "48.2s" | "0s"`. The sample report in §4.1 shows `3d 2h 14m` (three components) and `52m` (one). The two-component rule in §2.1 is normative; the §4 samples are illustrative prose.
2. **Spec-name lines in the ASCII tree are never annotated.** §4.3 annotates islands and feature nodes only. This is load-bearing, not cosmetic: `extractSpecBlockFromCache` locates a spec block with an exact string equality test (`rest === specName`), which any suffix would break.
3. **An unresolvable `ci` target exits 1 before spawning.** The spec covers the non-leaf case (run anyway, warn) and the missing-`--` case (exit 1 before spawning) but not a typo'd target. A typo is a usage error of the same class as a missing `--`, so it fails fast.

---

## File Structure

**New files**

| File | Responsibility |
|---|---|
| `src/timings.js` | Pure. Event → figures. No `fs`, no `process`. `formatDuration`, `formatAnnotation`, `transitionEvent`, `pairIntervals`, `deriveTotals`, `aggregateTree`, `aggregateForest`. |
| `src/timings-io.js` | Filesystem. `appendEvents`, `readEvents`, `recordTransition`. |
| `src/commands/ci.js` | The `ci` wrapper command. |
| `src/commands/timings.js` | The `timings` report command. |
| `tests/timings.test.js` | Unit tests for both new modules. |

**Modified files**

| File | Change |
|---|---|
| `src/config.js` | `timings: true` default, YAML template line, boolean validation |
| `src/paths.js` | `timings` path key |
| `src/commands/mark.js` | capture `from`, call `recordTransition` |
| `src/commands/implement.js` | same, at the `in_progress` assignment |
| `src/render.js` | `syncCheckboxes` returns `transitions` |
| `src/sync-helpers.js` | appends checkbox-sourced events |
| `src/commands/status.js` | timing suffix on forest + island lines |
| `src/ascii.js` | optional `annotate` callback on all three renderers |
| `src/tree-cache.js` | feed totals into the renderer; de-anchor `counterRe`; add `p.timings` to staleness inputs |
| `src/commands/tree.js` | pass `annotate` through |
| 10 other command files | pass `timingsPath` / `timingsEnabled` to `syncCheckboxesAndPersistOrphans` |
| `bin/cli.js` | register `ci` and `timings` |
| `SKILL.md` | § Timings, CI category rule, implement-flow step, pitfalls |
| `tests/io.test.js`, `tests/e2e.test.js`, `tests/render.test.js`, `tests/tree-cache.test.js` | new coverage |

---

## Task 1: Config flag and timings path

**Files:**
- Modify: `src/config.js`
- Modify: `src/paths.js`
- Test: `tests/io.test.js`

- [ ] **Step 1: Write the failing tests**

In `tests/io.test.js`, add these two tests immediately after the existing `test("paths derives all keys", …)` block:

```js
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

test("timings must be a boolean and can be disabled", async () => {
  const dir = await tmpProject();
  try {
    await writeDefaultConfig(dir);
    const c = await loadConfig(dir);
    assert.equal(c.timings, true);
    assert.ok(c.timings !== undefined);
    const p = paths("/proj", c);
    assert.ok(p.timings.endsWith(path.join(".specforest", "timings.jsonl")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  assert.throws(() => validateConfig({ ...defaultConfig(), timings: "yes" }), /timings must be a boolean/);
  assert.ok(validateConfig({ ...defaultConfig(), timings: false }));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/io.test.js`

Expected: both new tests FAIL — `c.timings` is `undefined`, `p.timings` is `undefined`, and `validateConfig` does not throw.

- [ ] **Step 3: Add the config default, YAML line, and validation**

In `src/config.js`, add `timings: true` as the last key of the object returned by `defaultConfig()`:

```js
export function defaultConfig() {
  return {
    specsDir: "docs/specs",
    outputDir: "docs/trees",
    hiddenDir: ".specforest",
    specsGlob: "**/*.md",
    ignore: [],
    maxDepth: 2,
    wikilinkStyle: "obsidian",
    checkboxMarkers: defaultMarkers(),
    timings: true,
  };
}
```

In the same file, append one line to the template string returned by `defaultConfigYaml()`, after the `checkboxMarkers` block:

```js
export function defaultConfigYaml() {
  return `# specforest config — see docs/superpowers/specs/2026-05-18-specforest-skill-design.md
specsDir: docs/specs
outputDir: docs/trees
hiddenDir: .specforest
specsGlob: "**/*.md"
ignore: []
maxDepth: 2
wikilinkStyle: obsidian
checkboxMarkers:
  todo: " "
  in_progress: "/"
  blocked: "-"
  done: "x"
timings: true
`;
}
```

In `validateConfig`, add the boolean check immediately before the `validateMarkers` call:

```js
  if (typeof c.timings !== "boolean") throw new Error("config.timings must be a boolean");
  validateMarkers(c.checkboxMarkers);
```

- [ ] **Step 4: Add the timings path**

In `src/paths.js`, add one key to the returned object, after `treeCache`:

```js
    treeCache: path.join(hidden, "tree.txt"),
    timings: path.join(hidden, "timings.jsonl"),
  };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/io.test.js`

Expected: PASS, including the pre-existing `defaultConfig validates` and `writeDefaultConfig then loadConfig roundtrip` tests.

- [ ] **Step 6: Commit** *(ask first)*

```bash
git add src/config.js src/paths.js tests/io.test.js
git commit -m "feat(specforest): add timings config flag and event-log path"
```

---

## Task 2: `formatDuration`

**Files:**
- Create: `src/timings.js`
- Create: `tests/timings.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/timings.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDuration } from "../src/timings.js";

test("formatDuration renders two components at each magnitude", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(-5000), "0s");
  assert.equal(formatDuration(null), "0s");
  assert.equal(formatDuration(48210), "48.2s");
  assert.equal(formatDuration(59999), "60.0s");
  assert.equal(formatDuration(60000), "1m 00s");
  assert.equal(formatDuration(124000), "2m 04s");
  assert.equal(formatDuration(1872000), "31m 12s");
  assert.equal(formatDuration(3600000), "1h 00m");
  assert.equal(formatDuration(9660000), "2h 41m");
  assert.equal(formatDuration(86400000), "1d 0h");
  assert.equal(formatDuration(266400000), "3d 2h");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/timings.test.js`

Expected: FAIL — `Cannot find module '../src/timings.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/timings.js`:

```js
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * Human duration, always at most two components.
 * @param {number|null|undefined} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "0s";
  if (ms < MIN) return `${(ms / SEC).toFixed(1)}s`;
  if (ms < HOUR) {
    const m = Math.floor(ms / MIN);
    const s = Math.floor((ms % MIN) / SEC);
    return `${m}m ${pad2(s)}s`;
  }
  if (ms < DAY) {
    const h = Math.floor(ms / HOUR);
    const m = Math.floor((ms % HOUR) / MIN);
    return `${h}h ${pad2(m)}m`;
  }
  const d = Math.floor(ms / DAY);
  const h = Math.floor((ms % DAY) / HOUR);
  return `${d}d ${h}h`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/timings.test.js`

Expected: PASS.

- [ ] **Step 5: Commit** *(ask first)*

```bash
git add src/timings.js tests/timings.test.js
git commit -m "feat(specforest): add formatDuration for timing reports"
```

---

## Task 3: Interval pairing and `deriveTotals`

**Files:**
- Modify: `src/timings.js`
- Test: `tests/timings.test.js`

This is the core reader. It converts a flat event list into per-target figures.

**The totals shape produced here** (referenced by every later task):

```js
{
  activeMs: number,
  ciMs: number,
  codingMs: number,
  leadMs: number,
  firstStart: number|null,   // epoch ms
  lastEnd: number|null,      // epoch ms
  open: boolean,
  intervals: [{ start: number, end: number, ms: number, to: string|null, source: string, open: boolean }],
  ciRuns: [{ ts: number, ms: number, cmd: string, exit: number }],
}
```

- [ ] **Step 1: Write the failing tests**

Append to `tests/timings.test.js`:

```js
import { deriveTotals } from "../src/timings.js";

const T0 = Date.parse("2026-09-21T09:00:00.000Z");
const iso = (offsetMs) => new Date(T0 + offsetMs).toISOString();
const NOW = T0 + 10 * 60 * 60 * 1000;

test("deriveTotals pairs a simple closed interval", () => {
  const totals = deriveTotals([
    { ts: iso(0), event: "start", target: "s/a", source: "cli" },
    { ts: iso(60000), event: "stop", target: "s/a", to: "done", source: "cli" },
  ], NOW);
  const t = totals.get("s/a");
  assert.equal(t.activeMs, 60000);
  assert.equal(t.ciMs, 0);
  assert.equal(t.codingMs, 60000);
  assert.equal(t.leadMs, 60000);
  assert.equal(t.open, false);
  assert.equal(t.intervals.length, 1);
  assert.equal(t.intervals[0].to, "done");
});

test("deriveTotals counts an open interval up to now and flags it", () => {
  const totals = deriveTotals([
    { ts: iso(0), event: "start", target: "s/a", source: "cli" },
  ], NOW);
  const t = totals.get("s/a");
  assert.equal(t.open, true);
  assert.equal(t.activeMs, NOW - T0);
  assert.equal(t.intervals[0].open, true);
  assert.equal(t.intervals[0].to, null);
});

test("deriveTotals ignores a duplicate start and an unpaired stop", () => {
  const totals = deriveTotals([
    { ts: iso(0), event: "start", target: "s/a", source: "cli" },
    { ts: iso(10000), event: "start", target: "s/a", source: "cli" },
    { ts: iso(60000), event: "stop", target: "s/a", to: "done", source: "cli" },
    { ts: iso(70000), event: "stop", target: "s/a", to: "todo", source: "cli" },
  ], NOW);
  const t = totals.get("s/a");
  assert.equal(t.intervals.length, 1);
  assert.equal(t.activeMs, 60000);
});

test("deriveTotals keeps interleaved targets separate", () => {
  const totals = deriveTotals([
    { ts: iso(0), event: "start", target: "s/a", source: "cli" },
    { ts: iso(1000), event: "start", target: "s/b", source: "cli" },
    { ts: iso(61000), event: "stop", target: "s/b", to: "done", source: "cli" },
    { ts: iso(120000), event: "stop", target: "s/a", to: "done", source: "cli" },
  ], NOW);
  assert.equal(totals.get("s/a").activeMs, 120000);
  assert.equal(totals.get("s/b").activeMs, 60000);
});

test("deriveTotals: ci inside an interval splits active into ci and coding", () => {
  const totals = deriveTotals([
    { ts: iso(0), event: "start", target: "s/a", source: "cli" },
    { ts: iso(30000), event: "ci", target: "s/a", ms: 20000, cmd: "npm test", exit: 0 },
    { ts: iso(100000), event: "stop", target: "s/a", to: "done", source: "cli" },
  ], NOW);
  const t = totals.get("s/a");
  assert.equal(t.activeMs, 100000);
  assert.equal(t.ciMs, 20000);
  assert.equal(t.codingMs, 80000);
  assert.equal(t.ciRuns.length, 1);
  assert.equal(t.ciRuns[0].cmd, "npm test");
});

test("deriveTotals: ci outside every interval is added to active, never negative coding", () => {
  const totals = deriveTotals([
    { ts: iso(0), event: "start", target: "s/a", source: "cli" },
    { ts: iso(10000), event: "stop", target: "s/a", to: "done", source: "cli" },
    { ts: iso(500000), event: "ci", target: "s/a", ms: 20000, cmd: "npm test", exit: 1 },
  ], NOW);
  const t = totals.get("s/a");
  assert.equal(t.activeMs, 30000);
  assert.equal(t.ciMs, 20000);
  assert.equal(t.codingMs, 10000);
  assert.equal(t.leadMs, 10000);
});

test("deriveTotals: ci with no interval at all yields zero coding, not negative", () => {
  const totals = deriveTotals([
    { ts: iso(0), event: "ci", target: "s/a", ms: 20000, cmd: "npm test", exit: 0 },
  ], NOW);
  const t = totals.get("s/a");
  assert.equal(t.activeMs, 20000);
  assert.equal(t.ciMs, 20000);
  assert.equal(t.codingMs, 0);
  assert.equal(t.leadMs, 0);
  assert.equal(t.firstStart, null);
});

test("deriveTotals clamps a negative interval caused by clock skew", () => {
  const totals = deriveTotals([
    { ts: iso(60000), event: "start", target: "s/a", source: "cli" },
    { ts: iso(0), event: "stop", target: "s/a", to: "done", source: "cli" },
  ], NOW);
  assert.equal(totals.get("s/a").activeMs, 0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/timings.test.js`

Expected: FAIL — `deriveTotals is not a function` / `SyntaxError: does not provide an export named 'deriveTotals'`.

- [ ] **Step 3: Write the implementation**

Append to `src/timings.js`:

```js
/**
 * Pairs a target's chronologically sorted start/stop events into intervals.
 * A trailing unpaired start becomes an open interval ending at `now`.
 * A stop with no open start is ignored; a start while one is already open is ignored.
 */
export function pairIntervals(events, now) {
  const intervals = [];
  let openAt = null;
  let openSource = "cli";
  for (const e of events) {
    const ts = Date.parse(e.ts);
    if (!Number.isFinite(ts)) continue;
    if (e.event === "start") {
      if (openAt != null) continue;
      openAt = ts;
      openSource = e.source || "cli";
    } else if (e.event === "stop") {
      if (openAt == null) continue;
      intervals.push({
        start: openAt,
        end: ts,
        ms: Math.max(0, ts - openAt),
        to: e.to || null,
        source: e.source || "cli",
        open: false,
      });
      openAt = null;
    }
  }
  if (openAt != null) {
    intervals.push({
      start: openAt,
      end: now,
      ms: Math.max(0, now - openAt),
      to: null,
      source: openSource,
      open: true,
    });
  }
  return intervals;
}

function emptyTotals() {
  return {
    activeMs: 0,
    ciMs: 0,
    codingMs: 0,
    leadMs: 0,
    firstStart: null,
    lastEnd: null,
    open: false,
    intervals: [],
    ciRuns: [],
  };
}

/**
 * @param {Array<object>} events raw log records
 * @param {number} [now] epoch ms used to close open intervals
 * @returns {Map<string, object>} target → totals
 */
export function deriveTotals(events, now = Date.now()) {
  const byTarget = new Map();
  for (const e of events) {
    if (!e || typeof e.target !== "string") continue;
    if (!byTarget.has(e.target)) byTarget.set(e.target, []);
    byTarget.get(e.target).push(e);
  }

  const out = new Map();
  for (const [target, raw] of byTarget) {
    const sorted = [...raw].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    const intervals = pairIntervals(sorted.filter((e) => e.event === "start" || e.event === "stop"), now);

    const t = emptyTotals();
    t.intervals = intervals;
    for (const iv of intervals) t.activeMs += iv.ms;
    t.open = intervals.some((iv) => iv.open);
    if (intervals.length > 0) {
      t.firstStart = intervals[0].start;
      t.lastEnd = intervals[intervals.length - 1].end;
      t.leadMs = Math.max(0, t.lastEnd - t.firstStart);
    }

    for (const e of sorted) {
      if (e.event !== "ci") continue;
      const ts = Date.parse(e.ts);
      const ms = typeof e.ms === "number" && Number.isFinite(e.ms) ? Math.max(0, e.ms) : 0;
      t.ciRuns.push({ ts, ms, cmd: typeof e.cmd === "string" ? e.cmd : "", exit: typeof e.exit === "number" ? e.exit : 0 });
      t.ciMs += ms;
      const inside = intervals.some((iv) => ts >= iv.start && ts <= iv.end);
      if (!inside) t.activeMs += ms;
    }

    t.codingMs = Math.max(0, t.activeMs - t.ciMs);
    out.set(target, t);
  }
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/timings.test.js`

Expected: PASS — all 9 tests.

- [ ] **Step 5: Commit** *(ask first)*

```bash
git add src/timings.js tests/timings.test.js
git commit -m "feat(specforest): derive per-target timing totals from the event log"
```

---

## Task 4: Tree and forest aggregation, and the annotation string

**Files:**
- Modify: `src/timings.js`
- Test: `tests/timings.test.js`

Implements spec §1.3: `node.total = node.ownRecords + Σ descendant.total`, with `leadMs` as `max(lastEnd) − min(firstStart)` across the node and its descendants.

**The aggregate shape** (distinct from the `deriveTotals` shape — it carries counts, not lists):

```js
{ activeMs, ciMs, codingMs, leadMs, firstStart, lastEnd, open, intervalCount, ciRunCount }
```

- [ ] **Step 1: Write the failing tests**

Append to `tests/timings.test.js`:

```js
import { aggregateTree, aggregateForest, formatAnnotation } from "../src/timings.js";

function leaf(name, status = "todo") {
  return { name, source: "heading", originalHeading: `## ${name}`, status, children: [] };
}

const TREE = {
  spec: "auth",
  specPath: "docs/specs/auth.md",
  specHash: "sha256:x",
  features: [
    { name: "login", source: "heading", originalHeading: "## login", status: "in_progress", children: [leaf("form"), leaf("validation")] },
    leaf("logout"),
  ],
};

test("aggregateTree rolls leaf totals up into parents", () => {
  const totals = deriveTotals([
    { ts: iso(0), event: "start", target: "auth/login/form", source: "cli" },
    { ts: iso(60000), event: "ci", target: "auth/login/form", ms: 10000, cmd: "npm test", exit: 0 },
    { ts: iso(100000), event: "stop", target: "auth/login/form", to: "done", source: "cli" },
    { ts: iso(200000), event: "start", target: "auth/login/validation", source: "cli" },
    { ts: iso(260000), event: "stop", target: "auth/login/validation", to: "done", source: "cli" },
  ], NOW);
  const agg = aggregateTree(TREE, totals);

  assert.equal(agg.get("auth/login/form").activeMs, 100000);
  assert.equal(agg.get("auth/login/form").ciMs, 10000);
  assert.equal(agg.get("auth/login/validation").activeMs, 60000);

  const login = agg.get("auth/login");
  assert.equal(login.activeMs, 160000);
  assert.equal(login.ciMs, 10000);
  assert.equal(login.codingMs, 150000);
  assert.equal(login.intervalCount, 2);
  assert.equal(login.ciRunCount, 1);
  assert.equal(login.leadMs, 260000);

  assert.equal(agg.get("auth/logout").activeMs, 0);
});

test("aggregateTree adds a node's own historical records on top of its children", () => {
  const totals = deriveTotals([
    { ts: iso(0), event: "start", target: "auth/login", source: "cli" },
    { ts: iso(50000), event: "stop", target: "auth/login", to: "done", source: "cli" },
    { ts: iso(100000), event: "start", target: "auth/login/form", source: "cli" },
    { ts: iso(130000), event: "stop", target: "auth/login/form", to: "done", source: "cli" },
  ], NOW);
  const agg = aggregateTree(TREE, totals);
  assert.equal(agg.get("auth/login").activeMs, 80000);
  assert.equal(agg.get("auth/login").leadMs, 130000);
});

test("aggregateForest sums islands and reports orphans", () => {
  const totals = deriveTotals([
    { ts: iso(0), event: "start", target: "auth/login/form", source: "cli" },
    { ts: iso(60000), event: "stop", target: "auth/login/form", to: "done", source: "cli" },
    { ts: iso(0), event: "start", target: "gone/old-thing", source: "cli" },
    { ts: iso(30000), event: "stop", target: "gone/old-thing", to: "done", source: "cli" },
  ], NOW);
  const built = { islands: [{ name: "auth-island", specs: [{ tree: TREE }] }] };
  const f = aggregateForest(built, totals);
  assert.equal(f.forest.activeMs, 60000);
  assert.equal(f.byIsland.get("auth-island").activeMs, 60000);
  assert.equal(f.byNode.get("auth/login/form").activeMs, 60000);
  assert.deepEqual(f.orphans.map((o) => o.target), ["gone/old-thing"]);
});

test("formatAnnotation is empty for zero time and omits ci when there is none", () => {
  assert.equal(formatAnnotation({ activeMs: 0, ciMs: 0, open: false }), "");
  assert.equal(formatAnnotation({ activeMs: 9660000, ciMs: 0, open: false }), "2h 41m");
  assert.equal(formatAnnotation({ activeMs: 9660000, ciMs: 1872000, open: false }), "2h 41m (ci 31m 12s)");
  assert.equal(formatAnnotation({ activeMs: 9660000, ciMs: 0, open: true }), "2h 41m (running)");
  assert.equal(formatAnnotation(undefined), "");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/timings.test.js`

Expected: FAIL — `does not provide an export named 'aggregateTree'`.

- [ ] **Step 3: Write the implementation**

Append to `src/timings.js`:

```js
function emptyAgg() {
  return {
    activeMs: 0,
    ciMs: 0,
    codingMs: 0,
    leadMs: 0,
    firstStart: null,
    lastEnd: null,
    open: false,
    intervalCount: 0,
    ciRunCount: 0,
  };
}

function addOwn(acc, t) {
  if (!t) return acc;
  acc.activeMs += t.activeMs;
  acc.ciMs += t.ciMs;
  acc.intervalCount += t.intervals.length;
  acc.ciRunCount += t.ciRuns.length;
  acc.open = acc.open || t.open;
  if (t.firstStart != null) acc.firstStart = acc.firstStart == null ? t.firstStart : Math.min(acc.firstStart, t.firstStart);
  if (t.lastEnd != null) acc.lastEnd = acc.lastEnd == null ? t.lastEnd : Math.max(acc.lastEnd, t.lastEnd);
  return acc;
}

function addAgg(acc, a) {
  if (!a) return acc;
  acc.activeMs += a.activeMs;
  acc.ciMs += a.ciMs;
  acc.intervalCount += a.intervalCount;
  acc.ciRunCount += a.ciRunCount;
  acc.open = acc.open || a.open;
  if (a.firstStart != null) acc.firstStart = acc.firstStart == null ? a.firstStart : Math.min(acc.firstStart, a.firstStart);
  if (a.lastEnd != null) acc.lastEnd = acc.lastEnd == null ? a.lastEnd : Math.max(acc.lastEnd, a.lastEnd);
  return acc;
}

function finish(acc) {
  acc.codingMs = Math.max(0, acc.activeMs - acc.ciMs);
  acc.leadMs = acc.firstStart != null && acc.lastEnd != null ? Math.max(0, acc.lastEnd - acc.firstStart) : 0;
  return acc;
}

/**
 * @param {object} tree a validated tree JSON
 * @param {Map<string, object>} totals from deriveTotals
 * @returns {Map<string, object>} "<spec>/<path…>" → aggregate
 */
export function aggregateTree(tree, totals) {
  const out = new Map();

  function visit(node, segs) {
    const path = [...segs, node.name];
    const key = `${tree.spec}/${path.join("/")}`;
    const acc = addOwn(emptyAgg(), totals.get(key));
    for (const child of node.children || []) {
      addAgg(acc, visit(child, path));
    }
    finish(acc);
    out.set(key, acc);
    return acc;
  }

  for (const f of tree.features) visit(f, []);
  return out;
}

/**
 * @param {{islands: Array<{name: string, specs: Array<{tree: object}>}>}} built from buildForestStructure
 * @param {Map<string, object>} totals from deriveTotals
 * @returns {{forest: object, byIsland: Map<string,object>, byNode: Map<string,object>, orphans: Array<{target: string, totals: object}>}}
 */
export function aggregateForest(built, totals) {
  const byIsland = new Map();
  const byNode = new Map();
  const forest = emptyAgg();
  const seen = new Set();

  for (const isl of built.islands || []) {
    const islAcc = emptyAgg();
    for (const spec of isl.specs || []) {
      const agg = aggregateTree(spec.tree, totals);
      for (const [key, a] of agg) byNode.set(key, a);
      for (const f of spec.tree.features) {
        addAgg(islAcc, byNode.get(`${spec.tree.spec}/${f.name}`));
      }
      for (const key of agg.keys()) seen.add(key);
    }
    finish(islAcc);
    byIsland.set(isl.name, islAcc);
    addAgg(forest, islAcc);
  }
  finish(forest);

  const orphans = [];
  for (const [target, t] of totals) {
    if (seen.has(target)) continue;
    orphans.push({ target, totals: finish(addOwn(emptyAgg(), t)) });
  }
  orphans.sort((a, b) => a.target.localeCompare(b.target));

  return { forest, byIsland, byNode, orphans };
}

/**
 * Suffix used by the ASCII tree and `status`. Empty string when nothing was recorded.
 * @param {object|undefined} agg
 * @returns {string}
 */
export function formatAnnotation(agg) {
  if (!agg || agg.activeMs <= 0) return "";
  let s = formatDuration(agg.activeMs);
  if (agg.ciMs > 0) s += ` (ci ${formatDuration(agg.ciMs)})`;
  if (agg.open) s += " (running)";
  return s;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/timings.test.js`

Expected: PASS — all 13 tests.

- [ ] **Step 5: Commit** *(ask first)*

```bash
git add src/timings.js tests/timings.test.js
git commit -m "feat(specforest): aggregate timing totals across trees and islands"
```

---

## Task 5: The IO layer — read, append, record

**Files:**
- Modify: `src/timings.js` (adds the pure `transitionEvent`)
- Create: `src/timings-io.js`
- Test: `tests/timings.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/timings.test.js`. Add these imports at the top of the file alongside the existing ones:

```js
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { transitionEvent } from "../src/timings.js";
import { appendEvents, readEvents, recordTransition } from "../src/timings-io.js";
```

Then append these tests:

```js
async function tmpLog() {
  const dir = await mkdtemp(path.join(tmpdir(), "sf-timings-"));
  return { dir, file: path.join(dir, "timings.jsonl") };
}

test("transitionEvent only fires on an in_progress boundary, and only for leaves", () => {
  const base = { target: "s/a", source: "cli", ts: "2026-09-21T09:00:00.000Z" };
  assert.equal(transitionEvent({ ...base, isLeaf: true, from: "todo", to: "in_progress" }).event, "start");
  const stop = transitionEvent({ ...base, isLeaf: true, from: "in_progress", to: "done" });
  assert.equal(stop.event, "stop");
  assert.equal(stop.to, "done");
  assert.equal(transitionEvent({ ...base, isLeaf: true, from: "todo", to: "blocked" }), null);
  assert.equal(transitionEvent({ ...base, isLeaf: true, from: "in_progress", to: "in_progress" }), null);
  assert.equal(transitionEvent({ ...base, isLeaf: false, from: "todo", to: "in_progress" }), null);
});

test("readEvents on a missing file yields nothing and no error", async () => {
  const { dir, file } = await tmpLog();
  try {
    const r = await readEvents(file);
    assert.deepEqual(r.events, []);
    assert.deepEqual(r.warnings, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("appendEvents then readEvents round-trips, and a malformed line is skipped with a warning", async () => {
  const { dir, file } = await tmpLog();
  try {
    await appendEvents(file, [{ ts: "2026-09-21T09:00:00.000Z", event: "start", target: "s/a", source: "cli" }]);
    await writeFile(file, "not json\n", { flag: "a" });
    await appendEvents(file, [{ ts: "2026-09-21T09:10:00.000Z", event: "stop", target: "s/a", to: "done", source: "cli" }]);
    const r = await readEvents(file);
    assert.equal(r.events.length, 2);
    assert.equal(r.events[0].event, "start");
    assert.equal(r.events[1].event, "stop");
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /line 2/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recordTransition writes nothing when disabled, for a non-leaf, or off-boundary", async () => {
  const { dir, file } = await tmpLog();
  try {
    const leafNode = { name: "form", children: [] };
    const parentNode = { name: "login", children: [{ name: "form", children: [] }] };

    assert.equal(await recordTransition({ enabled: false, timingsPath: file, node: leafNode, fullPath: "s/a", from: "todo", to: "in_progress", source: "cli" }), null);
    assert.equal(await recordTransition({ enabled: true, timingsPath: file, node: parentNode, fullPath: "s/login", from: "todo", to: "in_progress", source: "cli" }), null);
    assert.equal(await recordTransition({ enabled: true, timingsPath: file, node: leafNode, fullPath: "s/a", from: "todo", to: "blocked", source: "cli" }), null);
    assert.deepEqual((await readEvents(file)).events, []);

    const ev = await recordTransition({ enabled: true, timingsPath: file, node: leafNode, fullPath: "s/a", from: "todo", to: "in_progress", source: "cli" });
    assert.equal(ev.event, "start");
    assert.equal(ev.target, "s/a");
    assert.equal((await readEvents(file)).events.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/timings.test.js`

Expected: FAIL — `Cannot find module '../src/timings-io.js'`.

- [ ] **Step 3: Add `transitionEvent` to `src/timings.js`**

Append to `src/timings.js`:

```js
/**
 * Builds the event for a status change, or null when no event is warranted.
 * Emits only on a transition that crosses the in_progress boundary, and only for leaves.
 * Keeping this pure is what lets rollupAncestors stay untouched: every ancestor has
 * children, so isLeaf is false and nothing is recorded.
 */
export function transitionEvent({ isLeaf, from, to, source, target, ts }) {
  if (!isLeaf) return null;
  const wasIn = from === "in_progress";
  const isIn = to === "in_progress";
  if (wasIn === isIn) return null;
  return isIn
    ? { ts, event: "start", target, source }
    : { ts, event: "stop", target, to, source };
}
```

- [ ] **Step 4: Create `src/timings-io.js`**

```js
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { transitionEvent } from "./timings.js";

/**
 * Appends events as JSONL. One appendFile call per invocation.
 * @param {string} timingsPath
 * @param {Array<object>} events
 */
export async function appendEvents(timingsPath, events) {
  if (!events || events.length === 0) return;
  await mkdir(path.dirname(timingsPath), { recursive: true });
  const body = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await appendFile(timingsPath, body, "utf8");
}

/**
 * Tolerant read. A malformed line is skipped rather than fatal — append-only means
 * one bad line must not destroy history.
 * @param {string} timingsPath
 * @returns {Promise<{events: Array<object>, warnings: string[]}>}
 */
export async function readEvents(timingsPath) {
  let raw;
  try {
    raw = await readFile(timingsPath, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { events: [], warnings: [] };
    throw e;
  }
  const events = [];
  const warnings = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj.ts === "string" && typeof obj.target === "string") events.push(obj);
      else warnings.push(`timings.jsonl line ${i + 1}: missing ts or target, skipped`);
    } catch {
      warnings.push(`timings.jsonl line ${i + 1}: not valid JSON, skipped`);
    }
  }
  return { events, warnings };
}

/**
 * The single write hook used by mark and implement.
 * @returns {Promise<object|null>} the appended event, or null if nothing was recorded
 */
export async function recordTransition({ enabled, timingsPath, node, fullPath, from, to, source, ts = new Date().toISOString() }) {
  if (!enabled) return null;
  const isLeaf = !node.children || node.children.length === 0;
  const ev = transitionEvent({ isLeaf, from, to, source, target: fullPath, ts });
  if (!ev) return null;
  await appendEvents(timingsPath, [ev]);
  return ev;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/timings.test.js`

Expected: PASS — all 17 tests.

- [ ] **Step 6: Commit** *(ask first)*

```bash
git add src/timings.js src/timings-io.js tests/timings.test.js
git commit -m "feat(specforest): add timings event-log IO and the transition recorder"
```

---

## Task 6: Record CLI transitions from `mark` and `implement`

**Files:**
- Modify: `src/commands/mark.js`
- Modify: `src/commands/implement.js`
- Test: `tests/timings.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/timings.test.js`. Add these imports at the top alongside the existing ones:

```js
import { mkdir } from "node:fs/promises";
import { writeDefaultConfig, loadConfig } from "../src/config.js";
import { paths } from "../src/paths.js";
import { writeTree } from "../src/tree-io.js";
import { writeIslands } from "../src/islands-io.js";
import { cmdMark } from "../src/commands/mark.js";

function collector() {
  return { buf: "", write(s) { this.buf += s; } };
}

async function markProject() {
  const root = await mkdtemp(path.join(tmpdir(), "sf-timings-mark-"));
  await writeDefaultConfig(root);
  const config = await loadConfig(root);
  const p = paths(root, config);
  await mkdir(p.treesDir, { recursive: true });
  await mkdir(p.outputDir, { recursive: true });
  await writeTree(p.treesDir, {
    spec: "auth",
    specPath: "docs/specs/auth.md",
    specHash: "sha256:x",
    features: [
      { name: "login", source: "heading", originalHeading: "## login", status: "todo", children: [leaf("form")] },
    ],
  });
  await writeIslands(p.islands, {
    generatedAt: "2026-09-21T00:00:00Z",
    islands: [{ id: "isl_aaaaaa", name: "auth-island", members: [{ spec: "auth", feature: "login" }], dependencies: [] }],
  });
  return { root, config, p };
}
```

Then append these tests:

```js
test("mark records exactly one start and one stop with source cli", async () => {
  const { root, p } = await markProject();
  try {
    const out = collector();
    const err = collector();
    assert.equal(await cmdMark({ cwd: root, args: ["auth/login/form", "in_progress"], stdin: null, stdout: out, stderr: err }), 0, err.buf);
    assert.equal(await cmdMark({ cwd: root, args: ["auth/login/form", "done"], stdin: null, stdout: out, stderr: err }), 0, err.buf);

    const { events } = await readEvents(p.timings);
    assert.equal(events.length, 2);
    assert.deepEqual(events.map((e) => e.event), ["start", "stop"]);
    assert.equal(events[0].target, "auth/login/form");
    assert.equal(events[0].source, "cli");
    assert.equal(events[1].to, "done");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mark records nothing for an off-boundary transition, a non-leaf, or a rollup", async () => {
  const { root, p } = await markProject();
  try {
    const out = collector();
    const err = collector();
    // todo -> blocked never crosses in_progress
    await cmdMark({ cwd: root, args: ["auth/login/form", "blocked"], stdin: null, stdout: out, stderr: err });
    assert.deepEqual((await readEvents(p.timings)).events, []);

    // marking the parent directly: it has children, so no event
    await cmdMark({ cwd: root, args: ["auth/login", "in_progress"], stdin: null, stdout: out, stderr: err });
    assert.deepEqual((await readEvents(p.timings)).events, []);

    // marking the leaf done rolls the parent up to done — the rollup emits nothing
    await cmdMark({ cwd: root, args: ["auth/login/form", "in_progress"], stdin: null, stdout: out, stderr: err });
    await cmdMark({ cwd: root, args: ["auth/login/form", "done"], stdin: null, stdout: out, stderr: err });
    const { events } = await readEvents(p.timings);
    assert.equal(events.length, 2);
    assert.ok(events.every((e) => e.target === "auth/login/form"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("timings: false suppresses recording and leaves an existing log intact", async () => {
  const { root, p } = await markProject();
  try {
    await appendEvents(p.timings, [{ ts: "2026-09-21T09:00:00.000Z", event: "start", target: "auth/login/form", source: "cli" }]);
    await writeFile(path.join(root, "specforest.config.yml"), "timings: false\n", { flag: "a" });

    const out = collector();
    const err = collector();
    await cmdMark({ cwd: root, args: ["auth/login/form", "done"], stdin: null, stdout: out, stderr: err });

    const { events } = await readEvents(p.timings);
    assert.equal(events.length, 1);
    assert.equal(events[0].event, "start");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/timings.test.js`

Expected: the first two new tests FAIL — `readEvents` returns `[]` because `mark` records nothing. The `timings: false` test passes vacuously; it becomes meaningful after step 3.

- [ ] **Step 3: Wire `src/commands/mark.js`**

Add the import next to the other `../` imports at the top:

```js
import { recordTransition } from "../timings-io.js";
```

Replace this block:

```js
  resolved.node.status = state;
  const rolled = rollupAncestors(tree, resolved.node);
  await writeTree(p.treesDir, tree);
```

with:

```js
  const previousStatus = resolved.node.status;
  resolved.node.status = state;
  const rolled = rollupAncestors(tree, resolved.node);
  await writeTree(p.treesDir, tree);
  await recordTransition({
    enabled: config.timings,
    timingsPath: p.timings,
    node: resolved.node,
    fullPath: `${specName}/${resolved.fullPath}`,
    from: previousStatus,
    to: state,
    source: "cli",
  });
```

- [ ] **Step 4: Wire `src/commands/implement.js`**

Add the import next to the other `../` imports at the top:

```js
import { recordTransition } from "../timings-io.js";
```

Replace this block near the end of `cmdImplement`:

```js
  let rolled = [];
  if (!noMark && targetNode.status !== "in_progress") {
    targetNode.status = "in_progress";
    rolled = rollupAncestors(ownTree, targetNode);
    await writeTree(p.treesDir, ownTree);
    try { await regenAndWriteTreeCache({ config, p }); } catch {}
  }
```

with:

```js
  let rolled = [];
  if (!noMark && targetNode.status !== "in_progress") {
    const previousStatus = targetNode.status;
    targetNode.status = "in_progress";
    rolled = rollupAncestors(ownTree, targetNode);
    await writeTree(p.treesDir, ownTree);
    await recordTransition({
      enabled: config.timings,
      timingsPath: p.timings,
      node: targetNode,
      fullPath: `${specName}/${resolved.fullPath}`,
      from: previousStatus,
      to: "in_progress",
      source: "cli",
    });
    try { await regenAndWriteTreeCache({ config, p }); } catch {}
  }
```

Note the `!== "in_progress"` guard already present is what prevents a duplicate `start`; `--no-mark` skips the whole block and therefore records nothing.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/timings.test.js`

Expected: PASS — all 20 tests.

- [ ] **Step 6: Run the full suite to check for regressions**

Run: `npm test`

Expected: PASS.

- [ ] **Step 7: Commit** *(ask first)*

```bash
git add src/commands/mark.js src/commands/implement.js tests/timings.test.js
git commit -m "feat(specforest): record start/stop events from mark and implement"
```

---

## Task 7: Record checkbox-driven transitions

**Files:**
- Modify: `src/render.js` (the `syncCheckboxes` function)
- Modify: `src/sync-helpers.js`
- Modify: 12 call sites (listed in step 5)
- Test: `tests/render.test.js`, `tests/timings.test.js`

This is a correctness requirement, not just coverage. A feature started by `implement` and ticked done in Obsidian would otherwise leave an interval open forever.

- [ ] **Step 1: Write the failing test for the `transitions` return value**

Append to `tests/render.test.js`:

```js
test("syncCheckboxes reports adopted transitions with full paths", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sf-sync-transitions-"));
  try {
    const outputDir = path.join(dir, "out");
    const treesDir = path.join(dir, "trees");
    await mkdir(outputDir, { recursive: true });
    await mkdir(treesDir, { recursive: true });

    const tree = {
      spec: "auth",
      specPath: "docs/specs/auth.md",
      specHash: "sha256:x",
      features: [
        {
          name: "login", source: "heading", originalHeading: "## login", status: "in_progress",
          children: [{ name: "form", source: "implied", originalHeading: null, status: "in_progress", children: [] }],
        },
      ],
    };
    await writeFile(path.join(treesDir, "auth.json"), JSON.stringify(tree, null, 2) + "\n", "utf8");

    // The MD must be newer than the tree for its checkboxes to win.
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(
      path.join(outputDir, "auth-island.md"),
      "### From [[auth]]\n\n- [/] login\n  - [x] form\n",
      "utf8",
    );

    const r = await syncCheckboxes(outputDir, treesDir, defaultMarkers());
    assert.equal(r.transitions.length, 1);
    assert.deepEqual(r.transitions[0], {
      spec: "auth",
      fullPath: "login/form",
      from: "in_progress",
      to: "done",
      isLeaf: true,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

If `tests/render.test.js` does not already import them, add `mkdtemp`, `mkdir`, `writeFile`, `rm` from `node:fs/promises`, `tmpdir` from `node:os`, `path` from `node:path`, `syncCheckboxes` from `../src/render.js`, and `defaultMarkers` from `../src/checkbox.js`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/render.test.js`

Expected: FAIL — `r.transitions` is `undefined`.

- [ ] **Step 3: Return transitions from `syncCheckboxes`**

In `src/render.js`, inside `syncCheckboxes`:

Change the ENOENT early return from:

```js
    if (e.code === "ENOENT") return { updated: [], warnings: [], orphans: [] };
```

to:

```js
    if (e.code === "ENOENT") return { updated: [], warnings: [], orphans: [], transitions: [] };
```

Declare the accumulator next to `const updated = [];` and `const orphans = [];`:

```js
  const updated = [];
  const orphans = [];
  const transitions = [];
```

Replace the `visit` function and its invocation:

```js
    function visit(node) {
      const key = `${tree.spec}/${node.name}`;
      if (statusByFeature.has(key)) {
        // MD wins only if the MD file is newer than tree.json. Otherwise the tree.json
        // was just written by mark/implement and the MD is stale (pending re-render).
        const mdMtime = mdMtimeByKey.get(key) || 0;
        const adoptMd = mdMtime > treeStat.mtimeMs;
        const s = statusByFeature.get(key);
        if (adoptMd && node.status !== s) {
          node.status = s;
          mutated = true;
        }
        statusByFeature.delete(key);
      }
      for (const c of node.children || []) visit(c);
    }
    for (const tf of tree.features) visit(tf);
```

with:

```js
    function visit(node, pathSegs) {
      const segs = [...pathSegs, node.name];
      const key = `${tree.spec}/${node.name}`;
      if (statusByFeature.has(key)) {
        // MD wins only if the MD file is newer than tree.json. Otherwise the tree.json
        // was just written by mark/implement and the MD is stale (pending re-render).
        const mdMtime = mdMtimeByKey.get(key) || 0;
        const adoptMd = mdMtime > treeStat.mtimeMs;
        const s = statusByFeature.get(key);
        if (adoptMd && node.status !== s) {
          transitions.push({
            spec: tree.spec,
            fullPath: segs.join("/"),
            from: node.status,
            to: s,
            isLeaf: !node.children || node.children.length === 0,
          });
          node.status = s;
          mutated = true;
        }
        statusByFeature.delete(key);
      }
      for (const c of node.children || []) visit(c, segs);
    }
    for (const tf of tree.features) visit(tf, []);
```

Change the final return from:

```js
  return { updated, warnings, orphans };
```

to:

```js
  return { updated, warnings, orphans, transitions };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/render.test.js`

Expected: PASS.

- [ ] **Step 5: Append checkbox events in `src/sync-helpers.js`**

Replace the whole file with:

```js
import { syncCheckboxes } from "./render.js";
import { updateState } from "./state.js";
import { transitionEvent } from "./timings.js";
import { appendEvents } from "./timings-io.js";

/**
 * Runs syncCheckboxes() and persists any orphan checkboxes to state.json.orphanedProgress.
 * Spec §3.4 step 5: "Never lose progress silently" — orphans must be stashed.
 *
 * When timings are enabled, also appends start/stop events for the transitions the
 * checkbox round-trip adopted, tagged source: "checkbox". Timestamps are DETECTION
 * time, not tick time — see the timings design §2.3.
 *
 * Returns { updated, warnings, orphans, transitions } from syncCheckboxes.
 */
export async function syncCheckboxesAndPersistOrphans({
  outputDir,
  treesDir,
  statePath,
  markers,
  timingsPath,
  timingsEnabled = false,
}) {
  const result = await syncCheckboxes(outputDir, treesDir, markers);
  if (result.orphans.length > 0) {
    const now = new Date().toISOString();
    await updateState(statePath, (s) => {
      for (const { key, status } of result.orphans) {
        s.orphanedProgress[key] = { status, lostAt: now };
      }
    });
  }
  if (timingsEnabled && timingsPath && result.transitions.length > 0) {
    const ts = new Date().toISOString();
    const events = [];
    for (const t of result.transitions) {
      const ev = transitionEvent({
        isLeaf: t.isLeaf,
        from: t.from,
        to: t.to,
        source: "checkbox",
        target: `${t.spec}/${t.fullPath}`,
        ts,
      });
      if (ev) events.push(ev);
    }
    await appendEvents(timingsPath, events);
  }
  return result;
}
```

- [ ] **Step 6: Pass the new options at all 12 call sites**

Each of these already has the config and paths objects in scope. Add the two fields to the options object literal.

For these ten, the variables are `config` and `p` — add `timingsPath: p.timings, timingsEnabled: config.timings`:

| File | Locate the `syncCheckboxesAndPersistOrphans({ … })` call |
|---|---|
| `src/commands/add-island.js` | just after `const p = paths(cwd, config);` |
| `src/commands/commit-islands.js` | just after `const p = paths(cwd, config);` |
| `src/commands/extend-island.js` | just after `const p = paths(cwd, config);` |
| `src/commands/implement.js` | just after `const p = paths(cwd, config);` |
| `src/commands/ingest.js` | just after `const p = paths(cwd, config);` |
| `src/commands/mark.js` | just after `const p = paths(cwd, config);` |
| `src/commands/render.js` | just after `const p = paths(cwd, config);` |
| `src/commands/status.js` | just after `const p = paths(cwd, config);` |
| `src/commands/verify.js` | just after `const p = paths(cwd, config);` |
| `src/commands/tree.js` | inside the `if (specArg) { … }` branch |
| `src/tree-cache.js` | inside `renderFullTreeAscii({ config, p })` |

The one-line form becomes, for example in `src/commands/mark.js`:

```js
  await syncCheckboxesAndPersistOrphans({ outputDir: p.outputDir, treesDir: p.treesDir, statePath: p.state, markers: config.checkboxMarkers, timingsPath: p.timings, timingsEnabled: config.timings });
```

and the multi-line form, for example in `src/tree-cache.js`:

```js
  await syncCheckboxesAndPersistOrphans({
    outputDir: p.outputDir,
    treesDir: p.treesDir,
    statePath: p.state,
    markers: config.checkboxMarkers,
    timingsPath: p.timings,
    timingsEnabled: config.timings,
  });
```

For the twelfth, `src/commands/sync.js`, the variables are `scan.config` and `scan.paths`:

```js
    await syncCheckboxesAndPersistOrphans({
      outputDir: scan.paths.outputDir,
      treesDir: scan.paths.treesDir,
      statePath: scan.paths.state,
      markers: scan.config.checkboxMarkers,
      timingsPath: scan.paths.timings,
      timingsEnabled: scan.config.timings,
    });
```

Verify none were missed:

```bash
grep -rn "syncCheckboxesAndPersistOrphans({" src/ | grep -v "timingsPath"
```

Expected: no output.

- [ ] **Step 7: Write the failing end-to-end checkbox test**

Append to `tests/timings.test.js`:

```js
import { syncCheckboxesAndPersistOrphans } from "../src/sync-helpers.js";

test("checkbox adoption records a stop with source checkbox", async () => {
  const { root, config, p } = await markProject();
  try {
    const out = collector();
    const err = collector();
    await cmdMark({ cwd: root, args: ["auth/login/form", "in_progress"], stdin: null, stdout: out, stderr: err });
    assert.equal((await readEvents(p.timings)).events.length, 1);

    await new Promise((r) => setTimeout(r, 20));
    await writeFile(
      path.join(p.outputDir, "auth-island.md"),
      "### From [[auth]]\n\n- [/] login\n  - [x] form\n",
      "utf8",
    );

    await syncCheckboxesAndPersistOrphans({
      outputDir: p.outputDir,
      treesDir: p.treesDir,
      statePath: p.state,
      markers: config.checkboxMarkers,
      timingsPath: p.timings,
      timingsEnabled: config.timings,
    });

    const { events } = await readEvents(p.timings);
    assert.equal(events.length, 2);
    assert.equal(events[1].event, "stop");
    assert.equal(events[1].to, "done");
    assert.equal(events[1].source, "checkbox");
    assert.equal(events[1].target, "auth/login/form");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `node --test tests/timings.test.js tests/render.test.js`

Expected: PASS.

- [ ] **Step 9: Run the full suite**

Run: `npm test`

Expected: PASS.

- [ ] **Step 10: Commit** *(ask first)*

```bash
git add src/render.js src/sync-helpers.js src/commands src/tree-cache.js tests/render.test.js tests/timings.test.js
git commit -m "feat(specforest): record timing events adopted from Obsidian checkboxes"
```

---

## Task 8: The `ci` wrapper command

**Files:**
- Create: `src/commands/ci.js`
- Modify: `bin/cli.js`
- Test: `tests/e2e.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/e2e.test.js`. The existing `run` helper and `setupProject` are reused; `readEvents` needs importing at the top of the file:

```js
import { readEvents } from "../src/timings-io.js";
```

Add a helper below `setupProject`:

```js
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
```

Then the tests:

```js
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
  assert.match(r.stderr, /--/);

  r = await run(["ci", "auth/login", "--"], { cwd: root });
  assert.equal(r.code, 1);

  const { events } = await readEvents(path.join(root, ".specforest", "timings.jsonl"));
  assert.deepEqual(events, []);
});

test("ci on an unresolvable target exits 1 before spawning", async () => {
  const root = await ciProject();
  const r = await run(["ci", "auth/nope", "--", process.execPath, "-e", "process.stdout.write('ran')"], { cwd: root });
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.stdout, /ran/);
});

test("ci on a non-leaf still runs the command, warns, and records nothing", async () => {
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
  assert.match(r.stderr, /no time recorded/);

  const { events } = await readEvents(path.join(root, ".specforest", "timings.jsonl"));
  assert.deepEqual(events, []);
});

test("ci with timings disabled runs the command, notes it once, and records nothing", async () => {
  const root = await ciProject();
  await writeFile(path.join(root, "specforest.config.yml"), "timings: false\n", { flag: "a" });

  const r = await run(["ci", "auth/login", "--", process.execPath, "-e", "process.stdout.write('ran')"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /ran/);
  assert.match(r.stderr, /timings: false/);

  const { events } = await readEvents(path.join(root, ".specforest", "timings.jsonl"));
  assert.deepEqual(events, []);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/e2e.test.js`

Expected: FAIL — `unknown command: ci`.

- [ ] **Step 3: Write `src/commands/ci.js`**

```js
import { spawn } from "node:child_process";
import { loadConfig } from "../config.js";
import { paths } from "../paths.js";
import { readTree } from "../tree-io.js";
import { parseTarget, resolveTargetNode } from "../target.js";
import { pickMatch } from "../disambiguate.js";
import { appendEvents } from "../timings-io.js";

const USAGE = "usage: specforest ci <spec>/<feature-path> -- <command> [args…]\n";

function runCommand(argv) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: "inherit", shell: true });
    child.on("error", () => resolve(127));
    child.on("close", (code, signal) => resolve(code == null ? (signal ? 1 : 0) : code));
  });
}

export async function cmdCi({ cwd, args, stdin, stdout, stderr }) {
  if (args.includes("--help") || args.includes("-h")) {
    stdout.write(USAGE);
    return 0;
  }

  const sepIndex = args.indexOf("--");
  if (sepIndex === -1) {
    stderr.write(`missing '--' separator\n${USAGE}`);
    return 1;
  }
  const command = args.slice(sepIndex + 1);
  if (command.length === 0) {
    stderr.write(`no command after '--'\n${USAGE}`);
    return 1;
  }
  const target = args.slice(0, sepIndex).find((a) => !a.startsWith("-"));
  if (!target) {
    stderr.write(`missing target\n${USAGE}`);
    return 1;
  }

  const parsed = parseTarget(target);
  if (parsed.error) {
    stderr.write(`${parsed.error}\n`);
    return 1;
  }
  const { spec: specName, segments } = parsed;
  const config = await loadConfig(cwd);
  const p = paths(cwd, config);
  const tree = await readTree(p.treesDir, specName);
  if (!tree) {
    stderr.write(`spec not found: ${specName}\n`);
    return 1;
  }
  let resolved = resolveTargetNode(tree, segments);
  if (resolved.error) {
    stderr.write(`${resolved.error}\n`);
    return 1;
  }
  if (resolved.ambiguous) {
    const picked = await pickMatch({ spec: specName, name: segments[segments.length - 1], matches: resolved.matches, stdin, stdout, stderr });
    if (!picked) {
      stderr.write("aborted: ambiguous target\n");
      return 1;
    }
    resolved = picked;
  }

  const isLeaf = !resolved.node.children || resolved.node.children.length === 0;
  if (!config.timings) {
    stderr.write("specforest: timings: false in config — running the command, no time recorded\n");
  } else if (!isLeaf) {
    stderr.write(`specforest: ${specName}/${resolved.fullPath} has sub-features — running the command, no time recorded\n`);
  }

  const startedAt = Date.now();
  const exit = await runCommand(command);
  const ms = Date.now() - startedAt;

  if (config.timings && isLeaf) {
    await appendEvents(p.timings, [{
      ts: new Date(startedAt).toISOString(),
      event: "ci",
      target: `${specName}/${resolved.fullPath}`,
      ms,
      cmd: command.join(" "),
      exit,
    }]);
  }

  return exit;
}
```

- [ ] **Step 4: Register the command in `bin/cli.js`**

Add the import next to the others:

```js
import { cmdCi } from "../src/commands/ci.js";
```

Add one line to the `Commands:` block of `HELP`, immediately after the `implement` line:

```
  ci <spec>/<feature-path> -- <cmd>…         run a CI command (test/lint/format/typecheck/build)
                                             and charge its wall-clock to that leaf
```

Add one entry to `HANDLERS`, after `implement`:

```js
  ci: cmdCi,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/e2e.test.js`

Expected: PASS.

- [ ] **Step 6: Commit** *(ask first)*

```bash
git add src/commands/ci.js bin/cli.js tests/e2e.test.js
git commit -m "feat(specforest): add the ci wrapper command"
```

---

## Task 9: The `timings` report command

**Files:**
- Create: `src/commands/timings.js`
- Modify: `bin/cli.js`
- Test: `tests/e2e.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/e2e.test.js`:

```js
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

test("timings with no log reports zeros without error", async () => {
  const root = await ciProject();
  const r = await run(["timings"], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /active 0s/);
  assert.doesNotMatch(r.stdout, /orphaned/);
});

test("timings exits 0 with an explanation when the flag is off", async () => {
  const root = await ciProject();
  await writeFile(path.join(root, "specforest.config.yml"), "timings: false\n", { flag: "a" });
  const r = await run(["timings"], { cwd: root });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /timings: false/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/e2e.test.js`

Expected: FAIL — `unknown command: timings`.

- [ ] **Step 3: Write `src/commands/timings.js`**

```js
import { loadConfig } from "../config.js";
import { paths } from "../paths.js";
import { readIslands } from "../islands-io.js";
import { readAllTrees, readTree } from "../tree-io.js";
import { countFeatures, formatCounter } from "../counters.js";
import { buildForestStructure } from "../render.js";
import { syncCheckboxesAndPersistOrphans } from "../sync-helpers.js";
import { parseTarget, resolveTargetNode } from "../target.js";
import { pickMatch } from "../disambiguate.js";
import { readEvents } from "../timings-io.js";
import { deriveTotals, aggregateTree, aggregateForest, formatDuration } from "../timings.js";

const DISABLED_NOTE = "timings: false in specforest.config.yml — nothing is being recorded. Set `timings: true` to enable.\n";

/** "2026-09-18 09:12" in UTC, from epoch ms. */
function stamp(ms) {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/** End of a range: time-only when it falls on the same UTC day as the start. */
function endStamp(startMs, endMs) {
  const full = stamp(endMs);
  return full.slice(0, 10) === stamp(startMs).slice(0, 10) ? full.slice(11) : full;
}

function pct(part, whole) {
  if (whole <= 0) return null;
  return Math.round((part / whole) * 100);
}

function summaryLine(agg, indent) {
  const p = pct(agg.ciMs, agg.activeMs);
  const ci = p == null ? formatDuration(agg.ciMs) : `${formatDuration(agg.ciMs)} (${p}%)`;
  return `${indent}active ${formatDuration(agg.activeMs)}   ci ${ci}   coding ${formatDuration(agg.codingMs)}   lead ${formatDuration(agg.leadMs)}${agg.open ? "   (running)" : ""}`;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function writeForestReport({ stdout, islands, built, forestAgg, byIsland, orphans, json }) {
  if (json) {
    stdout.write(JSON.stringify({
      forest: forestAgg,
      islands: built ? built.islands.map((isl) => ({ name: isl.name, ...byIsland.get(isl.name) })) : [],
      orphans: orphans.map((o) => ({ target: o.target, ...o.totals })),
    }, null, 2) + "\n");
    return;
  }

  if (!built) {
    stdout.write("forest: (no islands.json yet; run `specforest sync` first)\n");
    stdout.write(summaryLine(forestAgg, "  ") + "\n");
  } else {
    const all = built.islands.flatMap((isl) => isl.specs.flatMap((s) => s.tree.features));
    const counts = countFeatures(all);
    // Same wording as `status` so the two surfaces agree.
    stdout.write(`forest: ${islands.islands.length} islands, ${formatCounter(counts.done, counts.total)}\n`);
    stdout.write(summaryLine(forestAgg, "  ") + "\n");
    stdout.write("\n");
    const width = Math.max(0, ...built.islands.map((isl) => isl.name.length));
    for (const isl of built.islands) {
      const a = byIsland.get(isl.name);
      const name = isl.name.padEnd(width);
      if (a.activeMs <= 0) {
        stdout.write(`  ${name}  (no time recorded)\n`);
      } else {
        stdout.write(`  ${name}  active ${formatDuration(a.activeMs)}   ci ${formatDuration(a.ciMs)}   coding ${formatDuration(a.codingMs)}   lead ${formatDuration(a.leadMs)}\n`);
      }
    }
  }

  if (orphans.length > 0) {
    stdout.write("\n");
    stdout.write(`orphaned: ${plural(orphans.length, "target")} no longer in any tree — \`specforest timings --orphans\`\n`);
  }
}

function writeOrphanReport({ stdout, orphans, json }) {
  if (json) {
    stdout.write(JSON.stringify({ orphans: orphans.map((o) => ({ target: o.target, ...o.totals })) }, null, 2) + "\n");
    return;
  }
  if (orphans.length === 0) {
    stdout.write("no orphaned timing targets\n");
    return;
  }
  stdout.write("orphaned targets (no longer in any tree):\n");
  const width = Math.max(0, ...orphans.map((o) => o.target.length));
  for (const o of orphans) {
    const a = o.totals;
    stdout.write(`  ${o.target.padEnd(width)}  active ${formatDuration(a.activeMs)}   ci ${formatDuration(a.ciMs)}   coding ${formatDuration(a.codingMs)}\n`);
  }
}

function writeNodeReport({ stdout, target, status, agg, own, json }) {
  if (json) {
    stdout.write(JSON.stringify({ target, status, ...agg, intervals: own.intervals, ciRuns: own.ciRuns }, null, 2) + "\n");
    return;
  }
  stdout.write(`${target}   [${status}]\n`);
  const range = agg.firstStart != null && agg.lastEnd != null
    ? `   (${stamp(agg.firstStart)} → ${stamp(agg.lastEnd)})`
    : "";
  stdout.write(`  lead    ${formatDuration(agg.leadMs)}${range}${agg.open ? "   (running)" : ""}\n`);
  const ci = agg.ciRunCount > 0
    ? `      ci ${formatDuration(agg.ciMs)} (${plural(agg.ciRunCount, "run")})`
    : "";
  stdout.write(`  active  ${formatDuration(agg.activeMs)}${ci}      coding ${formatDuration(agg.codingMs)}\n`);

  if (own.intervals.length > 0) {
    stdout.write("\nintervals:\n");
    for (const iv of own.intervals) {
      const to = iv.open ? "(running)" : `→ ${iv.to}`;
      stdout.write(`  ${stamp(iv.start)} → ${endStamp(iv.start, iv.end)}    ${formatDuration(iv.ms)}    ${to}   (${iv.source})\n`);
    }
  }
  if (own.ciRuns.length > 0) {
    stdout.write("\nci runs:\n");
    for (const run of own.ciRuns) {
      stdout.write(`  ${stamp(run.ts)}   ${formatDuration(run.ms)}   exit ${run.exit}   ${run.cmd}\n`);
    }
  }
}

export async function cmdTimings({ cwd, args, stdin, stdout, stderr }) {
  const json = args.includes("--json");
  const orphansOnly = args.includes("--orphans");
  const target = args.find((a) => !a.startsWith("--"));

  const config = await loadConfig(cwd);
  const p = paths(cwd, config);
  if (!config.timings) {
    stdout.write(DISABLED_NOTE);
    return 0;
  }

  await syncCheckboxesAndPersistOrphans({
    outputDir: p.outputDir,
    treesDir: p.treesDir,
    statePath: p.state,
    markers: config.checkboxMarkers,
    timingsPath: p.timings,
    timingsEnabled: config.timings,
  });

  const { events, warnings } = await readEvents(p.timings);
  for (const w of warnings) stderr.write(`warning: ${w}\n`);
  const totals = deriveTotals(events);

  if (target) {
    const parsed = parseTarget(target);
    if (parsed.error) {
      stderr.write(`${parsed.error}\n`);
      return 1;
    }
    const { spec: specName, segments } = parsed;
    const tree = await readTree(p.treesDir, specName);
    if (!tree) {
      stderr.write(`spec not found: ${specName}\n`);
      return 1;
    }
    let resolved = resolveTargetNode(tree, segments);
    if (resolved.error) {
      stderr.write(`${resolved.error}\n`);
      return 1;
    }
    if (resolved.ambiguous) {
      const picked = await pickMatch({ spec: specName, name: segments[segments.length - 1], matches: resolved.matches, stdin, stdout, stderr });
      if (!picked) {
        stderr.write("aborted: ambiguous target\n");
        return 1;
      }
      resolved = picked;
    }
    const key = `${specName}/${resolved.fullPath}`;
    const agg = aggregateTree(tree, totals).get(key);
    const own = totals.get(key) || { intervals: [], ciRuns: [] };
    writeNodeReport({ stdout, target: key, status: resolved.node.status, agg, own, json });
    return 0;
  }

  const islands = await readIslands(p.islands);
  const trees = await readAllTrees(p.treesDir);
  const treesBySpec = new Map(trees.map((t) => [t.spec, t]));
  const built = islands && islands.islands.length > 0
    ? buildForestStructure(islands.islands, treesBySpec)
    : null;
  const { forest, byIsland, orphans } = aggregateForest(built || { islands: [] }, totals);

  if (orphansOnly) {
    writeOrphanReport({ stdout, orphans, json });
    return 0;
  }
  writeForestReport({ stdout, islands, built, forestAgg: forest, byIsland, orphans, json });
  return 0;
}
```

- [ ] **Step 4: Register the command in `bin/cli.js`**

Add the import next to the others:

```js
import { cmdTimings } from "../src/commands/timings.js";
```

Add one line to the `Commands:` block of `HELP`, immediately after the `status` line:

```
  timings [<spec>/<feature-path>] [--json] [--orphans]
                                             recorded time: forest + island rollup, or one node's detail
```

Add one entry to `HANDLERS`, after `status`:

```js
  timings: cmdTimings,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/e2e.test.js`

Expected: PASS.

- [ ] **Step 6: Commit** *(ask first)*

```bash
git add src/commands/timings.js bin/cli.js tests/e2e.test.js
git commit -m "feat(specforest): add the timings report command"
```

---

## Task 10: Timing suffix in `status`

**Files:**
- Modify: `src/commands/status.js`
- Test: `tests/e2e.test.js`

The suffix is suppressed entirely when a line has zero recorded time, so a project not using the feature sees byte-identical output.

- [ ] **Step 1: Write the failing tests**

Append to `tests/e2e.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/e2e.test.js`

Expected: the second test FAILS — no suffix is emitted. The first passes and must keep passing.

- [ ] **Step 3: Write the implementation**

Replace `src/commands/status.js` with:

```js
import { loadConfig } from "../config.js";
import { paths } from "../paths.js";
import { readIslands } from "../islands-io.js";
import { readAllTrees } from "../tree-io.js";
import { countFeatures, formatCounter } from "../counters.js";
import { buildForestStructure } from "../render.js";
import { syncCheckboxesAndPersistOrphans } from "../sync-helpers.js";
import { readEvents } from "../timings-io.js";
import { deriveTotals, aggregateForest, formatDuration } from "../timings.js";

/** Suffix for one status line. Empty when nothing was recorded, so output stays as before. */
function suffix(agg) {
  if (!agg || agg.activeMs <= 0) return "";
  const running = agg.open ? " (running)" : "";
  return `  active ${formatDuration(agg.activeMs)} (ci ${formatDuration(agg.ciMs)} / code ${formatDuration(agg.codingMs)})${running}`;
}

export async function cmdStatus({ cwd, stdout, stderr }) {
  const config = await loadConfig(cwd);
  const p = paths(cwd, config);
  await syncCheckboxesAndPersistOrphans({
    outputDir: p.outputDir,
    treesDir: p.treesDir,
    statePath: p.state,
    markers: config.checkboxMarkers,
    timingsPath: p.timings,
    timingsEnabled: config.timings,
  });
  const islands = await readIslands(p.islands);
  const trees = await readAllTrees(p.treesDir);
  const treesBySpec = new Map(trees.map((t) => [t.spec, t]));
  if (!islands || islands.islands.length === 0) {
    stdout.write("no islands yet\n");
    return 0;
  }
  const built = buildForestStructure(islands.islands, treesBySpec);

  let forestAgg = null;
  let byIsland = new Map();
  if (config.timings) {
    const { events, warnings } = await readEvents(p.timings);
    for (const w of warnings) stderr.write(`warning: ${w}\n`);
    const agg = aggregateForest(built, deriveTotals(events));
    forestAgg = agg.forest;
    byIsland = agg.byIsland;
  }

  const total = countFeatures(built.islands.flatMap((isl) => isl.specs.flatMap((s) => s.tree.features)));
  stdout.write(`forest: ${islands.islands.length} islands, ${formatCounter(total.done, total.total)}${suffix(forestAgg)}\n`);
  for (const isl of built.islands) {
    const c = countFeatures(isl.specs.flatMap((s) => s.tree.features));
    stdout.write(`  ${isl.name}: ${formatCounter(c.done, c.total)} (${isl.specs.length} spec${isl.specs.length === 1 ? "" : "s"})${suffix(byIsland.get(isl.name))}\n`);
  }
  return 0;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/e2e.test.js`

Expected: PASS.

- [ ] **Step 5: Commit** *(ask first)*

```bash
git add src/commands/status.js tests/e2e.test.js
git commit -m "feat(specforest): annotate status output with recorded time"
```

---

## Task 11: Timing annotations in the ASCII tree

**Files:**
- Modify: `src/ascii.js`
- Modify: `src/tree-cache.js`
- Modify: `src/commands/tree.js`
- Test: `tests/tree-cache.test.js`

Two coupled changes plus one hazard fix:

- `ascii.js` gains an optional `annotate(key)` callback. Keys are `island:<name>` for island lines and `<spec>/<seg>/<seg>` for feature nodes. **Spec-name lines are never annotated** — `extractSpecBlockFromCache` finds a spec block by exact string equality (`rest === specName`), which any suffix would break.
- `extractSpecBlockFromCache`'s `counterRe` is currently `/\[\d+\/\d+\]$/`, anchored to end-of-line, and is used to skip parent lines when recounting leaves. A timing suffix after the counter defeats the anchor and makes parents count as leaves. De-anchoring is safe: leaf lines carry only a single-character status marker (`[x]`, `[ ]`, `[/]`, `[-]`) and a timing suffix like `2h 41m (ci 31m 12s)`, none of which match `\[\d+\/\d+\]`.
- `isTreeCacheStale` gains `p.timings` as an input so a fresh `ci` run invalidates the cache.

- [ ] **Step 1: Write the failing tests**

Append to `tests/tree-cache.test.js`. Extend the existing `tree-cache.js` import to pull in two more names, and add one new import:

```js
import {
  extractSpecBlockFromCache,
  renderFullTreeAscii,
  regenAndWriteTreeCache,
  isTreeCacheStale,
} from "../src/tree-cache.js";
import { appendEvents } from "../src/timings-io.js";
```

The existing `setup()` creates only empty directories — `seedAuthDashboard(root, p)` is what writes the `auth` + `dashboard` trees and the `auth-and-dashboard` island. Both are already in the file; use them as-is.

```js
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

test("isTreeCacheStale reacts to a newer timings log", async () => {
  const { root, config, p } = await setup();
  try {
    await seedAuthDashboard(root, p);
    await regenAndWriteTreeCache({ config, p });
    assert.equal(await isTreeCacheStale(p), false);
    await new Promise((r) => setTimeout(r, 20));
    await appendEvents(p.timings, [{ ts: "2026-09-21T09:00:00.000Z", event: "start", target: "auth/login", source: "cli" }]);
    assert.equal(await isTreeCacheStale(p), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/tree-cache.test.js`

Expected: the annotation test FAILS (no suffix), the `extractSpecBlockFromCache` test FAILS (the annotated parent line is counted as a leaf, giving `[1/3]` instead of `[1/2]`), and the staleness test FAILS (returns `false`).

- [ ] **Step 3: Add the `annotate` callback to `src/ascii.js`**

Replace the three render functions with these versions. `annotate` defaults to a function returning `""`, so every existing caller keeps its current output.

```js
function renderFeatureNode(node, prefix, isLast, lines, markerForStatus, spec, pathSegs, annotate) {
  const branch = isLast ? L : T;
  const counter = countLeaves(node);
  const isLeaf = !node.children || node.children.length === 0;
  const marker = markerForStatus(node.status);
  const segs = [...pathSegs, node.name];
  const base = isLeaf ? `${marker} ${node.name}` : `${marker} ${node.name} ${formatCounter(counter.done, counter.total)}`;
  const note = annotate(`${spec}/${segs.join("/")}`);
  lines.push(prefix + branch + base + (note ? `  ${note}` : ""));
  const childPrefix = prefix + (isLast ? S : I);
  const kids = node.children || [];
  kids.forEach((child, i) => {
    renderFeatureNode(child, childPrefix, i === kids.length - 1, lines, markerForStatus, spec, segs, annotate);
  });
}

export function renderSpecBlock(spec, prefix, isLast, lines, markerForStatus, annotate = () => "") {
  const branch = isLast ? L : T;
  // Spec lines carry no annotation: extractSpecBlockFromCache locates a block by exact
  // string equality on this line, so any suffix would break the cache slice path.
  lines.push(prefix + branch + spec.spec);
  const childPrefix = prefix + (isLast ? S : I);
  spec.features.forEach((f, i) => {
    renderFeatureNode(f, childPrefix, i === spec.features.length - 1, lines, markerForStatus, spec.spec, [], annotate);
  });
}

export function renderForestAscii(forest, markerForStatus, annotate = () => "") {
  const lines = [];
  const allFeatures = forest.islands.flatMap((isl) =>
    isl.specs.flatMap((s) => s.tree.features),
  );
  const totals = countFeatures(allFeatures);
  lines.push(`forest ${formatCounter(totals.done, totals.total)}`);
  forest.islands.forEach((isl, i) => {
    const islLast = i === forest.islands.length - 1;
    const branch = islLast ? L : T;
    const counter = countFeatures(isl.specs.flatMap((s) => s.tree.features));
    const note = annotate(`island:${isl.name}`);
    lines.push(`${branch}${isl.name} ${formatCounter(counter.done, counter.total)}${note ? `  ${note}` : ""}`);
    const childPrefix = islLast ? S : I;
    isl.specs.forEach((spec, j) => {
      const last = j === isl.specs.length - 1;
      renderSpecBlock(spec.tree, childPrefix, last, lines, markerForStatus, annotate);
    });
  });
  return lines.join("\n");
}

export function renderSingleSpecAscii(specName, forest, markerForStatus, annotate = () => "") {
  const lines = [];
  for (const isl of forest.islands) {
    for (const spec of isl.specs) {
      if (spec.tree.spec !== specName) continue;
      const totals = countFeatures(spec.tree.features);
      lines.push(`${isl.name} / ${specName} ${formatCounter(totals.done, totals.total)}`);
      spec.tree.features.forEach((f, i) => {
        renderFeatureNode(f, "", i === spec.tree.features.length - 1, lines, markerForStatus, specName, [], annotate);
      });
      return lines.join("\n");
    }
  }
  return null;
}
```

- [ ] **Step 4: Build the annotator in `src/tree-cache.js` and fix the two hazards**

Replace the imports and `renderFullTreeAscii`:

```js
import { readFile, writeFile, mkdir, stat, readdir } from "node:fs/promises";
import path from "node:path";
import { readIslands } from "./islands-io.js";
import { readAllTrees } from "./tree-io.js";
import { buildForestStructure } from "./render.js";
import { renderForestAscii, markerFn } from "./ascii.js";
import { syncCheckboxesAndPersistOrphans } from "./sync-helpers.js";
import { readEvents } from "./timings-io.js";
import { deriveTotals, aggregateForest, formatAnnotation } from "./timings.js";

/**
 * Builds the annotate(key) callback consumed by src/ascii.js.
 * Keys: "island:<name>" and "<spec>/<seg>/<seg>". Returns "" when nothing was recorded.
 */
export async function buildTimingAnnotator({ config, p, built }) {
  if (!config.timings) return () => "";
  const { events } = await readEvents(p.timings);
  if (events.length === 0) return () => "";
  const { byIsland, byNode } = aggregateForest(built, deriveTotals(events));
  return (key) => {
    const agg = key.startsWith("island:") ? byIsland.get(key.slice("island:".length)) : byNode.get(key);
    return formatAnnotation(agg);
  };
}

export async function renderFullTreeAscii({ config, p }) {
  await syncCheckboxesAndPersistOrphans({
    outputDir: p.outputDir,
    treesDir: p.treesDir,
    statePath: p.state,
    markers: config.checkboxMarkers,
    timingsPath: p.timings,
    timingsEnabled: config.timings,
  });
  const islands = await readIslands(p.islands);
  if (!islands) return null;
  const trees = await readAllTrees(p.treesDir);
  const treesBySpec = new Map(trees.map((t) => [t.spec, t]));
  const built = buildForestStructure(islands.islands, treesBySpec);
  const mfn = markerFn(config.checkboxMarkers);
  const annotate = await buildTimingAnnotator({ config, p, built });
  return renderForestAscii(built, mfn, annotate);
}
```

In `isTreeCacheStale`, add the timings log to the input list:

```js
  const inputs = [p.islands, p.state, p.configResolved, p.timings];
```

In `extractSpecBlockFromCache`, de-anchor the counter regex:

```js
  // De-anchored on purpose: parent lines may carry a timing suffix after the [d/N]
  // counter. Leaf lines never contain a [d/N] group — their marker is a single char.
  const counterRe = /\[\d+\/\d+\]/;
```

- [ ] **Step 5: Pass the annotator through `src/commands/tree.js`**

Add the import:

```js
import {
  readTreeCache,
  writeTreeCache,
  isTreeCacheStale,
  regenAndWriteTreeCache,
  extractSpecBlockFromCache,
  buildTimingAnnotator,
} from "../tree-cache.js";
```

Find the `renderSingleSpecAscii(specArg, built, mfn)` call in the `if (specArg)` branch and replace it with:

```js
    const annotate = await buildTimingAnnotator({ config, p, built });
    const ascii = renderSingleSpecAscii(specArg, built, mfn, annotate);
```

keeping whatever variable name the existing code binds the result to. If the existing call is inline (not assigned), assign it as shown and use `ascii` where the inline expression was.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/tree-cache.test.js`

Expected: PASS.

- [ ] **Step 7: Run the full suite**

Run: `npm test`

Expected: PASS.

- [ ] **Step 8: Commit** *(ask first)*

```bash
git add src/ascii.js src/tree-cache.js src/commands/tree.js tests/tree-cache.test.js
git commit -m "feat(specforest): annotate the ASCII tree with recorded time"
```

---

## Task 12: SKILL.md

**Files:**
- Modify: `SKILL.md`

- [ ] **Step 1: Add the Timings section**

Insert a new `## Timings` section immediately before `## Pitfalls + rules`:

````markdown
## Timings

Specforest records how long each leaf feature took, split into CI time and coding time.
Recording is on by default (`timings: true` in the config).

**The CI category rule.** Route through the `ci` wrapper any command that **verifies**
code rather than changes it: test runners, linters, formatters (including write modes),
type checkers, and builds run for verification. Do **not** wrap: editing, file
inspection, git operations, package installs, or running the application itself.

There is no config list and no auto-detection. This rule is the whole definition, and it
must work in a repo you have never seen — apply it to whatever build tooling the project
actually uses.

```
node ${CLAUDE_PLUGIN_ROOT}/skills/specforest/bin/cli.js ci <spec>/<feature-path> -- <command> [args…]
```

The wrapped command's output streams through live, and `ci` exits with the wrapped
command's exit code — so a failing check still surfaces as a failure. A failing check
still records its time; failed CI is time spent.

**Reading the numbers:**

```
node ${CLAUDE_PLUGIN_ROOT}/skills/specforest/bin/cli.js timings                        # forest + per-island rollup
node ${CLAUDE_PLUGIN_ROOT}/skills/specforest/bin/cli.js timings <spec>/<feature-path>  # one node, with intervals and ci runs
node ${CLAUDE_PLUGIN_ROOT}/skills/specforest/bin/cli.js timings --json                 # raw milliseconds
node ${CLAUDE_PLUGIN_ROOT}/skills/specforest/bin/cli.js timings --orphans              # time recorded against targets no longer in any tree
```

`status` and the ASCII `tree` also carry timing suffixes, on lines that have recorded
time. The Obsidian Markdown files carry none.

**Two different figures, both reported:**

- **lead** — calendar time from first start to last finish. Includes nights and weekends.
- **active** — summed `in_progress` intervals, split into **ci** and **coding**.
````

- [ ] **Step 2: Add the implement-flow step**

In `## Implement flow`, replace step 4 and renumber the rest:

```markdown
4. After the user confirms, plan + implement following project rules (TDD, planner agent if complex, coding-standards / security / testing guardrails from `CLAUDE.md` and `GUIDELINES.md`).
5. Run every verification command through the `ci` wrapper while the feature is `in_progress`, so its time is charged to this feature:
   ```
   node ${CLAUDE_PLUGIN_ROOT}/skills/specforest/bin/cli.js ci <spec>/<feature> -- <test-or-lint-command>
   ```
   See § Timings for which commands to wrap.
6. On completion:
   ```
   node ${CLAUDE_PLUGIN_ROOT}/skills/specforest/bin/cli.js mark <spec>/<feature> done
   ```
7. If paused / blocked:
   ```
   node ${CLAUDE_PLUGIN_ROOT}/skills/specforest/bin/cli.js mark <spec>/<feature> blocked
   ```
   And explain to the user why.
```

- [ ] **Step 3: Add the pitfalls**

Append two bullets to the end of `## Pitfalls + rules`:

```markdown
- **`ci` always needs an explicit target.** There is no inference from "whatever is currently `in_progress`" — a guessed attribution is worse than none. Pass the same `<spec>/<feature-path>` you passed to `implement`.
- **`ci` runs through the platform shell.** That is `cmd.exe` on Windows and `/bin/sh` elsewhere, not necessarily the shell the operator is using. Plain commands (`make check-all`, `npm test`, `pytest`, `cargo clippy`) work everywhere; anything relying on shell-specific syntax needs an explicit `bash -c "…"`.
```

- [ ] **Step 4: Add the config key**

In `## Config`, add one line to the defaults block, after `checkboxMarkers`:

```yaml
timings: true
```

- [ ] **Step 5: Add the spec reference**

In `## See also`, add:

```markdown
- Timings spec: `dev/specs/2026-09-21-feature-timings-design.md`
```

- [ ] **Step 6: Commit** *(ask first)*

```bash
git add SKILL.md
git commit -m "docs(specforest): document the timings feature and the CI category rule"
```

---

## Task 13: Full-suite verification

**Files:**
- Modify: whichever test or source file the run turns up

- [ ] **Step 1: Run the whole suite**

Run: `npm test`

Expected: PASS, with no skipped or todo entries.

- [ ] **Step 2: Confirm every call site was updated**

```bash
grep -rn "syncCheckboxesAndPersistOrphans({" src/ | grep -v "timingsPath"
```

Expected: no output.

- [ ] **Step 3: Confirm a zero-timing project is unchanged**

```bash
grep -rn "activeMs <= 0" src/
```

Expected: matches in `src/timings.js` (`formatAnnotation`) and `src/commands/status.js` (`suffix`) — the two guards that keep a non-user's output byte-identical.

- [ ] **Step 4: Check coverage against the 80% project rule**

Run: `node --test --experimental-test-coverage tests/*.test.js`

Expected: line coverage ≥ 80% overall, and ≥ 80% on `src/timings.js`, `src/timings-io.js`, `src/commands/ci.js`, and `src/commands/timings.js`. If any of the four falls short, add unit tests for the uncovered branches — most likely the `--json` paths in `src/commands/timings.js` and the `child.on("error")` path in `src/commands/ci.js`.

- [ ] **Step 5: Commit** *(ask first)*

```bash
git add tests
git commit -m "test(specforest): raise timings coverage to the project threshold"
```

---

## Deviations from this plan

Recorded after execution. The plan was written before the code existed, so several
steps specified something that turned out to be wrong against the real files. The
implementation follows the SPEC; where the plan and the spec disagreed, the spec won.
Nothing below is a spec change.

**Task 3 — `deriveTotals` / interval pairing.** The plan's version propagated `NaN`
from an unparseable `ts` through the arithmetic for the whole target, and its
identical-timestamp tie-break depended on the caller's array order. Fixed by skipping
events whose `ts` does not parse, and by the explicit `EVENT_ORDER` sort
(`{ stop: 0, ci: 1, start: 2 }`) so a `stop` closes before a `start` reopens.

**Task 4 — `aggregateTree` / `aggregateForest`.** Two corrections. (1) The plan added
own records in an `if (isLeaf) … else …`, which silently DESTROYED a leaf's recorded
history the moment a later ingest gave it children; own records are now added
unconditionally, which is also what spec §1.3's single formula actually says.
(2) Forest totals sum over every tree's top-level features, NOT over the islands, so
they stay correct when a feature is in no island, an island list is empty, or
`islands.json` is absent (spec §6).

**Task 5 — `appendEvents`.** The plan's writer could fuse a new record onto a
previous partial line when the log did not end in a newline.

**Tasks 6 and 7 — recording on the write path.** The plan left `recordTransition`
(Task 6) and the `appendEvents` call in `sync-helpers.js` (Task 7) unguarded, so an
unwritable or unreadable log would have taken down `mark`, `implement`, and the whole
`sync` render. Both are now guarded: warn to stderr and continue. This is the
write-path half of the two opposing error conventions.

**Task 8 — `ci` command.** Argument pre-dispatch and quoting defects; the wrapper now
validates the target, the `--` separator, and the command before spawning anything,
and an unresolvable target exits 1 without running the command.

**Task 9 — `timings` command.** The read-path convention is the opposite of the write
path: here the log IS the operation, so an unreadable log writes one clean message and
exits 1 rather than degrading. Also fixed a key-desynchronization bug: the node key is
built from `tree.spec`, not from the user-typed spec name, because `readTree` resolves
`${specName}.json` case-insensitively on Windows/macOS.

**Task 10 — `status` suffix.** Three plan defects caught before dispatch, plus two
found in review: a `try` that wrapped the pure computation as well as the IO call (so
a `TypeError` in our own code would have been relabelled an IO failure and swallowed),
and an `activeMs <= 0` guard that `Infinity` walks straight through —
`JSON.parse("1e999")` is `Infinity` and passes `deriveTotals`'s `ms > 0` filter, which
would have printed an all-zero suffix on a line the spec requires to be suppressed
ENTIRELY. Both `status` and the tree annotation now share one rule, `hasRecordedTime()`.

**Task 11 — ASCII tree annotations.** Three plan defects caught before dispatch (most
importantly `aggregateForest(built, …)`, which would have thrown
`TypeError: built.trees is not iterable` — the third recurrence of that same mistake),
and eight more from review. The substantive ones: `stderr` was not threaded through
`renderFullTreeAscii` or six of the seven `regenAndWriteTreeCache` call sites, making
the "could not record timing" warning dead on those paths; the guarded-read-and-
aggregate block was duplicated between `status` and the tree annotator and is now
`src/timings-aggregate.js` (a file this plan does not mention); and `isTreeCacheStale`
gained an open-interval check, because a `(running)` duration is derived from
`Date.now()` and therefore drifts out of sync with an mtime-fresh cache that no input
file has touched.

**Task 12 — SKILL.md.** One sentence added beyond the plan text: only childless nodes
are timed, so `ci` against a node with sub-features runs the command but records
nothing (and says so on stderr). The plan's text omitted this and would have left the
reader with no explanation for a silent non-recording.

**Task 13 — verification commands.** Both greps in the plan are wrong against the real
tree and were replaced:

- Step 2's `grep -rn "syncCheckboxesAndPersistOrphans({" src/ | grep -v "timingsPath"`
  is specified as "expected: no output", but every call site in this codebase spans
  multiple lines, so it emits a false positive for each one. Replaced with a Node
  one-liner that regex-matches the whole multi-line call:
  `call sites: 14 OK: all pass timingsPath`.
- Step 3's `grep -rn "activeMs <= 0" src/` is stale — Task 10 replaced both of the
  guards it was meant to find with the shared `hasRecordedTime()` helper. Replaced
  with `grep -rn "hasRecordedTime" src/` (5 matches).

Step 4's coverage gate passed as written (overall line coverage 90.66%; all four named
files above 80%), so the added tests targeted BRANCH coverage on the two new commands
instead — `ci.js` 61.90% → 87.10%, `timings.js` 67.65% → 77.78% — covering the
argument-validation and error paths that no test exercised.

### Final whole-feature review (after Task 13)

A review of the finished feature as a unit — rather than task by task — found six defects
that every per-task review had missed, because each write site looked correct in isolation
and only the write-path/read-path comparison exposed them. All six were fixed; the suite
went 209 → 220 tests.

1. **CRITICAL — the timing key was built from the user-typed spec string at every write
   site.** `readTree(dir, specName)` opens `${specName}.json` through the OS, so on
   Windows/macOS `AUTH` resolves `auth.json` and the command succeeds, but `tree.spec` —
   which every *reader* keys off — stays canonical. Typing `AUTH/login` therefore recorded
   under a key nothing reads: the work vanished from the node and surfaced only under
   `--orphans`. Worse, one casing for `start` and another for `stop` left the interval
   permanently open, so `active`/`lead` grew without bound, `(running)` stuck on a finished
   feature, and `isTreeCacheStale` returned `true` forever, defeating the tree cache.
   Fixed by deriving `canonicalSpec`/`canonicalTarget` from the tree once and using it for
   every key, lookup and printed target in `mark.js`, `implement.js` and `ci.js`.
   The review named four sites; `implement.js` had three more it missed —
   `findIslandForFeature` (line 66) and `startKey` (line 73), which made
   `implement AUTH/login` fail outright with the misleading *"feature not present in any
   island (islands.json out of date?)"*, plus the already-done `mark` hint, which suggested
   a command that could not be copy-pasted.
2. **IMPORTANT — `timings` bypassed the shared suppression rule.** It guarded on
   `activeMs <= 0` rather than `hasRecordedTime()`, and `<= 0` is `false` for both
   `Infinity` and `NaN`. Since `JSON.parse("1e999")` is `Infinity` and passes
   `deriveTotals`'s filter, an **unmutated** log could make an island line render
   `active 0s ci 0s coding 0s lead 0s` — a fabricated measurement, exactly what the rule
   exists to forbid — while `status` correctly suppressed the same data.
3. `pct()` returned a literal `NaN%`: with `part === whole === Infinity`, both `whole <= 0`
   and `Infinity > Infinity` are false.
4. Leaf-level `codingMs` lacked the `Number.isFinite` guard its aggregate twin in `finish()`
   has. Masked in text output by `formatDuration`, but *not* in JSON — `JSON.stringify(NaN)`
   is `null`, so `--orphans --json` emitted `"codingMs": null` where the aggregate path
   emitted `0` for the same data.
5. `timings <target> --orphans` silently ignored `--orphans`, and `timings` used
   `!a.startsWith("--")` for target detection where `ci` used `!a.startsWith("-")`.
6. `mark` and `implement` regenerated the tree cache *before* appending the timing event,
   so the cache knowingly omitted the transition that caused it. Swapped.

**One deliberate behaviour change.** Applying the shared guard to the forest `summaryLine`
means an empty log now prints `(no time recorded)` instead of `active 0s …`, which
invalidated the existing test `timings with no log reports zeros without error`. Kept and
the test rewritten: spec §4.1's own example prints `(no time recorded)` for a zero island,
and §4.2 states the rule as "suppressed entirely when that line has zero recorded time", so
the old forest line was the outlier. The island line already behaved this way.

**Known and not fixed:** `pickMatch({ spec: specName, … })` still echoes the user-typed spec
in its ambiguity listing and its `disambiguate by re-running with full path, e.g. "…"` hint —
the same copy-paste-broken suggestion class as item 1, but `spec` is display-only in
`src/disambiguate.js` and keys nothing, so it is cosmetic.

**Commits.** None of the commit steps in this plan were run. Every one of them is still
pending explicit permission from the repository owner.
