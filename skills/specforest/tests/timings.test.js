import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, stat, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  formatDuration,
  pairIntervals,
  deriveTotals,
  aggregateTree,
  aggregateForest,
  formatAnnotation,
  hasRecordedTime,
  transitionEvent,
} from "../src/timings.js";
import { appendEvents, readEvents, recordTransition } from "../src/timings-io.js";
import { writeDefaultConfig, loadConfig } from "../src/config.js";
import { paths } from "../src/paths.js";
import { writeTree, readTree } from "../src/tree-io.js";
import { writeIslands } from "../src/islands-io.js";
import { cmdMark } from "../src/commands/mark.js";
import { cmdImplement } from "../src/commands/implement.js";
import { cmdStatus } from "../src/commands/status.js";
import { cmdTimings } from "../src/commands/timings.js";
import { syncCheckboxesAndPersistOrphans } from "../src/sync-helpers.js";
import { cascadeDoneToDescendants, rollupAncestors } from "../src/rollup.js";

test("formatDuration renders each magnitude band", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(-5000), "0s");
  assert.equal(formatDuration(null), "0s");
  assert.equal(formatDuration(NaN), "0s");
  assert.equal(formatDuration(Infinity), "0s");
  assert.equal(formatDuration(48210), "48.2s");
  assert.equal(formatDuration(59999), "60.0s");
  assert.equal(formatDuration(60000), "1m 00s");
  assert.equal(formatDuration(124000), "2m 04s");
  assert.equal(formatDuration(1872000), "31m 12s");
  assert.equal(formatDuration(3599999), "59m 59s");
  assert.equal(formatDuration(3600000), "1h 00m");
  assert.equal(formatDuration(9660000), "2h 41m");
  assert.equal(formatDuration(86399999), "23h 59m");
  assert.equal(formatDuration(86400000), "1d 0h");
  assert.equal(formatDuration(266400000), "3d 2h");
});

