const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * Human-readable duration. Always two components (one below a minute) so
 * rendered columns stay narrow and comparable. Non-numeric, non-finite, and
 * non-positive input renders as "0s".
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

/**
 * Pair start/stop events into closed intervals. A start while one is already
 * open is ignored; a stop with nothing open is ignored; a trailing start
 * yields an open interval ending at `now`. Events whose `ts` does not parse
 * are skipped so one bad log line cannot destroy the surrounding history.
 */
export function pairIntervals(events, now) {
  const out = [];
  let openAt = null;
  let openEv = null;
  for (const e of events) {
    const ts = Date.parse(e.ts);
    if (!Number.isFinite(ts)) continue;
    if (e.event === "start") {
      if (openAt !== null) continue;
      openAt = ts;
      openEv = e;
    } else if (e.event === "stop") {
      if (openAt === null) continue;
      out.push({
        start: openAt,
        end: ts,
        ms: Math.max(0, ts - openAt),
        to: e.to || null,
        source: e.source || null,
        open: false,
      });
      openAt = null;
      openEv = null;
    }
  }
  if (openAt !== null) {
    out.push({
      start: openAt,
      end: now,
      ms: Math.max(0, now - openAt),
      to: null,
      source: openEv ? openEv.source || null : null,
      open: true,
    });
  }
  return out;
}

// At an identical timestamp an interval must be closed before a new one opens,
// otherwise the reopen is swallowed as "already open" and a real interval is
// silently lost. Ordering must not depend on the caller's array order.
const EVENT_ORDER = { stop: 0, ci: 1, start: 2 };

/**
 * Derive per-target totals from the raw event list. Nothing is pre-computed on
 * disk — every number here is recomputed from the log on each read. Events with
 * no target or an unparseable `ts` are skipped rather than allowed to poison
 * the arithmetic for the rest of that target.
 */
export function deriveTotals(events, now = Date.now()) {
  const byTarget = new Map();
  for (const e of events) {
    if (!e || !e.target) continue;
    if (!Number.isFinite(Date.parse(e.ts))) continue;
    if (!byTarget.has(e.target)) byTarget.set(e.target, []);
    byTarget.get(e.target).push(e);
  }
  const totals = new Map();
  for (const [target, evs] of byTarget) {
    evs.sort((a, b) => {
      const d = Date.parse(a.ts) - Date.parse(b.ts);
      if (d !== 0) return d;
      return (EVENT_ORDER[a.event] ?? 1) - (EVENT_ORDER[b.event] ?? 1);
    });
    const intervals = pairIntervals(
      evs.filter((e) => e.event === "start" || e.event === "stop"),
      now,
    );
    // `intervalMs` and `ciOutsideMs` are the two components `activeMs` is made
    // of, exposed separately because §1.3's aggregation treats them differently:
    // a node's own interval is suppressed when a descendant recorded one, while
    // its CI stays additive. `activeMs === intervalMs + ciOutsideMs` always
    // holds, so every consumer that only reads `activeMs` is unaffected.
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
    if (intervals.length > 0) {
      t.firstStart = intervals[0].start;
      t.lastEnd = intervals[intervals.length - 1].end;
      t.leadMs = Math.max(0, t.lastEnd - t.firstStart);
    }
    for (const e of evs) {
      if (e.event !== "ci") continue;
      const runMs = typeof e.ms === "number" && e.ms > 0 ? e.ms : 0;
      const ts = Date.parse(e.ts);
      t.ciMs += runMs;
      t.ciRuns.push({ ts, ms: runMs, cmd: e.cmd || "", exit: typeof e.exit === "number" ? e.exit : null });
      const inside = intervals.some((iv) => ts >= iv.start && ts <= iv.end);
      if (!inside) {
        t.ciOutsideMs += runMs;
        t.activeMs += runMs;
      }
    }
    // Same guard as the aggregate path's `finish()`: with activeMs === ciMs ===
    // Infinity the subtraction is NaN, and Math.max(0, NaN) is NaN — which
    // JSON.stringify emits as `null`, so the leaf and aggregate paths would
    // report different codingMs for identical data.
    const coding = t.activeMs - t.ciMs;
    t.codingMs = Number.isFinite(coding) ? Math.max(0, coding) : 0;
    totals.set(target, t);
  }
  return totals;
}

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
    // Own contributions are parked here rather than folded straight into
    // `activeMs`, because §1.3 cannot decide how much of a node's own record
    // counts until every child has been visited. `finish()` resolves them.
    ownIntervalMs: 0,
    ownCiOutsideMs: 0,
    ownCiMs: 0,
    descIntervalCount: 0,
  };
}

