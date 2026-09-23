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
import { deriveTotals, aggregateTree, aggregateForest, formatDuration, hasRecordedTime } from "../timings.js";

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
  // A ci run that straddles a start/stop boundary is deliberately not
  // double-counted into activeMs (see deriveTotals's `inside` check) — but its
  // raw duration can still exceed the interval containing it, producing
  // ciMs > activeMs and a nonsensical >100%. Suppress the percentage in that
  // case rather than print e.g. "(3000%)"; the raw ci duration next to it is
  // still accurate. Design spec §1.2 documents this as an accepted approximation.
  // The finiteness checks are not redundant with `part > whole`: with
  // part === whole === Infinity both `whole <= 0` and `Infinity > Infinity` are
  // false, so Math.round(Infinity / Infinity * 100) leaked a literal "(NaN%)".
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0 || part > whole) return null;
  return Math.round((part / whole) * 100);
}

function summaryLine(agg, indent) {
  // Same suppression rule as the per-island lines below and as `status`'s
  // suffix: hasRecordedTime additionally rejects non-finite totals, which
  // `activeMs <= 0` lets through to be rendered as an all-zero line.
  if (!hasRecordedTime(agg)) return `${indent}(no time recorded)`;
  const p = pct(agg.ciMs, agg.activeMs);
  const ci = p == null ? formatDuration(agg.ciMs) : `${formatDuration(agg.ciMs)} (${p}%)`;
  return `${indent}active ${formatDuration(agg.activeMs)}   ci ${ci}   coding ${formatDuration(agg.codingMs)}   lead ${formatDuration(agg.leadMs)}${agg.open ? "   (running)" : ""}`;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * Strip the heavy per-node detail (`intervals`/`ciRuns`) from a raw totals
 * entry so orphan JSON output stays a summary, matching the per-node object
 * shape used everywhere else in this command's JSON output.
 */
function summarizeTotals(t) {
  if (!t) return { activeMs: 0, ciMs: 0, codingMs: 0, leadMs: 0, firstStart: null, lastEnd: null, open: false };
  const { intervals, ciRuns, ...rest } = t;
  return rest;
}

/** Zero-valued fallback for a per-node aggregate, shaped like `aggregateTree`'s
 * output. Used when a resolved target's key has no entry in the tree's
 * aggregate map, so a lookup miss renders as all-zeros rather than crashing
 * (text mode) or silently spreading `undefined` into the JSON output. */
function zeroNodeAgg() {
  return { activeMs: 0, ciMs: 0, codingMs: 0, leadMs: 0, firstStart: null, lastEnd: null, open: false, intervalCount: 0, ciRunCount: 0 };
}

function writeForestReport({ stdout, built, forestAgg, byIsland, orphans, totals, json }) {
  if (json) {
    stdout.write(JSON.stringify({
      forest: forestAgg,
      islands: built ? built.islands.map((isl) => ({ name: isl.name, ...byIsland.get(isl.name) })) : [],
      orphans: orphans.map((key) => ({ target: key, ...summarizeTotals(totals.get(key)) })),
    }, null, 2) + "\n");
    return;
  }

  if (!built) {
    // `built` is null only when islands.json is genuinely absent (`readIslands`
    // returned null on ENOENT) — an islands.json that exists but lists zero
    // islands still builds (to an empty `{ islands: [] }`) and falls into the
    // branch below, printing "forest: 0 islands, ..." like any other count.
    stdout.write("forest: (no islands.json yet; run `specforest sync` first)\n");
    stdout.write(summaryLine(forestAgg, "  ") + "\n");
  } else {
    const all = built.islands.flatMap((isl) => isl.specs.flatMap((s) => s.tree.features));
    const counts = countFeatures(all);
    // Counter formatting matches `status` (formatCounter) so the two surfaces
    // agree; the island count is read from `built`, not a separate `islands`
    // param — the two are always identical since `buildForestStructure` maps
    // 1:1 and preserves names.
    stdout.write(`forest: ${built.islands.length} islands, ${formatCounter(counts.done, counts.total)}\n`);
    stdout.write(summaryLine(forestAgg, "  ") + "\n");
    stdout.write("\n");
    const width = Math.max(0, ...built.islands.map((isl) => isl.name.length));
    for (const isl of built.islands) {
      const a = byIsland.get(isl.name);
      const name = isl.name.padEnd(width);
      if (!hasRecordedTime(a)) {
        stdout.write(`  ${name}  (no time recorded)\n`);
      } else {
        stdout.write(`  ${name}  active ${formatDuration(a.activeMs)}   ci ${formatDuration(a.ciMs)}   coding ${formatDuration(a.codingMs)}   lead ${formatDuration(a.leadMs)}${a.open ? "   (running)" : ""}\n`);
      }
    }
  }

  if (orphans.length > 0) {
    stdout.write("\n");
    stdout.write(`orphaned: ${plural(orphans.length, "target")} no longer in any tree — \`specforest timings --orphans\`\n`);
  }
}

function writeOrphanReport({ stdout, orphans, totals, json }) {
  if (json) {
    stdout.write(JSON.stringify({ orphans: orphans.map((key) => ({ target: key, ...summarizeTotals(totals.get(key)) })) }, null, 2) + "\n");
    return;
  }
  if (orphans.length === 0) {
    stdout.write("no orphaned timing targets\n");
    return;
  }
  stdout.write("orphaned targets (no longer in any tree):\n");
  const width = Math.max(0, ...orphans.map((key) => key.length));
  for (const key of orphans) {
    const a = totals.get(key) || { activeMs: 0, ciMs: 0, codingMs: 0 };
    stdout.write(`  ${key.padEnd(width)}  active ${formatDuration(a.activeMs)}   ci ${formatDuration(a.ciMs)}   coding ${formatDuration(a.codingMs)}\n`);
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

  if (own.intervals.length === 0 && own.ciRuns.length === 0) {
    // A non-leaf's header numbers come from `agg` (rolled up through
    // aggregateTree from descendants), but `own` — this node's own records —
    // is always empty for a node that never itself recorded a start/stop or
    // ci run. Without this note the header prints real numbers with no
    // detail sections below, and a reader can't tell "no detail exists" from
    // "detail was dropped by a bug".
    if (agg.activeMs > 0) {
      stdout.write("\n(figures rolled up from descendants — this node has no timing records of its own)\n");
    }
  } else {
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
}

export async function cmdTimings({ cwd, args, stdin, stdout, stderr }) {
  const json = args.includes("--json");
  const orphansOnly = args.includes("--orphans");
  // `-` rather than `--`, matching `ci`'s own-arg scan: otherwise `-v` is
  // parsed as the target and reported as "bad target: -v".
  const target = args.find((a) => !a.startsWith("-"));

  // `--orphans` is a forest-wide report and the `target` branch below returns
  // before ever reaching it, so the combination silently dropped the flag and
  // handed back a node report — from which a user reasonably concludes there
  // are no orphans. Rejected here, before any IO.
  if (target && orphansOnly) {
    stderr.write("--orphans cannot be combined with a target\n");
    return 1;
  }

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
    stderr,
  });

  let events, warnings;
  try {
    ({ events, warnings } = await readEvents(p.timings));
  } catch (e) {
    // Deliberately different from the write path (ci/mark/sync degrade to a
    // stderr warning and carry on, because timing is an add-on there that
    // must never take the core operation down). Here the log IS the
    // operation: silently reporting zeros for an unreadable log would be
    // misleading, so fail cleanly with exit 1 instead of a raw stack trace.
    stderr.write(`could not read timings log: ${e.message}\n`);
    return 1;
  }
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
    // Build the key from tree.spec, not the user-typed specName: readTree
    // resolves ${specName}.json case-insensitively on Windows/macOS, so a
    // typed "AUTH/login" would otherwise desync from aggregateTree's
    // `${tree.spec}/...` keys (always lowercase-as-stored) and silently miss.
    const key = `${tree.spec}/${resolved.fullPath}`;
    const agg = aggregateTree(tree, totals).get(key) || zeroNodeAgg();
    const own = totals.get(key) || { intervals: [], ciRuns: [] };
    writeNodeReport({ stdout, target: key, status: resolved.node.status, agg, own, json });
    return 0;
  }

  const islands = await readIslands(p.islands);
  const trees = await readAllTrees(p.treesDir);
  const treesBySpec = new Map(trees.map((t) => [t.spec, t]));
  // `islands` (not `islands && islands.islands.length > 0`): an islands.json
  // that exists but lists zero islands still builds — to `{ islands: [] }` —
  // and is displayed as a normal (empty) forest. Only a genuinely absent
  // islands.json (readIslands returned null) takes the "no islands.json yet"
  // branch in writeForestReport.
  const built = islands ? buildForestStructure(islands.islands, treesBySpec) : null;
  const { forest, byIsland, orphans } = aggregateForest({ trees, islands }, totals);

  if (orphansOnly) {
    writeOrphanReport({ stdout, orphans, totals, json });
    return 0;
  }
  writeForestReport({ stdout, built, forestAgg: forest, byIsland, orphans, totals, json });
  return 0;
}
