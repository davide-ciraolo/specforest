# specforest

Turn project spec files into a forest of feature trees, cluster features into dependency islands, render Obsidian-friendly Markdown, and track per-feature progress with checkbox round-trips.

A **hybrid CLI + LLM skill**:
- The Node CLI does deterministic work: hashing, change detection, validation, ID reconciliation, rendering, locking.
- Claude does the language-aware work: reading specs to extract features and inferring dependencies between them.

The CLI emits explicit `NEXT: <state>` markers (and embedded prompts) telling Claude exactly what to do next. SKILL.md describes that loop.

---

## When to use

- You maintain a project with several spec files and want to see, at a glance, which features depend on which.
- You want a checklist that survives spec edits — progress is preserved across renames, ingests, and re-clusterings whenever feature names are stable.
- You use Obsidian (or any wikilink-aware MD viewer) and want a forest you can navigate and tick boxes on.

---

## Layout

```
.claude/skills/specforest/
├── SKILL.md            # Claude-facing skill instructions
├── README.md           # this file
├── bin/cli.js          # entry point
├── src/                # commands + pure modules
├── tests/              # 67 tests (node:test)
└── package.json
```

After `init`, the host project will look like:

```
<project>/
├── specforest.config.yml      # config (created by `init`)
├── docs/specs/                # spec files live here (configurable)
├── docs/trees/                # forest.md + one MD per island (configurable)
└── .specforest/               # internal state (gitignore this)
    ├── config.resolved.json
    ├── state.json
    ├── islands.json
    ├── trees/
    │   ├── <spec>.json
    │   └── ...
    └── archive/{trees,islands}/
```

---

## Install

Requires **Node >= 18**. The skill is self-contained — copy the directory into your project, install two runtime deps, done. No npm registry publish.

### 1. Drop the skill into your project

Pick one:

```bash
# Option A — clone the parent repo somewhere and copy the skill out
git clone https://github.com/OrionisBio/furiosa.git /tmp/furiosa
mkdir -p .claude/skills
cp -r /tmp/furiosa/.claude/skills/specforest .claude/skills/

# Option B — git subtree (keeps the skill updatable)
git remote add specforest-upstream https://github.com/OrionisBio/furiosa.git
git subtree add --prefix=.claude/skills/specforest specforest-upstream develop --squash -- .claude/skills/specforest

# Option C — sparse checkout (only the skill, no rest of the repo)
git clone --filter=blob:none --no-checkout https://github.com/OrionisBio/furiosa.git /tmp/furiosa
git -C /tmp/furiosa sparse-checkout set .claude/skills/specforest
git -C /tmp/furiosa checkout develop
cp -r /tmp/furiosa/.claude/skills/specforest .claude/skills/
```

### 2. Install runtime deps

```bash
cd .claude/skills/specforest
npm install
cd -
```

### 3. Wire it into your agent tool

The CLI works standalone — `node .claude/skills/specforest/bin/cli.js <command>` from project root is enough. The tool-specific steps below just make the agent **discover** the skill and drive the sync loop autonomously.

#### Claude Code

Already configured. Claude Code auto-discovers any `.claude/skills/<name>/SKILL.md` in the project. After step 1+2:

```bash
node .claude/skills/specforest/bin/cli.js init
```

Then in Claude Code, just say: `"sync the specforest"` or `"implement auth/login"`. Claude reads `SKILL.md` and drives the loop.

To make it available across **all** your projects, copy to `~/.claude/skills/specforest/` instead.

#### OpenCode (sst/opencode)

OpenCode doesn't auto-discover Anthropic-style skills, but it reads `AGENTS.md` at the project root. Add a pointer:

```markdown
# AGENTS.md

## specforest skill
A spec-driven feature forest CLI lives at `.claude/skills/specforest/`.
Read `.claude/skills/specforest/SKILL.md` before answering any user request
involving specs, features, dependencies, or progress tracking.
```

Then `opencode` will pull the SKILL.md into context on demand.

#### Cursor / Windsurf / Continue

Add a project rule that points the agent at SKILL.md:

