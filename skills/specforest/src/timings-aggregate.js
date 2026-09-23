import { readEvents } from "./timings-io.js";
import { deriveTotals, aggregateForest } from "./timings.js";

/**
 * Shared guarded-read + aggregate step behind both `tree`'s per-node
 * annotations (`buildTimingAnnotator` in tree-cache.js) and `status`'s
 * forest/island suffixes (src/commands/status.js).
 *
 * Returns null when timings are disabled, the log is unreadable, or nothing
 * has been recorded yet — every caller already treats null exactly like
 * "nothing to show" (`aggregateForest` on an empty event list produces the
 * same all-zero aggregates that `hasRecordedTime`/`formatAnnotation` already
 * suppress), so short-circuiting here changes no caller's visible output.
 *
 * Only the read is guarded: a throw out of deriveTotals/aggregateForest
 * (pure, no IO) is a bug in our own code and must surface, not be relabelled
 * as an IO failure — same convention as every other timings read site.
 *
 * `forwardWarnings` is the one behavioural knob the two callers disagree on:
 * `status` surfaces per-line malformed-log warnings (nothing else does, so
 * they'd otherwise never be reported); `tree`'s cache regenerates in the
 * background on almost every command, so repeating the same warning on every
 * mark/sync would be noise. Warnings are forwarded (when asked) BEFORE the
 * empty-events short-circuit, matching status's original behaviour of
 * reporting malformed lines even on a log with zero surviving events.
 */
export async function loadForestTimingAggregates({ config, p, trees, islands, stderr, forwardWarnings = false }) {
  if (!config.timings) return null;
  let events, warnings;
  try {
    ({ events, warnings } = await readEvents(p.timings));
  } catch (e) {
    stderr?.write(`warning: could not read timings log: ${e.message}\n`);
    return null;
  }
  if (forwardWarnings) {
    for (const w of warnings) stderr?.write(`warning: ${w}\n`);
  }
  if (events.length === 0) return null;
  return aggregateForest({ trees, islands }, deriveTotals(events));
}
