import { loadConfig } from "../config.js";
import { paths } from "../paths.js";
import { validateIslands, ValidationError } from "../validation.js";
import { readIslands, writeIslands, reconcileIds } from "../islands-io.js";
import { readAllTrees, structuralFingerprint } from "../tree-io.js";
import { syncCheckboxesAndPersistOrphans } from "../sync-helpers.js";
import { updateState } from "../state.js";
import { regenAndWriteTreeCache } from "../tree-cache.js";

async function readAllStdin(stdin) {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

export async function cmdCommitIslands({ cwd, stdin, stdout, stderr }) {
  const config = await loadConfig(cwd);
  const p = paths(cwd, config);
  await syncCheckboxesAndPersistOrphans({ outputDir: p.outputDir, treesDir: p.treesDir, statePath: p.state, markers: config.checkboxMarkers });

  const raw = await readAllStdin(stdin);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    stderr.write(`invalid JSON on stdin: ${e.message}\n`);
    return 1;
  }

  try {
    validateIslands(parsed);
  } catch (e) {
    if (e instanceof ValidationError) {
      stderr.write(`validation error: ${e.message}\n`);
      return 1;
    }
    throw e;
  }

  const trees = await readAllTrees(p.treesDir);
  const known = new Set();
  for (const t of trees) for (const f of t.features) known.add(`${t.spec}/${f.name}`);
  const referenced = new Set();
  for (const isl of parsed.islands) {
    for (const m of isl.members) referenced.add(`${m.spec}/${m.feature}`);
    for (const d of isl.dependencies) {
      referenced.add(`${d.from.spec}/${d.from.feature}`);
      referenced.add(`${d.to.spec}/${d.to.feature}`);
    }
  }
  const missing = [...referenced].filter((k) => !known.has(k));
  if (missing.length) {
    stderr.write("ERROR: islands reference unknown top-level features:\n");
    for (const m of missing) stderr.write(`  - ${m}\n`);
    return 1;
  }
  const islandedMembers = new Set();
  for (const isl of parsed.islands) for (const m of isl.members) islandedMembers.add(`${m.spec}/${m.feature}`);
  const uncovered = [...known].filter((k) => !islandedMembers.has(k));
  if (uncovered.length) {
    stderr.write("ERROR: top-level features missing from islands.members (every top-level feature must belong to exactly one island):\n");
    for (const u of uncovered) stderr.write(`  - ${u}\n`);
    return 1;
  }
  const memberKeys = [...islandedMembers];
  const memberSet = new Set();
  for (const isl of parsed.islands) {
    for (const m of isl.members) {
      const k = `${m.spec}/${m.feature}`;
      if (memberSet.has(k)) {
        stderr.write(`ERROR: feature ${k} appears in multiple islands\n`);
        return 1;
      }
      memberSet.add(k);
    }
  }

  const prev = await readIslands(p.islands);
  const reconciled = reconcileIds(parsed.islands, prev);
  const out = { generatedAt: parsed.generatedAt || new Date().toISOString(), islands: reconciled };
  await writeIslands(p.islands, out);
  const structHash = structuralFingerprint(trees);
  await updateState(p.state, (s) => { s.lastClusteredStructure = structHash; });
  try { await regenAndWriteTreeCache({ config, p }); } catch {}
  stdout.write(`committed ${reconciled.length} island(s); covered ${memberKeys.length} top-level features\n`);
  return 0;
}
