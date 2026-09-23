import { syncCheckboxes } from "./render.js";
import { updateState } from "./state.js";
import { transitionEvent } from "./timings.js";
import { appendEvents } from "./timings-io.js";

/**
 * Runs syncCheckboxes() and persists any orphan checkboxes to state.json.orphanedProgress.
 * Spec §3.4 step 5: "Never lose progress silently" — orphans must be stashed.
 *
 * When timings are enabled, also appends start/stop events for the transitions the
 * checkbox round-trip adopted, tagged source: "checkbox". Timestamps are DETECTION
 * time, not tick time — see the timings design §2.3.
 *
 * Returns { updated, warnings, orphans, transitions } from syncCheckboxes.
 */
export async function syncCheckboxesAndPersistOrphans({
  outputDir,
  treesDir,
  statePath,
  markers,
  timingsPath,
  timingsEnabled = false,
  stderr = null,
}) {
  const result = await syncCheckboxes(outputDir, treesDir, markers);
  if (result.orphans.length > 0) {
    const now = new Date().toISOString();
    await updateState(statePath, (s) => {
      for (const { key, status } of result.orphans) {
        s.orphanedProgress[key] = { status, lostAt: now };
      }
    });
  }
  if (timingsEnabled && timingsPath && result.transitions.length > 0) {
    const ts = new Date().toISOString();
    const events = [];
    for (const t of result.transitions) {
      const ev = transitionEvent({
        isLeaf: t.isLeaf,
        from: t.from,
        to: t.to,
        source: "checkbox",
        target: `${t.spec}/${t.fullPath}`,
        ts,
      });
      if (ev) events.push(ev);
    }
    try {
      await appendEvents(timingsPath, events);
    } catch (e) {
      // Timing is an add-on: it may never take the core status sync down.
      // Same convention as the recordTransition call sites in mark/implement.
      if (stderr) stderr.write(`warning: could not record timing: ${e.message}\n`);
    }
  }
  return result;
}
