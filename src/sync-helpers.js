import { syncCheckboxes } from "./render.js";
import { updateState } from "./state.js";

/**
 * Runs syncCheckboxes() and persists any orphan checkboxes to state.json.orphanedProgress.
 * Spec §3.4 step 5: "Never lose progress silently" — orphans must be stashed.
 *
 * Returns { updated, warnings, orphans } from syncCheckboxes for callers that want to log.
 */
export async function syncCheckboxesAndPersistOrphans({ outputDir, treesDir, statePath, markers }) {
  const result = await syncCheckboxes(outputDir, treesDir, markers);
  if (result.orphans.length > 0) {
    const now = new Date().toISOString();
    await updateState(statePath, (s) => {
      for (const { key, status } of result.orphans) {
        s.orphanedProgress[key] = { status, lostAt: now };
      }
    });
  }
  return result;
}
