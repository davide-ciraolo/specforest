import { readFile, writeFile, mkdir, readdir, unlink, stat } from "node:fs/promises";
import path from "node:path";
import { countLeaves, countFeatures, formatCounter } from "./counters.js";
import { renderCheckboxLine, parseCheckboxLine, buildMarkerToStatus } from "./checkbox.js";
import { findCycles } from "./graph.js";

export function buildForestStructure(islands, treesBySpec) {
  return {
    islands: islands.map((isl) => {
      const bySpec = new Map();
      for (const m of isl.members) {
        if (!treesBySpec.has(m.spec)) continue;
        if (!bySpec.has(m.spec)) bySpec.set(m.spec, new Set());
        bySpec.get(m.spec).add(m.feature);
      }
      const specs = [];
      for (const [specName, featureSet] of bySpec.entries()) {
        const fullTree = treesBySpec.get(specName);
        const filtered = fullTree.features.filter((f) => featureSet.has(f.name));
        specs.push({ spec: specName, tree: { ...fullTree, features: filtered }, dependencies: [] });
      }
      specs.sort((a, b) => a.spec.localeCompare(b.spec));
      return { id: isl.id, name: isl.name, specs, dependencies: isl.dependencies, raw: isl };
    }),
  };
}

function renderFeatureLines(node, markers, indent, lines) {
  const counter = countLeaves(node);
  const isLeaf = !node.children || node.children.length === 0;
  lines.push(
    renderCheckboxLine(
      node.name,
      node.status,
      markers,
      indent,
      isLeaf ? null : formatCounter(counter.done, counter.total),
    ),
  );
  for (const c of node.children || []) renderFeatureLines(c, markers, indent + 2, lines);
}

export function renderIslandMd(island, treesBySpec, markers, originalIsland) {
  const lines = [];
  lines.push(`# ${island.name}`);
  lines.push("");

  const totals = countFeatures(island.specs.flatMap((s) => s.tree.features));
  lines.push(formatCounter(totals.done, totals.total));
  lines.push("");

  lines.push("## Specs");
  for (const s of island.specs) {
    const tree = treesBySpec.get(s.spec);
    if (tree) {
      const basename = path.basename(tree.specPath, path.extname(tree.specPath));
      lines.push(`- [[${basename}]]`);
    }
  }
  lines.push("");

  lines.push("## Features");
  for (const s of island.specs) {
    const tree = treesBySpec.get(s.spec);
    const basename = tree ? path.basename(tree.specPath, path.extname(tree.specPath)) : s.spec;
    lines.push("");
    lines.push(`### From [[${basename}]]`);
    for (const f of s.tree.features) {
      renderFeatureLines(f, markers, 0, lines);
    }
  }
  lines.push("");

  if (originalIsland.dependencies.length) {
    lines.push("## Dependencies");
    for (const d of originalIsland.dependencies) {
      lines.push(`- ${d.from.spec}/${d.from.feature} → ${d.to.spec}/${d.to.feature} _(${d.kind}: ${d.reason})_`);
    }
    lines.push("");
  }

  const cycles = findCycles(originalIsland);
  if (cycles.length) {
    lines.push("## Warnings");
    for (const c of cycles) lines.push(`- ⚠ cycle: ${c.join(" → ")}`);
    lines.push("");
  }

  return lines.join("\n");
}

export function renderForestMd({ islands, treesBySpec, totals, timestamp }) {
  const lines = [];
  lines.push("# Forest");
  lines.push("");
  if (islands.length === 0) {
    lines.push("_no specs yet — add files to `specsDir` and run `specforest sync`_");
    lines.push("");
    return lines.join("\n");
  }
  const date = timestamp.split("T")[0];
  lines.push(`_Last sync: ${date} — ${islands.length} islands, ${totals.done}/${totals.total} features done_`);
  lines.push("");
  for (const isl of islands) {
    const islTotals = countFeatures(isl.specs.flatMap((s) => s.tree.features));
    const specCount = isl.specs.length;
    lines.push(`- [[${isl.name}]] — ${specCount} spec${specCount === 1 ? "" : "s"}, ${formatCounter(islTotals.done, islTotals.total)}`);
  }
  lines.push("");
  return lines.join("\n");
}

