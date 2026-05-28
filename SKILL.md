---
name: specforest
description: Build, maintain, and consume a feature-tree forest with dependency islands and progress tracking from project specs. Trigger when the user says "sync specforest" / "update the forest" / "show the forest" / "implement <feature>" / "verify <feature>" / "is <feature> already implemented?" / "build the forest" / "add an island" / "add a new island" / "extend an island" / "re-cluster islands" / "/specforest" / "/specforest-implement <spec>/<feature>" / "/specforest-verify <spec>/<feature>" / "/specforest-add-island" / "/specforest-extend-island" / "/specforest-recluster".
---

# Specforest Skill

Turn project specs into a forest of feature trees, cluster features into dependency islands, render Obsidian-friendly Markdown, and track per-feature progress. Driven by a Node CLI for deterministic ops; this file tells you (Claude) how to drive it.

## When to invoke

- "sync specforest" / "update the forest" / "rebuild the trees" / `/specforest` → **Sync flow** (§ Sync). Sync is incremental by default — existing islands are preserved.
- "re-cluster islands" / "rebuild islands from scratch" / `/specforest-recluster` → **Sync flow** with `--recluster-islands` (forces a full re-cluster via `commit-islands`). Use when features need to move between islands or when new cross-island edges are required.
- "add a new island" / "/specforest-add-island" → **Add-island flow** (§ Add island). Append ONE new island; existing islands stay byte-identical.
- "extend an island" / "add feature to <island>" / "/specforest-extend-island" → **Extend-island flow** (§ Extend island). Append members (and intra-island deps) to ONE existing island.
- "show the forest" / "what's in the forest" / `/specforest-tree` → **Tree-view flow** (§ Tree view). Do not write. Pass `--regenerate` to force rebuild.
- "implement \<spec\>/\<feature\>" / "let's build \<feature\>" / `/specforest-implement` → **Implement flow** (§ Implement).
- "verify \<spec\>/\<feature\>" / "is \<feature\> already implemented?" / "check if \<feature\> is done" / `/specforest-verify` → **Verify flow** (§ Verify).
- User edited spec files and wants the trees current → **Sync flow**.
- User ticked checkboxes in Obsidian and wants ASCII tree refreshed → run `tree` (it syncs checkboxes first).
- "rehash specforest" / "resync hashes" / `/specforest-rehash` → **Rehash flow** (§ Rehash). Use when spec bytes changed but feature content did not (CRLF flip, BOM fix, reformatting).

## Invocation

Always invoke the CLI from the project root:

```
node .claude/skills/specforest/bin/cli.js <command> [args]
```

If you get `ENOENT_CONFIG` or "not found", run `init` first.

## Sync flow

Loop until you read `NEXT: clean`:

1. Run `node .claude/skills/specforest/bin/cli.js sync` (add `--recluster-islands` if the user explicitly asked for a full re-cluster, or if cross-island moves / edges are needed).
2. Read stdout. Branch:
   - `NEXT: ingest` → see § Ingest step.
   - `NEXT: islands` → full re-cluster requested or first run; see § Islands step.
   - `NEXT: incremental-islands` → existing islands kept; only new top-level features need placement. See § Incremental islands step.
   - `rendered: …` → render just happened. Re-run `sync` once more to confirm `NEXT: clean`.
   - `NEXT: clean` → done.

**Decision rule for `--recluster-islands`:**
- Default = incremental. Existing islands are preserved byte-for-byte; new top-level features are appended either to an existing island (`extend-island`) or as a new island (`add-island`).
- Pass `--recluster-islands` only when (a) the user explicitly asks, (b) features must move between islands, or (c) the new work introduces cross-island edges that can't be modelled by extension. If unsure, prefer incremental first; the CLI will tell you to re-run with the flag if the incremental flow can't satisfy the change.
- The CLI auto-falls-back to the full-cluster path when `islands.json` is absent.

### Ingest step

The CLI prints:
- A list of stale spec paths.
- An embedded PROMPT block (between `--- begin prompt ---` / `--- end prompt ---`).

For EACH stale spec:

