// Per-lens analysis of reviewer-eval runs, against the pre-registered metrics in
// docs/benchmarks/pre-registration-lens-split.md. The bench reports POOLED numbers only; the
// hypothesis under test is about SUBSETS (strong pair vs weak pair), so this computes those.
//
//   bun lens-analysis.mjs <cases.jsonl> <runA> <runB> [--null <runNull>] [--labelA X] [--labelB Y]
//   bun lens-analysis.mjs --selftest
//
// Runs are either a bench .log (row lines) or a bench baseline .json (sections → rows). Both carry
// the same first-pass verdicts; the .json is the canonical artifact, the .log is what an --against
// run leaves behind.
//
// Lens attribution mirrors what the pre-registration declares: golds carry expectItems; decoys
// carry none (0 of 65 PASS rows do), so they inherit their gold twin's lens via variantOf, falling
// back to a shared caseId. Rows that cannot be mapped are reported, never silently dropped.
//
// REPRODUCIBILITY. The corpus is NOT committed beside these runs — it is the live
// gate-engine/review/eval/reviewers/cases-correctness.jsonl, which grows. The runs in ./runs were
// scored against blob 6a0a3da466c7375c1ab26ab4efd05ac0682ecad2 (140 rows, tree a319770). To
// reproduce exactly once the corpus has moved on:
//
//   git show 6a0a3da4 > /tmp/cases-at-run-time.jsonl
//
// Passing a corpus that does not contain a scored row is an error, not a silent skip — see
// assertComparable.

import { readFileSync } from 'node:fs';

const STRONG = new Set(['concurrency-races', 'state-transitions']);
const WEAK = new Set(['writer-reader-contracts', 'error-and-edge-classification']);
const ROW_RE = /^\s{2}(\S+)\s+(OK|MISS)\s+first=(PASS|FAIL|null)/;

function wilson(k, n) {
  if (!n) return [0, 0];
  const z = 1.96;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const m = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - m), Math.min(1, c + m)];
}

/** Exact two-sided McNemar mid-p over the b/c discordant pairs — the statistic the ruling cites.
 * Mid-p rather than the exact test because the exact one is conservative at these denominators;
 * it is what the bench prints, and `--selftest` pins it against three published runs. */
export function midP(b, c) {
  const n = b + c;
  if (n === 0) return 1;
  const m = Math.min(b, c);
  // Binomial(n, 0.5) pmf without factorials — the ratio form stays exact well past n=140.
  let pmf = 0.5 ** n;
  let below = 0;
  for (let k = 0; k < m; k += 1) {
    below += pmf;
    pmf = (pmf * (n - k)) / (k + 1);
  }
  return Math.min(1, 2 * (below + 0.5 * pmf));
}

function loadCorpus(file) {
  const byId = new Map();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    byId.set(r.id, r);
  }
  const lensOf = new Map();
  for (const r of byId.values()) {
    if (r.expectItems?.length) lensOf.set(r.id, r.expectItems[0]);
  }
  for (const r of byId.values()) {
    if (lensOf.has(r.id)) continue;
    const twin = r.variantOf && lensOf.get(r.variantOf);
    if (twin) {
      lensOf.set(r.id, twin);
      continue;
    }
    // fallback: any sibling sharing the caseId that does carry a lens
    if (!r.caseId) continue;
    for (const s of byId.values())
      if (s.caseId === r.caseId && lensOf.has(s.id)) {
        lensOf.set(r.id, lensOf.get(s.id));
        break;
      }
  }
  return { byId, lensOf };
}

/** id -> first-pass verdict, from a bench run log OR a bench baseline json. */
function loadRun(file) {
  const out = new Map();
  const raw = readFileSync(file, 'utf8');
  if (file.endsWith('.json')) {
    // Baseline shape: sections → rows → {expected, okFirst}. The verdict is not stored directly,
    // but for a binary expectation okFirst pins it exactly.
    for (const section of Object.values(JSON.parse(raw).sections ?? {}))
      for (const [id, row] of Object.entries(section.rows ?? {})) {
        if (row.okFirst === undefined) continue;
        const flip = row.expected === 'FAIL' ? 'PASS' : 'FAIL';
        out.set(id, row.okFirst ? row.expected : flip);
      }
  } else {
    for (const line of raw.split('\n')) {
      const m = ROW_RE.exec(line);
      if (m) out.set(m[1], m[3] === 'null' ? null : m[3]);
    }
  }
  if (out.size === 0)
    throw new Error(
      `${file}: no scored rows found. Expected a bench .log (rows like "  <id>  OK  first=FAIL") ` +
        'or a baseline .json with sections[].rows[].okFirst.',
    );
  return out;
}