```
# .cursor/rules/specforest.md  (Cursor)
# .windsurfrules                (Windsurf)
# .continue/rules.md            (Continue)

When the user asks about specs, features, dependencies, or wants to
"sync the forest" / "implement X/Y", read
`.claude/skills/specforest/SKILL.md` and follow its instructions.
The CLI is at `.claude/skills/specforest/bin/cli.js`.
```

#### Aider, Codex CLI, or any other tool with no skills concept

Just run the CLI manually and paste the embedded prompts into the agent yourself. `sync` prints exactly what the LLM needs to read and what to pipe back:

```bash
node .claude/skills/specforest/bin/cli.js sync
# → emits a PROMPT block per stale spec; paste it into your chat,
#   then pipe the LLM's tree JSON back through `ingest <spec-name>`.
```

The CLI is the contract — any LLM that can read a spec file and emit JSON can drive it.

### 4. Gitignore the state dir

```bash
echo ".specforest/" >> .gitignore
```

(Or commit it deliberately — your call. Most teams gitignore it and treat the rendered `docs/trees/` MDs as the shareable artifact.)

---

## Quick start

From the project root:

```bash
# 1. one-time bootstrap
node .claude/skills/specforest/bin/cli.js init

# 2. drop your spec files into docs/specs/ (or whatever you configured)
#    each `.md` becomes one tree in the forest.

# 3. let Claude drive the loop:
#    (ask: "sync the specforest" — SKILL.md will route Claude through the sync flow)
node .claude/skills/specforest/bin/cli.js sync
```

The `sync` command is idempotent and self-describing. Run it; it tells you what state it's in and what to do next.

---

## Commands

| Command | Purpose |
|---|---|
| `init` | Create `specforest.config.yml`, `docs/specs/`, `docs/trees/`, `.specforest/`. |
| `sync` | Orchestrator. Emits `NEXT: ingest`, `NEXT: islands`, `rendered: …`, or `NEXT: clean`. |
| `scan` | Read-only stale report as JSON (no state writes). |
| `ingest <spec-name>` | Reads tree JSON from stdin, validates, stores under `.specforest/trees/`. |
| `commit-islands` | Reads islands JSON from stdin, validates, reconciles IDs, writes `.specforest/islands.json`. |
| `render` | Force regenerate `forest.md` + island MDs. |
| `tree [<spec-name>]` | Print full forest as ASCII (or just one spec). Runs checkbox round-trip first. |
| `status` | One-line per-island counters. |
| `mark <spec>/<feature> <state>` | Set feature status: `todo` / `in_progress` / `blocked` / `done`. |
| `implement <spec>/<feature> [--no-mark]` | Print specs-to-read + prerequisites + embedded prompt, and mark the target `in_progress`. |
| `rehash [--dry-run]` | Resync `specHash` in state + trees to match on-disk bytes (no tree regen, no status touch). |

---

## Workflow

### Sync loop (driven by Claude)

```
$ node .claude/skills/specforest/bin/cli.js sync
NEXT: ingest
stale: 2
  - auth.md  (spec-name: auth)
  - dashboard.md  (spec-name: dashboard)

For EACH stale spec, run:
  1. read the spec file (full content)
  2. emit a tree JSON matching the schema below
  3. pipe it: node .claude/skills/specforest/bin/cli.js ingest <spec-name>
  4. re-run: node .claude/skills/specforest/bin/cli.js sync


PROMPT for auth (use verbatim):
--- begin prompt ---
You are ingesting a spec into the specforest.

Spec path: auth.md
Spec name (kebab): auth
…
--- end prompt ---

PROMPT for dashboard (use verbatim):
…
```

Claude reads each spec, emits tree JSON, pipes it through `ingest`, then re-runs `sync`. Next state:

```
$ node .claude/skills/specforest/bin/cli.js sync
NEXT: islands
trees: 2
  - .specforest/trees/auth.json
  - .specforest/trees/dashboard.json

Cluster all trees into dependency islands. Pipe the result:
  node .claude/skills/specforest/bin/cli.js commit-islands

PROMPT:
--- begin prompt ---
You are clustering the specforest into dependency islands.
…
```

Claude reads every tree, produces an islands JSON (connected-component clustering with `explicit-ref` / `semantic` edge labels), pipes it through `commit-islands`. Next:

