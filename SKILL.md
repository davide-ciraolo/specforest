---
name: specforest
description: Build, maintain, and consume a feature-tree forest with dependency islands and progress tracking from project specs. Trigger when the user says "sync specforest" / "update the forest" / "show the forest" / "implement <feature>" / "build the forest" / "/specforest" / "/specforest-implement <spec>/<feature>".
---

# Specforest Skill

Turn project specs into a forest of feature trees, cluster features into dependency islands, render Obsidian-friendly Markdown, and track per-feature progress. Driven by a Node CLI for deterministic ops; this file tells you (Claude) how to drive it.

## When to invoke

- "sync specforest" / "update the forest" / "rebuild the trees" / `/specforest` → **Sync flow** (§ Sync).
- "show the forest" / "what's in the forest" / `/specforest-tree` → **Tree-view flow** (§ Tree view). Do not write. Pass `--regenerate` to force rebuild.
- "implement \<spec\>/\<feature\>" / "let's build \<feature\>" / `/specforest-implement` → **Implement flow** (§ Implement).
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

1. Run `node .claude/skills/specforest/bin/cli.js sync`.
2. Read stdout. Branch:
   - `NEXT: ingest` → see § Ingest step.
   - `NEXT: islands` → see § Islands step.
   - `rendered: …` → render just happened. Re-run `sync` once more to confirm `NEXT: clean`.
   - `NEXT: clean` → done.

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
- **JSON via stdin only.** Never write tree JSON or islands JSON to disk yourself — always pipe through `ingest` / `commit-islands` so the CLI can validate, archive, and reconcile IDs.
- **CLI overwrites `specHash` and `specPath`.** Don't waste tokens computing them.
- **`status` must be `"todo"` on ingest.** The CLI preserves prior status by name-match. Don't carry status across renames in your JSON — the CLI handles this and stashes lost progress in `orphanedProgress`.
- **Spec name collisions error out.** If two files yield the same kebab name, the CLI exits non-zero with both paths; user resolves by renaming.
- **`implement` already marks `in_progress`.** Don't double-mark unless the user passes `--no-mark`.
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
