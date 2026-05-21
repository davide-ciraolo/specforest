#!/usr/bin/env node
import { cmdInit } from "../src/commands/init.js";
import { cmdScan } from "../src/commands/scan.js";
import { cmdSync } from "../src/commands/sync.js";
import { cmdIngest } from "../src/commands/ingest.js";
import { cmdCommitIslands } from "../src/commands/commit-islands.js";
import { cmdRender } from "../src/commands/render.js";
import { cmdTree } from "../src/commands/tree.js";
import { cmdMark } from "../src/commands/mark.js";
import { cmdImplement } from "../src/commands/implement.js";
import { cmdStatus } from "../src/commands/status.js";
import { cmdRehash } from "../src/commands/rehash.js";

const HELP = `specforest — spec-driven feature forest

Commands:
  init                                       create config + folders
  sync                                       orchestrator; emits "NEXT: …"
  scan                                       read-only stale report (JSON)
  ingest <spec-name>                         stdin: tree JSON
  commit-islands                             stdin: islands JSON
  render                                     regenerate forest.md + island MDs
  tree [<spec-name>] [--regenerate] [--print]
                                             default: emit cache path for Read; --print dumps ASCII; --regenerate forces rebuild
  mark <spec>/<feature-path> <state>         set status: todo|in_progress|blocked|done
  implement <spec>/<feature-path> [--no-mark] guide implementation; mark in_progress
  status                                     one-line counters per island
  rehash [--dry-run]                         resync specHash to on-disk bytes (no tree regen)

Feature paths may target leaves (or any sub-feature):
  <spec>/<top>/<sub>/.../<leaf>
A single segment after the spec is resolved by name across the whole tree
(ambiguities prompt or list candidates).

Examples:
  node .claude/skills/specforest/bin/cli.js init
  node .claude/skills/specforest/bin/cli.js sync
  echo '<tree-json>' | node .claude/skills/specforest/bin/cli.js ingest my-spec
  node .claude/skills/specforest/bin/cli.js implement auth-design/auth-frontend/login-screen
  node .claude/skills/specforest/bin/cli.js mark auth-design/auth-frontend/login-screen done
`;

const HANDLERS = {
  init: cmdInit,
  scan: cmdScan,
  sync: cmdSync,
  ingest: cmdIngest,
  "commit-islands": cmdCommitIslands,
  render: cmdRender,
  tree: cmdTree,
  mark: cmdMark,
  implement: cmdImplement,
  status: cmdStatus,
  rehash: cmdRehash,
};

async function main() {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd || cmd === "--help" || cmd === "-h") {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const handler = HANDLERS[cmd];
  if (!handler) {
    process.stderr.write(`unknown command: ${cmd}\n\n${HELP}`);
    process.exit(1);
  }
  try {
    const code = await handler({
      cwd: process.cwd(),
      args: rest,
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
    });
    process.exit(code ?? 0);
  } catch (e) {
    if (e.code === "ENOENT_CONFIG") {
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    }
    process.stderr.write(`fatal: ${e.stack || e.message}\n`);
    process.exit(1);
  }
}

main();
