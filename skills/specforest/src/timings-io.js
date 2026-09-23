import { open, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { transitionEvent } from "./timings.js";

/**
 * Appends events as JSONL. One append call per invocation.
 * @param {string} timingsPath
 * @param {Array<object>} events
 */
export async function appendEvents(timingsPath, events) {
  if (!events || events.length === 0) return;
  await mkdir(path.dirname(timingsPath), { recursive: true });
  const body = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  const fh = await open(timingsPath, "a+");
  try {
    // A previous write may have been torn, or the log hand-edited, leaving no
    // trailing newline. Appending straight onto it would fuse two records into
    // one unparseable line and lose the earlier, good one — the single case
    // where this format is not self-healing.
    const { size } = await fh.stat();
    let prefix = "";
    if (size > 0) {
      const buf = Buffer.alloc(1);
      await fh.read(buf, 0, 1, size - 1);
      if (buf[0] !== 0x0a) prefix = "\n";
    }
    await fh.appendFile(prefix + body, "utf8");
  } finally {
    await fh.close();
  }
}

/**
 * Tolerant read. A malformed line is skipped rather than fatal — append-only means
 * one bad line must not destroy history. A line with a `ts` that fails to parse is
 * treated as malformed too, so it can never slip downstream into `deriveTotals`
 * (which silently drops it) with no warning shown to the user.
 * @param {string} timingsPath
 * @returns {Promise<{events: Array<object>, warnings: string[]}>}
 */
export async function readEvents(timingsPath) {
  let raw;
  try {
    raw = await readFile(timingsPath, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { events: [], warnings: [] };
    throw e;
  }
  const events = [];
  const warnings = [];
  const lines = raw.split("\n");
  const filename = path.basename(timingsPath);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    try {
      const obj = JSON.parse(line);
      if (
        obj &&
        typeof obj.ts === "string" &&
        Number.isFinite(Date.parse(obj.ts)) &&
        typeof obj.target === "string"
      ) {
        events.push(obj);
      } else {
        warnings.push(`${filename} line ${i + 1}: missing or invalid ts/target, skipped`);
      }
    } catch {
      warnings.push(`${filename} line ${i + 1}: not valid JSON, skipped`);
    }
  }
  return { events, warnings };
}

/**
 * The single write hook used by mark and implement.
 * @returns {Promise<object|null>} the appended event, or null if nothing was recorded
 */
export async function recordTransition({ enabled, timingsPath, node, fullPath, from, to, source, ts = new Date().toISOString() }) {
  if (!enabled) return null;
  if (!node) return null;
  const stamp = typeof ts === "string" && Number.isFinite(Date.parse(ts)) ? ts : new Date().toISOString();
  const ev = transitionEvent({ from, to, source, target: fullPath, ts: stamp });
  if (!ev) return null;
  await appendEvents(timingsPath, [ev]);
  return ev;
}

/**
 * The cascade write hook (timings design §2.4). A status cascade touches several
 * nodes at once; each one that crosses the `in_progress` boundary becomes an event,
 * and all of them land in a single append so a crash cannot tear a cascade in half.
 *
 * Every event shares one timestamp on purpose: the cascade is one logical moment,
 * and distinct stamps would let a parent's `stop` sort ahead of its own child's.
 *
 * @param {object} args
 * @param {Array<{fullPath: string, from: string, to: string}>} args.changes
 *   `fullPath` is already prefixed with `<spec>/`.
 * @returns {Promise<Array<object>>} the appended events, empty if nothing crossed
 */
export async function recordTransitions({ enabled, timingsPath, changes, source, ts = new Date().toISOString() }) {
  if (!enabled) return [];
  if (!Array.isArray(changes) || changes.length === 0) return [];
  const stamp = typeof ts === "string" && Number.isFinite(Date.parse(ts)) ? ts : new Date().toISOString();
  const events = [];
  for (const c of changes) {
    const ev = transitionEvent({ from: c.from, to: c.to, source, target: c.fullPath, ts: stamp });
    if (ev) events.push(ev);
  }
  if (events.length === 0) return [];
  await appendEvents(timingsPath, events);
  return events;
}
