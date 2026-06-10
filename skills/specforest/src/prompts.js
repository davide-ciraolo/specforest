export function ingestPrompt({ specPath, specName, maxDepth }) {
  return `You are ingesting a spec into the specforest.

Spec path: ${specPath}
Spec name (kebab): ${specName}

INSTRUCTIONS:
1. Read the full file at the spec path.
2. Extract a list of features the spec defines. Markdown headings are CANDIDATES, not authoritative:
   - Rename headings to kebab-case feature identifiers.
   - Discard headings that are not features (e.g. "Background", "References", "Glossary").
   - Add features that are implied by the body text but not surfaced as headings.
3. The feature tree may have arbitrary depth. Soft cap: depth ${maxDepth} (deeper allowed only if a spec clearly demands).
4. If the spec defines zero implementable features (purely a verify / reference spec), output a single feature named "verify".
5. Output ONLY a single JSON object matching this schema, piped via stdin to:
   node .claude/skills/specforest/bin/cli.js ingest ${specName}

SCHEMA:
{
  "spec": "${specName}",
  "specPath": "${specPath}",
  "specHash": "<the CLI sets this; you may leave a placeholder>",
  "features": [
    {
      "name": "kebab-case-name",
      "source": "heading" | "implied",
      "originalHeading": "## Verbatim Heading" | null,
      "status": "todo",
      "children": [ ... same shape, recursive ]
    }
  ]
}

NOTES:
- All "status" values must be "todo" on ingest. The CLI preserves existing status by feature-name match.
- Feature names must be kebab-case (a-z0-9 with single dashes; no leading/trailing dash).
- Top-level feature names must be unique within the spec.
- The CLI overwrites "specHash" with the actual file hash; you may pass any string.
`;
}

export function islandsPrompt({ treePaths }) {
  return `You are clustering the specforest into dependency islands.

Trees to read:
${treePaths.map((p) => `  - ${p}`).join("\n")}

INSTRUCTIONS:
1. Read every tree JSON listed above.
2. Build a graph over TOP-LEVEL features only (children of tree.features[]). Sub-features travel with their parent — if the spec text declares a dep on a sub-feature, hoist the edge to its top-level ancestor and note the original target in "reason".
3. For each dependency edge:
   - Prefer EXPLICIT references first (wikilinks "[[other-spec]]", "depends on X", "requires Y") — set kind="explicit-ref".
   - Use SEMANTIC inference only when no explicit reference exists — set kind="semantic".
   - Every edge MUST include a human-readable "reason" string (audit trail).
4. Cluster features into connected components. Features with no edges form singleton islands. Every top-level feature appears in exactly one island.
5. Give each island a descriptive kebab-case theme name.
6. Output ONLY a single JSON object matching this schema, piped via stdin to:
   node .claude/skills/specforest/bin/cli.js commit-islands

SCHEMA:
{
  "generatedAt": "<ISO-8601>",
  "islands": [
    {
      "id": "isl_<6-char-random>",
      "name": "kebab-case-theme",
      "members": [
        { "spec": "<spec-kebab>", "feature": "<top-level-feature-kebab>" }
      ],
      "dependencies": [
        {
          "from": { "spec": "...", "feature": "..." },
          "to":   { "spec": "...", "feature": "..." },
          "kind": "explicit-ref" | "semantic",
          "reason": "..."
        }
      ]
    }
  ]
}

NOTES:
- The CLI will REUSE existing island IDs based on member-set overlap (largest-overlap match). If you don't know prior IDs, generate new ones — CLI will reconcile.
- An island with one member and zero deps is valid (singleton).
- Do not reference sub-features in "members" or "dependencies" — only top-level features.
`;
}

