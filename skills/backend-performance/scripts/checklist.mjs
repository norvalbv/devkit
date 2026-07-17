#!/usr/bin/env node

/**
 * Backend Performance Review Checklist
 *
 * Checks backend code against performance best practices.
 * Only runs on backend files (src/main/, vercel-serverless/, socket-server/).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, win32 } from 'node:path';

const CHECKLIST_PATH = '.claude/.backend-performance-review.json';
const PATH_SEPARATOR_RE = /[\\/]/u;

// Top-level regex patterns for performance
const RE_DB_QUERY = /\b(query|select|findMany|findUnique|findFirst|execute|raw|sql)/i;
const RE_SELECT_STAR = /select\s*\*/i;
const RE_N_PLUS_ONE_FOR = /for\s*\(.*\)[\s\S]*?(find|query|select)/i;
const RE_N_PLUS_ONE_MAP = /\.map\s*\([\s\S]*?(find|query|await)/i;
const RE_PAGINATION = /\b(skip|take|limit|offset|page|cursor|pagination)/i;
const RE_INDEXING = /\b(index|createIndex|ensureIndex|orderBy)/i;
const RE_CACHING = /\b(cache|redis|memcache|lru|ttl|expire|invalidate)/i;
const RE_POOL = /\b(pool|connection|Pool|max|idle|timeout)/i;
const RE_ASYNC = /\b(async|await|Promise|queue|worker|job|bull|agenda)/i;
const RE_STREAM = /\b(stream|pipe|chunk|buffer|createReadStream|createWriteStream)/i;
const RE_BATCH = /\b(batch|bulk|Promise\.all|in:\s*\[)/i;
const RE_TIMEOUT = /\b(timeout|retry|backoff|AbortController)/i;
const RE_RESPONSE = /\b(json\(|send\(|Response|gzip|brotli|compress)/i;
const RE_NETWORK = /\b(cdn|cloudfront|cloudflare|edge|prefetch|preload)/i;
const RE_LOGGING = /\b(log|logger|console\.|info|warn|error|debug|pino|winston)/i;
// Event-loop + memory-lifetime items (coverage refresh — see SKILL.md Provenance). existsSync is
// excluded from the sync-IO trigger: it is cheap and ubiquitous in startup/config code.
const RE_SYNC_IO =
  /\b(readFileSync|writeFileSync|appendFileSync|execSync|spawnSync|readdirSync|statSync|execFileSync)\b/;
const RE_UNBOUNDED =
  /\b\w*(cache|memo|registry|store|buffer|queue)\w*\s*[:=]\s*(new\s+(Map|Set)\b|\{\}|\[\])/i;

// Prose files under a root ride along with source commits; their text trips the item
// regexes (a README mentioning "password") and hands the judge prose to hallucinate on.
const RE_PROSE_FILE = /\.(md|mdx|markdown|txt)$/i;

const log = console.log;

const isStringArray = (v) =>
  Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length > 0);

function injectedReviewRoots() {
  const raw = process.env.DEVKIT_REVIEW_BACKEND_ROOTS;
  if (raw === undefined) return null;
  let roots;
  try {
    roots = JSON.parse(raw);
  } catch {
    throw new Error('DEVKIT_REVIEW_BACKEND_ROOTS must be a JSON string array');
  }
  const normalized = Array.isArray(roots)
    ? roots.map((root) => (typeof root === 'string' ? root.trim() : root))
    : roots;
  if (
    !isStringArray(normalized) ||
    normalized.length === 0 ||
    normalized.some(
      (root) =>
        isAbsolute(root) || win32.isAbsolute(root) || root.split(PATH_SEPARATOR_RE).includes('..'),
    )
  )
    throw new Error(
      'DEVKIT_REVIEW_BACKEND_ROOTS must be a non-empty JSON array of repository-relative paths',
    );
  return normalized;
}

// Backend roots to review — from guard.config.json `review.backendRoots` (NOT hardcoded), so the
// checklist scopes to ANY repo's layout. No/unreadable config, a non-object config, or an absent
// review.backendRoots → all staged files (the gate never silently no-ops). A PRESENT but invalid
// value (not an array of non-empty strings) warns loudly and falls back to scan-all, rather than
// letting a bad entry crash the git call into an empty result that would wave the commit through.
function backendRoots() {
  const injected = injectedReviewRoots();
  if (injected) return injected;
  let c;
  try {
    c = JSON.parse(readFileSync('guard.config.json', 'utf-8'));
  } catch {
    return ['.'];
  }
  const review = c && typeof c === 'object' ? c.review : undefined;
  const roots = review && typeof review === 'object' ? review.backendRoots : undefined;
  if (roots === undefined) return ['.'];
  if (!isStringArray(roots)) {
    console.error(
      '⚠️  backend-performance: ignoring invalid `review.backendRoots` in guard.config.json (expected an array of non-empty strings) — scanning all staged files instead.',
    );
    return ['.'];
  }
  return roots;
}

function getStagedFiles() {
  const roots = backendRoots();
  try {
    const output = execFileSync(
      'git',
      ['diff', '--cached', '--name-only', '--diff-filter=ACM', '--', ...roots],
      { encoding: 'utf-8' },
    );
    return output
      .trim()
      .split('\n')
      .filter((f) => f.length > 0)
      .filter((f) => !RE_PROSE_FILE.test(f));
  } catch {
    return [];
  }
}

function getFileDiff(file) {
  try {
    return execFileSync('git', ['diff', '--cached', '--', file], { encoding: 'utf-8' });
  } catch {
    return '';
  }
}

function detectPerformancePatterns(_files, diffs) {
  const items = [];
  const fullDiff = diffs.join('\n');

  if (RE_DB_QUERY.test(fullDiff)) {
    items.push({
      name: 'db-query-optimization',
      category: 'Database',
      status: 'pending',
      issues: [],
    });
  }
  if (RE_SELECT_STAR.test(fullDiff)) {
    items.push({ name: 'select-star', category: 'Database', status: 'pending', issues: [] });
  }
  if (RE_N_PLUS_ONE_FOR.test(fullDiff) || RE_N_PLUS_ONE_MAP.test(fullDiff)) {
    items.push({ name: 'n-plus-one', category: 'Database', status: 'pending', issues: [] });
  }
  if (RE_PAGINATION.test(fullDiff)) {
    items.push({ name: 'pagination', category: 'Database', status: 'pending', issues: [] });
  }
  if (RE_INDEXING.test(fullDiff)) {
    items.push({ name: 'indexing', category: 'Database', status: 'pending', issues: [] });
  }
  if (RE_CACHING.test(fullDiff)) {
    items.push({ name: 'caching-strategy', category: 'Caching', status: 'pending', issues: [] });
  }
  if (RE_UNBOUNDED.test(fullDiff)) {
    items.push({ name: 'unbounded-cache', category: 'Caching', status: 'pending', issues: [] });
  }
  if (RE_POOL.test(fullDiff)) {
    items.push({ name: 'connection-pooling', category: 'Database', status: 'pending', issues: [] });
  }
  if (RE_ASYNC.test(fullDiff)) {
    items.push({ name: 'async-handling', category: 'Asynchronism', status: 'pending', issues: [] });
  }
  if (RE_STREAM.test(fullDiff)) {
    items.push({ name: 'streaming', category: 'Code Optimization', status: 'pending', issues: [] });
  }
  if (RE_BATCH.test(fullDiff)) {
    items.push({ name: 'batching', category: 'Code Optimization', status: 'pending', issues: [] });
  }
  if (RE_SYNC_IO.test(fullDiff)) {
    items.push({ name: 'sync-io', category: 'Code Optimization', status: 'pending', issues: [] });
  }
  if (RE_TIMEOUT.test(fullDiff)) {
    items.push({
      name: 'timeout-retry',
      category: 'Code Optimization',
      status: 'pending',
      issues: [],
    });
  }
  if (RE_RESPONSE.test(fullDiff)) {
    items.push({
      name: 'response-optimization',
      category: 'API Response',
      status: 'pending',
      issues: [],
    });
  }
  if (RE_NETWORK.test(fullDiff)) {
    items.push({
      name: 'network-optimization',
      category: 'Network',
      status: 'pending',
      issues: [],
    });
  }
  if (RE_LOGGING.test(fullDiff)) {
    items.push({ name: 'logging-overhead', category: 'Monitoring', status: 'pending', issues: [] });
  }
  if (items.length === 0) {
    items.push({ name: 'general-performance', category: 'General', status: 'pending', issues: [] });
  }
  return items;
}

function loadChecklist() {
  if (!existsSync(CHECKLIST_PATH)) return null;
  return JSON.parse(readFileSync(CHECKLIST_PATH, 'utf-8'));
}

function saveChecklist(data) {
  mkdirSync(dirname(CHECKLIST_PATH), { recursive: true });
  writeFileSync(CHECKLIST_PATH, JSON.stringify(data, null, 2));
}

function generate() {
  const stagedFiles = getStagedFiles();
  if (stagedFiles.length === 0) {
    log(
      '⏭️  No staged backend files under review.backendRoots (guard.config.json). Skipping performance review.',
    );
    process.exit(0);
  }
  const diffs = stagedFiles.map((f) => getFileDiff(f));
  const items = detectPerformancePatterns(stagedFiles, diffs);
  const data = { generated: new Date().toISOString(), files: stagedFiles, items };
  saveChecklist(data);
  log(`✅ Backend Performance: ${stagedFiles.length} files, ${items.length} checks`);
  log('');
  log('Items to review:');
  for (const item of items) log(`  - [${item.category}] ${item.name}`);
}

function status() {
  const data = loadChecklist();
  if (!data) {
    log('❌ No checklist. Run: generate');
    process.exit(1);
  }
  const done = data.items.filter((i) => i.status !== 'pending').length;
  const failed = data.items.filter((i) => i.status === 'fail');
  log(`📋 Backend Performance: ${done}/${data.items.length} | Failed: ${failed.length}`);
  if (failed.length > 0) {
    log('Issues:');
    for (const item of failed) for (const issue of item.issues) log(`  - [${item.name}] ${issue}`);
  }
}

function checkItem(name, pass, failReason) {
  const data = loadChecklist();
  if (!data) {
    log('❌ No checklist');
    process.exit(1);
  }
  const item = data.items.find((i) => i.name === name);
  if (!item) {
    log(`❌ Item not found: ${name}`);
    log('Available:', data.items.map((i) => i.name).join(', '));
    process.exit(1);
  }
  item.status = pass ? 'pass' : 'fail';
  if (pass) item.issues = []; // a recovery pass clears the stale failure trail
  if (!pass && failReason) item.issues.push(failReason);
  saveChecklist(data);
  log(`✓ ${name}: ${item.status}${failReason ? ` (${failReason})` : ''}`);
}

function finalize() {
  const data = loadChecklist();
  if (!data) {
    log('❌ No checklist');
    process.exit(1);
  }
  const pending = data.items.filter((i) => i.status === 'pending');
  const failed = data.items.filter((i) => i.status === 'fail');
  const allIssues = data.items.flatMap((i) => i.issues);
  if (pending.length > 0) {
    log(`❌ Incomplete: ${pending.length} items pending`);
    log('Pending:', pending.map((i) => i.name).join(', '));
    process.exit(1);
  }
  if (failed.length > 0 || allIssues.length > 0) {
    log(`❌ Failed: ${allIssues.length} issues`);
    for (const issue of allIssues) log(`  - ${issue}`);
    process.exit(1);
  }
  log('✅ Backend Performance: All checks passed');
}

function cleanup() {
  if (process.env.DEVKIT_RUN_MODE === 'review') return;
  if (existsSync(CHECKLIST_PATH)) {
    unlinkSync(CHECKLIST_PATH);
    log('🗑️  Removed backend performance checklist');
  }
}

const args = process.argv.slice(2);
const cmd = args[0];
switch (cmd) {
  case 'generate':
    generate();
    break;
  case 'status':
    status();
    break;
  case 'check-item': {
    const name = args[1];
    const pass = args.includes('--pass');
    const failIdx = args.indexOf('--fail');
    const failReason = failIdx !== -1 ? args[failIdx + 1] : null;
    if (!name || (!pass && failIdx === -1)) {
      log('Usage: check-item <name> --pass OR --fail "reason"');
      process.exit(1);
    }
    checkItem(name, pass, failReason);
    break;
  }
  case 'finalize':
    finalize();
    break;
  case 'cleanup':
    cleanup();
    break;
  default:
    log('Backend Performance Review Commands:');
    log('  generate                    Create checklist');
    log('  status                      Show progress');
    log('  check-item <name> --pass    Mark passed');
    log('  check-item <name> --fail    Mark failed');
    log('  finalize                    Verify every item was resolved');
    log('  cleanup                     Remove checklist');
    process.exit(1);
}
