# Specforest Skill — Design

**Status:** Locked design — ready for planning
**Date:** 2026-05-18
**Owner:** Davide
**Scope:** A reusable Claude skill that turns project specs into a forest of feature trees with dependency islands, progress tracking, and Obsidian-friendly Markdown output.

---

## 1. Goal

Help contributors (and Claude) plan implementation by:

1. Extracting feature trees from every spec file.
2. Clustering features into dependency **islands** (connected components of cross-spec feature dependencies).
3. Surfacing the result as Obsidian-friendly Markdown (`forest.md` + one MD per island).
4. Tracking per-feature progress (`todo` / `in_progress` / `blocked` / `done`).
5. Re-syncing on spec changes without losing progress.

Minimal/simple. Node.js CLI + a SKILL.md that drives Claude. No LLM calls from Node — Claude does all reasoning; Node does deterministic ops.

---

## 2. Architecture

Two cooperating layers, colocated under `<project>/.claude/skills/specforest/`.

### 2.1 Node CLI (deterministic)

- File scan, SHA-256 hashing of spec files.
- JSON read/write of trees + islands.
- Checkbox parse/render in island MDs (round-trip).
- Wholesale regeneration of `forest.md` + `<island>.md` files.
- ASCII tree print with `[x/N]` counters.
- Archive moves on rename/merge/delete.
- No LLM calls.

### 2.2 SKILL.md (LLM driver)

- Tells Claude how to drive `specforest sync` and which sub-commands to call.
- Carries the **Ingest prompt** and **Islands prompt** templates verbatim so Claude has explicit instructions regardless of context.

### 2.3 Invocation

- No npm publish. Skill is copied into each project's `.claude/skills/specforest/`.
- Dependencies installed once via `npm install` inside the skill dir.
- Claude invokes the CLI as `node .claude/skills/specforest/bin/cli.js <cmd>` from the project root.
- `node_modules/` under the skill dir is gitignored.

---

## 3. Sync flow

`specforest sync` is the orchestrator. It is **idempotent** and **stateless across runs**: it inspects the filesystem, computes the next required action, prints it, exits 0. Claude re-runs `sync` after each action until output reads `NEXT: clean`.

### 3.1 State machine (CLI-side)

```
state = read .specforest/state.json
compute liveSpecs   = files matching specsGlob in specsDir minus ignore
compute stale       = liveSpecs whose sha256 != state.specHashes[name] OR new
compute deleted     = state.specHashes names with no matching liveSpec

1. if stale not empty:
     print "NEXT: ingest"
     list stale spec paths + the Ingest prompt
     (archive of prior tree.json happens inside `ingest`, not here — see §9)
     exit 0

2. if deleted not empty:
     for each deleted: archive its tree.json, drop from state.specHashes
     (no early exit — fall through; islands must recompute)

3. needsIslands = (deleted was not empty) OR (any tree.json mtime > islands.json mtime) OR (islands.json missing)
   if needsIslands:
     print "NEXT: islands"
     list all tree.json paths + the Islands prompt
     exit 0

4. needsRender = (islands.json mtime > state.lastRender) OR (any tree.json mtime > state.lastRender) OR (forest.md missing)
   if needsRender:
     run render internally; update state.lastRender; exit 0

5. print "NEXT: clean"; update state.lastSync; exit 0
```

### 3.2 Loop (Claude-side, per SKILL.md)

1. Run `specforest sync`. Read stdout.
2. If `NEXT: ingest`:
   - For each listed spec path, read the file, produce a tree JSON matching §6.1.
   - Pipe each JSON to `specforest ingest <spec-name>` via stdin.
   - Re-run `sync`.
3. If `NEXT: islands`:
   - Read all `.specforest/trees/*.json`.
   - Produce an islands JSON matching §6.2 (one connected component per island, every edge has `kind` + `reason`).
   - Pipe to `specforest commit-islands`.
   - Re-run `sync`.
4. If `NEXT: clean`: done.

### 3.3 Implement command

`specforest implement <spec>/<feature> [--no-mark]` is the entry point Claude uses when the user says "implement X" / `/specforest-implement X`. CLI behavior:

1. **Validate** the `<spec>/<feature>` target:
   - `<spec>` must exist in `.specforest/trees/`.
   - `<feature>` must be a **top-level feature** in that spec's tree (sub-features are not directly implementable — their parent is the unit; if user passes a sub-feature, error suggesting the parent).
   - Refuse if current status is `done` (require explicit `mark` to reopen first).

