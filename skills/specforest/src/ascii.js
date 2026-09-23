import { countLeaves, countFeatures, formatCounter } from "./counters.js";

const T = "├── ";
const L = "└── ";
const I = "│   ";
const S = "    ";

function renderFeatureNode(node, prefix, isLast, lines, markerForStatus, spec, pathSegs, annotate) {
  const branch = isLast ? L : T;
  const counter = countLeaves(node);
  const isLeaf = !node.children || node.children.length === 0;
  const marker = markerForStatus(node.status);
  const segs = [...pathSegs, node.name];
  const base = isLeaf ? `${marker} ${node.name}` : `${marker} ${node.name} ${formatCounter(counter.done, counter.total)}`;
  const note = annotate(`${spec}/${segs.join("/")}`);
  lines.push(prefix + branch + base + (note ? `  ${note}` : ""));
  const childPrefix = prefix + (isLast ? S : I);
  const kids = node.children || [];
  kids.forEach((child, i) => {
    renderFeatureNode(child, childPrefix, i === kids.length - 1, lines, markerForStatus, spec, segs, annotate);
  });
}

export function renderSpecBlock(spec, prefix, isLast, lines, markerForStatus, annotate = () => "") {
  const branch = isLast ? L : T;
  // Spec lines carry no annotation: extractSpecBlockFromCache locates a block by exact
  // string equality on this line, so any suffix would break the cache slice path.
  lines.push(prefix + branch + spec.spec);
  const childPrefix = prefix + (isLast ? S : I);
  spec.features.forEach((f, i) => {
    renderFeatureNode(f, childPrefix, i === spec.features.length - 1, lines, markerForStatus, spec.spec, [], annotate);
  });
}

export function renderForestAscii(forest, markerForStatus, annotate = () => "") {
  const lines = [];
  const allFeatures = forest.islands.flatMap((isl) =>
    isl.specs.flatMap((s) => s.tree.features),
  );
  const totals = countFeatures(allFeatures);
  lines.push(`forest ${formatCounter(totals.done, totals.total)}`);
  forest.islands.forEach((isl, i) => {
    const islLast = i === forest.islands.length - 1;
    const branch = islLast ? L : T;
    const counter = countFeatures(isl.specs.flatMap((s) => s.tree.features));
    const note = annotate(`island:${isl.name}`);
    lines.push(`${branch}${isl.name} ${formatCounter(counter.done, counter.total)}${note ? `  ${note}` : ""}`);
    const childPrefix = islLast ? S : I;
    isl.specs.forEach((spec, j) => {
      const last = j === isl.specs.length - 1;
      renderSpecBlock(spec.tree, childPrefix, last, lines, markerForStatus, annotate);
    });
  });
  return lines.join("\n");
}

export function renderSingleSpecAscii(specName, forest, markerForStatus, annotate = () => "") {
  const lines = [];
  for (const isl of forest.islands) {
    for (const spec of isl.specs) {
      if (spec.tree.spec !== specName) continue;
      const totals = countFeatures(spec.tree.features);
      lines.push(`${isl.name} / ${specName} ${formatCounter(totals.done, totals.total)}`);
      spec.tree.features.forEach((f, i) => {
        renderFeatureNode(f, "", i === spec.tree.features.length - 1, lines, markerForStatus, specName, [], annotate);
      });
      return lines.join("\n");
    }
  }
  return null;
}

export function markerFn(markers) {
  return (status) => {
    const m = markers[status] ?? markers.todo;
    return `[${m}]`;
  };
}
