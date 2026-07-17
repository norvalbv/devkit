#!/usr/bin/env node

/**
 * Frontend Performance Review Checklist
 *
 * Checks frontend code against performance best practices.
 * Only runs on frontend files (src/renderer/, src/preload/).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, win32 } from 'node:path';

const CHECKLIST_PATH = '.claude/.frontend-performance-review.json';
const PATH_SEPARATOR_RE = /[\\/]/u;

// Top-level regex patterns for performance
const RE_IMAGE_DIFF = /\b(img|image|src=|srcset|loading|width=|height=)/i;
const RE_IMAGE_FILE = /\.(png|jpg|jpeg|gif|webp|svg|avif)/;
const RE_CSS = /\b(import.*\.css|className|style=|tailwind|styled)/i;
const RE_INLINE_STYLE = /style\s*=\s*\{/i;
const RE_IMPORT = /\bimport\s+/i;
const RE_SCRIPT = /<script/i;
const RE_IFRAME = /<iframe/i;
const RE_COMPONENT = /\b(function\s+\w+|const\s+\w+\s*=.*=>).*return.*</i;
const RE_HOOKS = /\b(useEffect|useMemo|useCallback|useState|React\.memo|memo\()/i;
const RE_LAZY = /\b(lazy|Suspense|dynamic|React\.lazy)/i;
const RE_MAP = /\.map\s*\(/i;
const RE_FETCH = /\b(fetch|axios|useQuery|useMutation|trpc)/i;
const RE_SW = /\b(serviceWorker|navigator\.serviceWorker|workbox)/i;
const RE_COOKIE = /\b(cookie|document\.cookie|Cookies)/i;
const RE_RESOURCE_HINTS = /\b(preconnect|prefetch|preload|dns-prefetch)/i;
const RE_FONT = /\b(font|@font-face|woff|woff2|font-display)/i;
const RE_DEPS = /\b(from\s+['"][^'"]+['"])/i;
// Runtime rendering-cost items (coverage refresh — see SKILL.md Provenance): synchronous layout
// reads that force reflow, and animation of layout-affecting properties.
const RE_LAYOUT_READ =
  /\b(getBoundingClientRect|offsetWidth|offsetHeight|offsetTop|offsetLeft|clientWidth|clientHeight|scrollWidth|scrollHeight|getComputedStyle)\b/;
const RE_ANIMATION =
  /\b(transition|animation|animate|keyframes)\b[^;\n]{0,80}\b(top|left|right|bottom|width|height|margin|padding)\b|\b(top|left|width|height)\b[^;\n]{0,40}\b(transition|animation)\b/i;

// Prose files under a root ride along with source commits; their text trips the item
// regexes (a README mentioning "password") and hands the judge prose to hallucinate on.
const RE_PROSE_FILE = /\.(md|mdx|markdown|txt)$/i;

const log = console.log;

const isStringArray = (v) =>
  Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length > 0);

function injectedReviewRoots() {
  const raw = process.env.DEVKIT_REVIEW_FRONTEND_ROOTS;
  if (raw === undefined) return null;
  let roots;
  try {
    roots = JSON.parse(raw);
  } catch {
    throw new Error('DEVKIT_REVIEW_FRONTEND_ROOTS must be a JSON string array');
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
      'DEVKIT_REVIEW_FRONTEND_ROOTS must be a non-empty JSON array of repository-relative paths',
    );
  return normalized;
}

// Frontend roots to review — from guard.config.json `review.frontendRoots` (NOT hardcoded), so the
// checklist scopes to ANY repo's layout. No/unreadable config, a non-object config, or an absent
// review.frontendRoots → all staged files (the gate never silently no-ops). A PRESENT but invalid
// value (not an array of non-empty strings) warns loudly and falls back to scan-all, rather than
// letting a bad entry crash the git call into an empty result that would wave the commit through.
function frontendRoots() {
  const injected = injectedReviewRoots();
  if (injected) return injected;
  let c;
  try {
    c = JSON.parse(readFileSync('guard.config.json', 'utf-8'));
  } catch {
    return ['.'];
  }
  const review = c && typeof c === 'object' ? c.review : undefined;
  const roots = review && typeof review === 'object' ? review.frontendRoots : undefined;
  if (roots === undefined) return ['.'];
  if (!isStringArray(roots)) {
    console.error(
      '⚠️  frontend-performance: ignoring invalid `review.frontendRoots` in guard.config.json (expected an array of non-empty strings) — scanning all staged files instead.',
    );
    return ['.'];
  }
  return roots;
}

function getStagedFiles() {
  const roots = frontendRoots();
  try {
    const output = execFileSync(
      'git',
      ['diff', '--cached', '--name-only', '--diff-filter=ACM', '--', ...roots],
      { encoding: 'utf-8' },
    );
    return output
      .trim()
      .split('\n')
      .filter((f) => f.length > 0 && !f.endsWith('.pen'))
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

function detectPerformancePatterns(files, diffs) {
  const items = [];
  const fullDiff = diffs.join('\n');

  if (RE_IMAGE_DIFF.test(fullDiff) || files.some((f) => RE_IMAGE_FILE.test(f))) {
    items.push({
      name: 'image-optimization',
      category: 'High Priority',
      status: 'pending',
      issues: [],
    });
  }
  if (RE_CSS.test(fullDiff)) {
    items.push({
      name: 'css-optimization',
      category: 'High Priority',
      status: 'pending',
      issues: [],
    });
  }
  if (RE_INLINE_STYLE.test(fullDiff)) {
    items.push({ name: 'inline-styles', category: 'High Priority', status: 'pending', issues: [] });
  }
  if (RE_IMPORT.test(fullDiff)) {
    items.push({ name: 'bundle-size', category: 'High Priority', status: 'pending', issues: [] });
  }
  if (RE_SCRIPT.test(fullDiff)) {
    items.push({
      name: 'script-loading',
      category: 'High Priority',
      status: 'pending',
      issues: [],
    });
  }
  if (RE_IFRAME.test(fullDiff)) {
    items.push({ name: 'iframe-usage', category: 'High Priority', status: 'pending', issues: [] });
  }
  if (RE_LAYOUT_READ.test(fullDiff)) {
    items.push({ name: 'layout-thrash', category: 'High Priority', status: 'pending', issues: [] });
  }
  if (RE_ANIMATION.test(fullDiff)) {
    items.push({
      name: 'animation-performance',
      category: 'Medium Priority',
      status: 'pending',
      issues: [],
    });
  }
  if (RE_COMPONENT.test(fullDiff)) {
    items.push({
      name: 'react-rendering',
      category: 'Medium Priority',
      status: 'pending',
      issues: [],
    });
  }
  if (RE_HOOKS.test(fullDiff)) {
    items.push({
      name: 'hooks-optimization',
      category: 'Medium Priority',
      status: 'pending',
      issues: [],
    });
  }
  if (RE_LAZY.test(fullDiff)) {
    items.push({
      name: 'code-splitting',
      category: 'Medium Priority',
      status: 'pending',
      issues: [],
    });
  }
  if (RE_MAP.test(fullDiff)) {
    items.push({
      name: 'list-rendering',
      category: 'Medium Priority',
      status: 'pending',
      issues: [],
    });
  }
  if (RE_FETCH.test(fullDiff)) {
    items.push({
      name: 'data-fetching',
      category: 'Medium Priority',
      status: 'pending',
      issues: [],
    });
  }
  if (RE_SW.test(fullDiff)) {
    items.push({
      name: 'service-worker',
      category: 'Medium Priority',
      status: 'pending',
      issues: [],
    });
  }
  if (RE_COOKIE.test(fullDiff)) {
    items.push({
      name: 'cookie-optimization',
      category: 'Medium Priority',
      status: 'pending',
      issues: [],
    });
  }
  if (RE_RESOURCE_HINTS.test(fullDiff)) {
    items.push({ name: 'resource-hints', category: 'Low Priority', status: 'pending', issues: [] });
  }
  if (RE_FONT.test(fullDiff)) {
    items.push({
      name: 'font-optimization',
      category: 'Low Priority',
      status: 'pending',
      issues: [],
    });
  }
  if (RE_DEPS.test(fullDiff)) {
    items.push({
      name: 'dependency-size',
      category: 'Low Priority',
      status: 'pending',
      issues: [],
    });
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
      '⏭️  No staged frontend files under review.frontendRoots (guard.config.json). Skipping performance review.',
    );
    process.exit(0);
  }
  const diffs = stagedFiles.map((f) => getFileDiff(f));
  const items = detectPerformancePatterns(stagedFiles, diffs);
  const data = { generated: new Date().toISOString(), files: stagedFiles, items };
  saveChecklist(data);
  log(`✅ Frontend Performance: ${stagedFiles.length} files, ${items.length} checks`);
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
  log(`📋 Frontend Performance: ${done}/${data.items.length} | Failed: ${failed.length}`);
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
  log('✅ Frontend Performance: All checks passed');
}

function cleanup() {
  if (process.env.DEVKIT_RUN_MODE === 'review') return;
  if (existsSync(CHECKLIST_PATH)) {
    unlinkSync(CHECKLIST_PATH);
    log('🗑️  Removed frontend performance checklist');
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
    log('Frontend Performance Review Commands:');
    log('  generate                    Create checklist');
    log('  status                      Show progress');
    log('  check-item <name> --pass    Mark passed');
    log('  check-item <name> --fail    Mark failed');
    log('  finalize                    Verify every item was resolved');
    log('  cleanup                     Remove checklist');
    process.exit(1);
}