function spanIn(acc, firstStart, lastEnd) {
  if (firstStart !== null && (acc.firstStart === null || firstStart < acc.firstStart)) {
    acc.firstStart = firstStart;
  }
  if (lastEnd !== null && (acc.lastEnd === null || lastEnd > acc.lastEnd)) {
    acc.lastEnd = lastEnd;
  }
}

/**
 * The out-of-interval CI remainder, re-tested against the node's ancestors.
 *
 * `deriveTotals` can only compare a `ci` run to the intervals of its own
 * target, so a run on an untimed leaf during `implement <parent>` looks
 * "outside every interval" and gets folded into `activeMs` — while the
 * wall-clock it occupies already sits inside the parent's interval, which the
 * roll-up adds too. That reports the run twice. §1.2 folds a run in only to
 * stop it being unaccounted wall-clock, so a run an ancestor already covers
 * must not be folded.
 *
 * Falls back to the precomputed figure when there is nothing to re-test
 * against, which also keeps hand-built totals (no `ciRuns`) working.
 */
function ciOutsideOf(t, ancestorIntervals) {
  if (ancestorIntervals.length === 0 || !t.ciRuns || t.ciRuns.length === 0) return t.ciOutsideMs || 0;
  let outside = 0;
  for (const run of t.ciRuns) {
    const covered = (iv) => run.ts >= iv.start && run.ts <= iv.end;
    if ((t.intervals || []).some(covered)) continue;
    if (!ancestorIntervals.some(covered)) outside += run.ms;
  }
  return outside;
}

// Deliberately does NOT touch `acc.activeMs` — how much of this node's own
// record survives depends on whether a descendant recorded an interval, which
// is not known until every child has been added. `finish()` applies it.
function addOwn(acc, t, ancestorIntervals) {
  acc.ownIntervalMs += t.intervalMs || 0;
  acc.ownCiOutsideMs += ciOutsideOf(t, ancestorIntervals);
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
  // A child's aggregate interval count already includes its own descendants',
  // so this reaches arbitrary depth: any timed node anywhere below makes the
  // count non-zero.
  acc.descIntervalCount += a.intervalCount;
  if (a.open) acc.open = true;
  acc.intervalCount += a.intervalCount;
  acc.ciRunCount += a.ciRunCount;
  spanIn(acc, a.firstStart, a.lastEnd);
}

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

/**
 * Roll per-node totals up through one spec's tree under spec §1.3's
 * **descendants win** rule. Every node can carry its own records now — the
 * recorder times any node whose status crosses the `in_progress` boundary, at
 * any depth — and a parent's interval spans its descendants' by construction
 * under the §2.4 cascades, so the two overlap and cannot simply be added:
 *
 *   node.ciMs     = ownCiMs + Σ descendant.ciMs
 *   node.activeMs = Σ descendant.activeMs
 *                 + (descendantsTimed ? ownCiMs : ownIntervalMs + ownCiOutsideMs)
 *
 * Intervals and CI diverge because only intervals overlap: a `ci` event is
 * attributed to exactly one target and never nests inside another node's run,
 * so CI is additive at every level while a node's own interval counts only
 * when no descendant recorded one. A leaf has no descendants, so it always
 * takes the second branch — its figures are identical to the pre-amendment
 * behaviour.
 */
