import { readFile, writeFile, mkdir, stat, readdir } from "node:fs/promises";
import path from "node:path";
import { readIslands } from "./islands-io.js";
import { readAllTrees } from "./tree-io.js";
import { buildForestStructure } from "./render.js";
import { renderForestAscii, markerFn } from "./ascii.js";
import { syncCheckboxesAndPersistOrphans } from "./sync-helpers.js";

export async function renderFullTreeAscii({ config, p }) {
  await syncCheckboxesAndPersistOrphans({
    outputDir: p.outputDir,
    treesDir: p.treesDir,
    statePath: p.state,
    markers: config.checkboxMarkers,
  });
  const islands = await readIslands(p.islands);
  if (!islands) return null;
  const trees = await readAllTrees(p.treesDir);
  const treesBySpec = new Map(trees.map((t) => [t.spec, t]));
  const built = buildForestStructure(islands.islands, treesBySpec);
  const mfn = markerFn(config.checkboxMarkers);
  return renderForestAscii(built, mfn);
}

export async function readTreeCache(p) {
  try {
    return await readFile(p.treeCache, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

export async function writeTreeCache(p, content) {
  await mkdir(path.dirname(p.treeCache), { recursive: true });
  await writeFile(p.treeCache, content + (content.endsWith("\n") ? "" : "\n"), "utf8");
}

async function mtimeMs(filePath) {
  try {
    const s = await stat(filePath);
    return s.mtimeMs;
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

export async function isTreeCacheStale(p) {
  const cacheMt = await mtimeMs(p.treeCache);
  if (cacheMt == null) return true;

  const inputs = [p.islands, p.state, p.configResolved];
  let treeFiles = [];
  try {
    treeFiles = (await readdir(p.treesDir))
      .filter((f) => f.endsWith(".json"))
      .map((f) => path.join(p.treesDir, f));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  inputs.push(...treeFiles);
  let mdFiles = [];
  try {
    mdFiles = (await readdir(p.outputDir))
      .filter((f) => f.endsWith(".md"))
      .map((f) => path.join(p.outputDir, f));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  inputs.push(...mdFiles);

  for (const f of inputs) {
    const m = await mtimeMs(f);
    if (m != null && m > cacheMt) return true;
  }
  return false;
}

export async function regenAndWriteTreeCache({ config, p }) {
  const ascii = await renderFullTreeAscii({ config, p });
  if (ascii == null) return null;
  await writeTreeCache(p, ascii);
  return ascii;
}

function branchIndex(line) {
  const i = line.search(/[├└]── /);
  return i;
}

export function extractSpecBlockFromCache(cacheText, specName, markers) {
  const lines = cacheText.split("\n");
  const doneMark = `[${markers.done}]`;
  const counterRe = /\[\d+\/\d+\]$/;
  let currentIsland = null;
  let specIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const bc = branchIndex(line);
    if (bc === -1) continue;
    if (bc === 0) {
      const rest = line.slice(4);
      const m = /^(\S+)/.exec(rest);
      if (m) currentIsland = m[1];
    } else if (bc === 4) {
      const rest = line.slice(8).trim();
      if (rest === specName) {
        specIdx = i;
        break;
      }
    }
  }

  if (specIdx === -1) return null;

  const block = [];
  for (let i = specIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    const bc = branchIndex(line);
    if (bc === -1) break;
    if (bc < 8) break;
    block.push(line.slice(8));
  }

  let total = 0;
  let done = 0;
  for (const l of block) {
    if (counterRe.test(l.trimEnd())) continue;
    const m = /[├└]── (\[[^\]]\]) /.exec(l);
    if (!m) continue;
    total++;
    if (m[1] === doneMark) done++;
  }

  const header = currentIsland
    ? `${currentIsland} / ${specName} [${done}/${total}]`
    : `${specName} [${done}/${total}]`;
  return [header, ...block].join("\n");
}