```
$ node .claude/skills/specforest/bin/cli.js sync
rendered: forest.md + 1 island MD(s) at <project>/docs/trees

$ node .claude/skills/specforest/bin/cli.js sync
NEXT: clean
```

Done. The forest is up to date.

### Implement a feature

```
$ node .claude/skills/specforest/bin/cli.js implement dashboard/widget-grid
NEXT: implement
target: dashboard/widget-grid
target-status: todo → in_progress
specs-to-read:
  - docs/specs/dashboard.md
  - docs/specs/auth.md
prerequisites:
  - auth/login  [todo]   ⚠ not done
prompt: |
  You are implementing a feature from the specforest.

  Target: dashboard/widget-grid
  Specs to read (FULL FILES, not excerpts):
    - docs/specs/dashboard.md
    - docs/specs/auth.md

  Prerequisites:
    - auth/login  [todo]   ⚠ not done

  INSTRUCTIONS:
  1. Read every spec file listed above in full.
  2. WARNING: one or more prerequisites are not done. Surface this list to the user
     and confirm: proceed anyway, implement prerequisites first, or abort.
  3. Plan the implementation following project rules (TDD, planner agent if the work
     is complex, coding-standards / security / testing guardrails from CLAUDE.md and
     GUIDELINES.md).
  4. Implement the feature.
  5. On completion: run `node .claude/skills/specforest/bin/cli.js mark dashboard/widget-grid done`.
  6. If the work is paused / blocked: run `node .claude/skills/specforest/bin/cli.js mark dashboard/widget-grid blocked` and explain why to the user.
```

The CLI:
- Resolves all transitive prerequisites via the dependency graph.
- Lists every spec file that must be read (target + all upstream deps).
- Flags prerequisites that aren't `done` with `⚠ not done`.
- Marks the target `in_progress` (unless `--no-mark`).

After the work is done:

```
$ node .claude/skills/specforest/bin/cli.js mark dashboard/widget-grid done
marked dashboard/widget-grid → done
```

### Inspect

```
$ node .claude/skills/specforest/bin/cli.js tree
forest [1/3]
└── auth-and-dashboard [1/3]
    ├── auth
    │   ├── [x] login
    │   └── [ ] logout
    └── dashboard
        └── [/] widget-grid
```

```
$ node .claude/skills/specforest/bin/cli.js status
forest: 1 islands, [1/3]
  auth-and-dashboard: [1/3] (2 specs)
```

`tree <spec-name>` narrows to a single spec subtree.

---

## Rendered output

`docs/trees/forest.md`:

```markdown
# Forest

_Last sync: 2026-05-18 — 1 islands, 1/3 features done_

- [[auth-and-dashboard]] — 2 specs, [1/3]
```

`docs/trees/auth-and-dashboard.md`:

```markdown
# auth-and-dashboard

[1/3]

## Specs
- [[auth]]
- [[dashboard]]

## Features

### From [[auth]]
- [x] login
- [ ] logout

### From [[dashboard]]
- [/] widget-grid

## Dependencies
- dashboard/widget-grid → auth/login _(explicit-ref: dashboard requires authenticated session)_
```

Open the project in Obsidian: `[[auth-and-dashboard]]` links to the island MD, which links to each spec. Tick a checkbox in Obsidian — the next CLI command picks up the change and updates the underlying tree JSON.

---

## Checkbox round-trip

The forest is a **projection** of `.specforest/trees/*.json` and `.specforest/islands.json`. The MDs are regenerated wholesale on every render — hand-edits other than checkboxes will be overwritten.

Status flow:
- **MD → JSON**: ticking a box in Obsidian updates the tree JSON on the next CLI call (any command except `init` / `scan` runs `syncCheckboxes()` first).
- **JSON → MD**: `mark` and `implement` write the tree JSON; the next `sync` re-renders the MD.

Conflict resolution: if both sides changed, whichever file has the newer mtime wins. So `mark`/`implement` are not silently overwritten by stale MDs.

Checkbox markers (configurable):

| status | marker | example |
|---|---|---|
| `todo` | `[ ]` | `- [ ] login` |
| `in_progress` | `[/]` | `- [/] widget-grid` |
| `blocked` | `[-]` | `- [-] payments` |
| `done` | `[x]` | `- [x] login` |

