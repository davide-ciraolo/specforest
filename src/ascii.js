import { countLeaves, countFeatures, formatCounter } from "./counters.js";

const T = "├── ";
const L = "└── ";
const I = "│   ";
const S = "    ";

function renderFeatureNode(node, prefix, isLast, lines, markerForStatus) {
  const branch = isLast ? L : T;
  const counter = countLeaves(node);
  const isLeaf = !node.children || node.children.length === 0;
  const marker = markerForStatus(node.status);
  const tag = isLeaf ? `${marker} ${node.name}` : `${marker} ${node.name} ${formatCounter(counter.done, counter.total)}`;
  lines.push(prefix + branch + tag);
  const childPrefix = prefix + (isLast ? S : I);
  const kids = node.children || [];
  kids.forEach((child, i) => {
    renderFeatureNode(child, childPrefix, i === kids.length - 1, lines, markerForStatus);
  });
}

export function renderSpecBlock(spec, prefix, isLast, lines, markerForStatus) {
  const branch = isLast ? L : T;
  lines.push(prefix + branch + spec.spec);
  const childPrefix = prefix + (isLast ? S : I);
  spec.features.forEach((f, i) => {
    renderFeatureNode(f, childPrefix, i === spec.features.length - 1, lines, markerForStatus);
  });
}

export function renderForestAscii(forest, markerForStatus) {
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
    lines.push(`${branch}${isl.name} ${formatCounter(counter.done, counter.total)}`);
    const childPrefix = islLast ? S : I;
    isl.specs.forEach((spec, j) => {
      const last = j === isl.specs.length - 1;
      renderSpecBlock(spec.tree, childPrefix, last, lines, markerForStatus);
    });
  });
  return lines.join("\n");
}

export function renderSingleSpecAscii(specName, forest, markerForStatus) {
  const lines = [];
  for (const isl of forest.islands) {
    for (const spec of isl.specs) {
      if (spec.tree.spec !== specName) continue;
      const totals = countFeatures(spec.tree.features);
      lines.push(`${isl.name} / ${specName} ${formatCounter(totals.done, totals.total)}`);
      spec.tree.features.forEach((f, i) => {
        renderFeatureNode(f, "", i === spec.tree.features.length - 1, lines, markerForStatus);
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
