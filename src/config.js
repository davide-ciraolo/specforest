import { readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { defaultMarkers, STATUSES } from "./checkbox.js";

export const CONFIG_FILENAME = "specforest.config.yml";

export function defaultConfig() {
  return {
    specsDir: "docs/specs",
    outputDir: "docs/trees",
    hiddenDir: ".specforest",
    specsGlob: "**/*.md",
    ignore: [],
    maxDepth: 2,
    wikilinkStyle: "obsidian",
    checkboxMarkers: defaultMarkers(),
  };
}

export function defaultConfigYaml() {
  return `# specforest config — see docs/superpowers/specs/2026-05-18-specforest-skill-design.md
specsDir: docs/specs
outputDir: docs/trees
hiddenDir: .specforest
specsGlob: "**/*.md"
ignore: []
maxDepth: 2
wikilinkStyle: obsidian
checkboxMarkers:
  todo: " "
  in_progress: "/"
  blocked: "-"
  done: "x"
`;
}

function validateMarkers(markers) {
  if (!markers || typeof markers !== "object") throw new Error("checkboxMarkers must be an object");
  for (const s of STATUSES) {
    if (typeof markers[s] !== "string" || markers[s].length !== 1) {
      throw new Error(`checkboxMarkers.${s} must be a single character`);
    }
  }
  const used = new Set();
  for (const s of STATUSES) {
    if (used.has(markers[s])) throw new Error(`checkboxMarkers conflict on '${markers[s]}'`);
    used.add(markers[s]);
  }
}

export function validateConfig(c) {
  const required = ["specsDir", "outputDir", "hiddenDir", "specsGlob", "maxDepth", "wikilinkStyle"];
  for (const k of required) {
    if (c[k] === undefined || c[k] === null) throw new Error(`config.${k} missing`);
  }
  if (!Array.isArray(c.ignore)) throw new Error("config.ignore must be array");
  if (typeof c.maxDepth !== "number" || c.maxDepth < 1) throw new Error("config.maxDepth must be >= 1");
  if (c.wikilinkStyle !== "obsidian") throw new Error(`config.wikilinkStyle must be 'obsidian' (got ${c.wikilinkStyle})`);
  validateMarkers(c.checkboxMarkers);
  return c;
}

export async function loadConfig(projectRoot) {
  const p = path.join(projectRoot, CONFIG_FILENAME);
  let raw;
  try {
    raw = await readFile(p, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") {
      const err = new Error(`config not found at ${p}. Run \`specforest init\` first.`);
      err.code = "ENOENT_CONFIG";
      throw err;
    }
    throw e;
  }
  const parsed = yaml.load(raw) || {};
  const merged = { ...defaultConfig(), ...parsed };
  if (parsed.checkboxMarkers) merged.checkboxMarkers = { ...defaultMarkers(), ...parsed.checkboxMarkers };
  return validateConfig(merged);
}

export async function writeDefaultConfig(projectRoot) {
  const p = path.join(projectRoot, CONFIG_FILENAME);
  try {
    await access(p);
    return { created: false, path: p };
  } catch {
    await writeFile(p, defaultConfigYaml(), "utf8");
    return { created: true, path: p };
  }
}
