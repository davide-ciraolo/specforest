import { mkdir } from "node:fs/promises";
import { loadConfig } from "../config.js";
import { paths } from "../paths.js";
import { readIslands } from "../islands-io.js";
import { readAllTrees } from "../tree-io.js";
import { writeRenderedOutputs } from "../render.js";
import { updateState, readState } from "../state.js";
import { syncCheckboxesAndPersistOrphans } from "../sync-helpers.js";

export async function cmdRender({ cwd, stdout, stderr }) {
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
  const state = await readState(p.state);
  const previousNames = state.previousIslandNames || [];
  await mkdir(p.outputDir, { recursive: true });
  const now = new Date().toISOString();
  await writeRenderedOutputs({
    outputDir: p.outputDir,
    archiveIslandsDir: p.archiveIslands,
    islands: islands.islands,
    treesBySpec,
    markers: config.checkboxMarkers,
    timestamp: now,
    previousIslandNames: previousNames,
  });
  await updateState(p.state, (s) => {
    s.lastRender = now;
    s.previousIslandNames = islands.islands.map((i) => i.name);
    const map = {};
    for (const isl of islands.islands) map[isl.id] = isl.members.map((m) => `${m.spec}/${m.feature}`);
    s.islandIdMap = map;
  });
  stdout.write(`rendered: ${p.outputDir}\n`);
  return 0;
}