const T = (h, m = 0) => `2026-09-20T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;
const ms = (iso) => Date.parse(iso);

test("pairIntervals pairs start/stop in order", () => {
  const evs = [
    { ts: T(9), event: "start" },
    { ts: T(11), event: "stop" },
    { ts: T(14), event: "start" },
    { ts: T(15), event: "stop" },
  ];
  const ivs = pairIntervals(evs, ms(T(20)));
  assert.equal(ivs.length, 2);
  assert.equal(ivs[0].ms, 2 * 3600000);
  assert.equal(ivs[1].ms, 3600000);
  assert.equal(ivs[0].open, false);
});

test("pairIntervals ignores a second start while one is open", () => {
  const evs = [
    { ts: T(9), event: "start" },
    { ts: T(10), event: "start" },
    { ts: T(11), event: "stop" },
  ];
  const ivs = pairIntervals(evs, ms(T(20)));
  assert.equal(ivs.length, 1);
  assert.equal(ivs[0].ms, 2 * 3600000);
});

test("pairIntervals ignores a stop with no open start", () => {
  const evs = [
    { ts: T(9), event: "stop" },
    { ts: T(10), event: "start" },
    { ts: T(11), event: "stop" },
  ];
  const ivs = pairIntervals(evs, ms(T(20)));
  assert.equal(ivs.length, 1);
  assert.equal(ivs[0].ms, 3600000);
});

test("pairIntervals leaves a trailing start open, ending at now", () => {
  const evs = [{ ts: T(9), event: "start" }];
  const ivs = pairIntervals(evs, ms(T(12)));
  assert.equal(ivs.length, 1);
  assert.equal(ivs[0].open, true);
  assert.equal(ivs[0].ms, 3 * 3600000);
});

test("pairIntervals clamps a stop that precedes its start", () => {
  const evs = [
    { ts: T(11), event: "start" },
    { ts: T(9), event: "stop" },
  ];
  const ivs = pairIntervals(evs, ms(T(20)));
  assert.equal(ivs.length, 1);
  assert.equal(ivs[0].ms, 0);
});

test("deriveTotals groups by target and computes lead vs active", () => {
  const evs = [
    { ts: T(9), event: "start", target: "a/x", source: "cli" },
    { ts: T(11), event: "stop", target: "a/x", to: "done", source: "cli" },
    { ts: T(14), event: "start", target: "b/y", source: "checkbox" },
    { ts: T(15), event: "stop", target: "b/y", to: "done", source: "checkbox" },
  ];
  const totals = deriveTotals(evs, ms(T(20)));
  const a = totals.get("a/x");
  assert.equal(a.activeMs, 2 * 3600000);
  assert.equal(a.leadMs, 2 * 3600000);
  assert.equal(a.ciMs, 0);
  assert.equal(a.codingMs, 2 * 3600000);
  assert.equal(a.open, false);
  assert.equal(a.intervals.length, 1);
  assert.equal(totals.get("b/y").activeMs, 3600000);
});

test("deriveTotals lead time spans gaps between intervals", () => {
  const evs = [
    { ts: T(9), event: "start", target: "a/x" },
    { ts: T(10), event: "stop", target: "a/x", to: "blocked" },
    { ts: T(18), event: "start", target: "a/x" },
    { ts: T(19), event: "stop", target: "a/x", to: "done" },
  ];
  const totals = deriveTotals(evs, ms(T(20)));
  const a = totals.get("a/x");
  assert.equal(a.activeMs, 2 * 3600000);
  assert.equal(a.leadMs, 10 * 3600000);
});

test("deriveTotals folds ci events inside an interval without inflating active", () => {
  const evs = [
    { ts: T(9), event: "start", target: "a/x" },
    { ts: T(10), event: "ci", target: "a/x", ms: 1800000, cmd: "npm test", exit: 0 },
    { ts: T(11), event: "stop", target: "a/x", to: "done" },
  ];
  const totals = deriveTotals(evs, ms(T(20)));
  const a = totals.get("a/x");
  assert.equal(a.activeMs, 2 * 3600000);
  assert.equal(a.ciMs, 1800000);
  assert.equal(a.codingMs, 2 * 3600000 - 1800000);
  assert.equal(a.ciRuns.length, 1);
  assert.equal(a.ciRuns[0].cmd, "npm test");
});

test("one unparseable ts cannot destroy the surrounding history", () => {
  const evs = [
    { ts: T(9), event: "start", target: "a/x" },
    { ts: T(10), event: "stop", target: "a/x", to: "blocked" },
    { ts: "not-a-date", event: "start", target: "a/x" },
    { ts: T(15), event: "stop", target: "a/x", to: "done" },
  ];
  const a = deriveTotals(evs, ms(T(20))).get("a/x");
  assert.equal(a.activeMs, 3600000);
  assert.equal(a.codingMs, 3600000);
  assert.equal(a.leadMs, 3600000);
});

test("a ci event with an unparseable ts is skipped, not counted as outside", () => {
  const evs = [
    { ts: T(9), event: "start", target: "a/x" },
    { ts: null, event: "ci", target: "a/x", ms: 600000, cmd: "npm test", exit: 0 },
    { ts: T(10), event: "stop", target: "a/x", to: "done" },
  ];
  const a = deriveTotals(evs, ms(T(20))).get("a/x");
  assert.equal(a.activeMs, 3600000);
  assert.equal(a.ciMs, 0);
  assert.equal(a.ciRuns.length, 0);
});

test("stop sorts before start at an identical ts, whatever the input order", () => {
  const chronological = [
    { ts: T(9), event: "start", target: "a/x" },
    { ts: T(10), event: "stop", target: "a/x", to: "done" },
    { ts: T(10), event: "start", target: "a/x" },
    { ts: T(11), event: "stop", target: "a/x", to: "done" },
  ];
  const expected = deriveTotals(chronological, ms(T(20))).get("a/x");
  assert.equal(expected.activeMs, 2 * 3600000);
  assert.equal(expected.intervals.length, 2);

  const reversed = deriveTotals([...chronological].reverse(), ms(T(20))).get("a/x");
  assert.equal(reversed.activeMs, expected.activeMs);
  assert.equal(reversed.intervals.length, expected.intervals.length);
});

test("deriveTotals groups interleaved targets", () => {
  const evs = [
    { ts: T(9), event: "start", target: "a/x" },
    { ts: T(10), event: "start", target: "b/y" },
    { ts: T(11), event: "stop", target: "a/x", to: "done" },
    { ts: T(13), event: "stop", target: "b/y", to: "done" },
  ];
  const totals = deriveTotals(evs, ms(T(20)));
  assert.equal(totals.get("a/x").activeMs, 2 * 3600000);
  assert.equal(totals.get("b/y").activeMs, 3 * 3600000);
});

test("codingMs floors at zero when a ci run outlasts its interval", () => {
  const evs = [
    { ts: T(9), event: "start", target: "a/x" },
    { ts: T(9, 5), event: "ci", target: "a/x", ms: 2 * 3600000, cmd: "npm test", exit: 0 },
    { ts: T(9, 10), event: "stop", target: "a/x", to: "done" },
  ];
  const a = deriveTotals(evs, ms(T(20))).get("a/x");
  assert.equal(a.activeMs, 600000);
  assert.equal(a.ciMs, 2 * 3600000);
  assert.equal(a.codingMs, 0);
});

test("an open interval carries the source of its start event", () => {
  const ivs = pairIntervals([{ ts: T(9), event: "start", source: "checkbox" }], ms(T(12)));
  assert.equal(ivs[0].open, true);
  assert.equal(ivs[0].source, "checkbox");
});

test("deriveTotals adds an out-of-interval ci run to active time", () => {
  const evs = [
    { ts: T(9), event: "start", target: "a/x" },
    { ts: T(10), event: "stop", target: "a/x", to: "done" },
    { ts: T(15), event: "ci", target: "a/x", ms: 600000, cmd: "npm run lint", exit: 0 },
  ];
  const totals = deriveTotals(evs, ms(T(20)));
  const a = totals.get("a/x");
  assert.equal(a.activeMs, 3600000 + 600000);
  assert.equal(a.ciMs, 600000);
  assert.equal(a.codingMs, 3600000);
});

const leafTree = {
  spec: "auth",
  features: [
    { name: "login", status: "done", children: [] },
    {
      name: "session",
      status: "in_progress",
      children: [
        { name: "cookie", status: "done", children: [] },
        { name: "refresh", status: "todo", children: [] },
      ],
    },
  ],
};

// Hand-built stand-ins for deriveTotals output. `intervalMs` / `ciOutsideMs` are
// the §1.3 components aggregateTree reads: these fixtures model a node whose CI
// all ran inside its interval, so the whole of `activeMs` is interval time and
// the out-of-interval remainder is zero — matching the `codingMs` below.
// `intervals` stays empty on purpose (several assertions count it), which means
// these fixtures always take the "no descendant recorded an interval" branch;
// the descendants-win branch is covered by the deriveTotals-backed tests below.
function totalsOf(pairs) {
  const m = new Map();
  for (const [k, v] of pairs) {
    m.set(k, {
      activeMs: v.activeMs || 0,
      intervalMs: v.activeMs || 0,
      ciOutsideMs: 0,
      ciMs: v.ciMs || 0,
      codingMs: (v.activeMs || 0) - (v.ciMs || 0),
      leadMs: v.leadMs || 0,
      firstStart: v.firstStart ?? null,
      lastEnd: v.lastEnd ?? null,
      open: v.open || false,
      intervals: [],
      ciRuns: [],
    });
  }
  return m;
}

test("aggregateTree rolls leaves up into their ancestors", () => {
  const totals = totalsOf([
    ["auth/login", { activeMs: 3600000, ciMs: 600000, firstStart: 100, lastEnd: 200 }],
    ["auth/session/cookie", { activeMs: 1800000, ciMs: 0, firstStart: 50, lastEnd: 300 }],
    ["auth/session/refresh", { activeMs: 900000, ciMs: 300000, firstStart: 400, lastEnd: 500 }],
  ]);
  const agg = aggregateTree(leafTree, totals);
  const session = agg.get("auth/session");
  assert.equal(session.activeMs, 2700000);
  assert.equal(session.ciMs, 300000);
  assert.equal(session.codingMs, 2400000);
  assert.equal(session.firstStart, 50);
  assert.equal(session.lastEnd, 500);
  assert.equal(session.leadMs, 450);
  assert.equal(session.intervalCount, 0);
  const login = agg.get("auth/login");
  assert.equal(login.activeMs, 3600000);
  assert.equal(login.ciMs, 600000);
});

test("aggregateTree reports zero for an untimed subtree", () => {
  const agg = aggregateTree(leafTree, new Map());
  assert.equal(agg.get("auth/session").activeMs, 0);
  assert.equal(agg.get("auth/session").leadMs, 0);
  assert.equal(agg.get("auth/login").activeMs, 0);
});

test("formatAnnotation is empty for zero time and annotated otherwise", () => {
  assert.equal(formatAnnotation(null), "");
  assert.equal(formatAnnotation({ activeMs: 0, ciMs: 0, open: false }), "");
  assert.equal(formatAnnotation({ activeMs: 3600000, ciMs: 0, open: false }), "1h 00m");
  assert.equal(
    formatAnnotation({ activeMs: 3600000, ciMs: 600000, open: false }),
    "1h 00m (ci 10m 00s)",
  );
  assert.equal(
    formatAnnotation({ activeMs: 3600000, ciMs: 0, open: true }),
    "1h 00m (running)",
  );
});

test("aggregateForest sums islands and flags orphans", () => {
  const built = {
    trees: [leafTree],
    islands: {
      islands: [
        {
          id: "isl_aaaaaa",
          name: "auth-island",
          members: [
            { spec: "auth", feature: "login" },
            { spec: "auth", feature: "session" },
          ],
        },
      ],
    },
  };
  const totals = totalsOf([
    ["auth/login", { activeMs: 3600000, ciMs: 600000, firstStart: 100, lastEnd: 200 }],
    ["auth/session/cookie", { activeMs: 1800000, ciMs: 0, firstStart: 50, lastEnd: 300 }],
    ["ghost/thing", { activeMs: 5000, ciMs: 0, firstStart: 1, lastEnd: 2 }],
  ]);
  const out = aggregateForest(built, totals);
  assert.equal(out.forest.activeMs, 5400000);
  assert.equal(out.byIsland.get("auth-island").activeMs, 5400000);
  assert.equal(out.byNode.get("auth/session").activeMs, 1800000);
  assert.deepEqual(out.orphans, ["ghost/thing"]);
});

// The child here records no interval (totalsOf leaves `intervals` empty), so
// §1.3's descendants-win clause does not fire and the grown leaf's own history
// still counts. The converse — a child that did record one, suppressing the
// parent's spanning interval — is asserted further down.
test("aggregateTree keeps the history of a leaf that later gained children", () => {
  const grown = {
    spec: "auth",
    features: [
      { name: "session", status: "in_progress", children: [{ name: "cookie", status: "done", children: [] }] },
    ],
  };
  const totals = totalsOf([
    ["auth/session", { activeMs: 3600000, ciMs: 0, firstStart: 100, lastEnd: 200 }],
    ["auth/session/cookie", { activeMs: 1800000, ciMs: 0, firstStart: 5000, lastEnd: 9000 }],
  ]);
  const session = aggregateTree(grown, totals).get("auth/session");
  assert.equal(session.activeMs, 5400000);
  assert.equal(session.firstStart, 100);
  assert.equal(session.lastEnd, 9000);
  assert.equal(session.leadMs, 8900);
});

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

// The workflow the feature-level timing introduced: `implement auth/login`
// opens an interval on the parent, then `ci auth/login/form` runs inside that
// window. The leaf has no interval of its own, so deriveTotals classes the run
// as "outside every interval" and folds it into activeMs — but the wall-clock
// it occupies is already inside the parent's interval, so adding it reports the
// CI second twice. The fold's own §1.2 rationale (a run must not be
// unaccounted wall-clock) says it must not fire when an ANCESTOR covers it.
test("aggregateTree does not re-count a leaf ci run that falls inside an ancestor's interval", () => {
  const events = [
    { ts: T0, event: "start", target: "auth/login", source: "cli" },
    { ts: T1, event: "ci", target: "auth/login/form", ms: 5000, cmd: "npm test", exit: 0 },
    { ts: T2, event: "stop", target: "auth/login", to: "done", source: "cli" },
  ];
  const agg = aggregateTree(TREE, deriveTotals(events));
  const login = agg.get("auth/login");
  assert.equal(login.activeMs, 30 * 60 * 1000, "the parent's interval already spans the ci run");
  assert.equal(login.ciMs, 5000, "ci is still attributed, and still additive");
  assert.equal(login.codingMs, 30 * 60 * 1000 - 5000, "ci is carved out of coding time");
  // The leaf adds no wall-clock of its own: its only record is a run that
  // happened during the parent's session.
  assert.equal(agg.get("auth/login/form").activeMs, 0);
  assert.equal(agg.get("auth/login/form").ciMs, 5000);
});

// The complement: once the parent's interval is closed, a later ci run on a
// leaf is genuinely unaccounted wall-clock and must still be folded in.
test("aggregateTree still folds a leaf ci run that falls outside every ancestor interval", () => {
  const events = [
    { ts: T0, event: "start", target: "auth/login", source: "cli" },
    { ts: T1, event: "stop", target: "auth/login", to: "done", source: "cli" },
    { ts: T2, event: "ci", target: "auth/login/form", ms: 5000, cmd: "npm test", exit: 0 },
  ];
  const agg = aggregateTree(TREE, deriveTotals(events));
  const login = agg.get("auth/login");
  assert.equal(login.activeMs, 10 * 60 * 1000 + 5000);
  assert.equal(login.ciMs, 5000);
  assert.equal(agg.get("auth/login/form").activeMs, 5000);
});

test("aggregateTree is unchanged for a leaf", () => {
  const events = [
    { ts: T0, event: "start", target: "auth/login/form", source: "cli" },
    { ts: T1, event: "stop", target: "auth/login/form", to: "done", source: "cli" },
  ];
  const agg = aggregateTree(TREE, deriveTotals(events));
  assert.equal(agg.get("auth/login/form").activeMs, 10 * 60 * 1000);
});

test("aggregateForest totals every tree, not only islanded features", () => {
  const built = {
    trees: [leafTree],
    islands: { islands: [{ id: "isl_aaaaaa", name: "auth-island", members: [{ spec: "auth", feature: "login" }] }] },
  };
  const totals = totalsOf([
    ["auth/login", { activeMs: 3600000, ciMs: 0, firstStart: 100, lastEnd: 200 }],
    ["auth/session/cookie", { activeMs: 600000, ciMs: 0, firstStart: 300, lastEnd: 400 }],
  ]);
  const out = aggregateForest(built, totals);
  assert.equal(out.byIsland.get("auth-island").activeMs, 3600000);
  assert.equal(out.forest.activeMs, 4200000);
  assert.deepEqual(out.orphans, []);
});

test("aggregateForest still totals the forest when islands.json is absent", () => {
  const totals = totalsOf([["auth/login", { activeMs: 3600000, ciMs: 0, firstStart: 100, lastEnd: 200 }]]);
  const out = aggregateForest({ trees: [leafTree], islands: null }, totals);
  assert.equal(out.forest.activeMs, 3600000);
  assert.equal(out.byIsland.size, 0);
  assert.deepEqual(out.orphans, []);
});

test("formatAnnotation stays empty for non-finite totals", () => {
  assert.equal(formatAnnotation({}), "");
  assert.equal(formatAnnotation({ activeMs: NaN, ciMs: 0, open: false }), "");
  assert.equal(formatAnnotation({ activeMs: Infinity, ciMs: Infinity, open: false }), "");
  assert.equal(formatAnnotation({ activeMs: 3600000, ciMs: Infinity, open: false }), "1h 00m");
});

test("hasRecordedTime is the single suppression rule shared by formatAnnotation and status's suffix", () => {
  assert.equal(hasRecordedTime(null), false);
  assert.equal(hasRecordedTime(undefined), false);
  assert.equal(hasRecordedTime({}), false);
  assert.equal(hasRecordedTime({ activeMs: 0 }), false);
  assert.equal(hasRecordedTime({ activeMs: -1 }), false);
  assert.equal(hasRecordedTime({ activeMs: Infinity }), false);
  assert.equal(hasRecordedTime({ activeMs: -Infinity }), false);
  assert.equal(hasRecordedTime({ activeMs: NaN }), false);
  assert.equal(hasRecordedTime({ activeMs: 1 }), true);
  assert.equal(hasRecordedTime({ activeMs: 3600000 }), true);
});

async function tmpLog() {
  const dir = await mkdtemp(path.join(tmpdir(), "sf-timings-"));
  return { dir, file: path.join(dir, "timings.jsonl") };
}

test("transitionEvent only fires on an in_progress boundary", () => {
  const base = { target: "s/a", source: "cli", ts: "2026-09-21T09:00:00.000Z" };
  assert.equal(transitionEvent({ ...base, from: "todo", to: "in_progress" }).event, "start");
  const stop = transitionEvent({ ...base, from: "in_progress", to: "done" });
  assert.equal(stop.event, "stop");
  assert.equal(stop.to, "done");
  assert.equal(transitionEvent({ ...base, from: "todo", to: "blocked" }), null);
  assert.equal(transitionEvent({ ...base, from: "in_progress", to: "in_progress" }), null);
});

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

test("readEvents warns on an unparseable ts rather than passing it downstream", async () => {
  const { dir, file } = await tmpLog();
  try {
    await appendEvents(file, [
      { ts: "2026-09-21T09:00:00.000Z", event: "start", target: "s/a", source: "cli" },
      { ts: "yesterday", event: "stop", target: "s/a", to: "done", source: "cli" },
    ]);
    const r = await readEvents(file);
    assert.equal(r.events.length, 1);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /line 2/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recordTransition writes nothing when disabled or off-boundary", async () => {
  const { dir, file } = await tmpLog();
  try {
    const leafNode = { name: "form", children: [] };

    assert.equal(await recordTransition({ enabled: false, timingsPath: file, node: leafNode, fullPath: "s/a", from: "todo", to: "in_progress", source: "cli" }), null);
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

test("appendEvents repairs a missing trailing newline instead of fusing records", async () => {
  const { dir, file } = await tmpLog();
  try {
    await writeFile(file, JSON.stringify({ ts: "2026-09-21T09:00:00.000Z", event: "start", target: "s/a", source: "cli" }), "utf8");
    await appendEvents(file, [{ ts: "2026-09-21T09:10:00.000Z", event: "stop", target: "s/a", to: "done", source: "cli" }]);
    const r = await readEvents(file);
    assert.equal(r.events.length, 2);
    assert.deepEqual(r.warnings, []);
    assert.deepEqual(r.events.map((e) => e.event), ["start", "stop"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("appendEvents with no events does not create the directory", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sf-timings-empty-"));
  const nested = path.join(dir, "nested", "timings.jsonl");
  try {
    await appendEvents(nested, []);
    await assert.rejects(stat(path.dirname(nested)), (e) => e.code === "ENOENT");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recordTransition honours an explicit ts and a checkbox source", async () => {
  const { dir, file } = await tmpLog();
  try {
    const ev = await recordTransition({
      enabled: true, timingsPath: file, node: { name: "form" },
      fullPath: "s/a", from: "todo", to: "in_progress",
      source: "checkbox", ts: "2026-09-21T09:00:00.000Z",
    });
    assert.equal(ev.ts, "2026-09-21T09:00:00.000Z");
    assert.equal(ev.source, "checkbox");
    const bad = await recordTransition({
      enabled: true, timingsPath: file, node: { name: "form" },
      fullPath: "s/b", from: "todo", to: "in_progress", source: "cli", ts: null,
    });
    assert.equal(typeof bad.ts, "string");
    assert.ok(Number.isFinite(Date.parse(bad.ts)));
    assert.deepEqual((await readEvents(file)).warnings, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function collector() {
  return { buf: "", write(s) { this.buf += s; } };
}

const leaf = (name, status = "todo") => ({
  name, source: "heading", originalHeading: `## ${name}`, status, children: [],
});

