export function buildAdjacency(island) {
  const adj = new Map();
  const ensure = (k) => {
    if (!adj.has(k)) adj.set(k, new Set());
    return adj.get(k);
  };
  for (const m of island.members) ensure(`${m.spec}/${m.feature}`);
  for (const d of island.dependencies) {
    const f = `${d.from.spec}/${d.from.feature}`;
    const t = `${d.to.spec}/${d.to.feature}`;
    ensure(f).add(t);
    ensure(t);
  }
  return adj;
}

export function findCycles(island) {
  const adj = buildAdjacency(island);
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  for (const k of adj.keys()) color.set(k, WHITE);
  const cycles = [];
  const stack = [];

  function dfs(node) {
    color.set(node, GRAY);
    stack.push(node);
    for (const next of adj.get(node) || []) {
      if (color.get(next) === GRAY) {
        const idx = stack.indexOf(next);
        cycles.push(stack.slice(idx).concat(next));
      } else if (color.get(next) === WHITE) {
        dfs(next);
      }
    }
    stack.pop();
    color.set(node, BLACK);
  }

  for (const k of adj.keys()) if (color.get(k) === WHITE) dfs(k);
  return cycles;
}

export function transitiveDeps(island, startSpec, startFeature) {
  const adj = buildAdjacency(island);
  const visited = new Set();
  const cycle = [];
  const stack = [];

  function visit(node) {
    if (stack.includes(node)) {
      const idx = stack.indexOf(node);
      cycle.push(stack.slice(idx).concat(node));
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    stack.push(node);
    for (const next of adj.get(node) || []) visit(next);
    stack.pop();
  }

  const start = `${startSpec}/${startFeature}`;
  visit(start);
  visited.delete(start);
  return { reached: [...visited], cycles: cycle };
}

export function findIslandForFeature(islands, spec, feature) {
  const key = `${spec}/${feature}`;
  for (const isl of islands) {
    for (const m of isl.members) {
      if (`${m.spec}/${m.feature}` === key) return isl;
    }
  }
  return null;
}
