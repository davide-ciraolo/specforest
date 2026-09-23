# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-09-23

Per-feature time tracking: how long a feature took, split into time spent
coding and time spent waiting on CI.

### Added

- **`ci <spec>/<feature> -- <cmd>…`** — runs a test/lint/format/typecheck/build
  command and charges its wall-clock to that node, so reports can carve CI out
  of coding time. Any node is a valid target.
- **`timings [<spec>/<feature>]`** — forest and island roll-up by default, one
  node's detail when given a path. `--json` for machine use, `--orphans` to list
  recorded events whose target no longer matches a node.
- **Automatic timing on status changes.** `mark` and `implement` open an interval
  when a node goes `in_progress` and close it when it goes `done`. Features are
  timed, not just leaves.
- **Status cascades.** Marking a feature `done` marks every descendant done; the
  last leaf going `done` promotes its parent (and so on up); marking a leaf
  `in_progress` opens an interval on its ancestors too. Only boundary crossings
  are recorded, so re-marking a node is idempotent.
- **Recorded time in the existing views** — the ASCII tree, `status` island
  lines, and the generated Markdown now show rolled-up coding and CI time, and
  flag a node whose interval is still open.
- **`timings` config flag** (default `true`) to disable recording entirely.

### Notes

- Time lives in `.specforest/timings.jsonl`, an append-only event log. Totals are
  always derived on read, never stored, so the log stays replayable.
- Roll-up is "descendants win": a parent's interval spans its leaves' by
  construction, so wall-clock comes from the descendants whenever any of them
  recorded time. CI time stays additive at every level, because a CI run is
  charged to exactly one node and runs never overlap.
- Checkbox adoption (ticking a box in Obsidian) records the transition but
  deliberately does not cascade.

## [0.1.0] — 2026-09-20

First release. Turns project specs into a forest of feature trees, clusters them
into dependency islands, renders Obsidian-friendly Markdown, and tracks progress.

### Added

- **Forest pipeline** — `init`, `scan`, `ingest`, `commit-islands`, `render`, and
  `sync` to drive the whole loop from spec files to rendered trees.
- **Incremental sync.** Existing islands are preserved byte-for-byte; only new
  top-level features need placement. `--recluster-islands` forces a full
  re-cluster when features must move between islands.
- **`add-island` / `extend-island`** — additive island edits that leave every
  other island untouched. Cross-island edges are rejected, pointing you at a full
  re-cluster instead.
- **Progress tracking** — `mark` and `implement` set feature status; Obsidian
  checkboxes are parsed back, so ticking a box in your vault updates the forest.
- **`verify`** — read-only check of whether a feature is already implemented.
  Reports a verdict with evidence and suggests the follow-up `mark`.
- **`status` and `tree`** — island counters for cheap orientation, and a cached
  ASCII tree with per-spec drill-down.
- **`rehash`** — resyncs `specHash` to on-disk bytes when a spec's bytes changed
  but its features did not (line-ending flips, BOM fixes, reformatting).
- **Multi-segment feature paths** for `mark` and `implement`, so any sub-feature
  is addressable, not just top-level ones.
- Packaged as a Claude Code plugin marketplace.

[0.2.0]: https://github.com/davide-ciraolo/specforest/releases/tag/v0.2.0
[0.1.0]: https://github.com/davide-ciraolo/specforest/releases/tag/v0.1.0