2. **Resolve specs to read** (transitive closure over deps):
   - Start with the target's own spec.
   - Follow every outgoing dependency edge from the target (within `islands.json`); collect `to.spec`.
   - Recurse on each newly-added prerequisite feature using its own outgoing edges.
   - Dedupe by spec path.
   - Cycle-safe (visited set).

3. **Resolve prerequisite features** (same traversal, but collect `{spec, feature, status}` tuples).

4. **Print a `NEXT: implement` block** to stdout for Claude:
   ```
   NEXT: implement
   target: <spec>/<feature>
   target-status: todo  →  in_progress    (or "unchanged" with --no-mark)
   specs-to-read:
     - docs/specs/<owner-spec>.md
     - docs/specs/<dep-spec-1>.md
     - …
   prerequisites:
     - <spec-a>/<feature-x>  [done]
     - <spec-b>/<feature-y>  [todo]   ⚠ not done
   prompt: |
     <Implement prompt — see §14>
   ```
   When any prerequisite is not `done`, the line is flagged `⚠ not done` and the prompt instructs Claude to surface this to the user and confirm before proceeding.

5. **State mutation:** unless `--no-mark`, set target's `status: "in_progress"` in `.specforest/trees/<spec>.json`, run `syncCheckboxes()` afterwards so the island MD reflects it. `--no-mark` skips this for read-only planning.

6. **Exit 0** after printing. Implementation work itself is entirely Claude-driven — CLI does no further coordination. When Claude finishes the work, it calls `specforest mark <spec>/<feature> done` per the prompt.

Notes:

- `implement` does **not** run `specforest sync` first. It assumes the forest is current; if specs have drifted from `.specforest/trees/`, the resolution is computed against the cached trees. (Claude can run `sync` beforehand if needed; SKILL.md may recommend that, but CLI does not force it.)
- If the target feature has zero outgoing dependencies, `specs-to-read` is just its own spec and `prerequisites` is empty — the simplest path.
- Cycles in the dep graph: traversal is visited-set-guarded; the cycle is reported in the output as `cycle-warning: A → B → A` and Claude proceeds anyway (deps are advisory).

### 3.4 Checkbox round-trip

Every command that touches state runs `syncCheckboxes()` first:

1. Parse existing `<outputDir>/<island>.md` files.
2. Read each `- [marker] <feature-name>` line; map marker → status.
3. Patch matching feature `status` in `.specforest/trees/<spec>.json` (match by spec name + feature kebab name).
4. Unknown / corrupt markers logged as warnings, treated as `todo`.
5. Orphan checkboxes (feature deleted from spec) stashed in `state.json` under `orphanedProgress` keyed by `<spec>/<feature>`.

This guarantees: user ticks checkbox in Obsidian → next CLI invocation persists it before any regen.

---

## 4. CLI surface

```
specforest init                       # create config + folders; auto-create config if missing
specforest sync                       # orchestrator (see §3)
specforest scan                       # read-only stale report (JSON)
specforest ingest <spec-name>         # stdin: tree JSON → .specforest/trees/<spec-name>.json
specforest commit-islands             # stdin: islands JSON → .specforest/islands.json
specforest render                     # syncCheckboxes + regenerate forest.md + island MDs
specforest tree                       # ASCII forest (whole)
specforest tree <spec-name>           # ASCII subtree for one spec
specforest mark <spec>/<feature> <state>   # set feature status; states: todo|in_progress|blocked|done
specforest implement <spec>/<feature> [--no-mark]   # guide Claude to implement the feature (see §3.3)
specforest status                     # one-line counters per island + total
```

All commands run `syncCheckboxes()` first except `init` and `scan` (scan is purely read-only against the filesystem). Read-only display commands (`tree`, `status`) sync checkboxes so the displayed counters reflect Obsidian-side edits. Exit code 0 on success, 1 on validation error, 2 on lock contention.

---

## 5. On-disk layout

Relative to project root:

```
<specsDir>/                          # input — default docs/specs
  foo.md
  bar.md
  …
<outputDir>/                         # output — default docs/trees (regenerated wholesale)
  forest.md
  <island-name>.md
.specforest/                         # cache — default hidden dir
  config.resolved.json               # effective config snapshot (for debugging)
  state.json                         # spec hashes, last sync timestamp, orphanedProgress, islandIdMap
  islands.json                       # current island clustering + stable IDs
  trees/<spec-name>.json             # one per spec, output of ingest
  archive/
    trees/<spec-name>-<hash>.json    # historical tree snapshots
    islands/<island-name>-<hash>.md  # historical island MDs
  sync.lock                          # PID-stamped file lock; stale after 5 min
specforest.config.yml                # user-edited config (at project root)
.claude/skills/specforest/           # the skill itself
  SKILL.md
  bin/cli.js
  src/…                              # CLI source modules
  package.json
  node_modules/                      # gitignored
```

