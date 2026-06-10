export const STATUSES = ["todo", "in_progress", "blocked", "done"];

export function defaultMarkers() {
  return { todo: " ", in_progress: "/", blocked: "-", done: "x" };
}

export function buildMarkerToStatus(markers) {
  const m = {};
  for (const s of STATUSES) m[markers[s]] = s;
  return m;
}

const CHECKBOX_LINE_RE = /^(\s*)- \[(.)\] ([a-z0-9][a-z0-9-]*)(?:\s+\[(\d+)\/(\d+)\])?\s*$/;

export function parseCheckboxLine(line, markerToStatus) {
  const m = CHECKBOX_LINE_RE.exec(line);
  if (!m) return null;
  const [, indent, marker, name] = m;
  const status = markerToStatus[marker];
  if (!status) return { indent: indent.length, name, status: "todo", unknown: true };
  return { indent: indent.length, name, status, unknown: false };
}

export function renderCheckboxLine(name, status, markers, indent = 0, counter = null) {
  const marker = markers[status] ?? markers.todo;
  const pad = " ".repeat(indent);
  const tail = counter ? ` ${counter}` : "";
  return `${pad}- [${marker}] ${name}${tail}`;
}
