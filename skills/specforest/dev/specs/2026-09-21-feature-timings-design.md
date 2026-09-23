# Feature Timings — Design

**Date:** 2026-09-21
**Status:** Approved (brainstorming) — pending implementation plan
**Scope:** `skills/specforest` — event log, `ci` + `timings` commands, write hooks in `mark` / `implement` / `syncCheckboxes`, reporting in `status` / `tree`, config flag, SKILL.md, tests.
**Companion to:** [SKILL.md](../../SKILL.md), [DESIGN.md](../DESIGN.md).

## Purpose

Specforest tracks *whether* a feature is done but not *how long it took*. This
adds per-feature timing so a project can answer two different questions:

1. **Lead time** — how much calendar time passed between first starting a feature
   and finishing it. Includes nights, weekends, and blocked stretches.
2. **Active time** — how much time was actually spent with the feature
   `in_progress`, split into **CI** (tests, lint, format, typecheck, verification
   builds) and **coding** (everything else).

Granularity is the **feature node**, at any depth, leaf or not. A node is timed
directly whenever its own status crosses the `in_progress` boundary — whether it
was the explicit target of a `mark` / `implement`, or was moved by one of the
cascades in §2.4. A node with children therefore carries both its own interval
(the wall-clock span of the whole feature) and the rolled-up records of its
descendants; §1.3 defines how the two combine without double-counting.

## Non-goals

- No timing in the Obsidian output. `forest.md` and `<island>.md` are unchanged,
  so the checkbox round-trip in §3.4 of [DESIGN.md](../DESIGN.md) is untouched.
- No new status. Timing rides on the existing `todo` / `in_progress` /
  `blocked` / `done` transitions.
- No automatic detection of CI commands. Claude routes them through the `ci`
  wrapper per the category rule in §7; there is no hook, no config list, and no
  command-sniffing.
- No estimation, velocity projection, or burndown. This records; it does not
  forecast.

## 1. Data model

### 1.1 Event log

`<hiddenDir>/timings.jsonl` — append-only, one JSON object per line.

```jsonl
{"ts":"2026-09-21T09:12:03.123Z","event":"start","target":"auth-design/login/form","source":"cli"}
{"ts":"2026-09-21T09:31:44.900Z","event":"ci","target":"auth-design/login/form","ms":48210,"cmd":"make check-all","exit":0}
{"ts":"2026-09-21T09:40:02.004Z","event":"stop","target":"auth-design/login/form","to":"done","source":"checkbox"}
```

| Field | Applies to | Meaning |
|---|---|---|
| `ts` | all | ISO-8601 UTC, millisecond precision |
| `event` | all | `start` \| `stop` \| `ci` |
| `target` | all | `<spec>/<top>/…/<leaf>` — always the **resolved full path**, never the abbreviated single-segment form |
| `source` | `start`, `stop` | `cli` (from `mark` / `implement`) \| `checkbox` (adopted from an Obsidian tick) |
| `to` | `stop` | the status the feature moved to (`todo` \| `blocked` \| `done`) |
| `ms` | `ci` | measured wall-clock of the wrapped command |
| `cmd` | `ci` | the wrapped argv, space-joined, for audit |
| `exit` | `ci` | the wrapped command's exit code |

`start` is emitted on any transition **into** `in_progress`. `stop` is emitted on
any transition **out of** `in_progress`. Transitions that do not cross the
`in_progress` boundary (e.g. `todo` → `blocked`) emit nothing.

Storing the resolved full path is load-bearing: `mark` and `implement` accept a
single trailing segment resolved by name across the whole tree, and two nodes in
different branches may share a name. The log must be unambiguous.

Append-only is chosen over a rewritten map so that a crash mid-write cannot
corrupt earlier records, and so the tree JSON stays lean — `sync` rebuilds trees
wholesale from Claude's ingest output on every spec edit and carries over only
`status`, so inline timings would need bespoke merge logic that can silently drop
data on a rename.

### 1.2 Derived figures

Nothing below is stored; all of it is computed on read.

