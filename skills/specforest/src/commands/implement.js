import { loadConfig } from "../config.js";
import { paths } from "../paths.js";
import { readIslands } from "../islands-io.js";
import { readTree, readAllTrees, findTopLevelFeature, writeTree } from "../tree-io.js";
import { findIslandForFeature, buildAdjacency } from "../graph.js";
import { implementPrompt } from "../prompts.js";
import { syncCheckboxesAndPersistOrphans } from "../sync-helpers.js";
import { regenAndWriteTreeCache } from "../tree-cache.js";
import { parseTarget, resolveTargetNode } from "../target.js";
import { rollupAncestors } from "../rollup.js";
import { pickMatch } from "../disambiguate.js";

export async function cmdImplement({ cwd, args, stdin, stdout, stderr }) {
  const target = args.find((a) => !a.startsWith("--"));
  const noMark = args.includes("--no-mark");
  if (!target) {
    stderr.write("usage: specforest implement <spec>/<feature-path> [--no-mark]\n");
    return 1;
  }
  const parsed = parseTarget(target);
  if (parsed.error) {
    stderr.write(`${parsed.error}\n`);
    return 1;
  }
  const { spec: specName, segments } = parsed;
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

  let resolved = resolveTargetNode(ownTree, segments);
  if (resolved.error) {
    stderr.write(`${resolved.error}\n`);
    return 1;
  }
  if (resolved.ambiguous) {
    const picked = await pickMatch({ spec: specName, name: segments[segments.length - 1], matches: resolved.matches, stdin, stdout, stderr });
    if (!picked) {
      stderr.write(`aborted: ambiguous target\n`);
      return 1;
    }
    resolved = picked;
  }

  const targetNode = resolved.node;
  const topLevel = resolved.topLevel;
  const fullPath = resolved.fullPath;

  if (targetNode.status === "done") {
    stderr.write(`feature already done; run \`specforest mark ${specName}/${fullPath} todo\` first to reopen\n`);
    return 1;
  }

  const island = findIslandForFeature(islands.islands, specName, topLevel.name);
  if (!island) {
    stderr.write(`feature not present in any island (islands.json out of date?). run \`specforest sync\` first\n`);
    return 1;
  }

  const adj = buildAdjacency(island);
  const startKey = `${specName}/${topLevel.name}`;
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

  const hasUndone = prerequisites.some((pr) => pr.status !== "done");
  const specsToRead = [...specsToReadSet];

  const fullTarget = `${specName}/${fullPath}`;
  const lines = [];
  lines.push("NEXT: implement");
  lines.push(`target: ${fullTarget}`);
  if (!noMark) {
    lines.push(`target-status: ${targetNode.status} → in_progress`);
  } else {
    lines.push(`target-status: ${targetNode.status} (unchanged, --no-mark)`);
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
    target: fullTarget,
    specsToRead,
    prerequisites,
    hasUndonePrereqs: hasUndone,
  });
  for (const ln of prompt.split("\n")) lines.push(`  ${ln}`);

  let rolled = [];
  if (!noMark && targetNode.status !== "in_progress") {
    targetNode.status = "in_progress";
    rolled = rollupAncestors(ownTree, targetNode);
    await writeTree(p.treesDir, ownTree);
    try { await regenAndWriteTreeCache({ config, p }); } catch {}
  }

  stdout.write(lines.join("\n") + "\n");
  for (const r of rolled) {
    stdout.write(`rollup: ${specName}/${r.name} ${r.from} → ${r.to}\n`);
  }

  return 0;
}
