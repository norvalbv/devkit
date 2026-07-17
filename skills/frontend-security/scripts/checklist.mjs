#!/usr/bin/env node

/**
 * Frontend Security Review Checklist
 *
 * Checks frontend code against security best practices.
 * Only runs on frontend files (src/renderer/, src/preload/).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, win32 } from 'node:path';

const CHECKLIST_PATH = '.claude/.frontend-security-review.json';
const PATH_SEPARATOR_RE = /[\\/]/u;

// Top-level regex patterns for performance
const RE_DANGEROUS_HTML = /dangerouslySetInnerHTML/i;
const RE_INNER_HTML = /\.(innerHTML|outerHTML)\s*=/i;
const RE_DOC_WRITE = /document\.write/i;
const RE_URL = /\b(href|src|url|link)[\s]*[=:]/i;
const RE_LOCALSTORAGE = /\b(localStorage|sessionStorage)\.setItem/i;
const RE_TOKEN = /\b(token|credential|password|secret|apiKey|api_key|API_KEY)/i;
const RE_FETCH = /\b(fetch|axios|\.post|\.put|\.delete|\.patch)\s*\(/i;
const RE_INPUT = /\b(input|onChange|onSubmit|value|formData|useForm)/i;
const RE_BLANK = /target\s*=\s*["']_blank/i;
const RE_WINDOW_OPEN = /window\.open/i;
const RE_EVAL = /\b(eval\s*\(|new\s+Function\s*\(|setTimeout\s*\(\s*["']|setInterval\s*\(\s*["'])/i;
const RE_URL_PARAMS = /\b(window\.location|searchParams|URLSearchParams|queryString)/i;
const RE_SANITIZE = /\b(DOMPurify|sanitize|xss)/i;
const RE_COOKIE = /\b(document\.cookie|Cookies\.|cookie)/i;
const RE_JWT = /\b(jwt|jsonwebtoken|expiresIn|decode|verify|sign)\b/i;
const RE_OAUTH = /\b(oauth|authorize|redirect_uri|state|scope|grant_type)\b/i;
const RE_HARDCODED = /\b(users|pass|key|secret|token)\s*[:=]\s*["'][^"']{8,}["']/i;
const RE_DEBUG_LOG = /\bconsole\.(log|debug|info|warn|error)\s*\(/i;
// Cross-origin messaging (coverage from OWASP ASVS v5 V3 — see SKILL.md Provenance).
const RE_POSTMESSAGE =
  /\bpostMessage\s*\(|addEventListener\s*\(\s*['"]message['"]|\bonmessage\s*=/i;

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
      '⚠️  frontend-security: ignoring invalid `review.frontendRoots` in guard.config.json (expected an array of non-empty strings) — scanning all staged files instead.',
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

function detectSecurityPatterns(_files, diffs) {
  const items = [];
  const fullDiff = diffs.join('\n');

  if (RE_DANGEROUS_HTML.test(fullDiff)) {
    items.push({
      name: 'xss-innerhtml',
      category: 'XSS Prevention',
      status: 'pending',
      issues: [],
    });
  }
  if (RE_INNER_HTML.test(fullDiff)) {
    items.push({
      name: 'xss-innerhtml-direct',
      category: 'XSS Prevention',
      status: 'pending',
      issues: [],
    });
  }
  if (RE_DOC_WRITE.test(fullDiff)) {
    items.push({
      name: 'xss-document-write',
      category: 'XSS Prevention',
      status: 'pending',
      issues: [],
    });
  }
  if (RE_URL.test(fullDiff)) {
    items.push({
      name: 'url-validation',
      category: 'XSS Prevention',
      status: 'pending',
      issues: [],
    });
  }
  if (RE_LOCALSTORAGE.test(fullDiff)) {
    items.push({
      name: 'token-storage-localstorage',
      category: 'Secure Storage',
      status: 'pending',
      issues: [],
    });
  }
  if (RE_TOKEN.test(fullDiff)) {
    items.push({
      name: 'token-handling',
      category: 'Secure Storage',
      status: 'pending',
      issues: [],
    });
  }
  if (RE_FETCH.test(fullDiff)) {
    items.push({ name: 'csrf-protection', category: 'CSRF', status: 'pending', issues: [] });
  }
  if (RE_INPUT.test(fullDiff)) {
    items.push({
      name: 'input-validation',
      category: 'Input Validation',
      status: 'pending',
      issues: [],
    });
  }
  if (RE_BLANK.test(fullDiff)) {
    items.push({
      name: 'external-links',
      category: 'XSS Prevention',
      status: 'pending',
      issues: [],
    });
  }
  if (RE_WINDOW_OPEN.test(fullDiff)) {
    items.push({ name: 'window-open', category: 'XSS Prevention', status: 'pending', issues: [] });
  }
  if (RE_POSTMESSAGE.test(fullDiff)) {
    items.push({
      name: 'postmessage-origin',
      category: 'Cross-Origin',
      status: 'pending',
      issues: [],
    });
  }
  if (RE_EVAL.test(fullDiff)) {
    items.push({
      name: 'code-injection',
      category: 'XSS Prevention',
      status: 'pending',
      issues: [],
    });
  }
  if (RE_URL_PARAMS.test(fullDiff)) {
    items.push({
      name: 'url-sensitive-data',
      category: 'Secure Storage',
      status: 'pending',
      issues: [],
    });
  }
  if (RE_SANITIZE.test(fullDiff)) {
    items.push({
      name: 'sanitization-check',
      category: 'XSS Prevention',
      status: 'pending',
      issues: [],
    });
  }
  if (RE_COOKIE.test(fullDiff)) {
    items.push({
      name: 'cookie-security',
      category: 'Secure Storage',
      status: 'pending',
      issues: [],
    });
  }
  if (RE_JWT.test(fullDiff)) {
    items.push({
      name: 'jwt-handling',
      category: 'Authentication',
      status: 'pending',
      issues: [],
    });
  }
  if (RE_OAUTH.test(fullDiff)) {
    items.push({
      name: 'oauth-security',
      category: 'Authentication',
      status: 'pending',
      issues: [],
    });
  }
  if (RE_HARDCODED.test(fullDiff)) {
    items.push({
      name: 'hardcoded-secrets',
      category: 'Secure Storage',
      status: 'pending',
      issues: [],
    });
  }
  if (RE_DEBUG_LOG.test(fullDiff)) {
    items.push({
      name: 'debug-logging',
      category: 'Security Hygiene',
      status: 'pending',
      issues: [],
    });
  }
  if (items.length === 0) {
    items.push({ name: 'general-security', category: 'General', status: 'pending', issues: [] });
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
      '⏭️  No staged frontend files under review.frontendRoots (guard.config.json). Skipping security review.',
    );
    process.exit(0);
  }
  const diffs = stagedFiles.map((f) => getFileDiff(f));
  const items = detectSecurityPatterns(stagedFiles, diffs);
  const data = { generated: new Date().toISOString(), files: stagedFiles, items };
  saveChecklist(data);
  log(`✅ Frontend Security: ${stagedFiles.length} files, ${items.length} checks`);
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
  log(`📋 Frontend Security: ${done}/${data.items.length} | Failed: ${failed.length}`);
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
  log('✅ Frontend Security: All checks passed');
}

function cleanup() {
  if (process.env.DEVKIT_RUN_MODE === 'review') return;
  if (existsSync(CHECKLIST_PATH)) {
    unlinkSync(CHECKLIST_PATH);
    log('🗑️  Removed frontend security checklist');
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
    log('Frontend Security Review Commands:');
    log('  generate                    Create checklist');
    log('  status                      Show progress');
    log('  check-item <name> --pass    Mark passed');
    log('  check-item <name> --fail    Mark failed');
    log('  finalize                    Verify every item was resolved');
    log('  cleanup                     Remove checklist');
    process.exit(1);
}
