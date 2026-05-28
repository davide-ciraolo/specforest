import { loadConfig } from "../config.js";
import { paths } from "../paths.js";
import { validateIslands, ValidationError } from "../validation.js";
import { readIslands, writeIslands, newIslandId } from "../islands-io.js";
import { readAllTrees } from "../tree-io.js";
import { syncCheckboxesAndPersistOrphans } from "../sync-helpers.js";
import { regenAndWriteTreeCache } from "../tree-cache.js";

async function readAllStdin(stdin) {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const USAGE = `usage: specforest add-island   (stdin: single island JSON)

Appends ONE island to islands.json without re-clustering the rest.
The 10 existing islands stay byte-identical; only the new island is added.

Stdin schema (single object, NOT wrapped in {islands:[...]}):
  {
    "id": "isl_xxxxxx",         // optional — auto-generated if omitted
    "name": "kebab-case-theme",
    "members": [
      { "spec": "<spec-kebab>", "feature": "<top-level-feature-kebab>" }
    ],
    "dependencies": [
      {
        "from": { "spec": "...", "feature": "..." },
        "to":   { "spec": "...", "feature": "..." },
        "kind": "explicit-ref" | "semantic",
        "reason": "..."
      }
    ]
  }

Rejects if:
  - any member feature is unknown (not in any tree)
  - any member already belongs to an existing island
  - id or name collides with an existing island
  - dependency endpoints reference a feature outside the new island
    (cross-island edges still require the full commit-islands flow)

After success run \`sync\` to re-render forest.md + island MDs.
`;

export async function cmdAddIsland({ cwd, args, stdin, stdout, stderr }) {
  if (args.includes("--help") || args.includes("-h")) {
    stdout.write(USAGE);
    return 0;
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
  let incoming;
  try {
    incoming = JSON.parse(raw);
  } catch (e) {
    stderr.write(`invalid JSON on stdin: ${e.message}\n`);
    return 1;
  }
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
    stderr.write("stdin must be a single island object (not an array, not an islands envelope)\n");
    return 1;
  }
  if (Array.isArray(incoming.islands)) {
    stderr.write("stdin is an islands envelope — use `commit-islands` for full re-clustering, or pass a single island object to `add-island`\n");
    return 1;
  }

  if (!incoming.dependencies) incoming.dependencies = [];
  if (!incoming.id) incoming.id = newIslandId();

  const existing = await readIslands(p.islands);
  if (!existing) {
    stderr.write("no existing islands.json — first cluster must go through `commit-islands`\n");
    return 1;
  }

  const trees = await readAllTrees(p.treesDir);
  const knownFeatures = new Set();
  for (const t of trees) for (const f of t.features) knownFeatures.add(`${t.spec}/${f.name}`);

  const incomingMembers = new Set();
  for (const m of incoming.members || []) {
    if (!m || typeof m !== "object") {
      stderr.write("member entry is not an object\n");
      return 1;
    }
    const k = `${m.spec}/${m.feature}`;
    if (incomingMembers.has(k)) {
      stderr.write(`ERROR: duplicate member in new island: ${k}\n`);
      return 1;
    }
    incomingMembers.add(k);
  }

  const unknownMembers = [...incomingMembers].filter((k) => !knownFeatures.has(k));
  if (unknownMembers.length) {
    stderr.write("ERROR: members reference unknown top-level features:\n");
    for (const k of unknownMembers) stderr.write(`  - ${k}\n`);
    return 1;
  }

  const existingMemberOwner = new Map();
  for (const isl of existing.islands) {
    for (const m of isl.members) {
      existingMemberOwner.set(`${m.spec}/${m.feature}`, isl);
    }
  }
  const overlapping = [...incomingMembers].filter((k) => existingMemberOwner.has(k));
  if (overlapping.length) {
    stderr.write("ERROR: members already belong to an existing island (use `commit-islands` to move features between islands):\n");
    for (const k of overlapping) {
      const isl = existingMemberOwner.get(k);
      stderr.write(`  - ${k}  (in ${isl.name} / ${isl.id})\n`);
    }
    return 1;
  }

  for (let i = 0; i < incoming.dependencies.length; i++) {
    const d = incoming.dependencies[i];
    if (!d || typeof d !== "object" || !d.from || !d.to) {
      stderr.write(`ERROR: dependencies[${i}] missing from/to\n`);
      return 1;
    }
    const fromKey = `${d.from.spec}/${d.from.feature}`;
    const toKey = `${d.to.spec}/${d.to.feature}`;
    if (!incomingMembers.has(fromKey) || !incomingMembers.has(toKey)) {
      stderr.write(`ERROR: dependencies[${i}] crosses island boundary (${fromKey} → ${toKey}). Cross-island edges require a full re-cluster via \`commit-islands\`.\n`);
      return 1;
    }
  }

  const existingIds = new Set(existing.islands.map((i) => i.id));
  const existingNames = new Set(existing.islands.map((i) => i.name));
  if (existingIds.has(incoming.id)) {
    stderr.write(`ERROR: island id collides with existing: ${incoming.id}\n`);
    return 1;
  }
  if (existingNames.has(incoming.name)) {
    stderr.write(`ERROR: island name collides with existing: ${incoming.name}\n`);
    return 1;
  }

  const merged = {
    generatedAt: new Date().toISOString(),
    islands: [...existing.islands, incoming],
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
    `appended island '${incoming.name}' (${incoming.id}); ` +
    `+${incomingMembers.size} member(s); ` +
    `${uncoveredRemaining.length} top-level feature(s) still uncovered\n`
  );
  if (uncoveredRemaining.length) {
    stdout.write("uncovered:\n");
    for (const k of uncoveredRemaining) stdout.write(`  - ${k}\n`);
    stdout.write("(`sync` will refuse to clean until every top-level feature belongs to an island — add more islands or fall back to `commit-islands`.)\n");
  } else {
    stdout.write("run `sync` to re-render forest.md + island MDs.\n");
  }
  return 0;
}
