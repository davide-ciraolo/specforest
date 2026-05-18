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