`.specforest/` may be either gitignored or committed depending on whether the team wants to share progress state. Default: not gitignored (sharing progress is useful).

---

## 6. Data model

### 6.1 Tree JSON (`.specforest/trees/<spec-name>.json`)

```json
{
  "spec": "multi-user-auth",
  "specPath": "docs/specs/2026-05-13-multi-user-auth-design.md",
  "specHash": "sha256:…",
  "features": [
    {
      "name": "oidc-login-flow",
      "source": "heading",
      "originalHeading": "## OIDC Login",
      "status": "todo",
      "children": [
        { "name": "discovery-doc-fetch", "source": "heading", "originalHeading": "### Discovery", "status": "todo", "children": [] },
        { "name": "token-validation",    "source": "implied",  "originalHeading": null,           "status": "todo", "children": [] }
      ]
    }
  ]
}
```

- `name`: kebab-case identifier. Used as feature ID within the spec namespace.
- `source`: `"heading"` (derived from a markdown heading) or `"implied"` (added by LLM from body text).
- `originalHeading`: verbatim heading text if `source = "heading"`, else `null`.
- `status`: one of `todo` / `in_progress` / `blocked` / `done`.
- `children`: same shape, recursive.
- `verify-only` specs: `features: [{ "name": "verify", "source": "implied", "originalHeading": null, "status": "todo", "children": [] }]`.

### 6.2 Islands JSON (`.specforest/islands.json`)

```json
{
  "generatedAt": "2026-05-18T12:00:00Z",
  "islands": [
    {
      "id": "isl_a1b2c3",
      "name": "auth-and-tenant-isolation",
      "members": [
        { "spec": "multi-user-auth",   "feature": "oidc-login-flow" },
        { "spec": "worker-pool",       "feature": "context-binding" }
      ],
      "dependencies": [
        {
          "from": { "spec": "worker-pool",     "feature": "context-binding"  },
          "to":   { "spec": "multi-user-auth", "feature": "oidc-login-flow" },
          "kind": "explicit-ref",
          "reason": "worker-pool spec wikilinks [[multi-user-auth]] in §3"
        }
      ]
    }
  ]
}
```

- `id`: stable across runs. New islands get `isl_<6-char-random>`. On re-cluster, an existing ID is reused for the new island with the **largest member-set overlap** with the previous version.
- `name`: LLM-chosen kebab-case theme. May change across runs.
- `members`: **top-level features** (children of `tree.features[]`) that belong to this island's connected component, listed by `{ spec, feature }`. Top-level features with no dependency edges form **singleton islands** of size 1. Every top-level feature in every tree JSON appears in exactly one island in `islands.json` — partition over top-level features.
- Sub-features always travel with their parent top-level feature (they live under it in the rendered MD per §7.2) and contribute to that island's counters. LLM-detected edges between sub-features count as edges between their respective top-level feature ancestors.
- `dependencies.kind`: `"explicit-ref"` (the spec text explicitly references another spec/feature — wikilink, "depends on X", etc.) or `"semantic"` (LLM inferred).
- `dependencies.reason`: human-readable, audit-friendly string.
- `dependencies.from` / `to`: always `{ spec, feature }` where `feature` is a top-level feature name. If the spec actually mentioned a sub-feature, the LLM hoists the edge to its top-level ancestor and notes the original target in `reason`.

### 6.3 State JSON (`.specforest/state.json`)

```json
{
  "lastSync": "2026-05-18T12:00:00Z",
  "lastRender": "2026-05-18T12:00:00Z",
  "specHashes": { "multi-user-auth": "sha256:…" },
  "islandIdMap": {
    "isl_a1b2c3": ["multi-user-auth/oidc-login-flow", "worker-pool/context-binding"]
  },
  "orphanedProgress": {
    "multi-user-auth/legacy-feature-name": { "status": "done", "lostAt": "2026-05-18T11:55:00Z" }
  }
}
```

- `lastSync`: timestamp of the last `specforest sync` invocation that reached `NEXT: clean`.
- `lastRender`: timestamp of the last successful render (used by §3.1 step 5).

---

## 7. Rendered output (Obsidian)

All output regenerated wholesale on every render. User-authored prose between syncs is **not** preserved — canonical state is the JSON, MDs are projections.

