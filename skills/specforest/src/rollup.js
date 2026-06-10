export function rollupNodeStatus(node) {
  const kids = node.children || [];
  if (kids.length === 0) return node.status;
  if (kids.some((c) => c.status === "blocked")) return "blocked";
  if (kids.every((c) => c.status === "done")) return "done";
  if (kids.some((c) => c.status === "done" || c.status === "in_progress")) return "in_progress";
  return "todo";
}

function findPathFromRoot(tree, targetNode) {
  for (const f of tree.features) {
    const stack = [];
    let found = null;
    (function dfs(n) {
      if (found) return;
      stack.push(n);
      if (n === targetNode) {
        found = [...stack];
        stack.pop();
        return;
      }
      for (const c of n.children || []) {
        dfs(c);
        if (found) return;
      }
      stack.pop();
    })(f);
    if (found) return found;
  }
  return null;
}

export function rollupAncestors(tree, targetNode) {
  const path = findPathFromRoot(tree, targetNode);
  if (!path || path.length <= 1) return [];
  const changes = [];
  for (let i = path.length - 2; i >= 0; i--) {
    const ancestor = path[i];
    const before = ancestor.status;
    const after = rollupNodeStatus(ancestor);
    if (before !== after) {
      ancestor.status = after;
      changes.push({ name: ancestor.name, from: before, to: after });
    }
  }
  return changes;
}