**Interval pairing.** For each target, walk its `start` / `stop` events in
timestamp order. Each `start` pairs with the next `stop`. A trailing unpaired
`start` is an **open** interval, counted up to now and flagged `(running)`.

| Figure | Rule |
|---|---|
| `activeMs` | Σ interval durations + Σ `ms` of `ci` events whose `ts` falls outside every interval |
| `ciMs` | Σ `ms` over the target's `ci` events |
| `codingMs` | `activeMs − ciMs`, floored at 0 |
| `leadMs` | last interval end (or now, if open) − first interval start |

`ci` events outside every interval are folded into `activeMs` so that a CI run
executed after `mark … done` still counts as time spent rather than producing a
negative `codingMs`.

**"Outside every interval" means outside the node's own intervals *and* its
ancestors'.** The fold exists only to stop a run being unaccounted wall-clock, so
a run an ancestor already accounts for must not be folded. Under feature-level
timing this is the common case, not an edge: `implement <feature>` opens an
interval on the feature, and a `ci` aimed at one of its untimed leaves lands
inside that window. Testing the run against the leaf's own (empty) interval list
alone would class it "outside", fold it in, and then add it again with the
parent's interval during roll-up — reporting the run twice. The ancestor test
needs the tree, so it is applied during §1.3 aggregation rather than in the
per-target derivation; an orphan target (matching no node) has no ancestors and
keeps the per-target answer.

**Known approximation — the straddling run.** A `ci` event is placed by its `ts`,
which is when the wrapped command *started*. A run that starts inside an interval
but finishes after the `stop` is therefore classed as "inside" and contributes
nothing to the fold, while its full `ms` still counts toward `ciMs`. When that
run is longer than the interval containing it, `ciMs` exceeds `activeMs` and
`codingMs` clamps to 0 — reporting e.g. `5m 00s (ci 10m 00s)`. This is the only
path that reaches the floor, it requires marking the feature done from a second
terminal while CI is still running, and the reported `ciMs` remains accurate.
Charging only the in-interval remainder would need an end timestamp per `ci`
event; deferred until the case is observed in practice.

### 1.3 Node aggregation

A node's own records and its descendants' records describe **overlapping**
wall-clock, so they cannot simply be added. Under the §2.4 cascades a parent's
interval opens with its first leaf and closes with its last, so it spans every
descendant interval by construction — summing both would report exactly twice
the elapsed time.

Intervals and CI runs therefore aggregate differently, because only intervals
overlap. A `ci` event is attributed to exactly one target and never nests inside
another node's run, so CI stays additive at every level:

```
descendantsTimed = any descendant recorded at least one interval

node.ciMs     = ownCiMs + Σ descendant.ciMs
node.activeMs = Σ descendant.activeMs
              + (descendantsTimed ? ownCiMs
                                  : ownIntervalMs + ownCiOutsideMs)
node.codingMs = max(0, node.activeMs − node.ciMs)
```

where `ownIntervalMs` is the node's own closed/open `start`→`stop` durations and
`ownCiOutsideMs` is the §1.2 out-of-interval CI remainder — evaluated here,
where the ancestor intervals are known, against the node's own intervals plus
every ancestor's.

In words: **descendants win.** A node's own interval counts only when no
descendant recorded one. This gives the three workflows a single consistent
answer:

| Workflow | Result |
|---|---|
| Leaf only (no children) | `descendantsTimed` is false → own interval + out-of-interval CI. Identical to the pre-cascade behaviour. |
| Feature marked directly, leaves never marked | `descendantsTimed` is false → the feature's own interval counts. This is what makes `implement <feature>` record time on its own. |
| Leaves marked, feature moved by cascade | `descendantsTimed` is true → the sum of the leaves counts and the parent's spanning interval is suppressed. No double-count. |

`leadMs` is unaffected: still `max(end)` − `min(start)` across the node and all
descendants. Under the cascades the parent's own interval equals that span
anyway, so `leadMs` is stable whichever workflow produced it.

