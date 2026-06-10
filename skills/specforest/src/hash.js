import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export async function sha256File(absPath) {
  const buf = await readFile(absPath);
  return "sha256:" + createHash("sha256").update(buf).digest("hex");
}

export function sha256String(s) {
  return "sha256:" + createHash("sha256").update(s).digest("hex");
}
