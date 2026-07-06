#!/usr/bin/env node

/**
 * mine-bots — sweep GitHub PR review comments left by external review bots (CodeRabbit,
 * Macroscope) into candidates.jsonl, the raw-material pool for reviewer-eval corpus rows.
 *
 *   node mine-bots.mts [--repo owner/name]...   (default: benord-labs/frink + norvalbv/devkit)
 *
 * Output: one JSON line per inline bot finding —
 *   { repo, pr, prTitle, author, path, line, category, body, diffHunk, url }
 *
 * `category` is a cheap keyword guess (security/performance/correctness/error-handling/docs/
 * style/other) to ease triage; corpus authorship re-labels by hand. candidates.jsonl is
 * gitignored: it is quarry, not corpus — rows only enter cases-*.jsonl after adaptation
 * (trimmed to fixture shape, anonymized, labeled with expectItems + note).
 *
 * Read-only against GitHub (gh api); never touches the repo checkout.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, 'candidates.jsonl');

const BOT_AUTHORS = new Set(['coderabbitai[bot]', 'macroscopeapp[bot]']);
const DEFAULT_REPOS = ['benord-labs/frink', 'norvalbv/devkit'];

// Advisory keyword buckets, checked in order — first hit wins. Security before performance
// before correctness: a comment naming an injection is security even if it also says "slow".
const CATEGORY_RULES = [
  ['security', /\b(inject|xss|csrf|sanitiz|credential|token|secret|auth[a-z]*|vulnerab|escap)/i],
  ['performance', /\b(n\+1|perform|slow|cache|memo|re-render|bundle|latency|pagination|O\(n)/i],
  ['error-handling', /\b(swallow|unhandled|catch|silently|error is (?:ignored|lost)|rejection)/i],
  [
    'correctness',
    /\b(race|concurren|CAS|overwrit|stale|dedup|double|rename|portab|BSD|JSON\.parse|falsy|off-by|incorrect|wrong|bug|breaks?|fails?)\b/i,
  ],
  ['docs', /\b(doc|readme|comment|typo|grammar|wording|markdown)\b/i],
  ['style', /\b(style|naming|convention|lint|format)\b/i],
];

function categorize(body) {
  for (const [cat, re] of CATEGORY_RULES) if (re.test(body)) return cat;
  return 'other';
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function listPrs(repo) {
  const raw = gh([
    'api',
    `repos/${repo}/pulls?state=all&per_page=100`,
    '--paginate',
    '--jq',
    '.[] | {number, title}',
  ]);
  return raw
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function botComments(repo, pr) {
  const raw = gh([
    'api',
    `repos/${repo}/pulls/${pr}/comments?per_page=100`,
    '--paginate',
    '--jq',
    '.[] | {user: .user.login, path, line, original_line, body, diff_hunk, html_url}',
  ]);
  return raw
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((c) => BOT_AUTHORS.has(c.user));
}

const repoArgs = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--repo' && argv[i + 1]) repoArgs.push(argv[(i += 1)]);
}
const repos = repoArgs.length > 0 ? repoArgs : DEFAULT_REPOS;

const rows = [];
for (const repo of repos) {
  const prs = listPrs(repo);
  console.error(`mine-bots: ${repo} — ${prs.length} PRs`);
  for (const { number, title } of prs) {
    let comments;
    try {
      comments = botComments(repo, number);
    } catch (e) {
      console.error(`mine-bots: ${repo}#${number} — skipped (${e.message?.split('\n')[0]})`);
      continue;
    }
    for (const c of comments) {
      rows.push({
        repo,
        pr: number,
        prTitle: title,
        author: c.user,
        path: c.path,
        line: c.line ?? c.original_line ?? null,
        category: categorize(c.body),
        // 4000 chars keeps CodeRabbit's prompt-sized comments reviewable without bloating the file.
        body: String(c.body).slice(0, 4000),
        diffHunk: String(c.diff_hunk ?? '').slice(0, 4000),
        url: c.html_url,
      });
    }
    if (comments.length > 0) console.error(`  #${number}: ${comments.length} bot comments`);
  }
}

writeFileSync(OUT, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
const byCat = {};
for (const r of rows) byCat[r.category] = (byCat[r.category] ?? 0) + 1;
console.error(
  `mine-bots: ${rows.length} findings → ${path.basename(OUT)} (${Object.entries(byCat)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}:${v}`)
    .join(', ')})`,
);
