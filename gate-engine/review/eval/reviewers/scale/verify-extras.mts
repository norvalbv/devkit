/**
 * Cheap noise gauge for the scale probe: every DEDUPED extra finding (a prediction matching no
 * telemetry label) is judged ONCE by a haiku verifier that sees the finding text plus the file's
 * own diff hunk, answering REAL or NOT. This is a precision PROXY (guardrail 1 of
 * pre-registration-scale-chunk.md), not ground truth. Appends verdicts to <out>/verify.jsonl
 * (checkpointed by finding key); prints per-(model, arm) verified-precision. Local only — never
 * committed.
 */
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execJudgeAsync } from '../../../../judge/run-judge.mts';
import { extractLocations, linesMatch, readArchivedDiff, resolveToStaged } from './labels.mts';
import { identityByPath } from '../../../lens/chunk.mts';
import { filePathOf, splitDiffByFile } from '../../../../judge/diff-focus.mts';

// The bench is not a gate run: silence the telemetry sink for the verifier's judge calls too.
process.env.DEVKIT_NO_TELEMETRY = '1';
delete process.env.DEVKIT_GATE_EVENTS;
delete process.env.DEVKIT_SHIP_ID;
delete process.env.DEVKIT_RUN_MODE;

const OUT =
  process.argv[2] ??
  path.join(os.homedir(), '.devkit', 'research', '2026-08-22-ship-attempts', 'probe');
const CAP = 150;

interface Extra {
  key: string;
  diff: string;
  model: string;
  arm: string;
  lens: string;
  file: string;
  line: number | null;
  text: string;
}

interface ResultsFile {
  diff: string;
  labels: Array<{ file: string; line: number | null }>;
  rows: Array<{
    arm: string;
    model?: string;
    status?: string;
    issues: Array<{ lens: string; text: string }>;
  }>;
}

const verified = new Map<string, { real: boolean }>();
const VFILE = path.join(OUT, 'verify.jsonl');
let tornVerdicts = 0;
if (existsSync(VFILE))
  for (const l of readFileSync(VFILE, 'utf8').trim().split('\n'))
    if (l.trim()) {
      try {
        // SAFETY: verify.jsonl is append-only and written exclusively by this script with {key, real} rows.
        const r = JSON.parse(l) as { key: string; real: boolean };
        verified.set(r.key, { real: r.real });
      } catch {
        tornVerdicts += 1; // a torn trailing line re-verifies that extra — safer than crashing
      }
    }
if (tornVerdicts > 0)
  console.error(`verify-extras: skipped ${tornVerdicts} torn verify.jsonl line(s)`);

