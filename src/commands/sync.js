import { stat, mkdir } from "node:fs/promises";
import path from "node:path";
import { computeScan } from "./scan.js";
import { archiveTree, listTreeFiles, readAllTrees, structuralFingerprint } from "../tree-io.js";
import { readIslands } from "../islands-io.js";
import { writeRenderedOutputs } from "../render.js";
import { syncCheckboxesAndPersistOrphans } from "../sync-helpers.js";
import { updateState, readState } from "../state.js";
import { ingestPrompt, islandsPrompt } from "../prompts.js";
import { acquireLock, releaseLock } from "../lock.js";

async function mtimeMs(p) {
  try {
    const s = await stat(p);
    return s.mtimeMs;
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

export async function cmdSync({ cwd, stdout, stderr }) {
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
    const islandsMt = await mtimeMs(scan.paths.islands);
    const stateForCluster = await readState(scan.paths.state);
    const currentTrees = await readAllTrees(scan.paths.treesDir);
    const currentStructHash = structuralFingerprint(currentTrees);
    const structuralChanged = stateForCluster.lastClusteredStructure !== currentStructHash;
    const needsIslands = !islandsMt || deletedAny || structuralChanged;

    if (needsIslands) {
      if (treeFiles.length === 0) {
        stdout.write("NEXT: clean\nno specs / no trees — nothing to cluster\n");
        await updateState(scan.paths.state, (s) => { s.lastSync = new Date().toISOString(); });
        return 0;
      }
      const lines = ["NEXT: islands"];
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

    const state = await readState(scan.paths.state);
    const forestMt = await mtimeMs(scan.paths.forestMd);
    let needsRender = !forestMt;
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