/** Every scored row must exist in the corpus, and paired runs must cover the SAME rows — otherwise
 * metrics silently describe a subset and the flip table pairs rows that were never comparable. */
function assertComparable(corpus, runs) {
  const problems = [];
  for (const [label, run] of runs) {
    const unknown = [...run.keys()].filter((id) => !corpus.byId.has(id));
    if (unknown.length)
      problems.push(`${label}: ${unknown.length} row(s) absent from the corpus: ${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? ' …' : ''}`);
  }
  const [first, ...rest] = runs;
  for (const [label, run] of rest) {
    const missing = [...first[1].keys()].filter((id) => !run.has(id));
    const extra = [...run.keys()].filter((id) => !first[1].has(id));
    if (missing.length || extra.length)
      problems.push(
        `${label} does not cover the same rows as ${first[0]}: ${missing.length} missing, ${extra.length} extra` +
          `${missing.length ? ` (e.g. ${missing.slice(0, 3).join(', ')})` : ''}`,
      );
  }
  if (problems.length) {
    console.error('non-comparable inputs — refusing to score:\n  ' + problems.join('\n  '));
    process.exit(2);
  }
}

const metrics = (ids, corpus, run) => {
  let gk = 0;
  let gn = 0;
  let dk = 0;
  let dn = 0;
  for (const id of ids) {
    const v = run.get(id);
    if (v === undefined) continue; // row not in this run
    const exp = corpus.byId.get(id).expected;
    if (exp === 'FAIL') {
      gn++;
      if (v === 'FAIL') gk++;
    } else {
      dn++;
      if (v === 'PASS') dk++;
    }
  }
  return { gk, gn, dk, dn };
};

const fmt = ({ gk, gn, dk, dn }) => {
  const r = gn ? (gk / gn).toFixed(2) : '—';
  const c = dn ? (dk / dn).toFixed(2) : '—';
  const rc = gn ? wilson(gk, gn).map((x) => x.toFixed(2)).join(',') : '';
  const cc = dn ? wilson(dk, dn).map((x) => x.toFixed(2)).join(',') : '';
  return `recall ${r} [${rc}] (${gk}/${gn})   clean-pass ${c} [${cc}] (${dk}/${dn})`;
};

/** McNemar discordance for one subset: b = A-right→B-wrong, c = A-wrong→B-right. */
function flips(ids, corpus, a, b) {
  let bb = 0;
  let cc = 0;
  const moved = [];
  const byId = new Map();
  for (const id of ids) {
    const va = a.get(id);
    const vb = b.get(id);
    if (va === undefined || vb === undefined) continue;
    const exp = corpus.byId.get(id).expected;
    const oka = va === exp;
    const okb = vb === exp;
    if (oka && !okb) {
      bb++;
      moved.push(`  regressed  ${id}`);
      byId.set(id, 'regressed');
    }
    if (!oka && okb) {
      cc++;
      moved.push(`  improved   ${id}`);
      byId.set(id, 'improved');
    }
  }
  return { b: bb, c: cc, net: cc - bb, moved, byId };
}

/** Flips left after removing rows that move the SAME way in the null (control-vs-control) run.
 * Those rows move regardless of arm, so counting them as an arm effect overstates it — this is the
 * adjustment behind the README's "+4 vs +1". */
function adjust(armFlips, nullFlips) {
  let b = 0;
  let c = 0;
  const shared = [];
  for (const [id, dir] of armFlips.byId) {
    if (nullFlips.byId.get(id) === dir) {
      shared.push(id);
      continue;
    }
    if (dir === 'regressed') b += 1;
    else c += 1;
  }
  return { b, c, net: c - b, shared };
}

