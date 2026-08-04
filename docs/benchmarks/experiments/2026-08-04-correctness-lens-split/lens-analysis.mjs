// Per-lens analysis of reviewer-eval runs, against the pre-registered metrics in
// docs/benchmarks/pre-registration-lens-split.md. The bench reports POOLED numbers only; the
// hypothesis under test is about SUBSETS (strong pair vs weak pair), so this computes those.
//
//   bun lens-analysis.mjs <cases.jsonl> <runA.log> [runB.log] [--labelA X] [--labelB Y]
//
// Lens attribution mirrors what the pre-registration declares: golds carry expectItems; decoys
// carry none (0 of 65 PASS rows do), so they inherit their gold twin's lens via variantOf, falling
// back to a shared caseId. Rows that cannot be mapped are reported, never silently dropped.

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

/** id -> first-pass verdict, from a bench run log. */
function loadRun(file) {
  const out = new Map();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = ROW_RE.exec(line);
    if (m) out.set(m[1], m[3] === 'null' ? null : m[3]);
  }
  return out;
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
    }
    if (!oka && okb) {
      cc++;
      moved.push(`  improved   ${id}`);
    }
  }
  return { b: bb, c: cc, net: cc - bb, moved };
}

// Skip flag VALUES as well as flags when collecting positionals.
const argv = process.argv.slice(2);
const FLAGS = new Set(['--labelA', '--labelB']);
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

const corpus = loadCorpus(casesFile);
const a = loadRun(runA);
const b = runB ? loadRun(runB) : null;

const groups = { strong: [], weak: [], unmapped: [] };
for (const id of a.keys()) {
  const lens = corpus.lensOf.get(id);
  if (STRONG.has(lens)) groups.strong.push(id);
  else if (WEAK.has(lens)) groups.weak.push(id);
  else groups.unmapped.push(id);
}
const all = [...a.keys()];

console.log(`rows scored in ${labelA}: ${a.size}${b ? ` · ${labelB}: ${b.size}` : ''}`);
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
    console.log(`${name.padEnd(20)} b=${f.b} c=${f.c} net=${f.net > 0 ? '+' : ''}${f.net}`);
  }
  const wf = flips(groups.weak, corpus, a, b);
  if (wf.moved.length) {
    console.log('\nweak-pair movements:');
    for (const m of wf.moved) console.log(m);
  }
}
