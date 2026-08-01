#!/usr/bin/env node
// @ts-nocheck — BENCH-ONLY (excluded from tsc, see tsconfig.json exclude); loose types deliberate.

/**
 * propose — deterministic triage of candidates.jsonl (mine-bots' output) into a per-suite review
 * queue. No LLM calls: hard drops, a fixed crCategory→suite router, a priority sort, then a
 * network-only enrichment step that fetches each surviving comment's BASE file content so a human
 * (or a later agent) can turn it into an ANONYMIZED corpus fixture — nothing here writes to
 * cases-*.jsonl directly, and nothing here is exempt from the "never copy private-repo source
 * verbatim" rule: raw/ is gitignored precisely so this real, un-anonymized material never reaches
 * the public repo.
 *
 *   bun propose.mts --suite <correctness|api-security|frontend-security|backend-performance|frontend-performance> [--max N]
 *
 * Output: raw/queue-<suite>.jsonl (gitignored), one JSON line per surviving candidate —
 *   { queueId, suite, candidate: <full candidates.jsonl row>, baseFileContent }
 *
 * Pipeline: HARD DROPS (counted) → ROUTE (crCategory → suite, path splits security/performance
 * frontend vs backend) → SORT (outcome, severity, scope, recency) → ENRICH (gh api contents, up to
 * --max successes — a fetch failure drops that entry and the next-ranked one is tried instead) →
 * WRITE. A histogram of every drop reason prints to stderr so triage counts are auditable.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CANDIDATES_FILE = path.join(here, 'candidates.jsonl');
const RAW_DIR = path.join(here, 'raw');

const MAX_HUNK_LEN = 4000;

// ─── Suite routing ──────────────────────────────────────────────────────────────────

const CORRECTNESS_CATEGORIES = new Set([
  'Functional Correctness',
  'Data Integrity & Integration',
  'Stability & Availability',
]);

const FRONTEND_PATH_RE = /^src\/(renderer|preload)\//;

/** Returns the suite a candidate belongs to, or null for out-of-charter (Maintainability,
 * null, 'Potential issue', or any crCategory not in the router). */
function routeSuite(candidate) {
  const cat = candidate.crCategory;
  if (CORRECTNESS_CATEGORIES.has(cat)) return 'correctness';
  if (cat === 'Security & Privacy')
    return FRONTEND_PATH_RE.test(candidate.path ?? '') ? 'frontend-security' : 'api-security';
  if (cat === 'Performance & Scalability')
    return FRONTEND_PATH_RE.test(candidate.path ?? '')
      ? 'frontend-performance'
      : 'backend-performance';
  return null;
}

const SUITE_PREFIX = {
  correctness: 'corr',
  'api-security': 'api-sec',
  'frontend-security': 'fe-sec',
  'backend-performance': 'be-perf',
  'frontend-performance': 'fe-perf',
};
const VALID_SUITES = Object.keys(SUITE_PREFIX);

// ─── Hard drops ─────────────────────────────────────────────────────────────────────

/** Returns a drop reason string, or null if the candidate survives. */
function hardDropReason(c) {
  if (c.alreadyInCorpus) return 'already-in-corpus';
  if (c.outcome !== 'fixed' && c.outcome !== 'rebutted') return `bad-outcome:${c.outcome}`;
  if (!c.originalCommitId) return 'missing-original-commit';
  if (c.line === null && c.originalLine === null) return 'no-line';
  if (c.outcomeEvidence === 'outdated-only') return 'outdated-only';
  if (!c.diffHunk || c.diffHunk.length === 0) return 'empty-hunk';
  if ((c.hunkLen ?? c.diffHunk.length) > MAX_HUNK_LEN) return 'hunk-too-long';
  return null;
}

// ─── Sort ───────────────────────────────────────────────────────────────────────────

const OUTCOME_RANK = { fixed: 0, rebutted: 1 };
const SEVERITY_RANK = { Critical: 0, Major: 1, Minor: 2 };
const severityRank = (s) => SEVERITY_RANK[s] ?? 3;
const scopeRank = (s) => (s === 'confirmed' ? 0 : 1);

function compareCandidates(a, b) {
  const byOutcome = (OUTCOME_RANK[a.outcome] ?? 2) - (OUTCOME_RANK[b.outcome] ?? 2);
  if (byOutcome !== 0) return byOutcome;
  const bySeverity = severityRank(a.crSeverity) - severityRank(b.crSeverity);
  if (bySeverity !== 0) return bySeverity;
  const byScope = scopeRank(a.scopeConfirmed) - scopeRank(b.scopeConfirmed);
  if (byScope !== 0) return byScope;
  // Newest createdAt sorts last: prefer older (more time to accrue outcome evidence) comments.
  return Date.parse(a.createdAt ?? 0) - Date.parse(b.createdAt ?? 0);
}

// ─── Enrichment (gh api) ────────────────────────────────────────────────────────────

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function preflightGh() {
  try {
    execFileSync('gh', ['--version'], { encoding: 'utf8', timeout: 15000 });
  } catch {
    console.error('propose: `gh` CLI not available — cannot enrich candidates');
    process.exit(2);
  }
}