**Known consequence.** When a leaf gains children on a later ingest *and* those
children go on to record intervals, the node's own historical interval stops
counting toward `activeMs` (its CI still does). Its history remains in the log
and still shows in `leadMs`. Accepted: the alternative is the double-count this
rule exists to prevent, and there is no way to tell a stale pre-ingest interval
apart from a live spanning one.

## 2. Write path

### 2.1 The recorder

Two new modules, split pure-from-IO to match the existing `counters.js` /
`tree-io.js` convention — the pure half is directly testable with no temp
directories, which is where most of the arithmetic risk lives.

New module `src/timings.js` — pure, no `node:fs`:

```
deriveTotals(events)                   // → Map<target, {activeMs, ciMs, codingMs, leadMs, intervals, ciRuns, open}>
aggregateTree(tree, totals)            // → Map<fullPath, totals> with §1.3 applied
formatDuration(ms)                     // "3d 2h" | "2h 41m" | "48.2s" | "0s"
```

New module `src/timings-io.js` — everything that touches the disk:

```
appendEvents(timingsPath, events)      // single append per call
readEvents(timingsPath)                // tolerant parse, see §6
```

and a single helper, also in `src/timings-io.js`:

```
recordTransition({ enabled, timingsPath, node, fullPath, from, to, source })
```

which emits an event **only** when both of:

- `enabled` is true (§5),
- exactly one of `from` / `to` is `in_progress`.

There is no longer a leaf condition: any node whose status crosses the
`in_progress` boundary is recorded, at any depth. The boundary-crossing test is
what keeps the cascades of §2.4 idempotent — a cascade that re-asserts a status
a node already holds writes nothing.

### 2.2 Call sites

These are the only three places feature status is written:

| Site | Change |
|---|---|
| [`src/commands/mark.js`](../../src/commands/mark.js) | capture `resolved.node.status` before the assignment, call `recordTransition` after, `source: "cli"` |
| [`src/commands/implement.js`](../../src/commands/implement.js) | same, at the point it sets `in_progress` (skipped entirely under `--no-mark`, which changes no status) |
| `syncCheckboxes` in [`src/render.js`](../../src/render.js) | see §2.3 |

`rollupAncestors` already returns the list of ancestors whose status it changed.
Every such change is now recorded: the call sites emit one event per changed
node, not one for the target alone. `rollupAncestors` itself is unchanged — it
gains a `fullPath` on each returned change so the recorder can key the event
correctly (it currently returns a bare `name`, which is not a valid `target`
per §1.1).

### 2.4 Status cascades

Status already propagates **upward** through `rollupNodeStatus`: all children
`done` promotes the parent to `done`, and any child `in_progress` or `done`
promotes it to `in_progress`. That covers the upward half of this design and
needs no change beyond recording the events it produces.

One cascade is new — **downward on `done`**:

> Marking a node `done` marks every descendant `done`.

Rationale: a feature cannot be complete while its parts are not, and without it
a `done` feature leaves its in-progress leaves' intervals open forever, which
`deriveTotals` would keep counting against the clock.

The three cascade paths and what each records:

| Path | Status effect | Events |
|---|---|---|
| Leaf → `in_progress` | ancestors promoted to `in_progress` by rollup | `start` for the leaf **and** for each ancestor that changed |
| Node → `done` | all descendants set `done`; ancestors rolled up | `stop` for the node, for each descendant that was `in_progress`, and for each ancestor promoted to `done` |
| Last leaf → `done` | parent (and further ancestors) promoted to `done` by rollup | `stop` for the leaf and for each ancestor that changed |

Ordering within a single command: mutate descendants first, then the target,
then roll up ancestors; collect every `{node, fullPath, from, to}` whose status
actually changed, and append all events in **one** `appendEvents` call so a
crash cannot leave a half-written cascade.

Descendants that were `todo` when a `done` cascade reaches them cross no
boundary and so write nothing — they gain a `done` status with no interval,
exactly as a directly-marked `todo` → `done` does today.

