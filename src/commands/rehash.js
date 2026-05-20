import { loadConfig } from "../config.js";
import { paths } from "../paths.js";
import { findSpecs, specNameFromRel } from "../glob.js";
import { sha256File } from "../hash.js";
import { readState, writeState } from "../state.js";
import { readTree, writeTree } from "../tree-io.js";

export async function cmdRehash({ cwd, args, stdout, stderr }) {
  const dryRun = args.includes("--dry-run");
  const config = await loadConfig(cwd);
  const p = paths(cwd, config);

  const state = await readState(p.state);
  const specFiles = await findSpecs(p.specsDir, config.specsGlob, config.ignore);

  const rows = [];
  for (const f of specFiles) {
    const name = specNameFromRel(f.rel);
    const newHash = await sha256File(f.abs);
    const oldHash = state.specHashes[name] ?? null;
    const tree = await readTree(p.treesDir, name);
    const treeOld = tree?.specHash ?? null;
    const stateChange = oldHash !== newHash;
    const treeChange = tree != null && treeOld !== newHash;
    rows.push({ name, oldHash, newHash, stateChange, treeChange, tree });
  }

  const changed = rows.filter((r) => r.stateChange || r.treeChange);
  const orphans = Object.keys(state.specHashes).filter(
    (n) => !rows.some((r) => r.name === n),
  );

  stdout.write(`specforest rehash — ${dryRun ? "DRY RUN" : "APPLY"}\n`);
  stdout.write(`specs scanned: ${rows.length}\n`);
  stdout.write(`hashes to update: ${changed.length}\n`);
  if (orphans.length) {
    stderr.write(
      `WARNING: state hashes with no matching spec file: ${orphans.join(", ")}\n`,
    );
  }
  for (const r of changed) {
    const o = r.oldHash ? r.oldHash.slice(7, 19) : "—";
    const n = r.newHash.slice(7, 19);
    stdout.write(`  ${r.name}: ${o} → ${n}\n`);
  }

  if (changed.length === 0) {
    stdout.write("nothing to do.\n");
    return 0;
  }
  if (dryRun) {
    stdout.write("dry run — no files written.\n");
    return 0;
  }

  for (const r of changed) {
    if (r.tree && r.treeChange) {
      await writeTree(p.treesDir, { ...r.tree, specHash: r.newHash });
    }
  }
  const newState = {
    ...state,
    specHashes: { ...state.specHashes },
  };
  for (const r of changed) {
    if (r.stateChange) newState.specHashes[r.name] = r.newHash;
  }
  await writeState(p.state, newState);
  stdout.write(`updated ${changed.length} spec hash(es).\n`);
  return 0;
}
