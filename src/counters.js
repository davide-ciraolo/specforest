export function countLeaves(node) {
  if (!node.children || node.children.length === 0) {
    return { total: 1, done: node.status === "done" ? 1 : 0 };
  }
  let total = 0;
  let done = 0;
  for (const c of node.children) {
    const r = countLeaves(c);
    total += r.total;
    done += r.done;
  }
  return { total, done };
}

export function countFeatures(features) {
  let total = 0;
  let done = 0;
  for (const f of features) {
    const r = countLeaves(f);
    total += r.total;
    done += r.done;
  }
  return { total, done };
}

export function formatCounter(done, total) {
  return `[${done}/${total}]`;
}
