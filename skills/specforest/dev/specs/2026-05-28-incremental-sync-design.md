# Incremental Sync + `add-island` / `extend-island` — Design

**Date:** 2026-05-28
**Status:** Approved (brainstorming) — implementation landed in the same session
**Scope:** `.claude/skills/specforest` — sync command, two new CLI commands, prompt, SKILL.md docs.
**Companion to:** [.claude/skills/specforest/SKILL.md](../../SKILL.md),
[.claude/skills/specforest/src/commands/sync.js](../../src/commands/sync.js),
[.claude/skills/specforest/src/commands/commit-islands.js](../../src/commands/commit-islands.js).

## Purpose

`sync` historically had only one path for placing top-level features into
islands: emit `NEXT: islands`, expect Claude to re-cluster the entire forest,
pipe the result through `commit-islands`. That path **rebuilds every island
from scratch** and runs through `reconcileIds`, which can shuffle island IDs,
membership, themes, and dependency graphs even when the underlying change is a
single new spec.

In practice the operator (and Claude) almost always wants one of two narrower
operations:

- **Slot one or more new top-level features into an existing island** whose
  theme already matches.
- **Append a new island** for a thematically distinct batch of features, without
  touching any other island.

Re-clustering is correct only when features must *move between* islands or when
*cross-island* edges are introduced — i.e. when the island boundaries themselves
must change.

This spec defines an incremental sync mode (default) plus two surgical commands
that keep existing islands byte-identical, with `--recluster-islands` as the
escape hatch back to the full re-cluster path.

Use cases:

- New spec ingested → its top-level features get placed without disturbing the
  10 islands already in `islands.json`.
- A spec gains a new top-level feature → assign it to an existing island via
  `extend-island`, or spin up a new island via `add-island`.
- A spec loses a top-level feature → sync auto-prunes the dead member from any
  island that referenced it, drops empty islands silently.
- Operator wants the legacy global re-cluster (e.g. island taxonomy is stale)
  → `sync --recluster-islands`.

## Non-goals

- Changing the tree, island, or state JSON schemas. `members`, `dependencies`,
  `lastClusteredStructure`, `islandIdMap`, `previousIslandNames` all keep their
  current shape.
- Auto-merging islands. The incremental flow only *extends* or *adds*; merging
  two islands or moving a member between islands still requires
  `--recluster-islands`.
- Introducing a new island lifecycle status (e.g. "draft"). Islands written by
  `add-island` / `extend-island` are full citizens immediately.
- Auto-deciding extend-vs-add. Claude decides per uncovered feature based on
  the theme of existing islands and the feature's semantic affinity.
- Recovering from rename detection automatically. A rename surfaces as
  `orphan + uncovered` after auto-prune; the operator (or Claude) reassigns
  the new name back into the same island via `extend-island`.

## Surface

```
node .claude/skills/specforest/bin/cli.js sync [--recluster-islands]
node .claude/skills/specforest/bin/cli.js add-island                     # stdin: single-island JSON
node .claude/skills/specforest/bin/cli.js extend-island <id-or-name>     # stdin: { addMembers, addDependencies }
```

- `--recluster-islands` flag on `sync` — forces the full re-cluster path
  (emits `NEXT: islands`). Auto-applied when `islands.json` is absent.
- `add-island` — accepts a SINGLE island object on stdin (NOT an islands
  envelope). Existing islands are preserved byte-identical; only the new
  island is appended. `id` is auto-generated if omitted.
- `extend-island <id-or-name>` — accepts `{ addMembers, addDependencies }`
  on stdin. Target lookup falls back from id → name. Other islands untouched.

## Behaviour

### Sync decision tree

```
sync [--recluster-islands]
  │
  ├─ stale specs?      → NEXT: ingest             (unchanged)
  ├─ deleted specs     → archive tree(s)          (unchanged)
  │
  ├─ no islands.json   → NEXT: islands (full re-cluster)
  │
  ├─ --recluster-islands
  │                    → NEXT: islands (full re-cluster, banner-tagged)
  │
  └─ islands.json exists                          ← incremental path (NEW default)
       │
       1. auto-prune orphaned members (members no longer in any tree)
          drop empty islands
       2. compute uncovered = knownTopLevelFeatures \ islandMembers
       3. uncovered.length > 0
            → NEXT: incremental-islands
              (Claude runs add-island / extend-island per feature)
       4. uncovered.length === 0
            → if structuralChanged, bump lastClusteredStructure
            → render path (forest.md + island MDs)
            → on subsequent call: NEXT: clean
```