const extras: Extra[] = [];
for (const f of readdirSync(OUT)
  .filter((n) => n.startsWith('results-') && n.endsWith('.json'))
  .sort()) {
  let res: ResultsFile;
  try {
    // SAFETY: results-*.json files are written (tmp+rename) exclusively by scale-bench.mts with this shape.
    res = JSON.parse(readFileSync(path.join(OUT, f), 'utf8')) as ResultsFile;
  } catch {
    console.error(`verify-extras: SKIPPING unreadable ${f}`);
    continue;
  }
  // Resolve against the diff's FULL staged set — the same set score() resolves against — so an
  // ambiguous mention classifies identically on both sides of the hit/extra complement. Without
  // the archived diff that set cannot be reconstructed, so the file is skipped LOUDLY rather than
  // silently degrading to label-bearing paths (which reintroduces open-set cross-attribution).
  const wholeDiff = readArchivedDiff(res.diff);
  if (!wholeDiff) {
    console.error(`verify-extras: SKIPPING ${f} — archived diff missing, staged set unknowable`);
    continue;
  }
  const stagedPaths = [...identityByPath(wholeDiff).keys()];
  const isLabel = (file: string, line: number | null): boolean => {
    const resolved = resolveToStaged(file, stagedPaths);
    return (
      resolved !== undefined &&
      res.labels.some((l) => l.file === resolved && linesMatch(l.line, line))
    );
  };
  const seen = new Set<string>();
  for (const row of res.rows) {
    // Mirror score(): only terminal verdicts contribute — an error/inconclusive row earned no
    // hits on the recall side, so its findings must not count as noise on the precision side.
    if (row.status !== undefined && row.status !== 'pass' && row.status !== 'fail') continue;
    // Absent model = historical sonnet rows (their checkpoint keys carried no prefix).
    const model = row.model ?? 'sonnet';
    for (const issue of row.issues) {
      // An issue is an EXTRA only when NONE of its mentioned locations matches a label — the exact
      // complement of score()'s any-location hit rule, via the same shared predicate.
      const locs = extractLocations(issue.text);
      if (locs.length === 0 || locs.some((l) => isLabel(l.file, l.line))) continue;
      // Key and verify on RESOLVED locations only — the raw first regex match can be a
      // pseudo-file ("i.e."/"e.g."), colliding distinct issues onto one dedup key. A finding
      // with no location resolvable against the diff has nothing verifiable and is skipped.
      const resolved = locs
        .map((l) => ({ file: resolveToStaged(l.file, stagedPaths), line: l.line }))
        .filter((l): l is { file: string; line: number | null } => l.file !== undefined);
      if (resolved.length === 0) continue;
      const [first] = resolved;
      const line = first.line;
      const key = `${res.diff.slice(0, 12)}|${model}|${row.arm}|${issue.lens}|${first.file}|${line === null ? '' : Math.floor(line / 5)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      extras.push({
        key,
        diff: res.diff,
        model,
        arm: row.arm,
        lens: issue.lens,
        file: first.file,
        line,
        text: issue.text,
      });
    }
  }
}
// Deterministic order so cap membership is stable as new results files land.
extras.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
if (extras.length > CAP)
  console.error(
    `verify-extras: ${extras.length - CAP} extras BEYOND the ${CAP} cap are unverified this run — the registered 'every deduped extra' guardrail is incomplete until they are`,
  );
console.error(
  `verify-extras: ${extras.length} deduped extras (cap ${CAP}); ${[...verified.keys()].length} already verified`,
);

const hunkFor = (diffSha: string, file: string): string => {
  const diff = readArchivedDiff(diffSha);
  if (!diff) return '(diff unavailable)';
  // Same ambiguity-safe resolution as scoring: a mention that does not uniquely identify one
  // changed file gets no hunk rather than a same-basename sibling's hunk.
  const segs = splitDiffByFile(diff);
  const paths = segs.map((seg) => filePathOf(seg));
  const resolved = resolveToStaged(
    file,
    paths.filter((p): p is string => p !== null),
  );
  const seg = resolved === undefined ? undefined : segs[paths.indexOf(resolved)];
  return (seg ?? '(file hunk not found in diff)').slice(0, 20_000);
};

for (const e of extras.slice(0, CAP)) {
  if (verified.has(e.key)) continue;
  const prompt =
    `You are auditing ONE code-review finding for plausibility. The staged diff hunk for the file is on stdin.\n` +
    `Finding (${e.lens}): ${e.text}\n` +
    `Question: does the hunk contain a plausible, concrete correctness defect matching this finding — a real wrong-result or stuck-state bug introduced by this diff (not style, not speculation)?\n` +
    `Answer with exactly one line: VERDICT: REAL or VERDICT: NOT, then one sentence why. ` +
    `Do not repeat these instructions in your reply.`;
  const out = await execJudgeAsync({
    label: `scale-verify:${e.key.slice(0, 40)}`,
    args: ['-p', prompt, '--model', 'haiku'],
    input: hunkFor(e.diff, e.file),
    timeout: 120_000,
    cwd: process.cwd(),
  });
  // A null/empty judge result is an OUTAGE, not a verdict — do NOT checkpoint it, so the next
  // run re-drives it. Verdict = the FIRST WORD after the last decisive `VERDICT:` line; a line
  // that echoes the prompt's own option list ("REAL or ... NOT") is an instruction echo, not an
  // answer, and is ignored rather than first-alternative-matched as REAL.
  const text = String(out ?? '');
  let verdict: 'REAL' | 'NOT' | null = null;
  for (const ln of text.split('\n')) {
    const m = ln.match(/^.{0,10}VERDICT:\s*\**\s*(.*)$/i);
    if (!m) continue;
    const rest = m[1];
    if (/\bREAL\b\s*(?:\*+\s*)?or\b/i.test(rest)) continue;
    const word = rest
      .trim()
      .split(/[^A-Za-z]+/)[0]
      ?.toUpperCase();
    if (word === 'REAL' || word === 'NOT') verdict = word;
  }
  if (verdict === null) {
    console.error(
      `  ${e.key} → NO VERDICT (outage, echo, or malformed reply) — re-drives next run`,
    );
    continue;
  }
  const real = verdict === 'REAL';
  appendFileSync(
    VFILE,
    `${JSON.stringify({ key: e.key, model: e.model, arm: e.arm, diff: e.diff.slice(0, 12), real, at: new Date().toISOString() })}\n`,
  );
  verified.set(e.key, { real });
  console.error(`  ${e.key} → ${real ? 'REAL' : 'NOT'}`);
}

// Tally over EVERY verified extra (not only this run's cap slice), keyed by (model, arm).
const byArm = new Map<string, { real: number; n: number }>();
for (const e of extras) {
  const v = verified.get(e.key);
  if (!v) continue;
  const k = `${e.model} ${e.arm}`;
  const s = byArm.get(k) ?? { real: 0, n: 0 };
  s.n += 1;
  if (v.real) s.real += 1;
  byArm.set(k, s);
}
for (const [k, s] of [...byArm.entries()].sort()) {
  console.error(`VERIFIED-PRECISION ${k}: ${s.real}/${s.n}`);
}
