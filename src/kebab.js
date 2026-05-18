const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function isKebab(s) {
  return typeof s === "string" && KEBAB_RE.test(s);
}

export function toKebab(s) {
  return String(s)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const prev = new Array(n + 1);
  const curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

export function closestMatch(target, candidates) {
  let best = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    const d = levenshtein(target, c);
    if (d < bestScore) {
      bestScore = d;
      best = c;
    }
  }
  return best;
}
