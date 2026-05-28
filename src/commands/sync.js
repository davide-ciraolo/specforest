import { stat, mkdir } from "node:fs/promises";
import path from "node:path";
import { computeScan } from "./scan.js";
import { archiveTree, listTreeFiles, readAllTrees, structuralFingerprint } from "../tree-io.js";
import { readIslands, writeIslands } from "../islands-io.js";
import { writeRenderedOutputs } from "../render.js";
import { syncCheckboxesAndPersistOrphans } from "../sync-helpers.js";
import { updateState, readState } from "../state.js";
import { ingestPrompt, islandsPrompt, incrementalIslandsPrompt } from "../prompts.js";
import { acquireLock, releaseLock } from "../lock.js";
import { regenAndWriteTreeCache } from "../tree-cache.js";

async function mtimeMs(p) {
  try {
    const s = await stat(p);
    return s.mtimeMs;
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

export async function cmdSync({ cwd, args, stdout, stderr }) {
  const argv = args || [];
  const reclusterFlag = argv.includes("--recluster-islands");

  const scan = await computeScan({ cwd });
  if (scan.collisions.length) {
    stderr.write("ERROR: spec name collisions:\n");
    for (const c of scan.collisions) stderr.write(`  ${c.name}: ${c.paths.join(", ")}\n`);
    return 1;
  }

  const locked = await acquireLock(scan.paths.lock);
  if (!locked) {
    stderr.write("another sync is in progress (sync.lock held). retry after it completes.\n");
    return 2;
  }

  try {
    await syncCheckboxesAndPersistOrphans({
      outputDir: scan.paths.outputDir,
      treesDir: scan.paths.treesDir,
      statePath: scan.paths.state,
      markers: scan.config.checkboxMarkers,
    });

    if (scan.stale.length) {
      const lines = ["NEXT: ingest"];
      lines.push(`stale: ${scan.stale.length}`);
      for (const s of scan.stale) lines.push(`  - ${s.rel}  (spec-name: ${s.name})`);
      lines.push("");
      lines.push("For EACH stale spec, run:");
      lines.push("  1. read the spec file (full content)");
      lines.push("  2. emit a tree JSON matching the schema below");
      lines.push("  3. pipe it: node .claude/skills/specforest/bin/cli.js ingest <spec-name>");
      lines.push("  4. re-run: node .claude/skills/specforest/bin/cli.js sync");
      lines.push("");
      for (const s of scan.stale) {
        lines.push("");
        lines.push(`PROMPT for ${s.name} (use verbatim):`);
        lines.push("--- begin prompt ---");
        lines.push(ingestPrompt({ specPath: s.rel, specName: s.name, maxDepth: scan.config.maxDepth }));
        lines.push("--- end prompt ---");
      }
      stdout.write(lines.join("\n") + "\n");
      return 0;
    }

    let deletedAny = false;
    if (scan.deleted.length) {
      for (const name of scan.deleted) {
        await archiveTree(scan.paths.treesDir, scan.paths.archiveTrees, name);
      }
      await updateState(scan.paths.state, (s) => {
        for (const name of scan.deleted) delete s.specHashes[name];
      });
      deletedAny = true;
    }

    const treeFiles = await listTreeFiles(scan.paths.treesDir);
    let islandsMt = await mtimeMs(scan.paths.islands);
    const currentTrees = await readAllTrees(scan.paths.treesDir);
    const currentStructHash = structuralFingerprint(currentTrees);

    // ---- Full re-cluster path: no islands yet OR explicit --recluster-islands flag.
    if (!islandsMt || reclusterFlag) {
      if (treeFiles.length === 0) {
        stdout.write("NEXT: clean\nno specs / no trees — nothing to cluster\n");
        await updateState(scan.paths.state, (s) => { s.lastSync = new Date().toISOString(); });
        return 0;
      }
      const lines = ["NEXT: islands"];
      if (reclusterFlag) lines.push("(mode: full re-cluster — --recluster-islands)");
      lines.push(`trees: ${treeFiles.length}`);
      for (const f of treeFiles) lines.push(`  - ${path.relative(cwd, f)}`);
      lines.push("");
      lines.push("Cluster all trees into dependency islands. Pipe the result:");
      lines.push("  node .claude/skills/specforest/bin/cli.js commit-islands");
      lines.push("");
      lines.push("PROMPT:");
      lines.push("--- begin prompt ---");
      lines.push(islandsPrompt({ treePaths: treeFiles.map((f) => path.relative(cwd, f)) }));
      lines.push("--- end prompt ---");
      stdout.write(lines.join("\n") + "\n");
      return 0;
    }

    // ---- Incremental path: islands.json exists, preserve it.
    const knownFeatures = new Set();
    for (const t of currentTrees) for (const f of t.features) knownFeatures.add(`${t.spec}/${f.name}`);

    const existingIslands = await readIslands(scan.paths.islands);
    // existingIslands is non-null here (islandsMt was truthy).

    const coveredKeys = new Set();
    for (const isl of existingIslands.islands) {
      for (const m of isl.members) coveredKeys.add(`${m.spec}/${m.feature}`);
    }

    const orphanedKeys = new Set([...coveredKeys].filter((k) => !knownFeatures.has(k)));

    // Auto-prune orphaned members + empty islands. Dependencies that point to
    // orphaned members are dropped as well.
    let prunedSomething = false;
    let prunedEmptyIslands = [];
    if (orphanedKeys.size > 0) {
      const newIslands = [];
      for (const isl of existingIslands.islands) {
        const newMembers = isl.members.filter((m) => !orphanedKeys.has(`${m.spec}/${m.feature}`));
        if (newMembers.length === 0) {
          prunedEmptyIslands.push({ id: isl.id, name: isl.name });
          continue;
        }
        const newDeps = isl.dependencies.filter(
          (d) =>
            !orphanedKeys.has(`${d.from.spec}/${d.from.feature}`) &&
            !orphanedKeys.has(`${d.to.spec}/${d.to.feature}`),
        );
        newIslands.push({ ...isl, members: newMembers, dependencies: newDeps });
      }
      const pruned = { generatedAt: new Date().toISOString(), islands: newIslands };
      await writeIslands(scan.paths.islands, pruned);
      islandsMt = await mtimeMs(scan.paths.islands);
      existingIslands.islands = newIslands;
      prunedSomething = true;
    }

    // Recompute uncovered AFTER prune (covered may have shrunk; known features
    // didn't change — orphan removal only drops dead members).
    const coveredAfter = new Set();
    for (const isl of existingIslands.islands) {
      for (const m of isl.members) coveredAfter.add(`${m.spec}/${m.feature}`);
    }
    const uncoveredFeatures = [...knownFeatures].filter((k) => !coveredAfter.has(k));

    if (uncoveredFeatures.length > 0) {
      const islandsRel = path.relative(cwd, scan.paths.islands);
      const lines = ["NEXT: incremental-islands"];
      if (prunedSomething) {
        lines.push(`auto-pruned ${orphanedKeys.size} orphan member(s) from existing islands`);
        if (prunedEmptyIslands.length) {
          lines.push(`dropped empty island(s): ${prunedEmptyIslands.map((i) => `${i.name}/${i.id}`).join(", ")}`);
        }
      }
      lines.push(`existing islands: ${existingIslands.islands.length}`);
      lines.push(`uncovered top-level features: ${uncoveredFeatures.length}`);
      for (const k of uncoveredFeatures) lines.push(`  - ${k}`);
      lines.push("");
      lines.push("For each uncovered feature, pipe ONE of:");
      lines.push("  - extend-island <id-or-name>   (add to an existing island, intra-island deps only)");
      lines.push("  - add-island                    (create a NEW island; existing islands stay byte-identical)");
      lines.push("Cross-island edges or member moves require: sync --recluster-islands");
      lines.push("");
      lines.push("PROMPT:");
      lines.push("--- begin prompt ---");
      lines.push(
        incrementalIslandsPrompt({
          existingIslands: existingIslands.islands,
          uncoveredFeatures,
          treePaths: treeFiles.map((f) => path.relative(cwd, f)),
          islandsPath: islandsRel,
        }),
      );
      lines.push("--- end prompt ---");
      stdout.write(lines.join("\n") + "\n");
      return 0;
    }

    // Coverage is complete. Bump the structural fingerprint if needed — this
    // represents "current islands.json matches current tree structure" without
    // requiring a full commit-islands run.
    const stateNow = await readState(scan.paths.state);
    if (stateNow.lastClusteredStructure !== currentStructHash) {
      await updateState(scan.paths.state, (s) => {
        s.lastClusteredStructure = currentStructHash;
      });
    }

    // ---- Render path (unchanged in shape; honours pruned mtime).
    const state = await readState(scan.paths.state);
    const forestMt = await mtimeMs(scan.paths.forestMd);
    let needsRender = !forestMt || prunedSomething || deletedAny;
    if (!needsRender) {
      if (islandsMt && islandsMt > (state.lastRender ? Date.parse(state.lastRender) : 0)) needsRender = true;
      else {
        for (const f of treeFiles) {
          const m = await mtimeMs(f);
          if (m && m > (state.lastRender ? Date.parse(state.lastRender) : 0)) { needsRender = true; break; }
        }
      }
    }

    if (needsRender) {
      const islands = await readIslands(scan.paths.islands);
      const trees = await readAllTrees(scan.paths.treesDir);
      const treesBySpec = new Map(trees.map((t) => [t.spec, t]));
      const prevNames = state.previousIslandNames || [];
      await mkdir(scan.paths.outputDir, { recursive: true });
      const now = new Date().toISOString();
      await writeRenderedOutputs({
        outputDir: scan.paths.outputDir,
        archiveIslandsDir: scan.paths.archiveIslands,
        islands: islands.islands,
        treesBySpec,
        markers: scan.config.checkboxMarkers,
        timestamp: now,
        previousIslandNames: prevNames,
      });
      await updateState(scan.paths.state, (s) => {
        s.lastRender = now;
        s.previousIslandNames = islands.islands.map((i) => i.name);
        const map = {};
        for (const isl of islands.islands) {
          map[isl.id] = isl.members.map((m) => `${m.spec}/${m.feature}`);
        }
        s.islandIdMap = map;
      });
      try { await regenAndWriteTreeCache({ config: scan.config, p: scan.paths }); } catch {}
      stdout.write(`rendered: forest.md + ${islands.islands.length} island MD(s) at ${scan.paths.outputDir}\n`);
      return 0;
    }

    await updateState(scan.paths.state, (s) => { s.lastSync = new Date().toISOString(); });
    stdout.write("NEXT: clean\n");
    return 0;
  } finally {
    await releaseLock(scan.paths.lock);
  }
}
