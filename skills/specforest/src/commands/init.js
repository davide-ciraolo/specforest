import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeDefaultConfig, loadConfig } from "../config.js";
import { paths } from "../paths.js";

export async function cmdInit({ cwd, stdout }) {
  const r = await writeDefaultConfig(cwd);
  const config = await loadConfig(cwd);
  const p = paths(cwd, config);
  await mkdir(p.specsDir, { recursive: true });
  await mkdir(p.outputDir, { recursive: true });
  await mkdir(p.hiddenDir, { recursive: true });
  await mkdir(p.treesDir, { recursive: true });
  await mkdir(p.archiveTrees, { recursive: true });
  await mkdir(p.archiveIslands, { recursive: true });
  await writeFile(p.configResolved, JSON.stringify(config, null, 2) + "\n", "utf8");
  stdout.write(
    r.created
      ? `created ${r.path}\ninitialised: ${p.specsDir}, ${p.outputDir}, ${p.hiddenDir}\n`
      : `config already exists at ${r.path}; directories ensured\n`,
  );
  return 0;
}
