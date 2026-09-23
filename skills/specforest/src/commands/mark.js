import { loadConfig } from "../config.js";
import { paths } from "../paths.js";
import { readTree, writeTree } from "../tree-io.js";
import { STATUSES } from "../checkbox.js";
import { syncCheckboxesAndPersistOrphans } from "../sync-helpers.js";
import { regenAndWriteTreeCache } from "../tree-cache.js";
import { parseTarget, resolveTargetNode } from "../target.js";
import { rollupAncestors, cascadeDoneToDescendants } from "../rollup.js";
import { pickMatch } from "../disambiguate.js";
import { recordTransitions } from "../timings-io.js";

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
  await syncCheckboxesAndPersistOrphans({ outputDir: p.outputDir, treesDir: p.treesDir, statePath: p.state, markers: config.checkboxMarkers, timingsPath: p.timings, timingsEnabled: config.timings, stderr });
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
  // Key off the as-stored `tree.spec`, never the user-typed `specName`:
  // readTree resolves `${specName}.json` case-insensitively on Windows/macOS,
  // so a typed "AUTH/login" would record under "AUTH/login" while every reader
  // looks up "auth/login" — and a start typed in one case never closes against
  // a stop typed in another, leaving the interval open forever.
  const canonicalSpec = tree.spec;
  const previousStatus = resolved.node.status;
  // Spec §2.4: one cascade, collected in order — descendants, then the target,
  // then ancestors — so a `done` cascade closes the children's intervals before
  // the parent's own stop, and every crossing lands in a single append.
  const changes = [];
  if (state === "done") {
    changes.push(...cascadeDoneToDescendants(resolved.node, resolved.fullPath));
  }
  resolved.node.status = state;
  if (previousStatus !== state) {
    changes.push({ node: resolved.node, fullPath: resolved.fullPath, from: previousStatus, to: state });
  }
  const rolled = rollupAncestors(tree, resolved.node);
  changes.push(...rolled);
  await writeTree(p.treesDir, tree);
  // Append the event BEFORE regenerating the cache. The other order writes a
  // cache that knowingly omits the transition that caused it, leaving freshness
  // to rest entirely on isTreeCacheStale's strict `m > cacheMt`: if both writes
  // land in the same mtime tick the cache is judged fresh and the just-started
  // feature shows no "(running)" annotation until some unrelated write bumps an
  // input.
  try {
    await recordTransitions({
      enabled: config.timings,
      timingsPath: p.timings,
      changes: changes.map((c) => ({ ...c, fullPath: `${canonicalSpec}/${c.fullPath}` })),
      source: "cli",
    });
  } catch (e) {
    stderr.write(`warning: could not record timing: ${e.message}\n`);
  }
  try { await regenAndWriteTreeCache({ config, p, stderr }); } catch {}
  stdout.write(`marked ${canonicalSpec}/${resolved.fullPath} → ${state}\n`);
  for (const c of changes) {
    if (c.node === resolved.node) continue;
    if (rolled.includes(c)) continue;
    stdout.write(`cascade: ${canonicalSpec}/${c.fullPath} ${c.from} → ${c.to}\n`);
  }
  for (const r of rolled) {
    stdout.write(`rollup: ${canonicalSpec}/${r.name} ${r.from} → ${r.to}\n`);
  }
  return 0;
}
