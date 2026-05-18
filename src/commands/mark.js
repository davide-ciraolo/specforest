import { loadConfig } from "../config.js";
import { paths } from "../paths.js";
import { readTree, writeTree, isSubFeatureName, findParentTopLevel } from "../tree-io.js";
import { STATUSES } from "../checkbox.js";
import { syncCheckboxesAndPersistOrphans } from "../sync-helpers.js";
import { closestMatch } from "../kebab.js";

function visit(node, fn) {
  fn(node);
  for (const c of node.children || []) visit(c, fn);
}

export async function cmdMark({ cwd, args, stdout, stderr }) {
  const target = args[0];
  const state = args[1];
  if (!target || !state) {
    stderr.write("usage: specforest mark <spec>/<feature> <state>\n");
    return 1;
  }
  if (!STATUSES.includes(state)) {
    stderr.write(`invalid state: ${state}. valid: ${STATUSES.join("|")}\n`);
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
  const tree = await readTree(p.treesDir, specName);
  if (!tree) {
    stderr.write(`spec not found: ${specName}\n`);
    return 1;
  }
  let target_node = null;
  for (const f of tree.features) visit(f, (n) => { if (n.name === featureName) target_node = n; });
  if (!target_node) {
    const all = [];
    for (const f of tree.features) visit(f, (n) => all.push(n.name));
    const hint = closestMatch(featureName, all);
    stderr.write(`feature not found: ${specName}/${featureName}${hint ? `. did you mean "${specName}/${hint}"?` : ""}\n`);
    return 1;
  }
  target_node.status = state;
  await writeTree(p.treesDir, tree);
  stdout.write(`marked ${specName}/${featureName} → ${state}\n`);
  return 0;
}