export async function syncCheckboxes(outputDir, treesDir, markers) {
  const mtos = buildMarkerToStatus(markers);
  let mdFiles;
  try {
    mdFiles = (await readdir(outputDir)).filter((f) => f.endsWith(".md") && f !== "forest.md");
  } catch (e) {
    if (e.code === "ENOENT") return { updated: [], warnings: [], orphans: [] };
    throw e;
  }

  const statusByFeature = new Map();
  const mdMtimeByKey = new Map();
  const warnings = [];

  for (const mdFile of mdFiles) {
    const mdPath = path.join(outputDir, mdFile);
    const mdStat = await stat(mdPath);
    const text = await readFile(mdPath, "utf8");
    let currentSpec = null;
    for (const line of text.split("\n")) {
      const headingMatch = /^### From \[\[(.+?)\]\]/.exec(line);
      if (headingMatch) {
        currentSpec = null;
        const basename = headingMatch[1];
        const treeFile = await locateTreeBySpecBasename(treesDir, basename);
        if (treeFile) currentSpec = treeFile;
        continue;
      }
      const parsed = parseCheckboxLine(line, mtos);
      if (!parsed) continue;
      if (parsed.unknown) {
        warnings.push(`unknown marker in ${mdFile} for ${parsed.name}`);
        continue;
      }
      if (!currentSpec) continue;
      const key = `${currentSpec}/${parsed.name}`;
      statusByFeature.set(key, parsed.status);
      mdMtimeByKey.set(key, mdStat.mtimeMs);
    }
  }

  const updated = [];
  const orphans = [];
  let treeFiles;
  try {
    treeFiles = (await readdir(treesDir)).filter((f) => f.endsWith(".json"));
  } catch (e) {
    if (e.code === "ENOENT") treeFiles = [];
    else throw e;
  }

  for (const f of treeFiles) {
    const fp = path.join(treesDir, f);
    const treeStat = await stat(fp);
    const raw = await readFile(fp, "utf8");
    const tree = JSON.parse(raw);
    let mutated = false;
    function visit(node) {
      const key = `${tree.spec}/${node.name}`;
      if (statusByFeature.has(key)) {
        // MD wins only if the MD file is newer than tree.json. Otherwise the tree.json
        // was just written by mark/implement and the MD is stale (pending re-render).
        const mdMtime = mdMtimeByKey.get(key) || 0;
        const adoptMd = mdMtime > treeStat.mtimeMs;
        const s = statusByFeature.get(key);
        if (adoptMd && node.status !== s) {
          node.status = s;
          mutated = true;
        }
        statusByFeature.delete(key);
      }
      for (const c of node.children || []) visit(c);
    }
    for (const tf of tree.features) visit(tf);
    if (mutated) {
      await writeFile(fp, JSON.stringify(tree, null, 2) + "\n", "utf8");
      updated.push(tree.spec);
    }
  }

  for (const [key, status] of statusByFeature.entries()) {
    orphans.push({ key, status });
  }

  return { updated, warnings, orphans };
}

async function locateTreeBySpecBasename(treesDir, basename) {
  let files;
  try {
    files = (await readdir(treesDir)).filter((f) => f.endsWith(".json"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
  for (const f of files) {
    const raw = await readFile(path.join(treesDir, f), "utf8");
    const t = JSON.parse(raw);
    const b = path.basename(t.specPath, path.extname(t.specPath));
    if (b === basename) return t.spec;
  }
  return null;
}

export async function writeRenderedOutputs({ outputDir, archiveIslandsDir, islands, treesBySpec, markers, timestamp, previousIslandNames }) {
  await mkdir(outputDir, { recursive: true });
  const built = buildForestStructure(islands, treesBySpec);

  for (const oldName of previousIslandNames) {
    if (built.islands.some((b) => b.name === oldName)) continue;
    const p = path.join(outputDir, `${oldName}.md`);
    try {
      const raw = await readFile(p);
      await mkdir(archiveIslandsDir, { recursive: true });
      const ts = timestamp.replace(/[:.]/g, "-");
      await writeFile(path.join(archiveIslandsDir, `${oldName}-${ts}.md`), raw);
      await unlink(p);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }

  for (const isl of built.islands) {
    const original = islands.find((i) => i.id === isl.id);
    const md = renderIslandMd(isl, treesBySpec, markers, original);
    await writeFile(path.join(outputDir, `${isl.name}.md`), md + "\n", "utf8");
  }

  const totals = countFeatures(
    built.islands.flatMap((isl) => isl.specs.flatMap((s) => s.tree.features)),
  );

  const forestMd = renderForestMd({ islands: built.islands, treesBySpec, totals, timestamp });
  await writeFile(path.join(outputDir, "forest.md"), forestMd + "\n", "utf8");

  return { built, totals };
}