**Scope boundary.** Cascades apply to the `mark` and `implement` paths only.
Checkbox adoption (§2.3) has never rolled up ancestors and does not start doing
so here: an Obsidian tick still adopts exactly the nodes whose markers changed.
It does gain non-leaf recording, since the leaf condition is gone from §2.1 —
ticking a feature's own checkbox now times that feature. Extending the cascades
to the checkbox round-trip would mean mutating nodes whose markers the user did
not touch and re-rendering inside a sync, which is a larger change than this
design takes on.

### 2.3 Checkbox adoption

`syncCheckboxes` currently mutates `node.status` inline and keys its visit by
bare feature name. Two changes:

1. The internal `visit` carries a path array so a full path is available at the
   mutation point.
2. The function **returns** the adopted transitions as
   `{ spec, fullPath, from, to, isLeaf }[]` alongside its existing
   `{ updated, warnings, orphans }`, instead of writing events itself.

[`src/sync-helpers.js`](../../src/sync-helpers.js) — which already holds
`statePath` and can therefore derive the timings path — appends the events with
`source: "checkbox"`. This keeps `render.js` free of path and config knowledge.

Timestamps are **detection time**, not tick time: the CLI learns about an
Obsidian tick on the next command that runs `syncCheckboxes`. Ticking on Friday
and running a command on Monday overstates that interval by the gap. The
`source: "checkbox"` tag makes such records identifiable in the interval list so
the distortion is visible rather than hidden. Using the island MD's `mtime`
instead was rejected: one file carries a single mtime, so a session where
several features are ticked would stamp them all identically.

Recording checkbox transitions is a correctness requirement, not just coverage.
If only CLI transitions were recorded, a feature started with `implement` and
ticked done in Obsidian would leave an interval open forever.

**Accepted limitation — a failed append loses that transition permanently.**
`syncCheckboxes` persists the adopted status into the tree JSON before
`sync-helpers` appends the event. If the append then fails, the tree already
matches the Markdown, so the next sync adopts nothing and the event is never
retried: the interval opened by `implement` stays open, and the stderr warning
from §6 is the only trace. Appending before the tree write was rejected as
strictly worse — it would record a `stop` for a status change that then failed
to persist, corrupting the log rather than merely leaving a gap in it. A
two-phase write that made the transition retryable is out of scope.

## 3. The `ci` wrapper

```
specforest ci <target> -- <command> [args…]
```

An explicit `<target>` is **always required**; there is no inference from "the
feature that is currently `in_progress`". The record is then never a guess.

Behaviour:

1. Resolve `<target>` via the existing `parseTarget` / `resolveTargetNode` in
   [`src/target.js`](../../src/target.js), including the standard disambiguation
   prompt for a single-segment target.
2. Spawn everything after `--` with `stdio: "inherit"` so the user and Claude
   see output live.
3. Measure wall-clock around the spawn.
4. Append a `ci` event with `ms`, `cmd`, and `exit`.
5. Exit with the child's exit code.

Consequences, all deliberate:

- **A failing command still records its time** and still surfaces as a failure
  to Claude. Failed CI is time spent.
- **The target need not be `in_progress`.** §1.2 folds out-of-interval `ci`
  events into `activeMs`.
- **A non-leaf target is recorded like any other.** Nodes with children are
  timed as of §1.3, and CI is additive at every level, so a `ci` run aimed at a
  feature is charged to that feature. No warning, no special case.
- **A missing `--` separator, or no command after it, is an error** (exit 1)
  before anything is spawned.

**Shell caveat.** The command runs through the platform shell — `cmd.exe` on
Windows, `/bin/sh` elsewhere — not necessarily the shell the operator is using.
Plain commands (`make check-all`, `npm test`, `pytest`, `cargo clippy`) work
everywhere; shell-specific syntax requires an explicit `bash -c "…"`. This is
documented in SKILL.md rather than worked around.

## 4. Reporting

### 4.1 `specforest timings [<target>] [--json] [--orphans]`

No target — forest and per-island rollup:

```
forest: 3 islands, [12/47]
  active 14h 22m   ci 3h 01m (21%)   coding 11h 21m   lead 9d 4h

  auth-and-tenant-isolation    active 5h 12m   ci 1h 04m   coding 4h 08m   lead 3d 2h
  voice-pipeline               (no time recorded)
  visualizer-protocol          active 9h 10m   ci 1h 57m   coding 7h 13m   lead 6d 1h

orphaned: 2 targets no longer in any tree — `specforest timings --orphans`
```

