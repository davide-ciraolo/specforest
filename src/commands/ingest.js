import path from "node:path";
import { loadConfig } from "../config.js";
import { paths } from "../paths.js";
import { validateTree, ValidationError } from "../validation.js";
import { sha256File } from "../hash.js";
import { archiveTree, readTree, writeTree, collectStatuses, applyStatuses } from "../tree-io.js";
import { updateState } from "../state.js";
import { syncCheckboxesAndPersistOrphans } from "../sync-helpers.js";
import { findSpecs, specNameFromRel } from "../glob.js";

async function readAllStdin(stdin) {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

export async function cmdIngest({ cwd, args, stdin, stdout, stderr }) {
  const specName = args[0];
  if (!specName) {
    stderr.write("usage: specforest ingest <spec-name>\n");
    return 1;
  }
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
  if (parsed.spec && parsed.spec !== specName) {
    stderr.write(`spec mismatch: arg=${specName} vs payload=${parsed.spec}\n`);
    return 1;
  }
  parsed.spec = specName;

  const allSpecs = await findSpecs(p.specsDir, config.specsGlob, config.ignore);
  const match = allSpecs.find((f) => specNameFromRel(f.rel) === specName);
  if (!match) {
    stderr.write(`spec file not found in ${p.specsDir} for name "${specName}"\n`);
    return 1;
  }
  const hash = await sha256File(match.abs);
  parsed.specHash = hash;
  parsed.specPath = path.relative(cwd, match.abs).split(path.sep).join("/");

  try {
    validateTree(parsed);
  } catch (e) {
    if (e instanceof ValidationError) {
      stderr.write(`validation error: ${e.message}\n`);
      return 1;
    }
    throw e;
  }

  const existing = await readTree(p.treesDir, specName);
  const orphans = {};
  if (existing) {
    const prevStatuses = collectStatuses(existing);
    applyStatuses(parsed, prevStatuses);
    const newNames = new Set();
    function walk(n) { newNames.add(n.name); for (const c of n.children || []) walk(c); }
    for (const f of parsed.features) walk(f);
    for (const [name, status] of prevStatuses.entries()) {
      if (!newNames.has(name) && status !== "todo") {
        orphans[`${specName}/${name}`] = { status, lostAt: new Date().toISOString() };
      }
    }
    await archiveTree(p.treesDir, p.archiveTrees, specName);
  }

  await writeTree(p.treesDir, parsed);
  await updateState(p.state, (s) => {
    s.specHashes[specName] = hash;
    Object.assign(s.orphanedProgress, orphans);
  });

  stdout.write(`ingested: ${specName} (${parsed.features.length} top-level features)\n`);
  return 0;
}