1. Read the full spec file at the listed path.
2. Apply the Ingest prompt (below — use the CLI's embedded version, this is the canonical reference).
3. Produce a tree JSON object.
4. Pipe it to the CLI:
   ```
   echo '<json>' | node .claude/skills/specforest/bin/cli.js ingest <spec-name>
   ```
   (Use a shell heredoc or a temp file on Windows where echo escaping is awkward.)
5. After all stale specs are ingested, loop back to step 1 of Sync flow.

**Ingest prompt** (canonical — match the CLI's embedded version):

> Read the full spec. Extract features. Markdown headings are CANDIDATES, not authoritative:
> - rename headings to kebab-case feature names,
> - discard non-features (Background, References, Glossary),
> - add features only implied by body text.
>
> Arbitrary depth allowed. Soft cap: `maxDepth` from config (default 2). Verify-only spec (no implementable features) → single feature named `verify`.
>
> Output JSON matching the tree schema (see spec §6.1):
> ```json
> {
>   "spec": "<kebab>",
>   "specPath": "<rel-path>",
>   "specHash": "<placeholder — CLI overwrites>",
>   "features": [
>     { "name": "kebab", "source": "heading|implied", "originalHeading": "## ..." | null, "status": "todo", "children": [ ... ] }
>   ]
> }
> ```
>
> All `status` MUST be `todo`. CLI preserves prior status by name-match. Top-level names unique within spec.

### Islands step

The CLI prints:
- All tree JSON paths.
- An embedded PROMPT block.

You:

1. Read every listed `.specforest/trees/*.json` file.
2. Apply the Islands prompt.
3. Produce an islands JSON object.
4. Pipe to:
   ```
   echo '<json>' | node .claude/skills/specforest/bin/cli.js commit-islands
   ```
5. Loop back to step 1 of Sync flow.

**Islands prompt** (canonical):

> Build a graph over TOP-LEVEL features only (children of `tree.features[]`). Sub-features travel with their parent. If a spec text declares a dep on a sub-feature, HOIST the edge to its top-level ancestor and note the original target inside `reason`.
>
> Prefer EXPLICIT references (wikilinks `[[other-spec]]`, "depends on X", "requires Y") — `kind: "explicit-ref"`. Use SEMANTIC inference only as fallback — `kind: "semantic"`. EVERY edge MUST have a human-readable `reason`.
>
> Cluster into connected components. Top-level features with no edges form singleton islands of size 1. Every top-level feature MUST appear in exactly one island.
>
> Give each island a descriptive kebab-case theme name.
>
> Output:
> ```json
> {
>   "generatedAt": "<ISO-8601>",
>   "islands": [
>     {
>       "id": "isl_<6-char>",
>       "name": "kebab-theme",
>       "members": [ { "spec": "...", "feature": "..." } ],
>       "dependencies": [
>         {
>           "from": { "spec": "...", "feature": "..." },
>           "to":   { "spec": "...", "feature": "..." },
>           "kind": "explicit-ref" | "semantic",
>           "reason": "..."
>         }
>       ]
>     }
>   ]
> }
> ```
>
> Don't reference sub-features in `members` or `dependencies`. CLI re-uses prior island IDs based on largest member-set overlap; you may assign placeholder IDs.

### Incremental islands step

When sync emits `NEXT: incremental-islands` the existing `islands.json` is preserved. The CLI prints:
- Auto-prune notice (if it dropped orphaned members — features deleted from specs).
- The full existing-island summary (id, name, member count + first few members).
- The list of `uncovered top-level features` (newly added or renamed features needing placement).
- All tree JSON paths + the islands.json path.
- An embedded PROMPT block.

You:

1. Read `.specforest/islands.json` (full island detail) and every listed tree JSON.
2. Apply the embedded prompt verbatim.
3. For EACH uncovered feature, decide:
   - **(a) Extend** an existing island when the feature thematically belongs there:
     ```
     echo '{"addMembers":[{"spec":"...","feature":"..."}],"addDependencies":[...]}' | \
       node .claude/skills/specforest/bin/cli.js extend-island <id-or-name>
     ```
     Dependencies must stay WITHIN the target island.
   - **(b) Add a new island** when the feature is its own theme (or groups with other uncovered features):
     ```
     echo '{"name":"kebab-theme","members":[...],"dependencies":[...]}' | \
       node .claude/skills/specforest/bin/cli.js add-island
     ```
     The new island's members must not overlap any existing island.
4. If the work needs cross-island edges or member moves → abort the incremental flow and re-run `sync --recluster-islands` instead.
5. After all uncovered features are placed, re-run `sync` to render.

**Orphan auto-prune:** When a feature is deleted from a spec, the next sync drops it from any island that referenced it (members + edges). Empty islands are dropped silently. The notice in the stdout header lists what was pruned.

**Renames:** appear as `orphan + uncovered` because the prune drops the old name while the new name shows up uncovered. Reassign the new name back into the same island via `extend-island` to keep continuity.

## Add island

Standalone, additive: append ONE new island. Existing islands stay byte-identical.

Stdin schema (single object — NOT wrapped in `{islands:[...]}`):

```json
{
  "name": "kebab-theme",
  "members": [ { "spec": "...", "feature": "..." } ],
  "dependencies": [
    { "from": {...}, "to": {...}, "kind": "explicit-ref" | "semantic", "reason": "..." }
  ]
}
```

```
echo '<single-island-json>' | node .claude/skills/specforest/bin/cli.js add-island
```

Rejected if: member already in another island, member references unknown feature, dependencies cross island boundary, id/name collide with an existing island. The `id` is auto-generated if omitted.

## Extend island

Standalone, additive: append members (and intra-island dependencies) to ONE existing island. All other islands stay byte-identical.

```
echo '{"addMembers":[...],"addDependencies":[...]}' | \
  node .claude/skills/specforest/bin/cli.js extend-island <id-or-name>
```

Rejected if: target island not found, member already in any island, member references unknown feature, dependency endpoint outside the target island after extension. For cross-island moves or edges, re-run `sync --recluster-islands`.

## Implement flow

User asks to implement `<spec>/<feature>`:

1. Run:
   ```
   node .claude/skills/specforest/bin/cli.js implement <spec>/<feature>
   ```
2. Read the `NEXT: implement` block. It lists:
   - `specs-to-read`: full file paths. Read EVERY ONE in full (not excerpts).
   - `prerequisites`: each with its current status. Some may be `⚠ not done`.
   - `prompt`: embedded instructions.
3. If any prerequisite is `⚠ not done`:
   - Surface the list to the user. Ask: proceed anyway, implement prerequisites first, or abort.
   - DO NOT silently proceed past undone prereqs.
4. After the user confirms, plan + implement following project rules (TDD, planner agent if complex, coding-standards / security / testing guardrails from `CLAUDE.md` and `GUIDELINES.md`).
5. On completion:
   ```
   node .claude/skills/specforest/bin/cli.js mark <spec>/<feature> done
   ```
6. If paused / blocked:
   ```
   node .claude/skills/specforest/bin/cli.js mark <spec>/<feature> blocked
   ```
   And explain to the user why.

## Verify flow

User asks to verify `<spec>/<feature>` — i.e. check whether it is already implemented in the codebase.

1. Run:
   ```
   node .claude/skills/specforest/bin/cli.js verify <spec>/<feature>
   ```
   Accepts any current status (`todo` / `in_progress` / `blocked` / `done`). The command is **read-only** — it never mutates feature status.
2. Read the `NEXT: verify` block. It lists:
   - `target-status`: the current status, annotated `(no change)`.
   - `specs-to-read`: full file paths. Read EVERY ONE in full (not excerpts).
   - `prerequisites`: each with its current status. Some may be `⚠ not done`.
   - `prompt`: embedded instructions.
3. If any prerequisite is `⚠ not done`: surface the list to the user before continuing — the target may not be verifiable in isolation.
4. Inspect the codebase for evidence the feature is implemented using **Grep / Glob / Read only — never edits**:
   - Code paths, file structure, tests, configuration, migrations as the spec demands.
5. Report back to the user with **VERDICT** (implemented | partially implemented | not implemented), **EVIDENCE** (concrete file paths + line numbers), and **GAPS** (anything missing).
6. Suggest the matching follow-up `mark` command. Do NOT run `mark` yourself — the user (or the conversation) confirms first:
   ```
   node .claude/skills/specforest/bin/cli.js mark <spec>/<feature> <done|in_progress|todo|blocked>
   ```

## Tree view

`tree` does NOT dump the full forest to stdout by default — it would balloon Claude's context. Instead:

1. Run `status` first → one line per island with counters. Cheap orientation.
2. Need full detail? Run `tree`. Output is 3 lines:
   ```
   NEXT: read
   path: .specforest/tree.txt
   hint: run `specforest status` for island counters; pass --print to dump ASCII to stdout
   ```
   Use the **Read tool** on `path:` — do NOT `cat`/`type` it through bash (the cache can be huge).
3. Narrow drill-down: `tree <spec-name>` — sliced from cache, prints inline (small, safe).
4. Force rebuild: `tree --regenerate`.
5. Legacy stdout dump (debugging only): `tree --print`.

The cache (`.specforest/tree.txt`) is rewritten automatically by `sync` (after render), `mark`, `implement`, and `commit-islands`. `tree` regenerates it on demand if stale.

## Rehash flow

Use when a spec's bytes changed but its features did NOT (line-ending normalization, BOM removal, reformatting). Patches `specHash` in `.specforest/state.json` and `.specforest/trees/*.json` to match on-disk bytes WITHOUT re-ingesting or touching trees, islands, or progress.

```
node .claude/skills/specforest/bin/cli.js rehash            # apply
node .claude/skills/specforest/bin/cli.js rehash --dry-run  # report only
```

If features actually changed, use the Sync flow instead — `rehash` will not regenerate trees from new headings.

## Pitfalls + rules

- **Never ingest a sub-feature directly.** Top-level features only as nodes; sub-features live under them. The Islands prompt hoists sub-feature edges to their parent.
- **JSON via stdin only.** Never write tree JSON or islands JSON to disk yourself — always pipe through `ingest` / `commit-islands` / `add-island` / `extend-island` so the CLI can validate, archive, and reconcile IDs.
- **Default sync is incremental.** Only pass `--recluster-islands` when the user explicitly asks, or when the change genuinely needs cross-island moves / edges. Re-clustering shuffles island IDs (reconciled by member-overlap) and is more disruptive — prefer `add-island` / `extend-island` for everyday additions.
- **Cross-island edges are blocked from `add-island` / `extend-island`.** If a new feature has a dep crossing an existing island boundary, request `sync --recluster-islands` instead.
- **CLI overwrites `specHash` and `specPath`.** Don't waste tokens computing them.
- **`status` must be `"todo"` on ingest.** The CLI preserves prior status by name-match. Don't carry status across renames in your JSON — the CLI handles this and stashes lost progress in `orphanedProgress`.
- **Spec name collisions error out.** If two files yield the same kebab name, the CLI exits non-zero with both paths; user resolves by renaming.
- **`implement` already marks `in_progress`.** Don't double-mark unless the user passes `--no-mark`.
- **`verify` is read-only.** It never writes status. After reporting the verdict, suggest the appropriate `mark` follow-up; only run `mark` once the user confirms.
- **Wholesale regen.** `forest.md` and island MDs are projections of the JSON state. Never hand-edit them — your edits will be overwritten on next render. To edit progress: tick checkboxes (Obsidian-style markers; CLI parses them back).
- **Don't paraphrase the embedded prompts.** Use the CLI's printed prompt verbatim; this SKILL.md's prompt section is a reference, the CLI's stdout is the source of truth for any given run.

## Config

`specforest.config.yml` at project root. Defaults:

```yaml
specsDir: docs/specs
outputDir: docs/trees
hiddenDir: .specforest
specsGlob: "**/*.md"
ignore: []
maxDepth: 2
wikilinkStyle: obsidian
checkboxMarkers: { todo: " ", in_progress: "/", blocked: "-", done: "x" }
```

## See also

- Design spec: `docs/superpowers/specs/2026-05-18-specforest-skill-design.md`
