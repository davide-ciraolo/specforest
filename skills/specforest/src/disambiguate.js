import readline from "node:readline";

export async function pickMatch({ spec, name, matches, stdin, stdout, stderr }) {
  const interactive = stdin && stdin.isTTY && stdout && stdout.isTTY;
  const lines = [];
  lines.push(`ambiguous: "${name}" matches ${matches.length} nodes:`);
  matches.forEach((m, i) => {
    lines.push(`  [${i + 1}] ${spec}/${m.fullPath}`);
  });

  if (!interactive) {
    stderr.write(lines.join("\n") + "\n");
    stderr.write(`disambiguate by re-running with full path, e.g. "${spec}/${matches[0].fullPath}"\n`);
    return null;
  }

  stdout.write(lines.join("\n") + "\n");
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = await new Promise((resolve) => {
      rl.question(`select [1-${matches.length}] (or empty to abort): `, resolve);
    });
    const trimmed = answer.trim();
    if (!trimmed) return null;
    const idx = Number.parseInt(trimmed, 10);
    if (!Number.isInteger(idx) || idx < 1 || idx > matches.length) {
      stderr.write(`invalid selection: ${trimmed}\n`);
      return null;
    }
    return matches[idx - 1];
  } finally {
    rl.close();
  }
}
