import { spawn } from "node:child_process";
import os from "node:os";
import { loadConfig } from "../config.js";
import { paths } from "../paths.js";
import { readTree } from "../tree-io.js";
import { parseTarget, resolveTargetNode } from "../target.js";
import { pickMatch } from "../disambiguate.js";
import { appendEvents } from "../timings-io.js";

const USAGE = "usage: specforest ci <spec>/<feature-path> -- <command> [args…]\n";

// Node does not escape anything when `shell: true` — it joins argv with spaces
// and hands the string to the shell. Quote each element ourselves so a command
// or argument containing spaces (`C:\Program Files\…`) survives. Consequence:
// shell metacharacters in the argv are NOT interpreted; for a pipeline or a
// redirect, pass an explicit `bash -c "…"` (design spec §3). Quoting does NOT
// stop cmd.exe from expanding `%VAR%` — `%`/`!` land in the quoting class only
// because they can otherwise break word-splitting, not because quotes neutralize
// them; a literal `%` in an argument can still be substituted. cmd.exe also has
// no way to carry a `\r`/`\n` inside a single argument — never even reaches
// `quoteArg`, see the pre-spawn guard in `cmdCi` instead.
function quoteArg(a) {
  if (os.platform() === "win32") {
    if (a.length === 0) return '""';
    if (!/[\s"&|<>^()%!]/.test(a)) return a;
    // MSVCRT: a backslash run is only special immediately before a `"` — including
    // the closing one — so double any run that would collide with a quote.
    const body = a.replace(/(\\*)"/g, '$1$1""').replace(/(\\+)$/, "$1$1");
    return `"${body}"`;
  }
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
}

function runCommand(argv) {
  return new Promise((resolve) => {
    const child = spawn(argv.map(quoteArg).join(" "), { stdio: "inherit", shell: true });
    child.on("error", () => resolve(127));
    child.on("close", (code, signal) => resolve(code == null ? (signal ? 1 : 0) : code));
  });
}

export async function cmdCi({ cwd, args, stdin, stdout, stderr }) {
  const sepIndex = args.indexOf("--");
  const own = sepIndex === -1 ? args : args.slice(0, sepIndex);
  if (own.includes("--help") || own.includes("-h")) {
    stdout.write(USAGE);
    return 0;
  }

  if (sepIndex === -1) {
    stderr.write(`missing '--' separator\n${USAGE}`);
    return 1;
  }
  const command = args.slice(sepIndex + 1);
  if (command.length === 0) {
    stderr.write(`no command after '--'\n${USAGE}`);
    return 1;
  }
  const badArg = command.find((a) => /[\r\n]/.test(a));
  if (badArg !== undefined) {
    stderr.write("command arguments may not contain newlines\n");
    return 1;
  }
  const target = own.find((a) => !a.startsWith("-"));
  if (!target) {
    stderr.write(`missing target\n${USAGE}`);
    return 1;
  }

  const parsed = parseTarget(target);
  if (parsed.error) {
    stderr.write(`${parsed.error}\n`);
    return 1;
  }
  const { spec: specName, segments } = parsed;
  const config = await loadConfig(cwd);
  const p = paths(cwd, config);
  const tree = await readTree(p.treesDir, specName);
  if (!tree) {
    stderr.write(`spec not found: ${specName}\n`);
    return 1;
  }
  let resolved = resolveTargetNode(tree, segments);
  if (resolved.error) {
    stderr.write(`${resolved.error}\n`);
    return 1;
  }
  if (resolved.ambiguous) {
    const picked = await pickMatch({ spec: specName, name: segments[segments.length - 1], matches: resolved.matches, stdin, stdout, stderr });
    if (!picked) {
      stderr.write("aborted: ambiguous target\n");
      return 1;
    }
    resolved = picked;
  }

  // Key off the as-stored `tree.spec`, never the user-typed `specName`:
  // readTree resolves `${specName}.json` case-insensitively on Windows/macOS,
  // so a typed "AUTH/login" would record under "AUTH/login" while every reader
  // (aggregateTree, the timings command) looks up "auth/login" — the work
  // becomes invisible on the node and lands in the orphan bucket.
  const canonicalTarget = `${tree.spec}/${resolved.fullPath}`;

  // No leaf check: spec §1.3 keeps CI additive at every level, because a `ci`
  // event is charged to exactly one target and CI runs never overlap. A run
  // aimed at a feature is therefore recorded against that feature.
  if (!config.timings) {
    stderr.write("specforest: timings: false in config — running the command, no time recorded\n");
  }

  const startedAt = Date.now();
  const exit = await runCommand(command);
  const ms = Date.now() - startedAt;

  if (config.timings) {
    try {
      await appendEvents(p.timings, [{
        ts: new Date(startedAt).toISOString(),
        event: "ci",
        target: canonicalTarget,
        ms,
        cmd: command.join(" "),
        exit,
      }]);
    } catch (e) {
      stderr.write(`warning: could not record timing: ${e.message}\n`);
    }
  }

  return exit;
}
