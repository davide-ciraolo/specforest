import { open, mkdir, readFile, unlink, stat } from "node:fs/promises";
import path from "node:path";

const STALE_MS = 5 * 60 * 1000;

export async function acquireLock(lockPath) {
  await mkdir(path.dirname(lockPath), { recursive: true });
  try {
    const fh = await open(lockPath, "wx");
    await fh.writeFile(`${process.pid}\n${Date.now()}\n`);
    await fh.close();
    return true;
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    try {
      const st = await stat(lockPath);
      if (Date.now() - st.mtimeMs > STALE_MS) {
        await unlink(lockPath);
        return acquireLock(lockPath);
      }
    } catch (e2) {
      if (e2.code === "ENOENT") return acquireLock(lockPath);
      throw e2;
    }
    return false;
  }
}

export async function releaseLock(lockPath) {
  try {
    await unlink(lockPath);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
}

export async function readLockOwner(lockPath) {
  try {
    return (await readFile(lockPath, "utf8")).split("\n")[0];
  } catch {
    return null;
  }
}