---

## Config

`specforest.config.yml` at the project root:

```yaml
specsDir: docs/specs        # where spec files live
outputDir: docs/trees       # where forest.md + island MDs are written
hiddenDir: .specforest      # internal state (gitignore this)
specsGlob: "**/*.md"        # which files in specsDir count as specs
ignore: []                  # globs to exclude
maxDepth: 2                 # soft cap on tree depth (heuristic for Claude)
wikilinkStyle: obsidian
checkboxMarkers:
  todo: " "
  in_progress: "/"
  blocked: "-"
  done: "x"
```

All keys are optional — `init` writes defaults. `specsDir` and `outputDir` can point anywhere (e.g. `docs/superpowers/specs` for nested layouts).

---

## How dependencies are discovered

Claude is instructed (via the embedded `commit-islands` prompt) to:

1. Build a graph over **top-level features only**. Sub-features travel with their parent — if a spec text declares a dependency on a sub-feature, the edge is hoisted to its top-level ancestor and the original target is noted in `reason`.
2. Prefer **explicit references** first:
   - Wikilinks (`[[other-spec]]`)
   - Phrases like "depends on X", "requires Y", "after Z"
   - Edge labeled `kind: "explicit-ref"`
3. Fall back to **semantic inference** only when no explicit reference exists. Edge labeled `kind: "semantic"`.
4. Every edge has a human-readable `reason` field for audit.
5. Cluster into connected components. Each component is an "island" with a kebab-case theme name. Singletons are valid (size 1, no deps).

Island IDs are stable across runs: the CLI matches new island member-sets to previous IDs by largest overlap.

---

## State, change detection, and progress preservation

- **Per-spec hash**: `.specforest/state.json` tracks `sha256:` of each spec's source. `sync` calls `ingest` only for files whose hash has drifted.
- **Structural fingerprint**: `lastClusteredStructure` is a hash of (sorted spec → sorted top-level feature names). Re-cluster only happens when this changes — pure status mutations (`mark`, `implement`) do not trigger a re-cluster prompt.
- **Status preservation across ingest**: when a spec is re-ingested, statuses are mapped by feature name. Features renamed away land in `state.orphanedProgress` so progress is never silently lost.
- **Orphan checkboxes**: if an Obsidian-edited checkbox references a feature that no longer exists (rename / delete), the status is stashed in `orphanedProgress` for inspection.

---

## Driving with Claude

Tell Claude any of:
- `"sync the specforest"` / `"update the forest"` / `/specforest`
- `"show the forest"` / `/specforest-tree`
- `"implement <spec>/<feature>"` / `/specforest-implement <spec>/<feature>`
- `"rehash specforest"` / `/specforest-rehash` — resync hashes after byte-only spec edits (CRLF, BOM, formatting)

Claude consults `.claude/skills/specforest/SKILL.md` and walks the sync loop. The CLI's `NEXT: …` markers and embedded prompts are the contract — Claude doesn't need to memorize the schema.

---

## Testing

The skill ships with 67 tests covering pure modules, IO, render, and end-to-end CLI subprocess flows.

```bash
cd .claude/skills/specforest
node --test tests/pure.test.js tests/io.test.js tests/render.test.js tests/e2e.test.js
```

Or via the package script:

```bash
npm test
```

---

## Pitfalls

- **Don't hand-edit `forest.md` or island MDs** (other than ticking checkboxes). They are regenerated wholesale.
- **Don't ingest sub-features as top-level.** Only the children of `tree.features[]` are graph nodes; deeper levels are sub-features.
- **Spec name collisions abort `sync`.** Two files yielding the same kebab name (e.g. `auth.md` in two folders) exit non-zero. Rename one.
- **Specs are renamed by file basename only.** Moving `auth.md` to a subfolder doesn't change its spec name — it's still `auth`. Renaming the file does.
- **The `.specforest/` directory is internal.** Don't hand-edit. Add it to `.gitignore` (or commit it intentionally — both work, just be deliberate).

---

## License

MIT — see [LICENSE](LICENSE).
