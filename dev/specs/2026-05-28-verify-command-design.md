# `verify` Command — Design

**Date:** 2026-05-28
**Status:** Approved (brainstorming) — pending implementation plan
**Scope:** `.claude/skills/specforest` — CLI command, prompt, SKILL.md docs, tests.
**Companion to:** [.claude/skills/specforest/SKILL.md](../../../.claude/skills/specforest/SKILL.md),
[.claude/skills/specforest/src/commands/implement.js](../../../.claude/skills/specforest/src/commands/implement.js).

## Purpose

`specforest implement <spec>/<feature>` sets up the context to *build* a feature.
There is currently no symmetric command to *check* whether a feature is already
implemented in the codebase. This adds `verify` — a read-only command that emits
the same kind of `NEXT:` block as `implement`, instructs Claude to inspect the
codebase for evidence of implementation, and suggests a follow-up `mark` command
based on the verdict.

Use cases:

- Confirm a `done` feature is really implemented (regression / drift check).
- Discover that a `todo` / `blocked` feature is secretly already implemented
  (e.g. landed via another PR, or pre-existed when the spec was ingested).
- Sanity-check `in_progress` features before resuming work.

## Non-goals

- Auto-marking feature status based on the verdict. `verify` stays read-only;
  the operator (or Claude, on user confirmation) chains into `mark` separately.
- A new `verified` status. `done` keeps its existing meaning; `verify` does not
  introduce a parallel status axis.
- Running the verification itself in the CLI. Like `implement`, the CLI sets up
  the context; Claude does the inspection using Grep / Glob / Read.

## Surface

```
node .claude/skills/specforest/bin/cli.js verify <spec>/<feature-path>
```

- Same target grammar as `implement` (full path or single segment with
  disambiguation prompt). Implemented via the existing `parseTarget` +
  `resolveTargetNode` helpers in [src/target.js](../../../.claude/skills/specforest/src/target.js).
- No flags. Read-only.

## Behaviour

`verify` mirrors `implement` step-for-step except where noted.

| Step | `implement` | `verify` |
|---|---|---|
| `syncCheckboxesAndPersistOrphans` at top | yes | yes (keeps status fresh from Obsidian) |
| Parse target → resolve node → disambiguate | same | same |
| Status precheck | rejects `done` (must `mark todo` first) | **accepts any status** |
| Find island via `findIslandForFeature` | required (errors if absent) | required (errors if absent) |
| Prereq DFS via `buildAdjacency` | same | same |
| Cycle notes | same | same |
| `specs-to-read` (own + all reachable prereqs) | same | same |
| Prereqs flagged `⚠ not done` | yes | yes — same as `implement` |
| Mark target `in_progress` (rollup ancestors) | yes, unless `--no-mark` | **never** — read-only |
| `regenAndWriteTreeCache` | called after mark | not called (no state change) |
| Exit code on success | `0` | `0` |
| Exit code on usage / resolution error | `1` | `1` |

### Output

```
NEXT: verify
target: <spec>/<full-path>
target-status: <current-status> (no change)
specs-to-read:
  - <own spec path>
  - <prereq spec paths>
prerequisites:
  - <spec>/<feature>  [done]
  - <spec>/<feature>  [todo]   ⚠ not done
cycle-warning:
  - <cycle path>            # only if any
prompt: |
  <verify prompt — see below, indented two spaces>
```

If no prereqs: `prerequisites:\n  (none)` (same as `implement`).

### Verify prompt

Added as a new `verifyPrompt(...)` export in
[src/prompts.js](../../../.claude/skills/specforest/src/prompts.js):

```
You are verifying whether a feature from the specforest is implemented in the codebase.

Target: <spec>/<full-path>
Current status: <current-status>
Specs to read (FULL FILES, not excerpts):
  - <paths>

Prerequisites:
  - <list with statuses; flagged when not done>

INSTRUCTIONS:
1. Read every spec file listed above in full.
2. [if any undone prereq] WARNING: one or more prerequisites are not done. The
   feature may be unverifiable in isolation; surface the list to the user
   before proceeding.
3. Inspect the codebase for evidence that the target feature is implemented:
   - Code paths, file structure, tests, configuration, migrations as relevant.
   - Use Grep / Glob / Read; do NOT modify files.
4. Report back to the user with:
   - VERDICT: implemented | partially implemented | not implemented
   - EVIDENCE: concrete file paths + line numbers backing the verdict.
   - GAPS: anything in the spec that lacks corresponding code / tests.
5. Suggest the appropriate follow-up command based on the verdict:
   - implemented      → node .claude/skills/specforest/bin/cli.js mark <target> done
   - partial          → node .claude/skills/specforest/bin/cli.js mark <target> in_progress
   - not started      → node .claude/skills/specforest/bin/cli.js mark <target> todo
   - blocked          → node .claude/skills/specforest/bin/cli.js mark <target> blocked
6. DO NOT run `mark` yourself unless the user confirms.
```

The `[if any undone prereq]` line is rendered only when at least one prereq is
not `done` — same conditional pattern as `implementPrompt` already uses.

## Code changes

1. **New file** `.claude/skills/specforest/src/commands/verify.js` — structurally
   a copy of `implement.js` with the mark / rollup / cache-regen branches
   removed, the status precheck relaxed, and the prompt swapped to
   `verifyPrompt`. Output header line is `NEXT: verify` and target-status line
   is `target-status: <status> (no change)`.

2. **New export** `verifyPrompt` in `src/prompts.js` matching the prompt above.
   Reuses the same `prereqLines` formatter pattern from `implementPrompt`.

3. **Wire** `cmdVerify` in `bin/cli.js`:
   - Import `cmdVerify` from `../src/commands/verify.js`.
   - Add `verify: cmdVerify` to `HANDLERS`.
   - Add a `verify <spec>/<feature-path>` line to the HELP block in the same
     style as `implement`, with the suffix `read-only; suggests follow-up mark`.

4. **SKILL.md** updates:
   - Add the trigger `'verify <spec>/<feature>'` / `'/specforest-verify <spec>/<feature>'`
     / `"is <feature> already implemented?"` to the **When to invoke** list,
     pointing to a new **Verify flow** section.
   - Add a **Verify flow** section after **Implement flow** with the same
     structure: invoke the CLI, read the `NEXT: verify` block, read the listed
     specs in full, perform read-only codebase inspection, report verdict +
     evidence + gaps, and suggest the appropriate `mark` follow-up.
   - Add to **Pitfalls + rules**: "`verify` is read-only — it never writes
     status. Use `mark` after reporting the verdict."

5. **Tests** (`.claude/skills/specforest/tests/e2e.test.js`):
   - `verify` on a `done` target prints `NEXT: verify`, target-status shows
     `done (no change)`, and the tree JSON on disk is unchanged after the call.
   - `verify` on a `todo` target prints `NEXT: verify`, target-status shows
     `todo (no change)`, tree unchanged.
   - `verify` with a non-existent target exits non-zero with the same resolver
     error as `implement`.
   - Disambiguation behaviour is covered by `target.test.js` already; no new
     test needed there.

## Out of scope

- Auto-running the verification inside the CLI (no shelling out to git / grep
  from the Node process — the prompt drives Claude).
- A `--mark-done` convenience flag. Operators chain `verify` → `mark` manually.
- A history of past verify runs. The CLI emits the block fresh each call.