The render branch is unchanged in shape; the only addition is that a pruned or
deletion-triggered run forces `needsRender = true` so the rendered MDs reflect
the auto-prune.

### `add-island` semantics

Stdin schema (single object — **not** wrapped in `{islands:[...]}`):

```json
{
  "id": "isl_xxxxxx",          // optional — auto-generated if omitted
  "name": "kebab-case-theme",
  "members": [ { "spec": "<spec-kebab>", "feature": "<top-level-feature-kebab>" } ],
  "dependencies": [
    {
      "from": { "spec": "...", "feature": "..." },
      "to":   { "spec": "...", "feature": "..." },
      "kind": "explicit-ref" | "semantic",
      "reason": "..."
    }
  ]
}
```

Rejection rules:

| Condition | Error |
|---|---|
| No prior `islands.json` | "first cluster must go through `commit-islands`" |
| Stdin is an islands envelope (`{islands:[…]}`) | "use `commit-islands` for full re-cluster…" |
| Member references a feature not in any tree | "members reference unknown top-level features" |
| Member already belongs to an existing island | "members already belong to an existing island …" |
| Dependency endpoint outside the new island | "crosses island boundary" |
| `id` or `name` collides with an existing island | "island id/name collides with existing" |

On success: validate via `validateIslands(merged)`, write the merged envelope,
regenerate the tree cache, and report uncovered features still outstanding.
`lastClusteredStructure` is **not** written — sync owns it.

### `extend-island <id-or-name>` semantics

Stdin schema:

```json
{
  "addMembers": [
    { "spec": "<spec-kebab>", "feature": "<top-level-feature-kebab>" }
  ],
  "addDependencies": [
    {
      "from": { "spec": "...", "feature": "..." },
      "to":   { "spec": "...", "feature": "..." },
      "kind": "explicit-ref" | "semantic",
      "reason": "..."
    }
  ]
}
```

Target lookup: try `island.id === <arg>` first, fall back to
`island.name === <arg>`. On miss, error includes the full available list with
`<name>  (<id>)` per island.

Rejection rules:

| Condition | Error |
|---|---|
| Target island not found | "island not found by id or name: <arg>" + listing |
| `addMembers` and `addDependencies` both empty | "nothing to add" |
| Member references unknown feature | "addMembers reference unknown top-level features" |
| Member already in any island (target or other) | "addMembers already belong to an existing island" |
| Dependency endpoint outside the (post-extension) island | "crosses island boundary" |

On success: replace the target island with `{ ...island, members:
[...members, ...addMembers], dependencies: [...deps, ...addDependencies] }`,
validate the full envelope, write `islands.json`, regenerate tree cache. The
other islands are passed through unchanged in `Array.map` order — they are
byte-identical modulo the top-level `generatedAt` stamp.

### Orphan auto-prune

Triggered every incremental run. An *orphaned member* is one whose
`spec/feature` no longer appears in any tree (the feature was removed from the
spec, or the spec itself was deleted).

Algorithm:

1. Build `knownFeatures` from current trees.
2. For each island, filter `members` and `dependencies` to drop entries whose
   endpoints are orphaned.
3. If an island ends up with zero members, drop the island entirely.
4. Persist the pruned envelope back to `islands.json` (`generatedAt` updated).
5. Continue with the uncovered-features check on the pruned state.

The stdout for `NEXT: incremental-islands` includes a one-line auto-prune
notice when this fires:

```
auto-pruned <N> orphan member(s) from existing islands
dropped empty island(s): <name>/<id>, …       # only if any
```

Orphan auto-prune is **silent** when coverage is otherwise clean (no uncovered
features after pruning) — the sync falls through into the render branch and
reports `rendered: …` as usual.

### State ownership of `lastClusteredStructure`

| Writer | Reason |
|---|---|
| `commit-islands` | Authoritative full re-cluster — operator has reconciled the entire structure. |
| `sync` (incremental, when coverage complete) | Synchronises the fingerprint after `add-island` / `extend-island` finished placing everything. |
| ~~`add-island`~~ | Removed — was a bug: marking the structure "reconciled" after a single-island append would hide remaining uncovered features from the next sync. |
| `extend-island` | Never. Same reasoning. |