export function aggregateTree(tree, totals) {
  const out = new Map();
  const visit = (node, segs, ancestorIntervals) => {
    const path = [...segs, node.name];
    // Key construction assumes `/`-free segments; `validateFeature` /
    // `validateTree` already require kebab-case for `spec` and `name`, so a
    // segment containing `/` is unreachable.
    const key = `${tree.spec}/${path.join("/")}`;
    const acc = emptyAgg();
    const own = totals.get(key);
    if (own) addOwn(acc, own, ancestorIntervals);
    // Children are tested against this node's intervals too: `covering` is
    // every interval that could already account for a descendant's ci run.
    const covering = own && own.intervals && own.intervals.length > 0
      ? [...ancestorIntervals, ...own.intervals]
      : ancestorIntervals;
    for (const c of node.children || []) {
      addAgg(acc, visit(c, path, covering));
    }
    finish(acc);
    out.set(key, acc);
    return acc;
  };
  for (const f of tree.features) visit(f, [], []);
  return out;
}

/**
 * Aggregate the whole forest: per node, per island, and overall. `forest` is
 * summed over every tree's top-level features (not the islands), so it stays
 * correct when a feature isn't yet placed in any island, an island list is
 * empty, or `islands.json` is absent (`built.islands` is `null`) — matching
 * spec §6's requirement that forest-level totals still print in that case.
 * `byIsland` is a pure breakdown on top of that. Targets that match no node in
 * any tree are reported as orphans rather than silently dropped — they are
 * usually a feature that was renamed or deleted.
 */
export function aggregateForest(built, totals) {
  const byNode = new Map();
  for (const tree of built.trees) {
    for (const [k, v] of aggregateTree(tree, totals)) byNode.set(k, v);
  }
  const forest = emptyAgg();
  for (const tree of built.trees) {
    for (const f of tree.features) {
      const a = byNode.get(`${tree.spec}/${f.name}`);
      if (a) addAgg(forest, a);
    }
  }
  finish(forest);

  const byIsland = new Map();
  for (const isl of built.islands?.islands ?? []) {
    const acc = emptyAgg();
    for (const m of isl.members) {
      const a = byNode.get(`${m.spec}/${m.feature}`);
      if (a) addAgg(acc, a);
    }
    finish(acc);
    byIsland.set(isl.name, acc);
  }
  const orphans = [];
  for (const key of totals.keys()) {
    if (!byNode.has(key)) orphans.push(key);
  }
  orphans.sort((a, b) => a.localeCompare(b));
  return { forest, byIsland, byNode, orphans };
}

/**
 * True when an aggregate has real recorded time worth displaying. Single
 * suppression rule shared by the §4.2 `status` suffix and the §4.3 tree
 * annotation — the two formats differ, the rule must not. `activeMs` can be
 * `Infinity` from an unmutated log (`JSON.parse("1e999") === Infinity` passes
 * deriveTotals's `ms > 0` filter), which must suppress just like zero/NaN —
 * an all-zero-looking suffix is exactly what the "suppressed entirely" rule
 * forbids.
 */
export function hasRecordedTime(agg) {
  return !!agg && Number.isFinite(agg.activeMs) && agg.activeMs > 0;
}

/**
 * Short suffix for tree/status lines. Empty when nothing was recorded, so
 * output for a project that never used timings stays byte-identical.
 */
export function formatAnnotation(agg) {
  if (!hasRecordedTime(agg)) return "";
  let s = formatDuration(agg.activeMs);
  if (Number.isFinite(agg.ciMs) && agg.ciMs > 0) s += ` (ci ${formatDuration(agg.ciMs)})`;
  if (agg.open) s += " (running)";
  return s;
}

/**
 * Builds the event for a status change, or null when no event is warranted.
 * Emits on any transition that crosses the in_progress boundary, at any depth —
 * there is no leaf condition (spec §2.1). The boundary test is the whole gate,
 * and it is also what keeps the §2.4 cascades idempotent: a cascade that
 * re-asserts a status a node already holds crosses nothing and writes nothing.
 */
export function transitionEvent({ from, to, source, target, ts }) {
  const wasIn = from === "in_progress";
  const isIn = to === "in_progress";
  if (wasIn === isIn) return null;
  return isIn
    ? { ts, event: "start", target, source }
    : { ts, event: "stop", target, to, source };
}
