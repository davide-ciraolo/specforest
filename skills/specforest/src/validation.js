import { isKebab } from "./kebab.js";
import { STATUSES } from "./checkbox.js";

const VALID_STATUS = new Set(STATUSES);
const VALID_SOURCE = new Set(["heading", "implied"]);
const VALID_KIND = new Set(["explicit-ref", "semantic"]);

class ValidationError extends Error {
  constructor(message, path) {
    super(path ? `${path}: ${message}` : message);
    this.path = path;
  }
}

function fail(path, msg) {
  throw new ValidationError(msg, path);
}

function checkType(v, t, path) {
  if (t === "array") {
    if (!Array.isArray(v)) fail(path, `expected array, got ${typeof v}`);
  } else if (typeof v !== t) {
    fail(path, `expected ${t}, got ${typeof v}`);
  }
}

function validateFeature(node, path) {
  if (!node || typeof node !== "object") fail(path, "feature must be object");
  checkType(node.name, "string", `${path}.name`);
  if (!isKebab(node.name)) fail(`${path}.name`, `not kebab-case: "${node.name}"`);
  checkType(node.source, "string", `${path}.source`);
  if (!VALID_SOURCE.has(node.source)) fail(`${path}.source`, `invalid: ${node.source}`);
  if (node.originalHeading !== null && typeof node.originalHeading !== "string") {
    fail(`${path}.originalHeading`, "must be string or null");
  }
  checkType(node.status, "string", `${path}.status`);
  if (!VALID_STATUS.has(node.status)) fail(`${path}.status`, `invalid: ${node.status}`);
  checkType(node.children, "array", `${path}.children`);
  node.children.forEach((c, i) => validateFeature(c, `${path}.children[${i}]`));
}

export function validateTree(obj) {
  if (!obj || typeof obj !== "object") fail("$", "tree must be object");
  checkType(obj.spec, "string", "$.spec");
  if (!isKebab(obj.spec)) fail("$.spec", `not kebab-case: "${obj.spec}"`);
  checkType(obj.specPath, "string", "$.specPath");
  checkType(obj.specHash, "string", "$.specHash");
  checkType(obj.features, "array", "$.features");
  const seen = new Set();
  obj.features.forEach((f, i) => {
    validateFeature(f, `$.features[${i}]`);
    if (seen.has(f.name)) fail(`$.features[${i}].name`, `duplicate top-level feature: ${f.name}`);
    seen.add(f.name);
  });
  return obj;
}

function validateMember(m, path) {
  if (!m || typeof m !== "object") fail(path, "must be object");
  checkType(m.spec, "string", `${path}.spec`);
  if (!isKebab(m.spec)) fail(`${path}.spec`, `not kebab: ${m.spec}`);
  checkType(m.feature, "string", `${path}.feature`);
  if (!isKebab(m.feature)) fail(`${path}.feature`, `not kebab: ${m.feature}`);
}

function validateDependency(d, path) {
  if (!d || typeof d !== "object") fail(path, "must be object");
  validateMember(d.from, `${path}.from`);
  validateMember(d.to, `${path}.to`);
  checkType(d.kind, "string", `${path}.kind`);
  if (!VALID_KIND.has(d.kind)) fail(`${path}.kind`, `invalid: ${d.kind}`);
  checkType(d.reason, "string", `${path}.reason`);
}

const ISLAND_ID_RE = /^isl_[a-z0-9]+$/;

export function validateIslands(obj) {
  if (!obj || typeof obj !== "object") fail("$", "islands must be object");
  checkType(obj.generatedAt, "string", "$.generatedAt");
  checkType(obj.islands, "array", "$.islands");
  const seenIds = new Set();
  const seenNames = new Set();
  obj.islands.forEach((isl, i) => {
    const path = `$.islands[${i}]`;
    checkType(isl.id, "string", `${path}.id`);
    if (!ISLAND_ID_RE.test(isl.id)) fail(`${path}.id`, `invalid: ${isl.id}`);
    if (seenIds.has(isl.id)) fail(`${path}.id`, `duplicate: ${isl.id}`);
    seenIds.add(isl.id);
    checkType(isl.name, "string", `${path}.name`);
    if (!isKebab(isl.name)) fail(`${path}.name`, `not kebab: ${isl.name}`);
    if (seenNames.has(isl.name)) fail(`${path}.name`, `duplicate: ${isl.name}`);
    seenNames.add(isl.name);
    checkType(isl.members, "array", `${path}.members`);
    if (isl.members.length === 0) fail(`${path}.members`, "must not be empty");
    isl.members.forEach((m, j) => validateMember(m, `${path}.members[${j}]`));
    checkType(isl.dependencies, "array", `${path}.dependencies`);
    isl.dependencies.forEach((d, j) => validateDependency(d, `${path}.dependencies[${j}]`));
  });
  return obj;
}

export { ValidationError };
