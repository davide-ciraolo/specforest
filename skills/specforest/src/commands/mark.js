import { loadConfig } from "../config.js";
import { paths } from "../paths.js";
import { readTree, writeTree } from "../tree-io.js";
import { STATUSES } from "../checkbox.js";
import { syncCheckboxesAndPersistOrphans } from "../sync-helpers.js";
import { regenAndWriteTreeCache } from "../tree-cache.js";
import { parseTarget, resolveTargetNode } from "../target.js";
import { rollupAncestors } from "../rollup.js";
import { pickMatch } from "../disambiguate.js";

export async function cmdMark({ cwd, args, stdin, stdout, stderr }) {
  const target = args[0];
  const state = args[1];
  if (!target || !state) {
    stderr.write("usage: specforest mark <spec>/<feature-path> <state>\n");
    return 1;
  }
  if (!STATUSES.includes(state)) {
    stderr.write(`invalid state: ${state}. valid: ${STATUSES.join("|")}\n`);
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
  const tree = await readTree(p.treesDir, specName);
  if (!tree) {
    stderr.write(`spec not found: ${specName}\n`);
    return 1;
  }
  let resolved = resolveTargetNode(tree, segments);
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
  resolved.node.status = state;
  const rolled = rollupAncestors(tree, resolved.node);
  await writeTree(p.treesDir, tree);
  try { await regenAndWriteTreeCache({ config, p }); } catch {}
  stdout.write(`marked ${specName}/${resolved.fullPath} → ${state}\n`);
  for (const r of rolled) {
    stdout.write(`rollup: ${specName}/${r.name} ${r.from} → ${r.to}\n`);
  }
  return 0;
}
