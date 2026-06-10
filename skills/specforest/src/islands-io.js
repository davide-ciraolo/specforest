import { readFile, writeFile, mkdir, rename, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { validateIslands } from "./validation.js";

export async function readIslands(islandsPath) {
  try {
    const raw = await readFile(islandsPath, "utf8");
    return validateIslands(JSON.parse(raw));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

export async function writeIslands(islandsPath, islands) {
  validateIslands(islands);
  await mkdir(path.dirname(islandsPath), { recursive: true });
  await writeFile(islandsPath, JSON.stringify(islands, null, 2) + "\n", "utf8");
}

export function newIslandId() {
  return "isl_" + randomBytes(3).toString("hex");
}

function memberKey(m) {
  return `${m.spec}/${m.feature}`;
}

function memberSet(island) {
  return new Set(island.members.map(memberKey));
}

export function reconcileIds(newIslands, previousIslands) {
  if (!previousIslands || !previousIslands.islands.length) {
    return newIslands.map((isl) => ({ ...isl, id: isl.id && isl.id.startsWith("isl_") ? isl.id : newIslandId() }));
  }

  const prev = previousIslands.islands.map((p) => ({ id: p.id, name: p.name, members: memberSet(p) }));
  const usedPrevIds = new Set();
  const result = [];

  const pairs = [];
  newIslands.forEach((ni, niIdx) => {
    const nset = memberSet(ni);
    prev.forEach((p, pIdx) => {
      let overlap = 0;
      for (const k of nset) if (p.members.has(k)) overlap++;
      if (overlap > 0) pairs.push({ niIdx, pIdx, overlap });
    });
  });

  pairs.sort((a, b) => b.overlap - a.overlap);
  const assigned = new Map();
  for (const pair of pairs) {
    if (assigned.has(pair.niIdx)) continue;
    if (usedPrevIds.has(prev[pair.pIdx].id)) continue;
    assigned.set(pair.niIdx, prev[pair.pIdx].id);
    usedPrevIds.add(prev[pair.pIdx].id);
  }

  newIslands.forEach((ni, niIdx) => {
    const reusedId = assigned.get(niIdx);
    result.push({ ...ni, id: reusedId || newIslandId() });
  });

  return result;
}

export async function archiveIslandMd(outputDir, archiveDir, islandName) {
  const src = path.join(outputDir, `${islandName}.md`);
  try {
    await stat(src);
  } catch {
    return null;
  }
  await mkdir(archiveDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dst = path.join(archiveDir, `${islandName}-${ts}.md`);
  await rename(src, dst);
  return dst;
}
