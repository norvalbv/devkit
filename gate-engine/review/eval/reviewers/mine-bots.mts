#!/usr/bin/env node
// @ts-nocheck — BENCH-ONLY (excluded from tsc, see tsconfig.json exclude); loose types deliberate.

/**
 * mine-bots — sweep GitHub PR review comments left by external review bots (CodeRabbit,
 * Macroscope) into candidates.jsonl, the raw-material pool for reviewer-eval corpus rows.
 *
 *   node mine-bots.mts [--repo owner/name]...   (default: benord-labs/frink + norvalbv/devkit)
 *
 * Per bot comment this now also resolves: its GraphQL review thread (resolved/outdated + replies
 * after it), CodeRabbit category/severity markers, an addressed/withdrawal/line-touched signal
 * set, a resulting outcome + evidence, and — via the local usage-collector sqlite db — whether a
 * reviewer's declared file scope actually covered the commented path. Existing candidates.jsonl
 * rows are merged (new data wins by `url`) rather than clobbered, and rows already promoted into
 * a cases-*.jsonl corpus file are flagged `alreadyInCorpus` instead of dropped.
 *
 * `category` is a cheap keyword guess (security/performance/correctness/error-handling/docs/
 * style/other) to ease triage; corpus authorship re-labels by hand.
 *
 * Read-only against GitHub (gh api) and the checkout; the sqlite db is only ever SELECTed from.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  categorize,
  classifyOutcome,
  computeScopeConfirmed,
  hasAddressedMarker,
  hasHumanReply,
  hasWithdrawal,
  isLineTouchedLater,
  parseCoderabbitMarker,
  sqlString,
} from './mine-bots-lib.mts';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, 'candidates.jsonl');

const BOT_AUTHORS = new Set(['coderabbitai[bot]', 'macroscopeapp[bot]']);
const DEFAULT_REPOS = ['benord-labs/frink', 'norvalbv/devkit'];
const TRUNCATE_LEN = 4000;
const EXCERPT_LEN = 500;
const CORPUS_CASES_FILE_RE = /^cases-.*\.jsonl$/;

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function ghJsonLines(args) {
  return gh(args)
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function listPrs(repo) {
  return ghJsonLines([
    'api',
    `repos/${repo}/pulls?state=all&per_page=100`,
    '--paginate',
    '--jq',
    '.[] | {number, title, state, merged_at}',
  ]);
}

function botComments(repo, pr) {
  return ghJsonLines([
    'api',
    `repos/${repo}/pulls/${pr}/comments?per_page=100`,
    '--paginate',
    '--jq',
    '.[] | {id, in_reply_to_id, user: .user.login, path, line, original_line, start_line, side, commit_id, original_commit_id, created_at, body, diff_hunk, html_url}',
  ]).filter((c) => BOT_AUTHORS.has(c.user));
}

// ---------------------------------------------------------------------------------------------
// Thread resolution (GraphQL, paginated) — maps a comment's databaseId to {thread, comments}.
// ---------------------------------------------------------------------------------------------

const THREADS_QUERY = `
query($owner: String!, $name: String!, $pr: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved
          isOutdated
          comments(first: 100) {
            pageInfo { hasNextPage }
            nodes { databaseId author { login } createdAt body }
          }
        }
      }
    }
  }
}`;

// Hard cap on outer-page fetches — an unbounded-loop guard. reviewThreads(first: 100) means a PR
// would need 5000+ review threads to hit this legitimately; a run that does is almost certainly
// stuck on a cursor that isn't advancing (a `gh`/API quirk), so stop and say so rather than burning
// rate limit until killed.
const MAX_THREAD_PAGES = 50;

function fetchReviewThreads(repo, pr) {
  const [owner, name] = repo.split('/');
  const byDatabaseId = new Map();
  let cursor = null;
  for (let page = 0; page < MAX_THREAD_PAGES; page += 1) {
    const args = [
      'api',
      'graphql',
      '-f',
      `query=${THREADS_QUERY}`,
      '-F',
      `owner=${owner}`,
      '-F',
      `name=${name}`,
      '-F',
      `pr=${pr}`,
    ];
    if (cursor) args.push('-F', `cursor=${cursor}`);
    const data = JSON.parse(gh(args));
    const conn = data?.data?.repository?.pullRequest?.reviewThreads;
    if (!conn) break;
    for (const thread of conn.nodes ?? []) {
      const comments = (thread.comments?.nodes ?? []).filter(Boolean);
      if (thread.comments?.pageInfo?.hasNextPage) {
        console.error(
          `mine-bots: ${repo}#${pr} — a review thread has >100 comments; reply signals may be incomplete`,
        );
      }
      for (const c of comments) byDatabaseId.set(c.databaseId, { thread, comments });
    }
    if (!conn.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
    if (page === MAX_THREAD_PAGES - 1)
      console.error(`mine-bots: ${repo}#${pr} — hit the ${MAX_THREAD_PAGES}-page thread cap`);
  }
  return byDatabaseId;
}

function threadInfoFor(threadsById, commentId) {
  const entry = threadsById.get(commentId);
  if (!entry) {
    return { threadResolved: null, threadOutdated: null, repliesFull: [], repliesOut: [] };
  }
  const idx = entry.comments.findIndex((c) => c.databaseId === commentId);
  const after = idx === -1 ? [] : entry.comments.slice(idx + 1);
  const repliesFull = after.map((c) => ({
    author: c.author?.login ?? null,
    createdAt: c.createdAt,
    body: String(c.body ?? ''),
  }));
  const repliesOut = repliesFull.map((r) => ({
    author: r.author,
    createdAt: r.createdAt,
    excerpt: r.body.slice(0, EXCERPT_LEN),
  }));
  return {
    threadResolved: !!entry.thread.isResolved,
    threadOutdated: !!entry.thread.isOutdated,
    repliesFull,
    repliesOut,
  };
}

// ---------------------------------------------------------------------------------------------
// Line-touched-later — one commits list per PR, one file list per commit sha (cached).
// ---------------------------------------------------------------------------------------------

function fetchPrCommits(repo, pr) {
  return ghJsonLines([
    'api',
    `repos/${repo}/pulls/${pr}/commits?per_page=100`,
    '--paginate',
    '--jq',
    '.[] | {sha, committedDate: .commit.committer.date}',
  ]);
}

// GitHub's single-commit endpoint caps `files` at 300/page (unfollowed here) — at the cap the
// comment's path may be silently absent, so `truncated` lets callers distrust an absence.
const COMMIT_FILES_PAGE_CAP = 300;

function commitFiles(repo, sha, cache) {
  if (cache.has(sha)) return cache.get(sha);
  let files = [];
  try {
    files = JSON.parse(gh(['api', `repos/${repo}/commits/${sha}`, '--jq', '[.files[].filename]']));
  } catch (e) {
    console.error(
      `mine-bots: ${repo}@${sha.slice(0, 8)} — commit fetch failed (${e.message?.split('\n')[0]})`,
    );
  }
  const result = { files, truncated: files.length >= COMMIT_FILES_PAGE_CAP };
  cache.set(sha, result);
  return result;
}

// Commits (files hydrated) after `afterIso` only — pre-dated bot comments don't pay for file lists.
function commitsAfter(repo, prCommits, afterIso, fileCache) {
  const cutoff = Date.parse(afterIso);
  const later = prCommits.filter(
    (c) => Number.isFinite(cutoff) && Date.parse(c.committedDate) > cutoff,
  );
  return later.map((c) => {
    const { files, truncated } = commitFiles(repo, c.sha, fileCache);
    return { ...c, files, truncated };
  });
}

// ---------------------------------------------------------------------------------------------
// Scope confirmation (sqlite3 -json against the local usage-collector db).
// ---------------------------------------------------------------------------------------------

function resolveScopeDb() {
  const dbPath = process.env.USAGE_DB || path.join(os.homedir(), '.claude-usage', 'usage.db');
  if (!existsSync(dbPath)) return null;
  try {
    execFileSync('sqlite3', ['-version'], { stdio: 'ignore' });
  } catch {
    return null;
  }
  return dbPath;
}

function sqliteJson(dbPath, sql) {
  const raw = execFileSync('sqlite3', [dbPath, '-json', sql], { encoding: 'utf8' }).trim();
  return raw ? JSON.parse(raw) : [];
}

function scopeForPr(dbPath, cache, repoFull, repoShort, prNumber) {
  const key = `${repoFull}#${prNumber}`;
  if (cache.has(key)) return cache.get(key);
  let scopeRows = [];
  try {
    const ships = sqliteJson(
      dbPath,
      `SELECT ship_id FROM commit_ships WHERE repo=${sqlString(repoShort)} AND pr_number=${Number(prNumber)};`,
    );
    const shipIds = ships.map((r) => r.ship_id).filter((id) => id !== null && id !== undefined);
    if (shipIds.length > 0) {
      const idList = shipIds.map((id) => sqlString(id)).join(',');
      scopeRows = sqliteJson(
        dbPath,
        `SELECT reviewer, files_json FROM commit_review_scope WHERE ship_id IN (${idList});`,
      );
    }
  } catch (e) {
    console.error(`mine-bots: scope lookup failed for ${key} (${e.message?.split('\n')[0]})`);
  }
  cache.set(key, scopeRows);
  return scopeRows;
}

// ---------------------------------------------------------------------------------------------
// Merge / dedupe against existing candidates.jsonl and the promoted corpus.
// ---------------------------------------------------------------------------------------------

function readExistingCandidates() {
  const map = new Map();
  if (!existsSync(OUT)) return map;
  for (const line of readFileSync(OUT, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row.url) map.set(row.url, row);
    } catch {
      // skip malformed line rather than aborting the whole merge
    }
  }
  return map;
}

function collectCorpusUrls(dir) {
  const urls = new Set();
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return urls;
  }
  for (const name of entries) {
    if (!CORPUS_CASES_FILE_RE.test(name)) continue;
    let content = '';
    try {
      content = readFileSync(path.join(dir, name), 'utf8');
    } catch (e) {
      console.error(`mine-bots: corpus read failed for ${name} (${e.message?.split('\n')[0]})`);
      continue;
    }
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        const u = row?.source?.url;
        if (u) urls.add(u);
      } catch {
        // skip malformed line
      }
    }
  }
  return urls;
}

// ---------------------------------------------------------------------------------------------
// Main sweep.
// ---------------------------------------------------------------------------------------------

const repoArgs = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--repo' && argv[i + 1]) {
    i += 1;
    repoArgs.push(argv[i]);
  }
}
const repos = repoArgs.length > 0 ? repoArgs : DEFAULT_REPOS;

const scopeDb = resolveScopeDb();
if (!scopeDb) {
  console.error(
    'mine-bots: no usage.db / sqlite3 CLI found — scopeConfirmed will be "unverifiable" for all rows',
  );
}
const scopeCache = new Map();

const newRows = [];
for (const repo of repos) {
  const repoShort = path.basename(repo);
  let prs: unknown[];
  try {
    prs = listPrs(repo);
  } catch (e) {
    console.error(`mine-bots: ${repo} — PR listing failed (${e.message?.split('\n')[0]})`);
    continue;
  }
  console.error(`mine-bots: ${repo} — ${prs.length} PRs`);

  for (const { number, title, state, merged_at: mergedAt } of prs) {
    let comments: unknown[];
    try {
      comments = botComments(repo, number);
    } catch (e) {
      console.error(`mine-bots: ${repo}#${number} — skipped (${e.message?.split('\n')[0]})`);
      continue;
    }
    if (comments.length === 0) continue;

    let threadsById = new Map();
    try {
      threadsById = fetchReviewThreads(repo, number);
    } catch (e) {
      console.error(
        `mine-bots: ${repo}#${number} — thread fetch failed (${e.message?.split('\n')[0]})`,
      );
    }

    let prCommits = [];
    try {
      prCommits = fetchPrCommits(repo, number);
    } catch (e) {
      console.error(
        `mine-bots: ${repo}#${number} — commit listing failed (${e.message?.split('\n')[0]})`,
      );
    }
    const fileCache = new Map();

    for (const c of comments) {
      const { threadResolved, threadOutdated, repliesFull, repliesOut } = threadInfoFor(
        threadsById,
        c.id,
      );
      const { crCategory, crSeverity } = parseCoderabbitMarker(c.body);
      const addressedMarker = hasAddressedMarker([c.body, ...repliesFull.map((r) => r.body)]);
      const withdrawal = hasWithdrawal(repliesFull);
      const humanReplyPresent = hasHumanReply(repliesFull, BOT_AUTHORS);

      const later = commitsAfter(repo, prCommits, c.created_at, fileCache);
      const lineTouchedLater = isLineTouchedLater(later, c.path, c.created_at);
      // lineTouchedLater is real evidence only (true ⇒ some later commit's file list actually
      // contained the path). If it's false but a later commit's file list was capped at 300 by
      // the GitHub API, the absence is not trustworthy — flag it so downstream labeling can
      // distrust a 'resolved+line-touched' outcome built on a false negative.
      const lineTouchedTruncated = !lineTouchedLater && later.some((commit) => commit.truncated);

      const { outcome, outcomeEvidence } = classifyOutcome({
        addressedMarker,
        withdrawal,
        threadResolved,
        threadOutdated,
        lineTouchedLater,
        hasHumanReply: humanReplyPresent,
      });

      let scopeConfirmed = 'unverifiable';
      let scopedReviewers = [];
      if (scopeDb) {
        const scopeRows = scopeForPr(scopeDb, scopeCache, repo, repoShort, number);
        ({ scopeConfirmed, scopedReviewers } = computeScopeConfirmed(scopeRows, c.path));
      }

      const bodyStr = String(c.body ?? '');
      const hunkStr = String(c.diff_hunk ?? '');

      newRows.push({
        repo,
        pr: number,
        prTitle: title,
        prState: state,
        prMergedAt: mergedAt ?? null,
        id: c.id,
        inReplyToId: c.in_reply_to_id ?? null,
        createdAt: c.created_at,
        commitId: c.commit_id ?? null,
        originalCommitId: c.original_commit_id ?? null,
        side: c.side ?? null,
        startLine: c.start_line ?? null,
        originalLine: c.original_line ?? null,
        author: c.user,
        path: c.path,
        line: c.line ?? c.original_line ?? null,
        category: categorize(bodyStr),
        crCategory,
        crSeverity,
        addressedMarker,
        withdrawal,
        threadResolved,
        threadOutdated,
        replies: repliesOut,
        lineTouchedLater,
        lineTouchedTruncated,
        outcome,
        outcomeEvidence,
        scopeConfirmed,
        scopedReviewers,
        bodyLen: bodyStr.length,
        hunkLen: hunkStr.length,
        // 4000 chars keeps CodeRabbit's prompt-sized comments reviewable without bloating the file.
        body: bodyStr.slice(0, TRUNCATE_LEN),
        diffHunk: hunkStr.slice(0, TRUNCATE_LEN),
        url: c.html_url,
      });
    }
    console.error(`  #${number}: ${comments.length} bot comments`);
  }
}

// Merge: new data wins by url, but rows we didn't re-sweep this run (other repos/PRs not passed
// via --repo, or a PR gh failed to fetch this time) are preserved rather than dropped.
const merged = readExistingCandidates();
for (const row of newRows) {
  if (!row.url) {
    console.error(`mine-bots: dropping comment ${row.id} — no html_url to key on`);
    continue;
  }
  merged.set(row.url, row);
}

const corpusUrls = collectCorpusUrls(here);
const rows = [...merged.values()].map((row) => ({
  ...row,
  alreadyInCorpus: corpusUrls.has(row.url),
}));

// Atomic write: candidates.jsonl is also the merge source read above, so a crash/full-disk mid-write
// must never leave a truncated file that silently loses the accumulated candidate pool.
const tmpOut = `${OUT}.tmp`;
writeFileSync(tmpOut, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
renameSync(tmpOut, OUT);

function histogram(items, keyFn) {
  const counts = {};
  for (const item of items) {
    const k = keyFn(item) ?? 'null';
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}:${v}`)
    .join(', ');
}

const alreadyInCorpusCount = rows.filter((r) => r.alreadyInCorpus).length;
console.error(
  [
    `mine-bots: ${rows.length} candidates → ${path.basename(OUT)} (${newRows.length} new/updated this run)`,
    `  by outcome: ${histogram(rows, (r) => r.outcome)}`,
    `  by crCategory: ${histogram(rows, (r) => r.crCategory)}`,
    `  by scopeConfirmed: ${histogram(rows, (r) => r.scopeConfirmed)}`,
    `  alreadyInCorpus: ${alreadyInCorpusCount}/${rows.length}`,
  ].join('\n'),
);
