#!/usr/bin/env node

/**
 * decisions-recall: does the decision log return the axis that actually rules on a question?
 *
 * Unlike the three judge sub-benches next door, this one is DETERMINISTIC and free: scoring is set
 * arithmetic and substring matching over `query --json`, so a full run costs zero tokens and a few
 * seconds. That is what makes it affordable per-commit, and it is the reason the metrics live in a
 * separate pure module (scoring.mts) that never touches a model.
 *
 * THE CORPUS IS FROZEN, never the live docs/decisions/ tree. The gate under test writes to that
 * tree, so scoring against it would let labels rot silently — an ABSTAIN case stays correct only
 * until someone records a ruling on it. Cases carry the storeHash they were labelled against and
 * `coverage` fails loudly when it no longer matches.
 *
 *   node bench.mts                       # score the committed seed corpus
 *   node bench.mts --corpus <dir>        # score a local frozen snapshot (evidence-only tier)
 *   node bench.mts coverage              # composition + leakage matrix, zero retrieval calls
 *   node bench.mts --json                # machine-readable summary
 *
 * Tier sweep — the first question this suite exists to settle is whether the embedding tier earns
 * its keep at this corpus size, which no surveyed paper measures below a few thousand documents:
 *   BENCH_RETRIEVAL=lexical   BM25 only (default; what CI can run — no Ollama)
 *   BENCH_RETRIEVAL=semantic  requires a local Ollama + the embedding model
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BenchAbort, parseCasesText } from '../cases.mts';
import { wilson } from '../compare.mts';
import { type RecallCase, type Scored, scoreCase, summarize } from './scoring.mts';

const here = path.dirname(fileURLToPath(import.meta.url));
const SEED_CORPUS = path.join(here, 'corpus', 'seed');
const CASES = path.join(here, 'cases-retrieval.jsonl');
const TOP_K = 5;
/** G1: a question sharing more than this fraction of its tokens with its gold axis tests string
 *  matching, not retrieval. Rejected mechanically so the gate is auditable, not a matter of taste. */
const LEAK_CEILING = 0.5;
const TOKEN_RE = /[a-z0-9]+/g;

const tokens = (s: string) =>
  new Set(
    [...String(s).toLowerCase().matchAll(TOKEN_RE)].map((m) => m[0]).filter((t) => t.length > 1),
  );

/** Token Jaccard between a question and its gold axis text — the mechanical leakage gate. */
export function leakJaccard(question: string, axisText: string) {
  const a = tokens(question);
  const b = tokens(axisText);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  return shared / new Set([...a, ...b]).size;
}

/** Content hash of the frozen corpus: cases are only valid against the store they were labelled on. */
export function storeHash(dir: string) {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort();
  const h = createHash('sha256');
  for (const f of files)
    h.update(f)
      .update('\0')
      .update(readFileSync(path.join(dir, f)));
  return h.digest('hex').slice(0, 12);
}

function loadCases(): RecallCase[] {
  if (!existsSync(CASES))
    throw new BenchAbort(2, `decisions-recall: missing ${path.basename(CASES)}`);
  const rows = parseCasesText(readFileSync(CASES, 'utf8')) as RecallCase[];
  if (!rows.length) throw new BenchAbort(2, 'decisions-recall: case file is empty');
  const errors = lintRecallCases(rows);
  if (errors.length)
    throw new BenchAbort(2, `decisions-recall: malformed cases —\n  ${errors.join('\n  ')}`);
  return rows;
}

