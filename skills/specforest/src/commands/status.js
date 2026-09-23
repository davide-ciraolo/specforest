import { loadConfig } from "../config.js";
import { paths } from "../paths.js";
import { readIslands } from "../islands-io.js";
import { readAllTrees } from "../tree-io.js";
import { countFeatures, formatCounter } from "../counters.js";
import { buildForestStructure } from "../render.js";
import { syncCheckboxesAndPersistOrphans } from "../sync-helpers.js";
import { loadForestTimingAggregates } from "../timings-aggregate.js";
import { formatDuration, hasRecordedTime } from "../timings.js";

/** Suffix for one status line. Empty when nothing was recorded, so output stays as before. */
function suffix(agg) {
  if (!hasRecordedTime(agg)) return "";
  const running = agg.open ? " (running)" : "";
  return `  active ${formatDuration(agg.activeMs)} (ci ${formatDuration(agg.ciMs)} / code ${formatDuration(agg.codingMs)})${running}`;
}

export async function cmdStatus({ cwd, stdout, stderr }) {
  const config = await loadConfig(cwd);
  const p = paths(cwd, config);
  await syncCheckboxesAndPersistOrphans({ outputDir: p.outputDir, treesDir: p.treesDir, statePath: p.state, markers: config.checkboxMarkers, timingsPath: p.timings, timingsEnabled: config.timings, stderr });
  const islands = await readIslands(p.islands);
  const trees = await readAllTrees(p.treesDir);
  const treesBySpec = new Map(trees.map((t) => [t.spec, t]));
  if (!islands || islands.islands.length === 0) {
    stdout.write("no islands yet\n");
    return 0;
  }
  const built = buildForestStructure(islands.islands, treesBySpec);

  // Unlike `timings` (where the log IS the operation and an unreadable log
  // fails the command), here the counters are the operation and timing is
  // decoration — status must still print its normal output on a bad log
  // (mirrors the write path's own "add-on, never fatal" convention: see
  // `syncCheckboxesAndPersistOrphans`'s `appendEvents` catch in
  // src/sync-helpers.js). Guarding + aggregation is shared with `tree` via
  // `loadForestTimingAggregates` (src/timings-aggregate.js); this caller asks
  // for `forwardWarnings: true` since status is the one place a malformed
  // log line gets surfaced to the user.
  const agg = await loadForestTimingAggregates({ config, p, trees, islands, stderr, forwardWarnings: true });
  const forestAgg = agg ? agg.forest : null;
  const byIsland = agg ? agg.byIsland : new Map();

  const total = countFeatures(built.islands.flatMap((isl) => isl.specs.flatMap((s) => s.tree.features)));
  stdout.write(`forest: ${islands.islands.length} islands, ${formatCounter(total.done, total.total)}${suffix(forestAgg)}\n`);
  for (const isl of built.islands) {
    const c = countFeatures(isl.specs.flatMap((s) => s.tree.features));
    stdout.write(`  ${isl.name}: ${formatCounter(c.done, c.total)} (${isl.specs.length} spec${isl.specs.length === 1 ? "" : "s"})${suffix(byIsland.get(isl.name))}\n`);
  }
  return 0;
}
