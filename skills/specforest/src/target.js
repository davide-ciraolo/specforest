import { findTopLevelFeature, topLevelNames } from "./tree-io.js";
import { closestMatch } from "./kebab.js";

export function parseTarget(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    return { error: `bad target: empty` };
  }
  const parts = raw.split("/").filter((s) => s.length > 0);
  if (parts.length < 2) {
    return { error: `bad target: ${raw}; expected <spec>/<feature-path>` };
  }
  const [spec, ...segments] = parts;
  return { spec, segments };
}

function walk(node, fn, path = []) {
  const next = [...path, node];
  fn(node, next);
  for (const c of node.children || []) walk(c, fn, next);
}

function collectAllPaths(tree) {
  const out = [];
  for (const f of tree.features) {
    walk(f, (n, pathNodes) => {
      out.push({ node: n, topLevel: pathNodes[0], pathSegments: pathNodes.map((p) => p.name) });
    });
  }
  return out;
}

export function resolveTargetNode(tree, segments) {
  if (!segments || segments.length === 0) {
    return { error: `no feature segments` };
  }

  if (segments.length === 1) {
    const [name] = segments;
    const matches = collectAllPaths(tree).filter((e) => e.node.name === name);
    if (matches.length === 0) {
      const all = collectAllPaths(tree).map((e) => e.node.name);
      const hint = closestMatch(name, all);
      return { error: `feature not found: ${tree.spec}/${name}${hint ? `. did you mean "${tree.spec}/${hint}"?` : ""}` };
    }
    if (matches.length === 1) {
      const m = matches[0];
      return { node: m.node, topLevel: m.topLevel, fullPath: m.pathSegments.join("/") };
    }
    return {
      ambiguous: true,
      matches: matches.map((m) => ({ node: m.node, topLevel: m.topLevel, fullPath: m.pathSegments.join("/") })),
    };
  }

  const [first, ...rest] = segments;
  const top = findTopLevelFeature(tree, first);
  if (!top) {
    const hint = closestMatch(first, topLevelNames(tree));
    return { error: `top-level feature not found: ${tree.spec}/${first}${hint ? `. did you mean "${tree.spec}/${hint}"?` : ""}` };
  }
  let cur = top;
  const pathNodes = [top];
  for (const seg of rest) {
    const child = (cur.children || []).find((c) => c.name === seg);
    if (!child) {
      const childNames = (cur.children || []).map((c) => c.name);
      const hint = closestMatch(seg, childNames);
      const so_far = pathNodes.map((p) => p.name).join("/");
      return { error: `path not found: ${tree.spec}/${so_far}/${seg}${hint ? `. did you mean "${tree.spec}/${so_far}/${hint}"?` : ""}` };
    }
    pathNodes.push(child);
    cur = child;
  }
  return { node: cur, topLevel: top, fullPath: pathNodes.map((p) => p.name).join("/") };
}
