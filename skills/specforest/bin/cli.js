#!/usr/bin/env node
import { cmdInit } from "../src/commands/init.js";
import { cmdScan } from "../src/commands/scan.js";
import { cmdSync } from "../src/commands/sync.js";
import { cmdIngest } from "../src/commands/ingest.js";
import { cmdCommitIslands } from "../src/commands/commit-islands.js";
import { cmdAddIsland } from "../src/commands/add-island.js";
import { cmdExtendIsland } from "../src/commands/extend-island.js";
import { cmdRender } from "../src/commands/render.js";
import { cmdTree } from "../src/commands/tree.js";
import { cmdMark } from "../src/commands/mark.js";
import { cmdImplement } from "../src/commands/implement.js";
import { cmdVerify } from "../src/commands/verify.js";
import { cmdStatus } from "../src/commands/status.js";
import { cmdRehash } from "../src/commands/rehash.js";

const HELP = `specforest — spec-driven feature forest

Commands:
  init                                       create config + folders
  sync [--recluster-islands]                 orchestrator; emits "NEXT: …".
                                             default: incremental (preserve existing islands,
                                             extend/add for new top-level features).
                                             --recluster-islands forces a full re-cluster
                                             (also used automatically if islands.json is absent).
  scan                                       read-only stale report (JSON)
  ingest <spec-name>                         stdin: tree JSON
  commit-islands                             stdin: islands JSON (full re-cluster)
  add-island                                 stdin: single-island JSON (additive; preserves all existing islands)
  extend-island <id-or-name>                 stdin: { addMembers, addDependencies } (extends ONE existing island; intra-island deps only)
  render                                     regenerate forest.md + island MDs
  tree [<spec-name>] [--regenerate] [--print]
                                             default: emit cache path for Read; --print dumps ASCII; --regenerate forces rebuild
  mark <spec>/<feature-path> <state>         set status: todo|in_progress|blocked|done
  implement <spec>/<feature-path> [--no-mark] guide implementation; mark in_progress
  verify <spec>/<feature-path>               check if implemented; read-only, suggests follow-up mark
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
  "add-island": cmdAddIsland,
  "extend-island": cmdExtendIsland,
  render: cmdRender,
  tree: cmdTree,
  mark: cmdMark,
  implement: cmdImplement,
  verify: cmdVerify,
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
