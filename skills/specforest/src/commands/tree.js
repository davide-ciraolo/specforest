import path from "node:path";
import { loadConfig } from "../config.js";
import { paths } from "../paths.js";
import { readIslands } from "../islands-io.js";
import { readAllTrees } from "../tree-io.js";
import { buildForestStructure } from "../render.js";
import { renderSingleSpecAscii, markerFn } from "../ascii.js";
import { syncCheckboxesAndPersistOrphans } from "../sync-helpers.js";
import {
  readTreeCache,
  writeTreeCache,
  isTreeCacheStale,
  regenAndWriteTreeCache,
  extractSpecBlockFromCache,
} from "../tree-cache.js";

export async function cmdTree({ cwd, args, stdout, stderr }) {
  const config = await loadConfig(cwd);
  const p = paths(cwd, config);
  const regenerate = args.includes("--regenerate");
  const print = args.includes("--print");
  const specArg = args.find((a) => !a.startsWith("--"));

  if (specArg) {
    const cached = await readTreeCache(p);
    if (cached && !regenerate && !(await isTreeCacheStale(p))) {
      const sliced = extractSpecBlockFromCache(cached, specArg, config.checkboxMarkers);
      if (sliced != null) {
        stdout.write(sliced + "\n");
        return 0;
      }
    }
    await syncCheckboxesAndPersistOrphans({
      outputDir: p.outputDir,
      treesDir: p.treesDir,
      statePath: p.state,
      markers: config.checkboxMarkers,
    });
    const islands = await readIslands(p.islands);
    if (!islands) {
      stderr.write("no islands.json yet; run `specforest sync` first\n");
      return 1;
    }
    const trees = await readAllTrees(p.treesDir);
    const treesBySpec = new Map(trees.map((t) => [t.spec, t]));
    const built = buildForestStructure(islands.islands, treesBySpec);
    const ascii = renderSingleSpecAscii(specArg, built, markerFn(config.checkboxMarkers));
    if (!ascii) {
      stderr.write(`spec "${specArg}" not found\n`);
      return 1;
    }
    stdout.write(ascii + "\n");
    return 0;
  }

  let ascii;
  if (!regenerate) {
    const cached = await readTreeCache(p);
    if (cached && !(await isTreeCacheStale(p))) {
      ascii = cached;
    }
  }
  if (ascii == null) {
    ascii = await regenAndWriteTreeCache({ config, p });
    if (ascii == null) {
      stderr.write("no islands.json yet; run `specforest sync` first\n");
      return 1;
    }
  }

  if (print) {
    stdout.write(ascii.endsWith("\n") ? ascii : ascii + "\n");
    return 0;
  }

  const rel = (path.relative(cwd, p.treeCache) || p.treeCache).split(path.sep).join("/");
  const lines = [
    "NEXT: read",
    `path: ${rel}`,
    "hint: run `specforest status` for island counters; pass --print to dump ASCII to stdout",
  ];
  stdout.write(lines.join("\n") + "\n");
  return 0;
}