### 7.1 `forest.md`

```markdown
# Forest

_Last sync: 2026-05-18 — 3 islands, 12/47 features done_

- [[auth-and-tenant-isolation]] — 2 specs, [4/15]
- [[voice-pipeline]] — 1 spec, [0/8]
- [[visualizer-protocol]] — 1 spec, [8/24]
```

### 7.2 `<island-name>.md`

```markdown
# auth-and-tenant-isolation

[4/15]

## Specs
- [[2026-05-13-multi-user-auth-design]]
- [[2026-05-13-worker-process-pool-design]]

## Features

### From [[2026-05-13-multi-user-auth-design]]
- [/] oidc-login-flow [1/2]
  - [x] discovery-doc-fetch
  - [ ] token-validation
- [ ] csrf-protection

### From [[2026-05-13-worker-process-pool-design]]
- [-] context-binding

## Dependencies
- worker-pool/context-binding → multi-user-auth/oidc-login-flow _(explicit-ref: §3 wikilink)_
```

Conventions:

- Wikilinks use spec **basename without extension** so Obsidian resolves them against `specsDir`.
- Checkbox markers map 1:1 to statuses via `config.checkboxMarkers`.
- `[x/N]` counter on every parent feature (sum of leaves with `status=done` under it) and at the top of the file (sum of all leaves in island).
- If the dependency graph contains a cycle, render flags it: `⚠ cycle: A → B → A`.

### 7.3 ASCII tree (`specforest tree`)

```
forest [12/47]
├── auth-and-tenant-isolation [4/15]
│   ├── multi-user-auth
│   │   ├── [/] oidc-login-flow [1/2]
│   │   │   ├── [x] discovery-doc-fetch
│   │   │   └── [ ] token-validation
│   │   └── [ ] csrf-protection
│   └── worker-pool
│       └── [-] context-binding
├── voice-pipeline [0/8]
│   └── …
└── visualizer-protocol [8/24]
    └── …
```

`specforest tree <spec-name>` prints just that spec's subtree under its island.

---

## 8. Config (`specforest.config.yml`)

```yaml
specsDir: docs/specs
outputDir: docs/trees
hiddenDir: .specforest
specsGlob: "**/*.md"
ignore: []
maxDepth: 2
wikilinkStyle: obsidian          # only option in v1
checkboxMarkers:
  todo: " "
  in_progress: "/"
  blocked: "-"
  done: "x"
```

- Missing config → `specforest init` writes this default.
- Other commands: missing config → exit 1 with "run `specforest init` first".
- `maxDepth` is a soft cap given to the LLM via the Ingest prompt; CLI does not truncate trees that exceed it (LLM may go deeper if a spec clearly demands).

---

## 9. Change detection

- **Trigger:** `specforest sync` hashes every file matching `specsDir/specsGlob` minus `ignore`. Compare to `state.json.specHashes`.
- **Stale spec:** sha differs or name not in state → re-ingest. New tree replaces previous; previous tree archived to `.specforest/archive/trees/<spec>-<oldhash>.json`.
- **Deleted spec:** name in state but file missing → archive its tree, drop from `state.specHashes`, remove members from islands on next island recompute.
- **Progress preservation:** feature `status` carried over when feature `name` matches (Q6 answer A). A rename = remove + add; old status stashed in `orphanedProgress` for one round so user can manually `mark` the new name.

---

## 10. Island restructure

When `commit-islands` writes a new `islands.json`:

1. Build member-set fingerprint for every previous island and every new island.
2. For each new island, find the previous island with the largest member-set overlap (≥ 1 shared member). Reuse its `id`.
3. If a new island has no overlap with any previous → new `id`.
4. If a previous island has no successor → its members fully dispersed; ID retired.
5. For each previous `<old-name>.md` whose ID survived but name changed → move old MD to `.specforest/archive/islands/<old-name>-<timestamp>.md`.
6. For each retired ID → archive its MD.
7. Write the new MDs and `forest.md`.

---

## 11. Errors + edge cases

