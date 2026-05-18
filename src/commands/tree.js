import { loadConfig } from "../config.js";
import { paths } from "../paths.js";
import { readIslands } from "../islands-io.js";
import { readAllTrees } from "../tree-io.js";
import { buildForestStructure } from "../render.js";
import { renderForestAscii, renderSingleSpecAscii, markerFn } from "../ascii.js";
import { syncCheckboxesAndPersistOrphans } from "../sync-helpers.js";

export async function cmdTree({ cwd, args, stdout, stderr }) {
  const config = await loadConfig(cwd);
  const p = paths(cwd, config);
  await syncCheckboxesAndPersistOrphans({ outputDir: p.outputDir, treesDir: p.treesDir, statePath: p.state, markers: config.checkboxMarkers });
  const islands = await readIslands(p.islands);
  if (!islands) {
    stderr.write("no islands.json yet; run `specforest sync` first\n");
    return 1;
  }
  const trees = await readAllTrees(p.treesDir);
  const treesBySpec = new Map(trees.map((t) => [t.spec, t]));
  const built = buildForestStructure(islands.islands, treesBySpec);
  const mfn = markerFn(config.checkboxMarkers);
  if (args[0]) {
    const ascii = renderSingleSpecAscii(args[0], built, mfn);
    if (!ascii) {
      stderr.write(`spec "${args[0]}" not found\n`);
      return 1;
    }
    stdout.write(ascii + "\n");
  } else {
    stdout.write(renderForestAscii(built, mfn) + "\n");
  }
  return 0;
}