/** Structural contract, checked before any retrieval runs. */
export function lintRecallCases(rows: RecallCase[]) {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const [i, r] of rows.entries()) {
    const at = `row ${i + 1}${r?.id ? ` (${r.id})` : ''}`;
    if (!r?.id) errors.push(`${at}: missing id`);
    if (r?.id && seen.has(r.id)) errors.push(`${at}: duplicate id`);
    if (r?.id) seen.add(r.id);
    if (!r?.q) errors.push(`${at}: missing q`);
    // gold is empty IFF the case is an ABSTAIN — the two must never drift apart, or an unlabelled
    // answerable case would silently be scored as a correct abstain.
    if (r?.type === 'ABSTAIN' && r.gold?.length) errors.push(`${at}: ABSTAIN must have empty gold`);
    if (r?.type !== 'ABSTAIN' && !r?.gold?.length) errors.push(`${at}: ${r?.type} needs gold`);
    if (r?.type === 'CURRENT_STATE' && !r.currentState)
      errors.push(`${at}: CURRENT_STATE needs a currentState block`);
    if (r?.type === 'MULTI' && !(r.goldRequired?.length ?? 0))
      errors.push(`${at}: MULTI needs goldRequired`);
  }
  return errors;
}

/** Full text of an axis file, for the leakage gate. */
function axisText(corpus: string, slug: string) {
  const f = path.join(corpus, `${slug}.md`);
  return existsSync(f) ? readFileSync(f, 'utf8') : '';
}

async function runCases(corpus: string, cases: RecallCase[]): Promise<Scored[]> {
  // Point the engine's config at the frozen corpus and away from any live tree or vector cache.
  process.env.GUARD_DECISIONS_DIR = corpus;
  process.env.DECISIONS_INDEX = path.join(corpus, '..', '.vec-bench.json');
  if ((process.env.BENCH_RETRIEVAL ?? 'lexical') === 'lexical')
    process.env.DECISIONS_NO_EMBED = '1';
  const { queryEnvelope } = await import('../../decisions.mts');

  const scored: Scored[] = [];
  for (const c of cases) {
    let env = null;
    try {
      const first = await queryEnvelope(c.q, TOP_K, process.cwd());
      // Determinism assertion: the bench's whole premise is that a flip means a real change, so a
      // run that cannot reproduce its own ordering must abort rather than average over the noise.
      const second = await queryEnvelope(c.q, TOP_K, process.cwd());
      const order = (e: typeof first) => e.rows.map((r) => r.slug).join(',');
      if (order(first) !== order(second))
        throw new BenchAbort(2, `decisions-recall: non-deterministic rank for "${c.id}"`);
      env = first;
    } catch (e) {
      if (e instanceof BenchAbort) throw e;
      env = null; // CLI/engine failure → ERROR bucket, excluded from every metric
    }
    scored.push(scoreCase(c, env));
  }
  return scored;
}

const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : '—');
const ci = (k: number, n: number) => {
  if (!n) return '—';
  const { lo, hi } = wilson(k, n);
  return `${k}/${n} = ${pct(k, n)} [${(lo * 100).toFixed(0)}, ${(hi * 100).toFixed(0)}]`;
};

