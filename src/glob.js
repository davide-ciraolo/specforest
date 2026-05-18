import { readdir } from "node:fs/promises";
import path from "node:path";
import picomatch from "picomatch";

export async function findSpecs(specsDir, specsGlob, ignoreGlobs) {
  const isMatch = picomatch(specsGlob, { dot: false });
  const isIgnored = ignoreGlobs.length
    ? picomatch(ignoreGlobs, { dot: false })
    : () => false;

  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (e) {
      if (e.code === "ENOENT") return;
      throw e;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      const rel = path.relative(specsDir, full).split(path.sep).join("/");
      if (ent.isDirectory()) {
        await walk(full);
      } else if (ent.isFile()) {
        if (isMatch(rel) && !isIgnored(rel)) {
          out.push({ abs: full, rel });
        }
      }
    }
  }
  await walk(specsDir);
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return out;
}

export function specNameFromRel(rel) {
  const base = path.basename(rel, path.extname(rel));
  return base;
}