function selftest() {
  // Pinned against the three arms published in this directory's README, whose mid-p values the
  // bench printed independently: null ↓3↑2 = 0.688, 2-way ↓1↑5 = 0.125, 4-way ↓0↑5 = 0.031.
  const cases = [
    [3, 2, 0.6875],
    [1, 5, 0.125],
    [0, 5, 0.03125],
    [0, 0, 1],
  ];
  let bad = 0;
  for (const [b, c, want] of cases) {
    const got = midP(b, c);
    const ok = Math.abs(got - want) < 1e-9;
    if (!ok) bad += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'} midP(${b}, ${c}) = ${got} (want ${want})`);
  }
  process.exit(bad ? 1 : 0);
}

// Skip flag VALUES as well as flags when collecting positionals.
const argv = process.argv.slice(2);
if (argv.includes('--selftest')) selftest();
const FLAGS = new Set(['--labelA', '--labelB', '--null']);
const positional = [];
for (let i = 0; i < argv.length; i += 1) {
  if (FLAGS.has(argv[i])) {
    i += 1;
    continue;
  }
  if (!argv[i].startsWith('--')) positional.push(argv[i]);
}
const [casesFile, runA, runB] = positional;
const arg = (n, d) => {
  const i = argv.indexOf(n);
  return i === -1 ? d : argv[i + 1];
};
const labelA = arg('--labelA', 'A');
const labelB = arg('--labelB', 'B');
const nullFile = arg('--null', null);

if (!casesFile || !runA) {
  console.error('usage: lens-analysis.mjs <cases.jsonl> <runA> [runB] [--null <runNull>]');
  process.exit(2);
}

const corpus = loadCorpus(casesFile);
const a = loadRun(runA);
const b = runB ? loadRun(runB) : null;
const nul = nullFile ? loadRun(nullFile) : null;
assertComparable(corpus, [
  [labelA, a],
  ...(b ? [[labelB, b]] : []),
  ...(nul ? [['null', nul]] : []),
]);

const groups = { strong: [], weak: [], unmapped: [] };
for (const id of a.keys()) {
  const lens = corpus.lensOf.get(id);
  if (STRONG.has(lens)) groups.strong.push(id);
  else if (WEAK.has(lens)) groups.weak.push(id);
  else groups.unmapped.push(id);
}
const all = [...a.keys()];

console.log(`rows scored in ${labelA}: ${a.size}${b ? ` · ${labelB}: ${b.size}` : ''}${nul ? ` · null: ${nul.size}` : ''}`);
console.log(`lens-mapped: strong ${groups.strong.length} · weak ${groups.weak.length} · UNMAPPED ${groups.unmapped.length}\n`);

const show = (name, ids) => {
  console.log(`${name.padEnd(10)} ${labelA}: ${fmt(metrics(ids, corpus, a))}`);
  if (b) console.log(`${' '.repeat(10)} ${labelB}: ${fmt(metrics(ids, corpus, b))}`);
};
show('POOLED', all);
show('strong', groups.strong);
show('weak', groups.weak);
for (const lens of [...STRONG, ...WEAK]) {
  const ids = all.filter((id) => corpus.lensOf.get(id) === lens);
  show(lens.slice(0, 9), ids);
}

if (b) {
  console.log('\n── flip tables (b = regressed, c = improved; repo floor ≈ 5 net) ──');
  for (const [name, ids] of [
    ['POOLED', all],
    ['strong (guardrail)', groups.strong],
    ['weak (co-primary)', groups.weak],
  ]) {
    const f = flips(ids, corpus, a, b);
    const p = midP(f.b, f.c);
    let line = `${name.padEnd(20)} b=${f.b} c=${f.c} net=${f.net > 0 ? '+' : ''}${f.net} · mid-p ${p.toFixed(3)}`;
    if (nul) {
      const adj = adjust(f, flips(ids, corpus, a, nul));
      line += `  ⇒ null-adjusted b=${adj.b} c=${adj.c} net=${adj.net > 0 ? '+' : ''}${adj.net}`;
      line += ` (${adj.shared.length} shared with null)`;
    }
    console.log(line);
  }
  if (!nul)
    console.log('\n(pass --null <control-vs-control run> for the null-adjusted flips the ruling cites)');
  const wf = flips(groups.weak, corpus, a, b);
  if (wf.moved.length) {
    console.log('\nweak-pair movements:');
    for (const m of wf.moved) console.log(m);
  }
}