With a target — node detail, same target grammar as `mark`:

```
auth-design/login/form   [done]
  lead    3d 2h 14m   (2026-09-18 09:12 → 2026-09-21 11:26)
  active  2h 41m      ci 31m 12s (4 runs)      coding 2h 09m

intervals:
  2026-09-18 09:12 → 10:04    52m     → blocked   (cli)
  2026-09-21 09:40 → 11:26    1h 46m  → done      (checkbox)

ci runs:
  2026-09-18 09:31   48.2s   exit 0   make check-all
  2026-09-21 11:19   2m 04s  exit 1   npm test
```

`--json` emits raw milliseconds for both forms. `--orphans` lists targets that
have recorded time but no longer resolve to a node in any tree (§6).

The command runs `syncCheckboxesAndPersistOrphans` first, like every other
read-side command, so a just-ticked checkbox is reflected.

### 4.2 `status`

A suffix on each existing line, **suppressed entirely when that line has zero
recorded time** — so a project not using the feature sees byte-identical output:

```
forest: 3 islands, [12/47]  active 14h 22m (ci 3h 01m / code 11h 21m)
  auth-and-tenant-isolation: [4/15] (2 specs)  active 5h 12m (ci 1h 04m / code 4h 08m)
```

### 4.3 ASCII `tree`

Nodes with non-zero recorded time are annotated after the existing `[x/N]`
counter. Nodes with no recorded time are unchanged. `(ci …)` appears only when
`ciMs > 0`.

```
├── auth-and-tenant-isolation [4/15]  2h 41m
│   └── auth-design
│       └── [/] login [1/2]  2h 41m (ci 31m)
│           ├── [x] form  2h 41m (ci 31m)
│           └── [ ] validation
```

`regenAndWriteTreeCache` gains the derived totals as an input, so the cache
written by `sync`, `mark`, `implement`, and `commit-islands` stays consistent
with the log.

### 4.4 Obsidian output

Unchanged. `forest.md` and `<island>.md` carry no timing.

## 5. Config flag

```yaml
timings: true    # record per-feature implementation timings
```

Added to `defaultConfig()` and `defaultConfigYaml()` in
[`src/config.js`](../../src/config.js), validated by `validateConfig` as a
boolean. Because `loadConfig` merges the parsed YAML over `defaultConfig()`, an
existing config file without the key resolves to `true` — no migration needed.

When `false`:

- the three write sites in §2.2 become no-ops; nothing is appended
- `ci` still runs the command and still passes the exit code through — it is a
  command runner first — recording nothing and noting that once on stderr
- `status` and `tree` suppress their annotations
- `timings` exits **0** with an explanatory line naming the flag (asking for a
  report is not an error)
- `timings.jsonl` is never deleted or truncated, so re-enabling the flag resumes
  against existing history

**Caveat.** Disabling the flag while an interval is open means no `stop` is
written, so that interval stays open and reads as `(running)` until the feature
next enters `in_progress`. This is documented rather than detected; inferring a
"re-enable" would require extra state for a rare case.

## 6. Edge cases

