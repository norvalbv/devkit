#!/usr/bin/env node

/**
 * Frontend Performance Review Checklist
 *
 * Checks frontend code against performance best practices.
 * Only runs on frontend files (src/renderer/, src/preload/).
 */

import { execFileSync } from 'node:child_process';
import { createChecklistStore } from '../../_devkit/checklist-store.mjs';
import {
  assertStagedSetSane,
  resolveReviewRoots,
  toGitPathspecs,
} from '../../_devkit/review-roots.mjs';

const CHECKLIST_PATH = '.claude/.frontend-performance-review.json';

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

const store = createChecklistStore({
  path: CHECKLIST_PATH,
  label: 'Frontend Performance',
  log,
});
const { save: saveChecklist, status, checkItem, finalize, cleanup } = store;

// Frontend roots to review — from guard.config.json `review.frontendRoots` (NOT hardcoded), so the
// checklist scopes to ANY repo's layout. No/unreadable config, a non-object config, or an absent
// review.frontendRoots → all staged files (the gate never silently no-ops). A PRESENT but invalid
// value (not an array of non-empty strings) warns loudly and falls back to scan-all, rather than
// letting a bad entry crash the git call into an empty result that would wave the commit through.
function frontendRoots() {
  return resolveReviewRoots({
    envName: 'DEVKIT_REVIEW_FRONTEND_ROOTS',
    configKey: 'frontendRoots',
    reviewerName: 'frontend-performance',
  });
}

function getStagedFiles() {
  const pathspecs = toGitPathspecs(frontendRoots());
  try {
    const output = execFileSync(
      'git',
      ['diff', '--cached', '--name-only', '--diff-filter=ACM', '--', ...pathspecs],
      { encoding: 'utf-8' },
    );
    // ACM hides deletions, so an all-deletions index reads as "nothing staged" here. Never report
    // that as zero items — a reviewer that examined nothing must not read as a pass.
    if (!output.trim()) assertStagedSetSane(pathspecs, 'frontend-performance');
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
