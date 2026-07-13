#!/usr/bin/env bun

/**
 * Stage 3 of the edge-cases corpus pipeline: turn human-reviewed proposals into the committed
 * corpus. cases.jsonl is a hand-audited SNAPSHOT (like sentry-eval's) — this stage is a compiler,
 * not a reproducible pipeline: proposals carry LLM output and human corrections, both frozen in
 * raw/proposals.jsonl.
 *
 *   bun gate-engine/edge-cases/eval/finalize.mts             # rewrite cases.jsonl from proposals
 *   bun gate-engine/edge-cases/eval/finalize.mts --append    # only add proposal ids not already in cases.jsonl
 *
 * Refusals (consistency invariants, also asserted by the committed test gate):
 *  - wasLiveBug "true" with a compliance-tier evidence (none/test-added-green/rejected)
 *  - wasLiveBug "true" or verdict "noise" not human-reviewed (evidence.reviewed !== true)
 *  - any schema violation, any scrub-pattern leak, a diffExcerpt outside the repo allowlist
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXCERPT_ALLOWLIST, validateCase } from './lib/schema.mts';
import { findLeaks, scrubDeep } from './lib/scrub.mts';

const here = path.dirname(fileURLToPath(import.meta.url));
const proposalsPath = path.join(here, 'raw', 'proposals.jsonl');
const casesPath = path.join(here, 'cases.jsonl');
const append = process.argv.includes('--append');

const MAX_EXCERPT_LINES = 300;
const MAX_EXCERPT_BYTES = 12 * 1024;

const UNIT_START_RE = /^(@@ |diff --git )/;
const DIFF_SECTION_RE = /^diff --git /m;
const FILE_B_RE = / b\/(\S+)/;
const FILE_A_RE = /^a\/(\S+)/;
const NEW_FILE_RE = /^new file mode/m;
const DELETED_FILE_RE = /^deleted file mode/m;
const PLUS_FILE_RE = /^\+\+\+ b\/(\S+)/gm;
const STAT_LINE_RE = /^ ([\w./@-]+[\w./@-]) +\| +\d/gm;

const readJsonl = (file) =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

/** Truncate a unified diff at hunk boundaries — never mid-hunk. */
const excerptDiff = (diff) => {
  const lines = diff.split('\n');
  const out = [];
  let bytes = 0;
  let truncated = false;
  let i = 0;
  while (i < lines.length) {
    // find the end of the current unit: a hunk (@@) or header block runs until the next @@ / diff --git
    let j = i + 1;
    while (j < lines.length && !UNIT_START_RE.test(lines[j])) j++;
    const unit = lines.slice(i, j);
    const unitBytes = Buffer.byteLength(unit.join('\n'), 'utf8') + 1;
    if (out.length + unit.length > MAX_EXCERPT_LINES || bytes + unitBytes > MAX_EXCERPT_BYTES) {
      truncated = true;
      break;
    }
    out.push(...unit);
    bytes += unitBytes;
    i = j;
  }
  return { excerpt: out.join('\n'), truncated };
};

/** Derive a name-status list from diff headers (A/D/M per file). */
const nameStatusOf = (diff, statText) => {
  const entries = [];
  const sections = diff?.split(DIFF_SECTION_RE).slice(1) ?? [];
  for (const s of sections) {
    const file = s.match(FILE_B_RE)?.[1] ?? s.match(FILE_A_RE)?.[1];
    if (!file) continue;
    const status = NEW_FILE_RE.test(s) ? 'A' : DELETED_FILE_RE.test(s) ? 'D' : 'M';
    entries.push(`${status}\t${file}`);
  }
  if (entries.length) return entries.join('\n');
  // header-less capture (echo-wrapped multi-command output): fall back to +++ b/ lines, then
  // diff-stat table lines
  const plusFiles = [...(diff ?? '').matchAll(PLUS_FILE_RE)].map((m) => `M\t${m[1]}`);
  if (plusFiles.length) return [...new Set(plusFiles)].join('\n');
  const statFiles = [...(diff ?? '').matchAll(STAT_LINE_RE)].map((m) => `M\t${m[1]}`);
  if (statFiles.length) return [...new Set(statFiles)].join('\n');
  return (statText ?? '').trim() || null;
};

/** The labeler occasionally echoes an enum as a one-element array (the prompt showed enums as JSON
 * arrays) or wasLiveBug as a JSON boolean — normalize scalars before validating. */
const scalar = (v) => (Array.isArray(v) ? v[0] : v);
// freeform severities ("medium-high") bin to the highest named level
const normalizeSeverity = (v) => {
  const s = String(scalar(v) ?? '').toLowerCase();
  for (const level of ['high', 'medium', 'low']) if (s.includes(level)) return level;
  return 'unstated';
};
const normalizeFinding = (f) => ({
  ...f,
  severity: normalizeSeverity(f.severity),
  category: scalar(f.category),
  verdict: scalar(f.verdict),
  wasLiveBug: String(scalar(f.wasLiveBug)),
  evidence: f.evidence && {
    ...f.evidence,
    tier: scalar(f.evidence.tier),
    confidence: scalar(f.evidence.confidence),
  },
});

