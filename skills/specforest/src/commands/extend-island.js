import { loadConfig } from "../config.js";
import { paths } from "../paths.js";
import { validateIslands, ValidationError } from "../validation.js";
import { readIslands, writeIslands } from "../islands-io.js";
import { readAllTrees } from "../tree-io.js";
import { syncCheckboxesAndPersistOrphans } from "../sync-helpers.js";
import { regenAndWriteTreeCache } from "../tree-cache.js";

async function readAllStdin(stdin) {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const USAGE = `usage: specforest extend-island <id-or-name>   (stdin: extension JSON)

Appends members (and optional intra-island dependencies) to a SINGLE existing
island. All other islands stay byte-identical.

Stdin schema:
  {
    "addMembers": [
      { "spec": "<spec-kebab>", "feature": "<top-level-feature-kebab>" }
    ],
    "addDependencies": [
      {
        "from": { "spec": "...", "feature": "..." },
        "to":   { "spec": "...", "feature": "..." },
        "kind": "explicit-ref" | "semantic",
        "reason": "..."
      }
    ]
  }

Rejects if:
  - target island not found (lookup by id, falls back to name)
  - any addMembers feature is unknown (not in any tree)
  - any addMembers feature already belongs to ANY existing island
  - any addDependencies endpoint is outside the target island after extension
    (cross-island edges still require sync --recluster-islands)

After success run \`sync\` to re-render forest.md + island MDs.
`;

export async function cmdExtendIsland({ cwd, args, stdin, stdout, stderr }) {
  if (args.includes("--help") || args.includes("-h")) {
    stdout.write(USAGE);
    return 0;
  }

  const target = args.find((a) => !a.startsWith("-"));
  if (!target) {
    stderr.write(USAGE);
    return 1;
  }

  const config = await loadConfig(cwd);
  const p = paths(cwd, config);
  await syncCheckboxesAndPersistOrphans({
    outputDir: p.outputDir,
    treesDir: p.treesDir,
    statePath: p.state,
    markers: config.checkboxMarkers,
  });

  const raw = await readAllStdin(stdin);
  if (!raw.trim()) {
    stderr.write(USAGE);
    return 1;
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    stderr.write(`invalid JSON on stdin: ${e.message}\n`);
    return 1;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    stderr.write("stdin must be a single extension object\n");
    return 1;
  }

  const addMembers = Array.isArray(payload.addMembers) ? payload.addMembers : [];
  const addDependencies = Array.isArray(payload.addDependencies) ? payload.addDependencies : [];
  if (addMembers.length === 0 && addDependencies.length === 0) {
    stderr.write("ERROR: nothing to add (addMembers and addDependencies are both empty)\n");
    return 1;
  }

  const existing = await readIslands(p.islands);
  if (!existing) {
    stderr.write("no existing islands.json — run `sync` first (it will request a full cluster via `commit-islands`)\n");
    return 1;
  }

  const island =
    existing.islands.find((isl) => isl.id === target) ||
    existing.islands.find((isl) => isl.name === target);
  if (!island) {
    stderr.write(`ERROR: island not found by id or name: ${target}\n`);
    stderr.write("available islands:\n");
    for (const isl of existing.islands) stderr.write(`  - ${isl.name}  (${isl.id})\n`);
    return 1;
  }

  const trees = await readAllTrees(p.treesDir);
  const knownFeatures = new Set();
  for (const t of trees) for (const f of t.features) knownFeatures.add(`${t.spec}/${f.name}`);

  const existingMemberOwner = new Map();
  for (const isl of existing.islands) {
    for (const m of isl.members) {
      existingMemberOwner.set(`${m.spec}/${m.feature}`, isl);
    }
  }

  const addedKeys = new Set();
  for (const m of addMembers) {
    if (!m || typeof m !== "object") {
      stderr.write("ERROR: addMembers entry is not an object\n");
      return 1;
    }
    const k = `${m.spec}/${m.feature}`;
    if (addedKeys.has(k)) {
      stderr.write(`ERROR: duplicate member in addMembers: ${k}\n`);
      return 1;
    }
    addedKeys.add(k);
  }

  const unknown = [...addedKeys].filter((k) => !knownFeatures.has(k));
  if (unknown.length) {
    stderr.write("ERROR: addMembers reference unknown top-level features:\n");
    for (const k of unknown) stderr.write(`  - ${k}\n`);
    return 1;
  }

  const overlapping = [...addedKeys].filter((k) => existingMemberOwner.has(k));
  if (overlapping.length) {
    stderr.write("ERROR: addMembers already belong to an existing island (use `sync --recluster-islands` to move features between islands):\n");
    for (const k of overlapping) {
      const owner = existingMemberOwner.get(k);
      stderr.write(`  - ${k}  (in ${owner.name} / ${owner.id})\n`);
    }
    return 1;
  }

  const islandMemberKeysAfter = new Set([
    ...island.members.map((m) => `${m.spec}/${m.feature}`),
    ...addedKeys,
  ]);
  for (let i = 0; i < addDependencies.length; i++) {
    const d = addDependencies[i];
    if (!d || typeof d !== "object" || !d.from || !d.to) {
      stderr.write(`ERROR: addDependencies[${i}] missing from/to\n`);
      return 1;
    }
    const fromKey = `${d.from.spec}/${d.from.feature}`;
    const toKey = `${d.to.spec}/${d.to.feature}`;
    if (!islandMemberKeysAfter.has(fromKey) || !islandMemberKeysAfter.has(toKey)) {
      stderr.write(`ERROR: addDependencies[${i}] crosses island boundary (${fromKey} → ${toKey}). Cross-island edges require sync --recluster-islands.\n`);
      return 1;
    }
  }

  const updatedIsland = {
    ...island,
    members: [...island.members, ...addMembers],
    dependencies: [...island.dependencies, ...addDependencies],
  };

  const merged = {
    generatedAt: new Date().toISOString(),
    islands: existing.islands.map((isl) => (isl.id === island.id ? updatedIsland : isl)),
  };

  try {
    validateIslands(merged);
  } catch (e) {
    if (e instanceof ValidationError) {
      stderr.write(`validation error: ${e.message}\n`);
      return 1;
    }
    throw e;
  }

  await writeIslands(p.islands, merged);
  try { await regenAndWriteTreeCache({ config, p }); } catch {}

  const totalCovered = new Set();
  for (const isl of merged.islands) for (const m of isl.members) totalCovered.add(`${m.spec}/${m.feature}`);
  const uncoveredRemaining = [...knownFeatures].filter((k) => !totalCovered.has(k));

  stdout.write(
    `extended island '${island.name}' (${island.id}); ` +
    `+${addedKeys.size} member(s), +${addDependencies.length} dep(s); ` +
    `${uncoveredRemaining.length} top-level feature(s) still uncovered\n`
  );
  if (uncoveredRemaining.length) {
    stdout.write("uncovered:\n");
    for (const k of uncoveredRemaining) stdout.write(`  - ${k}\n`);
    stdout.write("(re-run `sync` for the next incremental step or `sync --recluster-islands` to re-cluster.)\n");
  } else {
    stdout.write("run `sync` to re-render forest.md + island MDs.\n");
  }
  return 0;
}
