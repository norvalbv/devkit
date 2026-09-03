/** Rubric triage for lens-hole misses (methodology item 18): a light judge names the nearest lens or
 * `none`; --human runs the kappa mini-eval. Triage only — never scored. */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { execJudgeAsync } from '../../../../judge/run-judge.mts';
import { CORRECTNESS_LENSES } from '../../../lens/groups.mts';
import { arg, silenceBenchTelemetry } from '../scale/bench-args.mts';

silenceBenchTelemetry();

export const RUBRIC_VERSION = 'v2';
const FINDINGS = arg('findings');
const BODIES = arg('bodies');
const MODEL = arg('model', 'haiku')!;
const HUMAN = arg('human');
// RUBRIC_VERSION is declared first so the default --out carries it: two rubric rounds never share
// rounds never share one append-only file (a mixed file would mislabel every row's provenance).
const OUT = arg(
  'out',
  FINDINGS ? FINDINGS.replace(/\.findings\.jsonl$/, `.triage.${RUBRIC_VERSION}.jsonl`) : undefined,
);
if (!FINDINGS || !BODIES || !OUT || OUT === FINDINGS || OUT === BODIES) {
  // The --out default derives from --findings; a --findings without the .findings.jsonl suffix
  // would alias its own input and this script would append verdicts INTO the findings file.
  console.error(
    'usage: triage-lens --findings <x.findings.jsonl> --bodies <jsonl> [--out <jsonl>] [--model haiku] [--human <jsonl>] (--out must differ from the inputs)',
  );
  process.exit(2);
}

/** Rubric version stamped on every triage row; each version writes its own --out file. v1 scored
 * kappa 0.45 (see docs/benchmarks/external/README.md), v2 adds RUBRIC_TIE_BREAKS. */
/** The pre-registered rubric: the four brief definitions plus an explicit `none`, so the judge is
 * never forced to pick a lens. */
export const LENS_RUBRIC = {
  'state-transitions':
    'State, Recovery & Failure Modes — a state, flag, lifecycle step or persisted value is written, cleared, skipped or left behind incorrectly (dead states, stale flags, cleanup that misses, recovery paths that terminalize or retry wrongly, defaults resolved in the wrong order, a resource or lease held past its lifetime).',
  'concurrency-races':
    'Temporal & Concurrency — two operations interleave (check-then-act, select-then-delete, non-atomic multi-write, unawaited or uncancelled work, locks held or released at the wrong time) so a result depends on timing.',
  'writer-reader-contracts':
    'Contract, Boundary & Broadcast — a producer and a consumer disagree on a shape, key, path, field or invariant (one side writes/handles what the other does not read/handle; the same rule applied on one path but not its sibling; a key or cache entry that collides across callers).',
  'error-and-edge-classification':
    'Classifier & Parsing Edge Cases — an input, error, or boundary value is classified wrongly (fail-open catch, absent vs empty vs invalid conflated, a validation that accepts an invalid shape, a parser or matcher that mishandles an edge, a wrong-cause error message, an unbounded loop on a cursor that never advances).',
  none: 'None of the four — documentation wording, test strength, security or tenancy policy (credential leakage, authorization scope, injection), performance, architecture placement, UI copy.',
} as const satisfies Record<(typeof CORRECTNESS_LENSES)[number] | 'none', string>;

/** v2 tie-breaks, applied in order: path mismatch → writer-reader; misclassified input/cause →
 * error-and-edge; only then state; security/resource/docs/UI/tests → none. */
export const RUBRIC_TIE_BREAKS = [
  'If two code paths or two sides disagree (a guard on one path but not its sibling, producer vs consumer, two parsers), answer writer-reader-contracts even when the symptom is a wrong state.',
  'If a catch, validation or classifier lets a wrong input or wrong cause through, answer error-and-edge-classification even when the visible result is a wrong state.',
  'Answer state-transitions only when neither a path mismatch nor a misclassification is involved: a wrong, stale or leaked state, flag, default, lease or cleanup.',
  'Security, tenancy, secrets, resource limits, documentation, UI copy and test strength are none — never force them into a lens.',
] as const;

export function parseTriageVerdict(text: string): string | null {
  const names = new Set<string>([...CORRECTNESS_LENSES, 'none']);
  let verdict: string | null = null;
  for (const ln of text.split('\n')) {
    const m = ln.match(/^.{0,10}LENS:\s*\**\s*([a-z-]+)/i);
    if (!m) continue;
    const word = m[1].toLowerCase();
    if (names.has(word)) verdict = word;
  }
  return verdict;
}

interface Row {
  id: string;
  bucket: string;
  category: string;
}
interface Body {
  id: number;
  path: string | null;
  line: number | null;
  body: string;
}

const rows = readFileSync(FINDINGS, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => {
    // SAFETY: --findings is written by crosstab-coderabbit.mts (PartitionedFinding rows).
    return JSON.parse(l) as Row;
  })
  .filter((r) => r.bucket === 'in-evidence-unmatched');