// Two leaves under `login`, so the cascades have something to cascade over:
// a `done` on the parent must reach both, and only the *last* leaf going done
// may promote the parent (spec §2.4).
async function markProject2() {
  const { root, config, p } = await markProject();
  const tree = await readTree(p.treesDir, "auth");
  tree.features[0].children.push(leaf("validation"));
  await writeTree(p.treesDir, tree);
  return { root, config, p };
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

async function setTimingsFalse(root) {
  const cfgPath = path.join(root, "specforest.config.yml");
  const raw = await readFile(cfgPath, "utf8");
  await writeFile(cfgPath, raw.replace("timings: true", "timings: false"), "utf8");
}

// Spec §2.4: a leaf transition cascades to its parent, so marking the only leaf
// of `login` starts and stops `login` too. The parent's event follows the leaf's
// within the same append.
test("mark records a start and stop for the leaf and for its parent, with source cli", async () => {
  const { root, p } = await markProject();
  try {
    const out = collector();
    const err = collector();
    assert.equal(await cmdMark({ cwd: root, args: ["auth/login/form", "in_progress"], stdin: null, stdout: out, stderr: err }), 0, err.buf);
    assert.equal(await cmdMark({ cwd: root, args: ["auth/login/form", "done"], stdin: null, stdout: out, stderr: err }), 0, err.buf);

    const { events } = await readEvents(p.timings);
    assert.deepEqual(
      events.map((e) => [e.event, e.target]),
      [
        ["start", "auth/login/form"],
        ["start", "auth/login"],
        ["stop", "auth/login/form"],
        ["stop", "auth/login"],
      ],
    );
    assert.ok(events.every((e) => e.source === "cli"));
    assert.equal(events[3].to, "done");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("marking a feature done stops it, stops its in-progress leaf, and marks every leaf done", async () => {
  const { root, p } = await markProject2();
  try {
    const out = collector();
    const err = collector();
    await cmdMark({ cwd: root, args: ["auth/login/form", "in_progress"], stdin: null, stdout: out, stderr: err });
    assert.equal(await cmdMark({ cwd: root, args: ["auth/login", "done"], stdin: null, stdout: out, stderr: err }), 0, err.buf);

    // Descendants are recorded before the target (spec §2.4), so the leaf's
    // interval closes before the parent's.
    const { events } = await readEvents(p.timings);
    assert.deepEqual(
      events.slice(2).map((e) => [e.event, e.target]),
      [["stop", "auth/login/form"], ["stop", "auth/login"]],
    );

    // `validation` was never touched, but a done parent means done children.
    const tree = await readTree(p.treesDir, "auth");
    assert.equal(tree.features[0].children[0].status, "done");
    assert.equal(tree.features[0].children[1].status, "done", "untouched leaf is marked done too");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("marking the last leaf done promotes and stops the parent", async () => {
  const { root, p } = await markProject2();
  try {
    const out = collector();
    const err = collector();
    await cmdMark({ cwd: root, args: ["auth/login/form", "in_progress"], stdin: null, stdout: out, stderr: err });
    await cmdMark({ cwd: root, args: ["auth/login/form", "done"], stdin: null, stdout: out, stderr: err });
    // One leaf done is not enough — the parent must stay open.
    let evs = (await readEvents(p.timings)).events;
    assert.ok(!evs.some((e) => e.event === "stop" && e.target === "auth/login"), "parent stopped too early");

    await cmdMark({ cwd: root, args: ["auth/login/validation", "in_progress"], stdin: null, stdout: out, stderr: err });
    await cmdMark({ cwd: root, args: ["auth/login/validation", "done"], stdin: null, stdout: out, stderr: err });

    evs = (await readEvents(p.timings)).events;
    const last = evs[evs.length - 1];
    assert.equal(last.event, "stop");
    assert.equal(last.target, "auth/login");
    const tree = await readTree(p.treesDir, "auth");
    assert.equal(tree.features[0].status, "done");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mark records nothing for an off-boundary transition", async () => {
  const { root, p } = await markProject();
  try {
    const out = collector();
    const err = collector();
    // todo -> blocked never crosses in_progress, for the leaf or for its parent
    await cmdMark({ cwd: root, args: ["auth/login/form", "blocked"], stdin: null, stdout: out, stderr: err });
    assert.deepEqual((await readEvents(p.timings)).events, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("timings: false suppresses recording and leaves an existing log intact", async () => {
  const { root, p } = await markProject();
  try {
    await appendEvents(p.timings, [{ ts: "2026-09-21T09:00:00.000Z", event: "start", target: "auth/login/form", source: "cli" }]);
    await setTimingsFalse(root);

    const out = collector();
    const err = collector();
    await cmdMark({ cwd: root, args: ["auth/login/form", "in_progress"], stdin: null, stdout: out, stderr: err });

    const { events } = await readEvents(p.timings);
    assert.equal(events.length, 1);
    assert.equal(events[0].event, "start");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("implement records exactly one start, and mark done after it records the stop", async () => {
  const { root, p } = await markProject();
  try {
    const out = collector();
    const err = collector();
    assert.equal(await cmdImplement({ cwd: root, args: ["auth/login/form"], stdin: null, stdout: out, stderr: err }), 0, err.buf);
    assert.equal(await cmdMark({ cwd: root, args: ["auth/login/form", "done"], stdin: null, stdout: out, stderr: err }), 0, err.buf);

    const { events } = await readEvents(p.timings);
    assert.deepEqual(
      events.map((e) => [e.event, e.target]),
      [
        ["start", "auth/login/form"],
        ["start", "auth/login"],
        ["stop", "auth/login/form"],
        ["stop", "auth/login"],
      ],
    );

    // Both the leaf and the parent close cleanly — the parent's interval spans
    // the leaf's, which is exactly why §1.3 aggregates with "descendants win".
    const totals = deriveTotals(events, Date.now());
    for (const key of ["auth/login/form", "auth/login"]) {
      const t = totals.get(key);
      assert.equal(t.intervals.length, 1, key);
      assert.equal(t.open, false, key);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("implement --no-mark records nothing", async () => {
  const { root, p } = await markProject();
  try {
    const out = collector();
    const err = collector();
    assert.equal(await cmdImplement({ cwd: root, args: ["auth/login/form", "--no-mark"], stdin: null, stdout: out, stderr: err }), 0, err.buf);

    assert.deepEqual((await readEvents(p.timings)).events, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("implement run twice yields exactly one start", async () => {
  const { root, p } = await markProject();
  try {
    const out = collector();
    const err = collector();
    assert.equal(await cmdImplement({ cwd: root, args: ["auth/login/form"], stdin: null, stdout: out, stderr: err }), 0, err.buf);
    assert.equal(await cmdImplement({ cwd: root, args: ["auth/login/form"], stdin: null, stdout: out, stderr: err }), 0, err.buf);

    // The second run is a no-op: the target is already in_progress, so neither
    // it nor its parent crosses the boundary again.
    const { events } = await readEvents(p.timings);
    assert.deepEqual(
      events.map((e) => [e.event, e.target]),
      [["start", "auth/login/form"], ["start", "auth/login"]],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The leaf-only gate is gone (spec §2.1), so `implement` on a feature that has
// children now starts that feature — this is the workflow that previously
// recorded no coding time at all.
test("implement on a feature with children starts the feature", async () => {
  const { root, p } = await markProject2();
  try {
    const out = collector();
    const err = collector();
    assert.equal(await cmdImplement({ cwd: root, args: ["auth/login"], stdin: null, stdout: out, stderr: err }), 0, err.buf);

    const { events } = await readEvents(p.timings);
    assert.deepEqual(events.map((e) => [e.event, e.target]), [["start", "auth/login"]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Spec §2.4 scope boundary: checkbox adoption gains non-leaf recording, but
// deliberately does NOT cascade — a sync must not mutate nodes the user did not
// tick. Replaces the old "checkbox adoption never times a non-leaf" invariant.
test("checkbox adoption records a non-leaf tick without cascading", async () => {
  const { root, config, p } = await markProject2();
  try {
    await new Promise((r) => setTimeout(r, 20));
    // Only `login` is ticked in-progress; both leaves stay todo.
    await writeFile(
      path.join(p.outputDir, "auth-island.md"),
      "### From [[auth]]\n\n- [/] login\n  - [ ] form\n  - [ ] validation\n",
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
    assert.deepEqual(
      events.map((e) => [e.event, e.target, e.source]),
      [["start", "auth/login", "checkbox"]],
      "the non-leaf is timed, and no leaf is dragged along",
    );
    const tree = await readTree(p.treesDir, "auth");
    assert.equal(tree.features[0].children[0].status, "todo", "leaf must not be cascaded by a sync");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checkbox adoption records a stop with source checkbox", async () => {
  const { root, config, p } = await markProject();
  try {
    const out = collector();
    const err = collector();
    await cmdMark({ cwd: root, args: ["auth/login/form", "in_progress"], stdin: null, stdout: out, stderr: err });
    // Starts the leaf and cascades a start to `login` (spec §2.4).
    assert.equal((await readEvents(p.timings)).events.length, 2);

    await new Promise((r) => setTimeout(r, 20));
    // `login` stays [/] — only the leaf crosses, and checkbox adoption does not
    // cascade (spec §2.4 scope boundary), so exactly one event is added.
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
    assert.equal(events.length, 3);
    assert.equal(events[2].event, "stop");
    assert.equal(events[2].to, "done");
    assert.equal(events[2].source, "checkbox");
    assert.equal(events[2].target, "auth/login/form");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a timings-append failure on the checkbox path degrades gracefully instead of crashing the command", async () => {
  const { root, p } = await markProject();
  try {
    const out = collector();
    const err = collector();
    assert.equal(await cmdMark({ cwd: root, args: ["auth/login/form", "in_progress"], stdin: null, stdout: out, stderr: err }), 0, err.buf);

    await new Promise((r) => setTimeout(r, 20));
    await writeFile(
      path.join(p.outputDir, "auth-island.md"),
      "### From [[auth]]\n\n- [/] login\n  - [x] form\n",
      "utf8",
    );

    // Simulate a fault at appendEvents' open() call: make the timings path a directory.
    await rm(p.timings, { force: true });
    await mkdir(p.timings, { recursive: true });

    const out2 = collector();
    const err2 = collector();
    const code = await cmdStatus({ cwd: root, stdout: out2, stderr: err2 });
    assert.equal(code, 0);
    assert.ok(out2.buf.length > 0);
    assert.match(err2.buf, /could not record timing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("timings: false suppresses the checkbox path too, not just mark/implement", async () => {
  const { root, config, p } = await markProject();
  try {
    await setTimingsFalse(root);
    const disabledConfig = await loadConfig(root);
    assert.equal(disabledConfig.timings, false);

    await new Promise((r) => setTimeout(r, 20));
    await writeFile(
      path.join(p.outputDir, "auth-island.md"),
      "### From [[auth]]\n\n- [/] login\n  - [/] form\n",
      "utf8",
    );

    await syncCheckboxesAndPersistOrphans({
      outputDir: p.outputDir,
      treesDir: p.treesDir,
      statePath: p.state,
      markers: config.checkboxMarkers,
      timingsPath: p.timings,
      timingsEnabled: disabledConfig.timings,
    });

    assert.deepEqual((await readEvents(p.timings)).events, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- cmdTimings <target> argument-resolution error paths ---
//
// Coverage target: the same target-resolution shape `cmdCi` uses (parseTarget
// -> readTree -> resolveTargetNode -> pickMatch), reached from `timings
// <target>` instead. All four branches return before any report is written.

async function ambiguousTimingsProject() {
  const root = await mkdtemp(path.join(tmpdir(), "sf-timings-ambig-"));
  await writeDefaultConfig(root);
  const config = await loadConfig(root);
  const p = paths(root, config);
  await mkdir(p.outputDir, { recursive: true });
  await writeTree(p.treesDir, {
    spec: "auth",
    specPath: "docs/specs/auth.md",
    specHash: "sha256:x",
    features: [
      { name: "a", source: "heading", originalHeading: "## a", status: "todo", children: [leaf("dup")] },
      { name: "b", source: "heading", originalHeading: "## b", status: "todo", children: [leaf("dup")] },
    ],
  });
  return { root, config, p };
}

test("timings <target> with a malformed target (no spec/feature slash) exits 1 with the parseTarget error", async () => {
  const { root } = await markProject();
  try {
    const out = collector();
    const err = collector();
    const code = await cmdTimings({ cwd: root, args: ["bogus"], stdin: null, stdout: out, stderr: err });
    assert.equal(code, 1);
    assert.equal(err.buf, "bad target: bogus; expected <spec>/<feature-path>\n");
    assert.equal(out.buf, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("timings <target> naming a spec with no tree JSON exits 1 with 'spec not found'", async () => {
  const { root } = await markProject();
  try {
    const out = collector();
    const err = collector();
    const code = await cmdTimings({ cwd: root, args: ["nospec/foo"], stdin: null, stdout: out, stderr: err });
    assert.equal(code, 1);
    assert.equal(err.buf, "spec not found: nospec\n");
    assert.equal(out.buf, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("timings <target> that resolves to no node in the tree exits 1 with the resolve error", async () => {
  const { root } = await markProject();
  try {
    const out = collector();
    const err = collector();
    const code = await cmdTimings({ cwd: root, args: ["auth/nope"], stdin: null, stdout: out, stderr: err });
    assert.equal(code, 1);
    assert.match(err.buf, /feature not found: auth\/nope/);
    assert.equal(out.buf, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("timings <target> on an ambiguous single-name target aborts with exit 1 when declined (non-interactive stdin)", async () => {
  const { root } = await ambiguousTimingsProject();
  try {
    const out = collector();
    const err = collector();
    const code = await cmdTimings({ cwd: root, args: ["auth/dup"], stdin: null, stdout: out, stderr: err });
    assert.equal(code, 1);
    assert.match(err.buf, /ambiguous: "dup" matches 2 nodes:/);
    assert.match(err.buf, /auth\/a\/dup/);
    assert.match(err.buf, /auth\/b\/dup/);
    assert.match(err.buf, /aborted: ambiguous target\n$/);
    assert.equal(out.buf, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- §2.4 status cascades: downward `done`, and full paths on rollup ---
//
// Pure tree surgery, so no temp project is needed. What these pin down is the
// shape the recorder needs: every entry must carry a `fullPath` usable as an
// event `target` (§1.1), and a cascade that re-asserts a status must report
// nothing so the append stays idempotent.

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
  const leafNode = { name: "form", status: "in_progress", children: [] };
  const tree = {
    spec: "auth",
    features: [{ name: "login", status: "todo", children: [leafNode] }],
  };
  const changes = rollupAncestors(tree, leafNode);
  assert.deepEqual(changes.map((c) => [c.fullPath, c.from, c.to]), [["login", "todo", "in_progress"]]);
});