const proposals = readJsonl(proposalsPath);
if (!proposals.length) {
  console.error('finalize: raw/proposals.jsonl is empty — run label.mts first');
  process.exit(2);
}
const existing = append ? readJsonl(casesPath) : [];
const existingIds = new Set(existing.map((c) => c.id));

const errors = [];
const cases = [];
for (const p of proposals) {
  if (existingIds.has(p.id)) continue;
  const allowExcerpt = EXCERPT_ALLOWLIST.includes(p.repo);
  const { excerpt, truncated } = p.diffFull
    ? excerptDiff(p.diffFull)
    : { excerpt: null, truncated: false };
  // strict: only true/"true" is degenerate — a malformed value (e.g. the string "false") must
  // fail loudly, never coerce into a degenerate row that silently drops its findings
  const rawDegenerate = scalar(p.degenerate);
  const degenerate = rawDegenerate === true || rawDegenerate === 'true';
  if (![true, false, 'true', 'false', null, undefined].includes(rawDegenerate))
    errors.push(`${p.id}: malformed degenerate flag ${JSON.stringify(rawDegenerate)}`);
  // malformed judge output (findings not an array / null entries) must surface as a row error,
  // never crash the whole finalize pass before validateCase can name the offender
  if (p.findings != null && !Array.isArray(p.findings))
    errors.push(`${p.id}: findings is not an array`);
  const rawFindings = Array.isArray(p.findings) ? p.findings : [];
  const findingObjects = rawFindings.filter((f) => f && typeof f === 'object');
  if (findingObjects.length !== rawFindings.length)
    errors.push(`${p.id}: findings contains non-object entries`);
  const c = scrubDeep({
    id: p.id,
    source: p.source,
    sourceRef: p.sourceRef,
    crossRefs: p.crossRefs ?? [],
    repo: p.repo,
    branch: p.branch,
    prNumber: p.prNumber,
    date: p.date,
    model: p.model,
    provider: p.provider,
    promptVariant: p.promptVariant,
    promptSha: p.promptSha,
    anchor: {
      // a recovered "diff" that yields no file list (e.g. a bare @@-range listing) is not a usable
      // diff anchor — demote it to session-summary rather than ship a diff row without nameStatus
      kind: p.diffFull && nameStatusOf(p.diffFull, p.statText) ? 'diff' : 'session-summary',
      nameStatus: nameStatusOf(p.diffFull, p.statText),
      diffExcerpt: allowExcerpt ? excerpt : null,
      diffOrigin: p.diffOrigin,
      diffLines: p.diffFull ? p.diffFull.split('\n').length : 0,
      truncated,
      summary: p.summary ?? '',
    },
    findings: degenerate ? [] : findingObjects.map(normalizeFinding),
    degenerate,
    degenerateReason: degenerate ? (scalar(p.degenerateReason) ?? 'empty-diff') : null,
    note: p.note ?? '',
  });

  for (const f of c.findings) {
    const needsReview = String(f.wasLiveBug) === 'true' || f.verdict === 'noise';
    if (needsReview && f.evidence?.reviewed !== true)
      errors.push(
        `${c.id}#${f.idx}: ${f.verdict}/${f.wasLiveBug} requires human review before finalize`,
      );
  }
  errors.push(...validateCase(c));
  const leaks = findLeaks(JSON.stringify(c));
  if (leaks.length) errors.push(`${c.id}: scrub leaks — ${leaks.join(', ')}`);
  cases.push(c);
}

// --append must not launder an invalid or leaked OLD row through a successful exit — the copied
// rows get the same validation as the new ones before the merged corpus is written.
for (const c of existing) {
  errors.push(...validateCase(c));
  const leaks = findLeaks(JSON.stringify(c));
  if (leaks.length) errors.push(`${c.id}: scrub leaks (existing row) — ${leaks.join(', ')}`);
}

if (errors.length) {
  for (const e of errors) console.error(`finalize: ${e}`);
  process.exit(1);
}

const all = [...existing, ...cases].sort((a, b) => a.date.localeCompare(b.date));
writeFileSync(casesPath, `${all.map((c) => JSON.stringify(c)).join('\n')}\n`);
const findings = all.reduce((n, c) => n + c.findings.length, 0);
console.log(
  `finalize: wrote ${all.length} cases (${cases.length} new, ${findings} findings, ${all.filter((c) => c.degenerate).length} degenerate, ${all.filter((c) => c.anchor.kind === 'diff').length} diff-anchored)`,
);