This places coverage adjudication in exactly one place: `sync` decides whether
the structure is fully clustered, every other command leaves the field alone.

## Output

### `NEXT: incremental-islands` block

```
NEXT: incremental-islands
[auto-pruned <N> orphan member(s) from existing islands]
[dropped empty island(s): <name>/<id>, …]
existing islands: <N>
uncovered top-level features: <M>
  - <spec>/<feature>
  - <spec>/<feature>

For each uncovered feature, pipe ONE of:
  - extend-island <id-or-name>   (add to an existing island, intra-island deps only)
  - add-island                    (create a NEW island; existing islands stay byte-identical)
Cross-island edges or member moves require: sync --recluster-islands

PROMPT:
--- begin prompt ---
<incrementalIslandsPrompt output>
--- end prompt ---
```

The two bracketed lines are conditional on the auto-prune actually firing. The
prompt block is the canonical Claude-driver text (see next section).

### `NEXT: islands` block (full re-cluster)

Unchanged from the legacy path, with one cosmetic addition: when triggered by
the explicit flag, the second line reads
`(mode: full re-cluster — --recluster-islands)`. The trees list and embedded
`islandsPrompt(...)` are identical to the pre-existing flow.

## Incremental islands prompt

Added as a new `incrementalIslandsPrompt(...)` export in
[src/prompts.js](../../src/prompts.js):

```
You are extending the specforest INCREMENTALLY. Existing islands are preserved.

Uncovered top-level features (newly added or renamed):
  - <spec>/<feature>
  - …

Existing islands (do NOT alter; only extend):
  - <name>  (<id>)  members:<count>  [<first 6 members>, +N more]
  - …

Trees on disk (read for feature context):
  - <relative tree path>
  - …

Existing islands.json (read for full members + dependencies):
  - <relative islands.json path>

INSTRUCTIONS:
1. Read .specforest/islands.json and the tree JSON files listed above.
2. For each uncovered feature, decide ONE of:

   (a) EXTEND an existing island — pick by semantic affinity to its theme / members.
       Pipe:

         cat <<JSON | node .claude/skills/specforest/bin/cli.js extend-island <id-or-name>
         {
           "addMembers": [ { "spec": "...", "feature": "..." } ],
           "addDependencies": [
             { "from": { … }, "to": { … }, "kind": "explicit-ref" | "semantic", "reason": "…" }
           ]
         }
         JSON

       Dependencies must stay WITHIN the target island (after extension).
       Cross-island edges are not allowed via extend-island.

   (b) CREATE a new island — group one or more uncovered features under a fresh theme.
       Pipe:

         cat <<JSON | node .claude/skills/specforest/bin/cli.js add-island
         {
           "name": "kebab-theme",
           "members": [ { "spec": "...", "feature": "..." } ],
           "dependencies": [ … ]
         }
         JSON

       Members must NOT already belong to any island; dependencies must stay inside
       the new island. Cross-island edges → request a full re-cluster.

3. If the uncovered features have HARD cross-island dependencies that cannot be
   modelled without changing existing island membership, abort the incremental
   flow and request:

     node .claude/skills/specforest/bin/cli.js sync --recluster-islands

4. After all uncovered features are placed, re-run `sync` to render.

NOTES:
- Existing island IDs / names / members must remain byte-identical (extend-island
  appends; add-island creates new). Renames or member moves require --recluster-islands.
- An island with one new singleton member and zero deps is fine.
- The CLI auto-prunes members whose underlying top-level feature no longer exists
  in any tree (true deletions). Renames look like "orphan + uncovered" — assign the
  new name back into the same island via extend-island to preserve continuity.
```

The "first 6 members + N more" preview keeps the prompt bounded — operators
with very large islands don't blow the prompt budget. Full island detail is
available via the `.specforest/islands.json` path printed above.

## Code changes

1. **New file** [.claude/skills/specforest/src/commands/extend-island.js](../../src/commands/extend-island.js)
   — implements `cmdExtendIsland`. Mirrors `add-island.js` for the validation
   plumbing (load config + paths, sync checkboxes, parse stdin, validate
   members against known features and existing-island ownership) but operates
   on one island in place instead of appending a fresh one.

