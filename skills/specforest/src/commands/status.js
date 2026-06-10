import { loadConfig } from "../config.js";
import { paths } from "../paths.js";
import { readIslands } from "../islands-io.js";
import { readAllTrees } from "../tree-io.js";
import { countFeatures, formatCounter } from "../counters.js";
import { buildForestStructure } from "../render.js";
import { syncCheckboxesAndPersistOrphans } from "../sync-helpers.js";

export async function cmdStatus({ cwd, stdout, stderr }) {
  const config = await loadConfig(cwd);
  const p = paths(cwd, config);
  await syncCheckboxesAndPersistOrphans({ outputDir: p.outputDir, treesDir: p.treesDir, statePath: p.state, markers: config.checkboxMarkers });
  const islands = await readIslands(p.islands);
  const trees = await readAllTrees(p.treesDir);
  const treesBySpec = new Map(trees.map((t) => [t.spec, t]));
  if (!islands || islands.islands.length === 0) {
    stdout.write("no islands yet\n");
    return 0;
  }
  const built = buildForestStructure(islands.islands, treesBySpec);
  const total = countFeatures(built.islands.flatMap((isl) => isl.specs.flatMap((s) => s.tree.features)));
  stdout.write(`forest: ${islands.islands.length} islands, ${formatCounter(total.done, total.total)}\n`);
  for (const isl of built.islands) {
    const c = countFeatures(isl.specs.flatMap((s) => s.tree.features));
    stdout.write(`  ${isl.name}: ${formatCounter(c.done, c.total)} (${isl.specs.length} spec${isl.specs.length === 1 ? "" : "s"})\n`);
  }
  return 0;
}