/** Fetches a file's content at a specific commit via the GitHub contents API. Throws on any
 * failure (missing file, bad ref, oversized blob, non-file content type) — caller drops the row. */
function fetchBaseFileContent(repo, filePath, ref) {
  const encodedPath = filePath
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  const b64 = gh([
    'api',
    `repos/${repo}/contents/${encodedPath}?ref=${ref}`,
    '--jq',
    '.content',
  ]).trim();
  if (!b64) throw new Error('empty .content (not a regular file, or missing at this ref)');
  return Buffer.from(b64, 'base64').toString('utf8');
}

// ─── queueId slug ───────────────────────────────────────────────────────────────────

function slugify(text, maxWords = 5) {
  return (
    String(text ?? '')
      .toLowerCase()
      .replace(/`/g, '')
      .match(/[a-z0-9]+/g)
      ?.slice(0, maxWords)
      .join('-')
      ?.slice(0, 40) || 'finding'
  );
}

/** A short kebab defect hint from the bot comment's bolded headline (CodeRabbit always leads with
 * one), falling back to the crCategory when no bold text is present. */
const BOLD_HEADLINE_RE = /\*\*([^*]{3,90})\*\*/;
function defectHint(candidate) {
  const m = BOLD_HEADLINE_RE.exec(candidate.body ?? '');
  return slugify(m ? m[1] : candidate.crCategory);
}

function makeQueueId(suite, candidate, seen) {
  const base = `${SUITE_PREFIX[suite]}-pr${candidate.pr}-${defectHint(candidate)}`;
  let id = base;
  let n = 2;
  while (seen.has(id)) {
    id = `${base}-${n}`;
    n += 1;
  }
  seen.add(id);
  return id;
}

// ─── Main ───────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const suiteIdx = argv.indexOf('--suite');
  const suite = suiteIdx !== -1 ? argv[suiteIdx + 1] : null;
  const maxIdx = argv.indexOf('--max');
  const max = maxIdx !== -1 ? Number.parseInt(argv[maxIdx + 1], 10) : 20;
  return { suite, max };
}

function printHelp() {
  console.log(
    'usage: propose.mts --suite <correctness|api-security|frontend-security|backend-performance|frontend-performance> [--max N]',
  );
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return;
  }
  const { suite, max } = parseArgs(argv);
  if (!suite || !VALID_SUITES.includes(suite)) {
    console.error(`propose: --suite must be one of ${VALID_SUITES.join(', ')}`);
    process.exit(2);
  }
  if (!Number.isFinite(max) || max <= 0) {
    console.error('propose: --max must be a positive integer');
    process.exit(2);
  }
  if (!existsSync(CANDIDATES_FILE)) {
    console.error(`propose: missing ${path.basename(CANDIDATES_FILE)} — run mine-bots.mts first`);
    process.exit(2);
  }
  preflightGh();

  const candidates = readFileSync(CANDIDATES_FILE, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

  const drops = {};
  const bump = (reason, n = 1) => {
    drops[reason] = (drops[reason] ?? 0) + n;
  };

  const routed = [];
  for (const c of candidates) {
    const dropReason = hardDropReason(c);
    if (dropReason) {
      bump(dropReason);
      continue;
    }
    const target = routeSuite(c);
    if (!target) {
      bump('out-of-charter');
      continue;
    }
    if (target !== suite) {
      bump(`routed-elsewhere:${target}`);
      continue;
    }
    routed.push(c);
  }

  routed.sort(compareCandidates);

  const seenIds = new Set();
  const enriched = [];
  let enrichFailures = 0;
  for (const c of routed) {
    if (enriched.length >= max) break;
    let baseFileContent: string;
    try {
      baseFileContent = fetchBaseFileContent(c.repo, c.path, c.originalCommitId);
    } catch (e) {
      enrichFailures += 1;
      console.error(
        `propose: enrich failed for ${c.repo}#${c.pr} ${c.path}@${c.originalCommitId.slice(0, 8)} — ${e.message?.split('\n')[0] ?? e}`,
      );
      continue;
    }
    enriched.push({
      queueId: makeQueueId(suite, c, seenIds),
      suite,
      candidate: c,
      baseFileContent,
    });
  }
  if (enrichFailures) bump('enrich-failed', enrichFailures);

  mkdirSync(RAW_DIR, { recursive: true });
  const outFile = path.join(RAW_DIR, `queue-${suite}.jsonl`);
  writeFileSync(outFile, `${enriched.map((r) => JSON.stringify(r)).join('\n')}\n`);

  console.error(
    [
      `propose: ${candidates.length} candidates → ${routed.length} routed to ${suite} (of which ${enriched.length} enriched, ${enrichFailures} enrich failures)`,
      `  drops: ${
        Object.entries(drops)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `${k}:${v}`)
          .join(', ') || '—'
      }`,
      `  → ${path.relative(here, outFile)}`,
    ].join('\n'),
  );
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await main();