2. **New file** [.claude/skills/specforest/src/commands/add-island.js](../../src/commands/add-island.js)
   — single-island additive command (`cmdAddIsland`). `lastClusteredStructure`
   write was removed in this session so the field is owned by `sync` only.

3. **Modified** [.claude/skills/specforest/src/commands/sync.js](../../src/commands/sync.js):
   - Accept `args` in the function signature; honour `--recluster-islands`.
   - Replace the binary `needsIslands` gate with the decision tree above.
   - Implement orphan auto-prune.
   - Emit `NEXT: incremental-islands` when coverage is incomplete.
   - Bump `lastClusteredStructure` when sync settles with complete coverage.
   - Force `needsRender` when the prune wrote `islands.json` or specs were
     deleted, so MDs catch up automatically.

4. **New export** [`incrementalIslandsPrompt`](../../src/prompts.js) in
   `src/prompts.js`. Reuses the formatting conventions of `islandsPrompt`
   (numbered instructions, fenced JSON skeletons, NOTES footer).

5. **Wire** [bin/cli.js](../../bin/cli.js):
   - Import `cmdAddIsland`, `cmdExtendIsland`.
   - Add `add-island: cmdAddIsland` and `extend-island: cmdExtendIsland` to
     `HANDLERS`.
   - Update the HELP block: `sync [--recluster-islands]` line, plus
     `add-island` and `extend-island` lines.

6. **SKILL.md** updates:
   - Description triggers: `'add an island'`, `'add a new island'`,
     `'extend an island'`, `'re-cluster islands'`, `'/specforest-add-island'`,
     `'/specforest-extend-island'`, `'/specforest-recluster'`.
   - **When to invoke** entries for the three new slash commands, each pointing
     to the matching flow section.
   - New **Sync flow** branch description (`NEXT: incremental-islands`) plus a
     decision rule for `--recluster-islands`.
   - New **Incremental islands step**, **Add island**, **Extend island**
     sections after the **Islands step**.
   - **Pitfalls + rules**: add "Default sync is incremental" and "Cross-island
     edges are blocked from `add-island` / `extend-island`".

## Verification (manual end-to-end)

Performed in the same session against the live `.specforest/islands.json`
(11 islands, 139 top-level features):

1. `sync` → `NEXT: clean` on a fully covered forest.
2. `sync --recluster-islands` → `NEXT: islands` with the full re-cluster banner
   and embedded `islandsPrompt`.
3. Manually removed one member from `islands.json` (`b7-startup-failfast` from
   `api-hardening-batch`) → `sync` → `NEXT: incremental-islands` listing it,
   plus the full existing-island summary.
4. `extend-island api-hardening-batch` with the missing member → "extended
   island 'api-hardening-batch' (isl_a34dbd); +1 member(s), +0 dep(s); 0
   top-level feature(s) still uncovered".
5. `sync` → `rendered: …`, then `sync` → `NEXT: clean`.
6. Injected a ghost member (`ghost-feature-that-does-not-exist`) into
   `api-hardening-batch` → `sync` auto-pruned silently and re-rendered.
   Subsequent `sync` → `NEXT: clean`.

Rejection paths exercised: `extend-island` unknown target (prints island
roster), member already in another island (`voice-architecture-overview` in
`voice-chat-stack`), member referencing unknown feature (`api-hardening/b3`).

## Out of scope

- A `move-member` command that shifts a member between two existing islands
  without a full re-cluster. Out of scope for v1 — current escape hatch is
  `sync --recluster-islands`.
- A `merge-islands <a> <b>` command. Same reasoning: rare and best handled by
  a full re-cluster, which lets Claude rebuild dependency edges from the spec
  text in a single pass.
- A `--dry-run` mode for `add-island` / `extend-island`. The validation errors
  already surface what would be wrong; no destructive operation happens before
  validation passes.
- Auto-detecting renames vs. delete-plus-new. The current "orphan + uncovered"
  pair is unambiguous *to the operator* but requires a human (or Claude) to
  match them up. A heuristic matcher could be added later but introduces false
  positives.
- Cross-spec dependency edges crossing newly-extended islands. The
  `extend-island` validation rejects them at write time; the operator falls
  back to `sync --recluster-islands`.
