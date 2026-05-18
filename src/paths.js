import path from "node:path";

export function paths(projectRoot, config) {
  const hidden = path.join(projectRoot, config.hiddenDir);
  return {
    projectRoot,
    specsDir: path.join(projectRoot, config.specsDir),
    outputDir: path.join(projectRoot, config.outputDir),
    hiddenDir: hidden,
    configResolved: path.join(hidden, "config.resolved.json"),
    state: path.join(hidden, "state.json"),
    islands: path.join(hidden, "islands.json"),
    treesDir: path.join(hidden, "trees"),
    archiveTrees: path.join(hidden, "archive", "trees"),
    archiveIslands: path.join(hidden, "archive", "islands"),
    lock: path.join(hidden, "sync.lock"),
    forestMd: path.join(projectRoot, config.outputDir, "forest.md"),
  };
}

export function treePath(p, specName) {
  return path.join(p.treesDir, `${specName}.json`);
}

export function islandMdPath(p, islandName) {
  return path.join(p.outputDir, `${islandName}.md`);
}