| Case | Behavior |
|---|---|
| Missing config | Auto-create on `init`; other cmds exit 1 with "run init first" |
| Invalid JSON piped to `ingest` / `commit-islands` | Schema-validate inline (no `ajv`), print field-path errors, exit 1, no state mutation |
| Spec kebab-name collision (two paths) | Exit 1, list both paths, user resolves |
| Checkbox parse failure | Warn, treat unknown markers as `todo`, continue. Never lose progress silently |
| Orphan checkboxes (feature deleted) | Status stashed in `state.json.orphanedProgress` |
| Concurrent `sync` | File-lock `.specforest/sync.lock` (PID-stamped). Stale lock cleanup after 5 min. Exit 2 on contention |
| Renamed island | Old MD archived, new MD written, stable ID preserved per §10 |
| Empty `specsDir` | `forest.md` reads "no specs yet" |
| Spec with zero features and no body | Treated as verify-only |
| Dependency cycle | Permitted (advisory); rendered with `⚠ cycle: …` note in island MD |
| Spec deleted | Tree archived, features removed from islands, MD regenerated |
| `implement` target missing | Exit 1, suggest closest match by Levenshtein distance |
| `implement` target is a sub-feature | Exit 1, suggest its parent top-level feature |
| `implement` target already `done` | Exit 1, suggest `specforest mark … todo` to reopen |
| `implement` with no `islands.json` | Exit 1, instruct user to run `specforest sync` first |

---

## 12. Dependencies + packaging

- Node ≥ 18, ESM only.
- npm deps (kept small):
  - `js-yaml` — config parsing.
  - `picomatch` — glob matching for `specsGlob` + `ignore`.
- No JSON-schema library; validation is hand-rolled per schema in §6 (tiny surface).
- No CLI arg parser dep; hand-rolled argv parse (≤ 50 lines).
- `package.json` in skill dir has no `bin` field (no npm install). Invocation is always `node bin/cli.js`.
- `node_modules/` gitignored under skill dir.

---

## 13. Testing strategy

- **Unit (`node:test`):** pure functions — sha256, kebab-case, checkbox parse/render, ASCII tree render, counter rollup, stable-ID matching, glob filtering, config validation.
- **Integration:** fixture project under `test/fixtures/` with sample specs, expected tree JSONs, expected islands JSON, expected rendered MDs. Run CLI commands, snapshot-assert outputs.
- **No LLM tests:** Step 1/2 prompts are not tested in CLI scope; instead the pipe-in entry points are tested with canned JSON.
- Coverage target: 80% per project rule.

---

## 14. SKILL.md outline

`SKILL.md` ships in the skill dir. Its body (high level):

- **Triggers:**
  - "sync specforest" / "update the forest" / "show the forest" / `/specforest` → sync flow.
  - "implement \<feature\>" / "let's build \<feature\>" / `/specforest-implement <spec>/<feature>` → implement flow.
- **Sync flow:** run `node .claude/skills/specforest/bin/cli.js sync`. Read stdout. Branch on `NEXT: …`. Loop until `NEXT: clean`. The CLI's stdout includes the prompt template Claude should use for that step.
- **Implement flow:** run `node .claude/skills/specforest/bin/cli.js implement <spec>/<feature>`. Read `NEXT: implement` block from stdout. Follow embedded prompt (see Implement prompt template below).
- **Ingest prompt template** (embedded verbatim): instructs Claude to extract features from a spec using markdown headings as candidates but renaming/discarding/extending per body text, capped at `maxDepth`, verify-only fallback, kebab-case names, JSON shape per §6.1.
- **Islands prompt template** (embedded verbatim): instructs Claude to find dependencies across features, prefer explicit refs (wikilinks, "depends on X") with `kind=explicit-ref`, fallback to `kind=semantic`, every edge has `reason`, cluster into connected components, name islands with descriptive kebab-case themes, top-level features only per §6.2, JSON shape per §6.2.
- **Implement prompt template** (embedded verbatim): instructs Claude to:
  1. Read every spec in `specs-to-read` (full files, not excerpts).
  2. Check `prerequisites` — if any is not `done`, surface the list to the user and confirm whether to proceed, implement prerequisites first, or abort.
  3. Plan the implementation following project rules (TDD, planner agent if complex, coding-style guardrails from CLAUDE.md / GUIDELINES.md).
  4. Implement the feature.
  5. On completion, run `specforest mark <spec>/<feature> done`.
  6. On failure or pause, run `specforest mark <spec>/<feature> blocked` with a brief note for the user.

---

## 15. Out of scope (v1)

- Watch mode (`specforest watch`).
- Web UI / dashboards.
- Non-Obsidian wikilink styles.
- Multi-project / cross-repo island fusion.
- LLM calls from inside Node (skill is and stays Claude-orchestrated).
- Automated migration of user notes alongside the regenerated MDs (the MD files are projections, not user-edited documents).

---

## 16. Open questions

None. All decisions locked via brainstorming Q&A 2026-05-18.