| Case | Behaviour |
|---|---|
| Interval still open | Counted up to now, flagged `(running)` in every report |
| Negative duration (clock skew) | Clamped to 0 |
| Malformed line in the log | Skipped with a stderr warning; append-only means one bad line cannot destroy history |
| `start` while an interval is already open | Reader ignores it; §2.1's `from`-check prevents it arising |
| `stop` with no open `start` | Reader ignores it |
| Feature renamed or deleted | Events retained; reported under `orphaned` rather than dropped, mirroring the existing `orphanedProgress` treatment in §3.4 of [DESIGN.md](../DESIGN.md) |
| `timings.jsonl` missing | All figures zero, no error; every surface degrades to today's output |
| `islands.json` missing when `timings` runs with no target | Forest-level totals and the orphan section still print; the per-island breakdown is omitted with a note, matching how `status` already handles this |
| Leaf later gains children | Once those children record intervals, the node's own historical interval stops counting toward `activeMs`; its CI still counts and its history still shows in `leadMs` (§1.3) |
| `ci` target is a non-leaf | Recorded normally — CI is additive at every level (§1.3) |
| `done` cascade reaches a `todo` descendant | Status becomes `done`, no boundary crossed, no event (§2.4) |
| `done` cascade reaches an already-`done` descendant | No status change, no event; cascades are idempotent (§2.4) |
| `ci` with no `--` or no command | Exit 1 before spawning |
| Log growth | One line per transition; no rotation |
| Concurrent writes | One `appendFile` per event; `sync` is already covered by `.specforest/sync.lock` |
| The timings write itself fails (read-only dir, bad path, locked file) | The status change still commits and the command still succeeds. Every `recordTransition` call site wraps the call and degrades to a `warning: could not record timing: …` line on stderr. Timing is an add-on; it may never take the core status write, the tree-cache regen, or `implement`'s prompt output down with it |

## 7. SKILL.md changes

1. **New § Timings** describing `timings`, the `ci` wrapper, and the config flag.
2. **CI category rule**, stated verbatim for Claude:

   > Route through `specforest ci <target> -- …` any command that **verifies**
   > code rather than changes it: test runners, linters, formatters (including
   > write modes), type checkers, and builds run for verification. Do **not**
   > wrap: editing, file inspection, git operations, package installs, or
   > running the application itself.

   There is no config list and no auto-detection — this prose is the whole
   definition, and it must work in a repo Claude has never seen.
3. **Implement flow** gains a step: run CI through the wrapper while the feature
   is `in_progress`.
4. **Pitfalls** gains: the shell caveat (§3), and that `ci` requires an explicit
   target.

## 8. Testing

**Pure unit tests** (`tests/pure.test.js` or a new `tests/timings.test.js`):

- interval pairing: normal, open trailing `start`, unpaired `stop`, interleaved
  targets
- `ci` inside vs outside an interval, and its effect on `activeMs` / `codingMs`
- negative-duration clamp and `codingMs` floor
- `formatDuration` across days / hours / minutes / seconds / zero
- `aggregateTree` — leaf; parent whose leaves are timed (own interval suppressed,
  no double-count); parent timed directly with untimed leaves (own interval
  counts); parent with own CI plus timed leaves (CI additive, interval
  suppressed); the exact two-leaf cascade of §1.3 asserting the total is the
  elapsed span and not twice it

**IO tests** (`tests/io.test.js`):

- `mark … in_progress` then `mark … done` writes exactly one `start` and one
  `stop` with `source: "cli"`
- `implement` writes a `start`; `implement --no-mark` writes nothing
- a transition that does not cross the `in_progress` boundary writes nothing
- rollup-induced ancestor transitions each write an event, keyed by full path
- a non-leaf target writes its own event
- marking a leaf `in_progress` writes a `start` for the leaf and one for each
  ancestor promoted by rollup
- marking a feature `done` writes a `stop` for it and for every descendant that
  was `in_progress`, and sets every descendant `done`
- marking the last outstanding leaf `done` writes a `stop` for the leaf and for
  the parent promoted by rollup
- a cascade writes all of its events in a single append
- checkbox adoption writes with `source: "checkbox"`
- `timings: false` suppresses all of the above and leaves an existing log intact

**E2E** (`tests/e2e.test.js`):

- `ci` wraps `node -e "…"` (portable across platforms), records a plausible
  `ms`, and propagates both exit 0 and a non-zero exit
- `timings` output for a fixture log matches a snapshot
- `status` and `tree` are byte-identical to today's output when no time is
  recorded

Coverage target: 80%, per the project rule.

## 9. Out of scope

- Estimation, velocity, burndown, or any forecast.
- Timing displayed in the Obsidian Markdown.
- Automatic CI detection via Claude Code hooks or command sniffing.
- Splitting a single CI run across multiple features.
- Idle-timeout truncation of long intervals.
- Log rotation or compaction.
