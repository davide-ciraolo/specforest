import { readFile, writeFile, mkdir, stat, readdir } from "node:fs/promises";
import path from "node:path";
import { readIslands } from "./islands-io.js";
import { readAllTrees } from "./tree-io.js";
import { buildForestStructure } from "./render.js";
import { renderForestAscii, markerFn } from "./ascii.js";
import { syncCheckboxesAndPersistOrphans } from "./sync-helpers.js";
import { readEvents } from "./timings-io.js";
import { deriveTotals, formatAnnotation } from "./timings.js";
import { loadForestTimingAggregates } from "./timings-aggregate.js";

/**
 * Builds the annotate(key) callback consumed by src/ascii.js.
 * Keys: "island:<name>" and "<spec>/<seg>/<seg>". Returns "" when nothing was recorded.
 *
 * Unlike the `timings` command (where the log IS the operation and an unreadable
 * log exits 1), the tree render is the operation here and timing is decoration —
 * an unreadable log degrades to an unannotated tree rather than taking the render
 * down. Guarding + aggregation is shared with `status` via
 * `loadForestTimingAggregates` (src/timings-aggregate.js); this caller passes
 * `forwardWarnings: false` — `status` and `timings` already surface
 * malformed-line warnings, and repeating them on every mark/sync (which
 * regenerate the cache in the background) would be noise.
 */
export async function buildTimingAnnotator({ config, p, trees, islands, stderr }) {
  const agg = await loadForestTimingAggregates({ config, p, trees, islands, stderr, forwardWarnings: false });
  if (!agg) return () => "";
  const { byIsland, byNode } = agg;
  return (key) => {
    const a = key.startsWith("island:") ? byIsland.get(key.slice("island:".length)) : byNode.get(key);
    return formatAnnotation(a);
  };
}

export async function renderFullTreeAscii({ config, p, stderr }) {
  await syncCheckboxesAndPersistOrphans({
    outputDir: p.outputDir,
    treesDir: p.treesDir,
    statePath: p.state,
    markers: config.checkboxMarkers,
    timingsPath: p.timings,
    timingsEnabled: config.timings,
    stderr,
  });
  const islands = await readIslands(p.islands);
  if (!islands) return null;
  const trees = await readAllTrees(p.treesDir);
  const treesBySpec = new Map(trees.map((t) => [t.spec, t]));
  const built = buildForestStructure(islands.islands, treesBySpec);
  const mfn = markerFn(config.checkboxMarkers);
  const annotate = await buildTimingAnnotator({ config, p, trees, islands, stderr });
  return renderForestAscii(built, mfn, annotate);
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

/**
 * `config` is optional so existing mtime-only callers keep working; passing it
 * additionally checks for an OPEN timing interval (see below).
 */
export async function isTreeCacheStale(p, config) {
  const cacheMt = await mtimeMs(p.treeCache);
  if (cacheMt == null) return true;

  const inputs = [p.islands, p.state, p.configResolved, p.timings];
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

  // The cache can be mtime-fresh yet still render a stale wall-clock-derived
  // "(running)" duration: an OPEN interval has no new input file to trigger
  // the mtime checks above (nothing more is written to timings.jsonl while a
  // feature just sits `in_progress`), so its elapsed time silently drifts out
  // of sync with the frozen cache. Only checked when timings are enabled —
  // a `timings: false` project must never pay this extra read, and must never
  // be invalidated by an open interval left behind in an old log (e.g. from
  // before timings was turned off).
  if (config?.timings) {
    let events = null;
    try {
      ({ events } = await readEvents(p.timings));
    } catch {
      events = null; // degrade to the mtime-only answer already computed above
    }
    if (events && events.length > 0) {
      for (const t of deriveTotals(events).values()) {
        if (t.open) return true;
      }
    }
  }

  return false;
}

export async function regenAndWriteTreeCache({ config, p, stderr }) {
  const ascii = await renderFullTreeAscii({ config, p, stderr });
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
  // De-anchored on purpose: parent lines may carry a timing suffix after the [d/N]
  // counter. Leaf lines never contain a [d/N] group — their marker is a single char.
  const counterRe = /\[\d+\/\d+\]/;
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
