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
      // `name` stays for the `rollup: <spec>/<name> …` line mark/implement print;
      // `fullPath` is what the timings recorder needs, since a bare name is not a
      // valid event `target` (timings design §1.1 — two branches may share a name).
      changes.push({
        node: ancestor,
        name: ancestor.name,
        fullPath: path.slice(0, i + 1).map((n) => n.name).join("/"),
        from: before,
        to: after,
      });
    }
  }
  return changes;
}

/**
 * Timings design §2.4: marking a node `done` marks every descendant `done`.
 * Returns one entry per descendant whose status actually changed, so the caller
 * can record a timing event for each. Pre-order, parents before their own
 * children.
 *
 * Re-asserting a status a descendant already holds yields no entry, which is
 * what keeps the cascade idempotent — an already-`done` subtree writes nothing.
 *
 * `basePath` is the node's own full path within the spec (no spec prefix); the
 * caller adds `<spec>/`.
 */
export function cascadeDoneToDescendants(node, basePath) {
  const changes = [];
  const walk = (n, segs) => {
    for (const c of n.children || []) {
      const path = [...segs, c.name];
      if (c.status !== "done") {
        changes.push({ node: c, name: c.name, fullPath: path.join("/"), from: c.status, to: "done" });
        c.status = "done";
      }
      walk(c, path);
    }
  };
  walk(node, basePath.split("/"));
  return changes;
}
