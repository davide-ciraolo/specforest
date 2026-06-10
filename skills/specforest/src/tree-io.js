import { readFile, writeFile, mkdir, readdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { validateTree } from "./validation.js";

export async function listTreeFiles(treesDir) {
  try {
    const entries = await readdir(treesDir);
    return entries.filter((f) => f.endsWith(".json")).map((f) => path.join(treesDir, f));
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}

export async function readTree(treesDir, specName) {
  const p = path.join(treesDir, `${specName}.json`);
  try {
    const raw = await readFile(p, "utf8");
    return validateTree(JSON.parse(raw));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

export async function readAllTrees(treesDir) {
  const files = await listTreeFiles(treesDir);
  const out = [];
  for (const f of files) {
    const raw = await readFile(f, "utf8");
    out.push(validateTree(JSON.parse(raw)));
  }
  return out;
}

export async function writeTree(treesDir, tree) {
  await mkdir(treesDir, { recursive: true });
  const p = path.join(treesDir, `${tree.spec}.json`);
  await writeFile(p, JSON.stringify(tree, null, 2) + "\n", "utf8");
  return p;
}

export async function archiveTree(treesDir, archiveDir, specName) {
  const src = path.join(treesDir, `${specName}.json`);
  try {
    await stat(src);
  } catch {
    return null;
  }
  await mkdir(archiveDir, { recursive: true });
  const raw = await readFile(src, "utf8");
  let hashTag = "unknown";
  try {
    const parsed = JSON.parse(raw);
    if (parsed.specHash) hashTag = parsed.specHash.replace(/^sha256:/, "").slice(0, 10);
  } catch {}
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dst = path.join(archiveDir, `${specName}-${hashTag}-${ts}.json`);
  await rename(src, dst);
  return dst;
}

function visitFeature(node, fn) {
  fn(node);
  for (const c of node.children || []) visitFeature(c, fn);
}

export function indexFeatures(tree) {
  const idx = new Map();
  for (const f of tree.features) visitFeature(f, (n) => idx.set(n.name, n));
  return idx;
}

export function collectStatuses(tree) {
  const out = new Map();
  for (const f of tree.features) {
    visitFeature(f, (n) => out.set(n.name, n.status));
  }
  return out;
}

export function applyStatuses(tree, statusMap) {
  for (const f of tree.features) {
    visitFeature(f, (n) => {
      if (statusMap.has(n.name)) n.status = statusMap.get(n.name);
    });
  }
}

export function findTopLevelFeature(tree, name) {
  return tree.features.find((f) => f.name === name) || null;
}

export function topLevelNames(tree) {
  return tree.features.map((f) => f.name);
}

export function isSubFeatureName(tree, name) {
  for (const f of tree.features) {
    if (f.name === name) return false;
    let found = false;
    visitFeature(f, (n) => {
      if (n.name === name) found = true;
    });
    if (found) return true;
  }
  return false;
}

/**
 * Structural fingerprint over all trees, sensitive only to spec set + top-level feature
 * names (sorted). Status changes are intentionally excluded so mark/implement do not
 * trigger spurious re-clustering on the next sync.
 */
export function structuralFingerprint(trees) {
  const obj = {};
  for (const t of trees) {
    obj[t.spec] = t.features.map((f) => f.name).sort();
  }
  return JSON.stringify(obj, Object.keys(obj).sort());
}

export function findParentTopLevel(tree, subName) {
  for (const f of tree.features) {
    let found = false;
    visitFeature(f, (n) => {
      if (n !== f && n.name === subName) found = true;
    });
    if (found) return f.name;
  }
  return null;
}