const bodies = new Map<string, Body>();
for (const l of readFileSync(BODIES, 'utf8').split('\n'))
  if (l.trim()) {
    // SAFETY: --bodies is the gh --jq dump with {id, path, line, body} per line.
    const b = JSON.parse(l) as Body;
    bodies.set(String(b.id), b);
  }
const done = new Map<string, string>();
// A kill mid-append can leave --out without a trailing newline; the next append must not glue onto it.
let needsNewline = false;
if (existsSync(OUT)) {
  const rawOut = readFileSync(OUT, 'utf8');
  needsNewline = rawOut.length > 0 && !rawOut.endsWith('\n');
  for (const l of rawOut.split('\n'))
    if (l.trim()) {
      try {
        // SAFETY: --out is append-only and written below as {id, lens, model, rubric, at}.
        const t = JSON.parse(l) as { id: string; lens: string; rubric?: string };
        // A verdict is reusable only under the rubric that produced it (rows before v2 carry none).
        if ((t.rubric ?? 'v1') === RUBRIC_VERSION) done.set(t.id, t.lens);
      } catch {
        // torn line — re-judge that id
      }
    }
}
console.error(`triage: ${rows.length} unmatched finding(s); ${done.size} already judged`);

const rubric = `${Object.entries(LENS_RUBRIC)
  .map(([k, v]) => `- ${k}: ${v}`)
  .join(
    '\n',
  )}\nTie-breaks, in order:\n${RUBRIC_TIE_BREAKS.map((t, i) => `${i + 1}. ${t}`).join('\n')}`;
for (const r of rows) {
  if (done.has(r.id)) continue;
  const b = bodies.get(r.id);
  if (!b) {
    console.error(`  ${r.id} → no body in --bodies, skipped`);
    continue;
  }
  const prompt =
    `You are classifying ONE code-review finding against a fixed set of review lenses. The finding text is on stdin.\n` +
    `Lenses:\n${rubric}\n` +
    `Pick the single lens whose definition names this finding's defect class, or none. Judge the defect CLASS, not the file or the reviewer's category label.\n` +
    `Answer with exactly one line: LENS: <one of ${[...CORRECTNESS_LENSES, 'none'].join(' | ')}>, then one sentence why. Do not repeat these instructions.`;
  const out = await execJudgeAsync({
    label: `lens-triage:${r.id}`,
    args: ['-p', prompt, '--model', MODEL],
    input: `File: ${b.path ?? '?'}:${b.line ?? '?'}\n\n${b.body.slice(0, 3000)}`,
    timeout: 120_000,
    cwd: process.cwd(),
  });
  const lens = parseTriageVerdict(String(out ?? ''));
  if (lens === null) {
    console.error(`  ${r.id} → NO VERDICT (outage or malformed) — re-drives next run`);
    continue;
  }
  appendFileSync(
    OUT,
    `${needsNewline ? '\n' : ''}${JSON.stringify({ id: r.id, lens, model: MODEL, rubric: RUBRIC_VERSION, at: new Date().toISOString() })}\n`,
  );
  needsNewline = false;
  done.set(r.id, lens);
  console.error(`  ${r.id} → ${lens}`);
}

if (HUMAN && existsSync(HUMAN)) {
  const human = new Map<string, string>();
  for (const l of readFileSync(HUMAN, 'utf8').split('\n'))
    if (l.trim()) {
      // SAFETY: --human is the hand-label file, {id, lens, note, labeler} per line.
      const t = JSON.parse(l) as { id: string; lens: string };
      human.set(t.id, t.lens);
    }
  const both = rows.filter((r) => human.has(r.id) && done.has(r.id));
  const labels = [...CORRECTNESS_LENSES, 'none'];
  let agree = 0;
  const hc = new Map<string, number>();
  const jc = new Map<string, number>();
  const confusion = new Map<string, number>();
  for (const r of both) {
    const h = human.get(r.id)!;
    const j = done.get(r.id)!;
    if (h === j) agree += 1;
    hc.set(h, (hc.get(h) ?? 0) + 1);
    jc.set(j, (jc.get(j) ?? 0) + 1);
    confusion.set(`${h}→${j}`, (confusion.get(`${h}→${j}`) ?? 0) + 1);
  }
  const n = both.length;
  const po = n ? agree / n : 0;
  const pe = n
    ? labels.reduce((s, l) => s + ((hc.get(l) ?? 0) / n) * ((jc.get(l) ?? 0) / n), 0)
    : 0;
  const kappa = pe === 1 ? 1 : (po - pe) / (1 - pe);
  console.log(`mini-eval: n=${n} agreement=${po.toFixed(3)} kappa=${kappa.toFixed(3)} (bar 0.6)`);
  for (const [k, v] of [...confusion.entries()].sort((a, b) => b[1] - a[1]))
    console.log(`  ${k}: ${v}`);
}