export function incrementalIslandsPrompt({ existingIslands, uncoveredFeatures, treePaths, islandsPath }) {
  const islandLines = existingIslands.map((isl) => {
    const memberPreview = isl.members.slice(0, 6).map((m) => `${m.spec}/${m.feature}`).join(", ");
    const more = isl.members.length > 6 ? `, +${isl.members.length - 6} more` : "";
    return `  - ${isl.name}  (${isl.id})  members:${isl.members.length}  [${memberPreview}${more}]`;
  }).join("\n");
  const uncoveredLines = uncoveredFeatures.map((k) => `  - ${k}`).join("\n");
  return `You are extending the specforest INCREMENTALLY. Existing islands are preserved.

Uncovered top-level features (newly added or renamed):
${uncoveredLines}

Existing islands (do NOT alter; only extend):
${islandLines}

Trees on disk (read for feature context):
${treePaths.map((p) => `  - ${p}`).join("\n")}

Existing islands.json (read for full members + dependencies):
  - ${islandsPath}

INSTRUCTIONS:
1. Read .specforest/islands.json and the tree JSON files listed above.
2. For each uncovered feature, decide ONE of:

   (a) EXTEND an existing island — pick by semantic affinity to its theme / members.
       Pipe:

         cat <<JSON | node .claude/skills/specforest/bin/cli.js extend-island <id-or-name>
         {
           "addMembers": [
             { "spec": "<spec-kebab>", "feature": "<feature-kebab>" }
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
         JSON

       Dependencies must stay WITHIN the target island (after extension).
       Cross-island edges are not allowed via extend-island.

   (b) CREATE a new island — group one or more uncovered features under a fresh theme.
       Pipe:

         cat <<JSON | node .claude/skills/specforest/bin/cli.js add-island
         {
           "name": "kebab-theme",
           "members": [ { "spec": "...", "feature": "..." } ],
           "dependencies": [
             {
               "from": { "spec": "...", "feature": "..." },
               "to":   { "spec": "...", "feature": "..." },
               "kind": "explicit-ref" | "semantic",
               "reason": "..."
             }
           ]
         }
         JSON

       Members must NOT already belong to any island; dependencies must stay inside
       the new island. Cross-island edges → request a full re-cluster.

3. If the uncovered features have HARD cross-island dependencies that cannot be
   modelled without changing existing island membership, abort the incremental
   flow and request:

     node .claude/skills/specforest/bin/cli.js sync --recluster-islands

4. After all uncovered features are placed, re-run \`sync\` to render.

NOTES:
- Existing island IDs / names / members must remain byte-identical (extend-island
  appends; add-island creates new). Renames or member moves require --recluster-islands.
- An island with one new singleton member and zero deps is fine.
- The CLI auto-prunes members whose underlying top-level feature no longer exists
  in any tree (true deletions). Renames look like "orphan + uncovered" — assign the
  new name back into the same island via extend-island to preserve continuity.
`;
}

export function implementPrompt({ target, specsToRead, prerequisites, hasUndonePrereqs }) {
  const prereqLines = prerequisites.length
    ? prerequisites.map((p) => `  - ${p.spec}/${p.feature}  [${p.status}]${p.status !== "done" ? "   ⚠ not done" : ""}`).join("\n")
    : "  (none)";
  return `You are implementing a feature from the specforest.

Target: ${target}
Specs to read (FULL FILES, not excerpts):
${specsToRead.map((p) => `  - ${p}`).join("\n")}

Prerequisites:
${prereqLines}

INSTRUCTIONS:
1. Read every spec file listed above in full.
${hasUndonePrereqs ? `2. WARNING: one or more prerequisites are not done. Surface this list to the user and confirm: proceed anyway, implement prerequisites first, or abort.\n` : ""}${hasUndonePrereqs ? "3" : "2"}. Plan the implementation following project rules (TDD, planner agent if the work is complex, coding-standards / security / testing guardrails from CLAUDE.md and GUIDELINES.md).
${hasUndonePrereqs ? "4" : "3"}. Implement the feature.
${hasUndonePrereqs ? "5" : "4"}. On completion: run \`node .claude/skills/specforest/bin/cli.js mark ${target} done\`.
${hasUndonePrereqs ? "6" : "5"}. If the work is paused / blocked: run \`node .claude/skills/specforest/bin/cli.js mark ${target} blocked\` and explain why to the user.
`;
}

export function verifyPrompt({ target, currentStatus, specsToRead, prerequisites, hasUndonePrereqs }) {
  const prereqLines = prerequisites.length
    ? prerequisites.map((p) => `  - ${p.spec}/${p.feature}  [${p.status}]${p.status !== "done" ? "   ⚠ not done" : ""}`).join("\n")
    : "  (none)";
  return `You are verifying whether a feature from the specforest is implemented in the codebase.

Target: ${target}
Current status: ${currentStatus}
Specs to read (FULL FILES, not excerpts):
${specsToRead.map((p) => `  - ${p}`).join("\n")}

Prerequisites:
${prereqLines}

INSTRUCTIONS:
1. Read every spec file listed above in full.
${hasUndonePrereqs ? `2. WARNING: one or more prerequisites are not done. The feature may be unverifiable in isolation; surface the list to the user before proceeding.\n` : ""}${hasUndonePrereqs ? "3" : "2"}. Inspect the codebase for evidence that the target feature is implemented:
   - Code paths, file structure, tests, configuration, migrations as relevant.
   - Use Grep / Glob / Read; do NOT modify files.
${hasUndonePrereqs ? "4" : "3"}. Report back to the user with:
   - VERDICT: implemented | partially implemented | not implemented
   - EVIDENCE: concrete file paths + line numbers backing the verdict.
   - GAPS: anything in the spec that lacks corresponding code / tests.
${hasUndonePrereqs ? "5" : "4"}. Suggest the appropriate follow-up command based on the verdict:
   - implemented      → node .claude/skills/specforest/bin/cli.js mark ${target} done
   - partial          → node .claude/skills/specforest/bin/cli.js mark ${target} in_progress
   - not started      → node .claude/skills/specforest/bin/cli.js mark ${target} todo
   - blocked          → node .claude/skills/specforest/bin/cli.js mark ${target} blocked
${hasUndonePrereqs ? "6" : "5"}. DO NOT run \`mark\` yourself unless the user confirms.
`;
}
