#!/usr/bin/env node

/**
 * API Security Review Checklist
 *
 * Checks backend/API code against security best practices.
 * Only runs on backend files (src/main/, vercel-serverless/, socket-server/).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveReviewRoots, toGitPathspecs } from '../../_devkit/review-roots.mjs';

const CHECKLIST_PATH = '.claude/.api-security-review.json';

// Top-level regex patterns for performance
const RE_AUTH = /\b(auth|login|signin|signup|password|credential|encryption|encrypt|decrypt|hash)/i;
const RE_JWT = /\b(jwt|jsonwebtoken|token|sign|verify|bearer|expiresIn|algorithm)/i;
const RE_OAUTH =
  /\b(oauth|redirect_uri|authorization|scope|state|client_id|client_secret|response_type)/i;
const RE_INPUT = /\b(body|params|query|input|req\.|request\.|zod|schema|validate)/i;
const RE_SQL = /\b(query|select|insert|update|delete|where|findMany|findUnique|execute|raw|sql)/i;
const RE_XXE = /\b(xml|yaml|parseXML|DOMParser|yaml\.load)/i;
const RE_ENDPOINT = /\b(router|handler|endpoint|route|get|post|put|patch|delete)\s*[.(]/i;
const RE_RATE_LIMIT = /\b(rate|limit|throttle|rateLimit)/i;
const RE_RESPONSE = /\b(res\.|response\.|json\(|send\(|return.*Response)/i;
const RE_HEADERS = /\b(header|X-Content-Type|X-Frame|Content-Security-Policy|HSTS|X-Powered-By)/i;
const RE_ERROR = /\b(catch|error|throw|exception|stack)/i;
const RE_PROCESSING = /\b(debug|DEBUG|NODE_ENV|upload|multer|stream|file)/i;
const RE_LOGGING = /\b(log|logger|console\.|info|warn|error|audit|monitor)/i;
// Injection/authz surfaces beyond SQL (coverage from OWASP ASVS v5 V1/V2/V4/V8 — see SKILL.md
// Provenance). Two-regex items AND a sink pattern with a request-input marker so the item only
// fires when both halves are present in the staged diff.
const RE_MASS_ASSIGN =
  /\.\.\.\s*(req\.(body|query|params)|body|payload)\b|Object\.assign\([^)]*\breq\./;
const RE_COMMAND = /\b(exec|execSync|spawn|spawnSync|execFile|execFileSync)\s*\(|child_process/;
const RE_FS_SINK =
  /\b(sendFile|createReadStream|createWriteStream|readFile|writeFile|appendFile|unlink|rmSync|rm|mkdir|readdir|stat)\w*\s*\(/;
const RE_REQ_INPUT = /\breq\.(params|query|body)\b|\bparams\.\w+/;
const RE_OBJECT_LOOKUP =
  /\b(findUnique|findFirst|findById|getById|updateMany|deleteMany|update|delete)\s*\(/;
const RE_REDIRECT = /\bredirect\s*\(/i;
const RE_OUTBOUND_DYNAMIC = /\b(fetch|axios[.\w]*|got)\s*\(\s*(`[^`\n]*\$\{|[^'"`\s)])/;

// Prose files under a root ride along with source commits; their text trips the item
// regexes (a README mentioning "password") and hands the judge prose to hallucinate on.
const RE_PROSE_FILE = /\.(md|mdx|markdown|txt)$/i;

const log = console.log;

// Backend roots to review — from guard.config.json `review.backendRoots` (NOT hardcoded), so the
// checklist scopes to ANY repo's layout. No/unreadable config, a non-object config, or an absent
// review.backendRoots → all staged files (the gate never silently no-ops). A PRESENT but invalid
// value (not an array of non-empty strings) warns loudly and falls back to scan-all, rather than
// letting a bad entry crash the git call into an empty result that would wave the commit through.
function backendRoots() {
  return resolveReviewRoots({
    envName: 'DEVKIT_REVIEW_BACKEND_ROOTS',
    configKey: 'backendRoots',
    reviewerName: 'api-security',
  });
}

function getStagedFiles() {
  const pathspecs = toGitPathspecs(backendRoots());
  try {
    const output = execFileSync(
      'git',
      ['diff', '--cached', '--name-only', '--diff-filter=ACM', '--', ...pathspecs],
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

function detectSecurityPatterns(_files, diffs) {
  const items = [];
  const fullDiff = diffs.join('\n');

  if (RE_AUTH.test(fullDiff)) {
    items.push({
      name: 'auth-mechanism',
      category: 'Authentication',
      status: 'pending',
      issues: [],
    });
  }
  if (RE_JWT.test(fullDiff)) {
    items.push({ name: 'jwt-security', category: 'JWT', status: 'pending', issues: [] });
  }
  if (RE_OAUTH.test(fullDiff)) {
    items.push({ name: 'oauth-security', category: 'OAuth', status: 'pending', issues: [] });
  }
  if (RE_INPUT.test(fullDiff)) {
    items.push({ name: 'input-validation', category: 'Input', status: 'pending', issues: [] });
  }
  if (RE_SQL.test(fullDiff)) {
    items.push({ name: 'sql-injection', category: 'Input', status: 'pending', issues: [] });
  }
  if (RE_XXE.test(fullDiff)) {
    items.push({ name: 'xxe-prevention', category: 'Input', status: 'pending', issues: [] });
  }
  if (RE_MASS_ASSIGN.test(fullDiff)) {
    items.push({ name: 'mass-assignment', category: 'Input', status: 'pending', issues: [] });
  }
  if (RE_COMMAND.test(fullDiff)) {
    items.push({ name: 'command-injection', category: 'Input', status: 'pending', issues: [] });
  }
  if (RE_FS_SINK.test(fullDiff) && RE_REQ_INPUT.test(fullDiff)) {
    items.push({ name: 'path-traversal', category: 'Input', status: 'pending', issues: [] });
  }
  if (RE_OUTBOUND_DYNAMIC.test(fullDiff)) {
    items.push({ name: 'ssrf-prevention', category: 'Input', status: 'pending', issues: [] });
  }
  if (RE_ENDPOINT.test(fullDiff)) {
    items.push({
      name: 'endpoint-auth',
      category: 'Access Control',
      status: 'pending',
      issues: [],
    });
  }
  if (RE_RATE_LIMIT.test(fullDiff)) {
    items.push({
      name: 'rate-limiting',
      category: 'Access Control',
      status: 'pending',
      issues: [],
    });
  }
  if (RE_OBJECT_LOOKUP.test(fullDiff) && RE_REQ_INPUT.test(fullDiff)) {
    items.push({
      name: 'object-level-authz',
      category: 'Access Control',
      status: 'pending',
      issues: [],
    });
  }
  if (RE_REDIRECT.test(fullDiff)) {
    items.push({ name: 'open-redirect', category: 'Output', status: 'pending', issues: [] });
  }
  if (RE_RESPONSE.test(fullDiff)) {
    items.push({ name: 'output-security', category: 'Output', status: 'pending', issues: [] });
  }
  if (RE_HEADERS.test(fullDiff)) {
    items.push({ name: 'security-headers', category: 'Output', status: 'pending', issues: [] });
  }
  if (RE_ERROR.test(fullDiff)) {
    items.push({ name: 'error-handling', category: 'Output', status: 'pending', issues: [] });
  }
  if (RE_PROCESSING.test(fullDiff)) {
    items.push({
      name: 'processing-security',
      category: 'Processing',
      status: 'pending',
      issues: [],
    });
  }
  if (RE_LOGGING.test(fullDiff)) {
    items.push({ name: 'logging-security', category: 'Monitoring', status: 'pending', issues: [] });
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
      '⏭️  No staged backend files under review.backendRoots (guard.config.json). Skipping API security review.',
    );
    process.exit(0);
  }
  const diffs = stagedFiles.map((f) => getFileDiff(f));
  const items = detectSecurityPatterns(stagedFiles, diffs);
  const data = { generated: new Date().toISOString(), files: stagedFiles, items };
  saveChecklist(data);
  log(`✅ API Security: ${stagedFiles.length} files, ${items.length} checks`);
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
  log(`📋 API Security: ${done}/${data.items.length} | Failed: ${failed.length}`);
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
  log('✅ API Security: All checks passed');
}

function cleanup() {
  if (process.env.DEVKIT_RUN_MODE === 'review') return;
  if (existsSync(CHECKLIST_PATH)) {
    unlinkSync(CHECKLIST_PATH);
    log('🗑️  Removed API security checklist');
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
    log('API Security Review Commands:');
    log('  generate                    Create checklist');
    log('  status                      Show progress');
    log('  check-item <name> --pass    Mark passed');
    log('  check-item <name> --fail    Mark failed');
    log('  finalize                    Verify every item was resolved');
    log('  cleanup                     Remove checklist');
    process.exit(1);
}
