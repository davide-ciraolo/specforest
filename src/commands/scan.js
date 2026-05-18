import { loadConfig } from "../config.js";
import { paths } from "../paths.js";
import { findSpecs, specNameFromRel } from "../glob.js";
import { sha256File } from "../hash.js";
import { readState } from "../state.js";

export async function computeScan({ cwd }) {
  const config = await loadConfig(cwd);
  const p = paths(cwd, config);
  const files = await findSpecs(p.specsDir, config.specsGlob, config.ignore);
  const state = await readState(p.state);

  const liveSpecs = [];
  const nameToPaths = new Map();
  for (const f of files) {
    const name = specNameFromRel(f.rel);
    if (!nameToPaths.has(name)) nameToPaths.set(name, []);
    nameToPaths.get(name).push(f.rel);
  }
  const collisions = [];
  for (const [name, paths] of nameToPaths.entries()) {
    if (paths.length > 1) collisions.push({ name, paths });
  }

  for (const f of files) {
    const name = specNameFromRel(f.rel);
    const hash = await sha256File(f.abs);
    liveSpecs.push({ name, rel: f.rel, abs: f.abs, hash });
  }

  const stale = liveSpecs.filter((s) => state.specHashes[s.name] !== s.hash);
  const deleted = Object.keys(state.specHashes).filter(
    (name) => !liveSpecs.some((s) => s.name === name),
  );
  return { config, paths: p, state, liveSpecs, stale, deleted, collisions };
}

export async function cmdScan({ cwd, stdout }) {
  const r = await computeScan({ cwd });
  stdout.write(
    JSON.stringify(
      {
        live: r.liveSpecs.map((s) => ({ name: s.name, rel: s.rel })),
        stale: r.stale.map((s) => ({ name: s.name, rel: s.rel })),
        deleted: r.deleted,
        collisions: r.collisions,
      },
      null,
      2,
    ) + "\n",
  );
  return r.collisions.length ? 1 : 0;
}
