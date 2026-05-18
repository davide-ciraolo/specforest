import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

export function emptyState() {
  return {
    lastSync: null,
    lastRender: null,
    specHashes: {},
    islandIdMap: {},
    orphanedProgress: {},
    lastClusteredStructure: null,
  };
}

export async function readState(statePath) {
  try {
    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(raw);
    return { ...emptyState(), ...parsed };
  } catch (e) {
    if (e.code === "ENOENT") return emptyState();
    throw e;
  }
}

export async function writeState(statePath, state) {
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");
}

export async function updateState(statePath, mutator) {
  const s = await readState(statePath);
  await mutator(s);
  await writeState(statePath, s);
  return s;
}