function report(sum: ReturnType<typeof summarize>, corpus: string, cases: RecallCase[]) {
  console.log(`\n── decisions-recall ──`);
  console.log(
    `corpus ${path.basename(corpus)} · storeHash ${storeHash(corpus)} · ${cases.length} cases`,
  );
  console.log(`tier ${process.env.BENCH_RETRIEVAL ?? 'lexical'} · 0 LLM calls\n`);

  // Five families, five denominators, printed apart. A single headline number is deliberately
  // absent: these failures have opposite fixes and pooling them lets one mask another.
  console.log('(a) Containment@5 — was the right axis returned at all');
  console.log(`      SINGLE  ${ci(sum.containment.SINGLE.hit, sum.containment.SINGLE.total)}`);
  console.log(`      MULTI   ${ci(sum.containment.MULTI.hit, sum.containment.MULTI.total)}`);
  console.log('(b) Buried@5 — returned, but under noise (conditional on containment)');
  console.log(
    `      by rank ${sum.buried.rank}/${sum.buried.total}  ·  by distractor ${sum.buried.distractor}/${sum.buried.total}`,
  );
  console.log('(c) Current-state — was the LIVE ruling returned, or a stale one');
  console.log(`      CSA     ${ci(sum.currentState.csa.hit, sum.currentState.csa.total)}`);
  console.log(
    `      SFER    ${ci(sum.currentState.sfer.bad, sum.currentState.sfer.total)}  (lower is better)`,
  );
  console.log('(d) Abstention — a 2x2, never blended into one score');
  console.log(
    `      FANR    ${ci(sum.abstention.fanr.bad, sum.abstention.fanr.total)}  answered when nothing rules`,
  );
  console.log(
    `      FAR     ${ci(sum.abstention.far.bad, sum.abstention.far.total)}  abstained when something does`,
  );
  console.log('(e) Multi-axis — could the question be settled at all');
  console.log(`      SetRecall     ${ci(sum.multi.setRecall.hit, sum.multi.setRecall.total)}`);
  console.log(
    `      PartialRecall ${sum.multi.partialRecall === null ? '—' : `${(sum.multi.partialRecall * 100).toFixed(1)}% (macro)`}`,
  );
  if (sum.errors)
    console.log(`\n  ⚠ ${sum.errors} case(s) errored and were excluded from every metric`);

  const misses = Object.entries(sum.rows).filter(
    ([, r]) =>
      r.outcome === 'MISS' || r.outcome === 'FALSE_ANSWER' || r.outcome === 'FALSE_ABSTAIN',
  );
  if (misses.length) {
    console.log('\n  failing cases:');
    for (const [id, r] of misses) console.log(`    ${r.outcome.padEnd(14)} ${id}`);
  }
}

/** Composition + the mechanical leakage audit. Zero retrieval calls. */
function coverage(corpus: string, cases: RecallCase[]) {
  const byType: Record<string, number> = {};
  for (const c of cases) byType[c.type] = (byType[c.type] ?? 0) + 1;
  console.log(`\n── coverage ──`);
  console.log(`corpus ${path.basename(corpus)} · storeHash ${storeHash(corpus)}`);
  for (const [t, n] of Object.entries(byType).sort()) console.log(`  ${t.padEnd(15)} ${n}`);

  console.log('\n  leakage (token Jaccard, question vs its gold axis file):');
  const leaks: { id: string; j: number }[] = [];
  for (const c of cases) {
    for (const g of c.gold) {
      const j = leakJaccard(c.q, axisText(corpus, g));
      leaks.push({ id: c.id, j });
    }
  }
  const over = leaks.filter((l) => l.j > LEAK_CEILING);
  const max = leaks.reduce((m, l) => Math.max(m, l.j), 0);
  console.log(`    max ${max.toFixed(3)} · ceiling ${LEAK_CEILING} · over ceiling: ${over.length}`);
  for (const o of over)
    console.log(`    ✗ ${o.id} — ${o.j.toFixed(3)} rewrites the ruling; reject`);
  if (!over.length) console.log('    ✓ every case is below the ceiling');
  return over.length;
}

export async function main(argv: string[]) {
  const args = new Set(argv);
  const at = argv.indexOf('--corpus');
  const corpus = at !== -1 && argv[at + 1] ? path.resolve(argv[at + 1]) : SEED_CORPUS;
  if (!existsSync(corpus)) throw new BenchAbort(2, `decisions-recall: no corpus at ${corpus}`);

  const cases = loadCases();
  if (args.has('coverage')) {
    process.exit(coverage(corpus, cases) ? 1 : 0);
  }

  const scored = await runCases(corpus, cases);
  const sum = summarize(scored);
  if (args.has('--json'))
    console.log(JSON.stringify({ storeHash: storeHash(corpus), ...sum }, null, 2));
  else report(sum, corpus, cases);
  process.exit(0);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof BenchAbort ? e.message : `decisions-recall: ${e}`);
    process.exit(e instanceof BenchAbort ? e.code : 2);
  });
}
