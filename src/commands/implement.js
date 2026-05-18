import path from "node:path";
import { loadConfig } from "../config.js";
import { paths } from "../paths.js";
import { readIslands } from "../islands-io.js";
import { readTree, readAllTrees, isSubFeatureName, findParentTopLevel, findTopLevelFeature, topLevelNames, writeTree } from "../tree-io.js";
import { findIslandForFeature, buildAdjacency } from "../graph.js";
import { closestMatch } from "../kebab.js";
import { implementPrompt } from "../prompts.js";
import { syncCheckboxesAndPersistOrphans } from "../sync-helpers.js";

export async function cmdImplement({ cwd, args, stdout, stderr }) {
  const target = args.find((a) => !a.startsWith("--"));
  const noMark = args.includes("--no-mark");
  if (!target) {
    stderr.write("usage: specforest implement <spec>/<feature> [--no-mark]\n");
    return 1;
  }
  const [specName, featureName] = target.split("/");
  if (!specName || !featureName) {
    stderr.write(`bad target: ${target}; expected <spec>/<feature>\n`);
    return 1;
  }
  const config = await loadConfig(cwd);
  const p = paths(cwd, config);
  await syncCheckboxesAndPersistOrphans({ outputDir: p.outputDir, treesDir: p.treesDir, statePath: p.state, markers: config.checkboxMarkers });

  const islands = await readIslands(p.islands);
  if (!islands) {
    stderr.write("no islands.json yet; run `specforest sync` first\n");
    return 1;
  }

  const ownTree = await readTree(p.treesDir, specName);
  if (!ownTree) {
    stderr.write(`spec not found: ${specName}\n`);
    return 1;
  }

  const isSub = isSubFeatureName(ownTree, featureName);
  if (isSub) {
    const parent = findParentTopLevel(ownTree, featureName);
    stderr.write(`"${featureName}" is a sub-feature; implement its parent top-level feature${parent ? ` "${specName}/${parent}"` : ""}\n`);
    return 1;
  }

  const ownFeature = findTopLevelFeature(ownTree, featureName);
  if (!ownFeature) {
    const hint = closestMatch(featureName, topLevelNames(ownTree));
    stderr.write(`feature not found: ${specName}/${featureName}${hint ? `. did you mean "${specName}/${hint}"?` : ""}\n`);
    return 1;
  }
  if (ownFeature.status === "done") {
    stderr.write(`feature already done; run \`specforest mark ${specName}/${featureName} todo\` first to reopen\n`);
    return 1;
  }

  const island = findIslandForFeature(islands.islands, specName, featureName);
  if (!island) {
    stderr.write(`feature not present in any island (islands.json out of date?). run \`specforest sync\` first\n`);
    return 1;
  }

  const adj = buildAdjacency(island);
  const startKey = `${specName}/${featureName}`;
  const visited = new Set();
  const reachedOrder = [];
  const cycleNotes = [];
  const dfsStack = [];
  function dfs(node) {
    if (dfsStack.includes(node)) {
      const idx = dfsStack.indexOf(node);
      cycleNotes.push(dfsStack.slice(idx).concat(node).join(" → "));
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    dfsStack.push(node);
    for (const next of adj.get(node) || []) dfs(next);
    dfsStack.pop();
    if (node !== startKey) reachedOrder.push(node);
  }
  dfs(startKey);

  const allTrees = await readAllTrees(p.treesDir);
  const treesBySpec = new Map(allTrees.map((t) => [t.spec, t]));

  const prerequisites = [];
  const specsToReadSet = new Set([ownTree.specPath]);
  for (const key of reachedOrder) {
    const [s, f] = key.split("/");
    const t = treesBySpec.get(s);
    if (t) specsToReadSet.add(t.specPath);
    const node = t ? findTopLevelFeature(t, f) : null;
    prerequisites.push({ spec: s, feature: f, status: node ? node.status : "unknown" });
  }

  const hasUndone = prerequisites.some((p) => p.status !== "done");
  const specsToRead = [...specsToReadSet];

  const lines = [];
  lines.push("NEXT: implement");
  lines.push(`target: ${specName}/${featureName}`);
  if (!noMark) {
    lines.push(`target-status: ${ownFeature.status} → in_progress`);
  } else {
    lines.push(`target-status: ${ownFeature.status} (unchanged, --no-mark)`);
  }
  lines.push("specs-to-read:");
  for (const s of specsToRead) lines.push(`  - ${s}`);
  lines.push("prerequisites:");
  if (prerequisites.length === 0) {
    lines.push("  (none)");
  } else {
    for (const pr of prerequisites) {
      lines.push(`  - ${pr.spec}/${pr.feature}  [${pr.status}]${pr.status !== "done" ? "   ⚠ not done" : ""}`);
    }
  }
  if (cycleNotes.length) {
    lines.push("cycle-warning:");
    for (const c of cycleNotes) lines.push(`  - ${c}`);
  }
  lines.push("prompt: |");
  const prompt = implementPrompt({
    target: `${specName}/${featureName}`,
    specsToRead,
    prerequisites,
    hasUndonePrereqs: hasUndone,
  });
  for (const ln of prompt.split("\n")) lines.push(`  ${ln}`);

  stdout.write(lines.join("\n") + "\n");

  if (!noMark && ownFeature.status !== "in_progress") {
    ownFeature.status = "in_progress";
    await writeTree(p.treesDir, ownTree);
  }

  return 0;
}
