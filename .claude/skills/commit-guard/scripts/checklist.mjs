#!/usr/bin/env node

/**
 * Pre-Commit Review Checklist (Incremental)
 *
 * Token-efficient checklist that updates incrementally.
 * Agent marks items one at a time, no full rewrites.
 *
 * Commands:
 *   init                  Create checklist from staged files
 *   status                Show progress summary
 *   check-file <path>     Mark file as reviewed (--pass or --fail "reason")
 *   finalize              Verify every item was resolved; refuses if any are pending or failed
 *                         --retrieval ok | --retrieval unavailable --cause "why" records whether
 *                         semantic duplicate retrieval ran (the gate reports an unrecorded or
 *                         unavailable retrieval as DEGRADED — sc-2317)
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  assertStagedSetSane,
  resolveConfigRoots,
  stagedFilesOverride,
  toGitPathspecs,
} from '../../_devkit/review-roots.mjs';

const CHECKLIST_PATH = '.claude/.pre-commit-review.json';

const log = console.log;

// First-level source roots to review — from guard.config.json (NOT hardcoded), so the checklist
// scopes to ANY repo's layout. The shared resolver normalizes the same roots as review selection,
// rejects Git pathspec magic, and conservatively scans all staged files for absent/invalid config.
function scanRoots() {
  return resolveConfigRoots({ configKey: 'scanRoots', reviewerName: 'commit-guard' });
}

function getStagedFiles() {
  const override = stagedFilesOverride();
  if (override) return override;
  const pathspecs = toGitPathspecs(scanRoots());
  try {
    const output = execFileSync(
      'git',
      ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '--', ...pathspecs],
      { encoding: 'utf-8' },
    );
    // ACMR hides deletions, so an all-deletions index reads as "nothing staged" here. Never report
    // that as zero items — a reviewer that examined nothing must not read as a pass.
    if (!output.trim()) assertStagedSetSane(pathspecs, 'commit-guard');
    return output
      .trim()
      .split('\n')
      .filter((f) => f.length > 0);
  } catch {
    return [];
  }
}

function loadChecklist() {
  if (!existsSync(CHECKLIST_PATH)) return null;
  return JSON.parse(readFileSync(CHECKLIST_PATH, 'utf-8'));
}

function saveChecklist(data) {
  mkdirSync(dirname(CHECKLIST_PATH), { recursive: true });
  writeFileSync(CHECKLIST_PATH, JSON.stringify(data, null, 2));
}

// ============ COMMANDS ============

function init() {
  const stagedFiles = getStagedFiles();
  if (stagedFiles.length === 0) {
    log('⚠️  No staged files under the configured scanRoots (guard.config.json)');
    // sc-1439: the GATE selected this reviewer, so an artifact must exist — a named skip, never
    // an absence (verifyChecklist voids a PASS on a missing artifact).
    if (stagedFilesOverride())
      saveChecklist({
        files: [],
        skipped:
          "gate-selected files were all excluded by this checklist's own filters (prose/tests/extensions/deletions) — deliberate skip, not an unfinished review",
      });
    process.exit(0);
  }

  const data = {
    generated: new Date().toISOString(),
    files: stagedFiles.map((path) => ({ path, status: 'pending', issues: [] })),
  };

  saveChecklist(data);
  log(`✅ ${stagedFiles.length} file(s)`);
}

function status() {
  const data = loadChecklist();
  if (!data) {
    log('❌ No checklist. Run: init');
    process.exit(1);
  }

  const filesDone = data.files.filter((f) => f.status !== 'pending').length;
  const issues = data.files.flatMap((f) => f.issues);

  log(`📋 Files: ${filesDone}/${data.files.length} | Issues: ${issues.length}`);

  if (issues.length > 0) {
    log('Issues:');
    for (const issue of issues) {
      log(`  - ${issue}`);
    }
  }
}

// Reason: flat CLI handler for the commit-guard check-file command: sequential early-exit guards (no checklist, file not found) plus a pass/fail ternary, near-zero nesting; high branch COUNT, each trivial; vendored commit-guard skill script whose review flow owns the complexity, not devkit's core gate
// fallow-ignore-next-line complexity
function checkFile(path, pass, failReason) {
  const data = loadChecklist();
  if (!data) {
    log('❌ No checklist');
    process.exit(1);
  }

  const file = data.files.find((f) => f.path === path);
  if (!file) {
    log(`❌ File not found: ${path}`);
    process.exit(1);
  }

  file.status = pass ? 'pass' : 'fail';
  if (pass) file.issues = []; // a recovery pass clears the stale failure trail
  if (!pass && failReason) {
    file.issues.push(failReason);
  }
  saveChecklist(data);
  log(`✓ ${path}: ${file.status}${failReason ? ` (${failReason})` : ''}`);
}

// Reason: flat CLI handler for the commit-guard finalize command: sequential early-exit guards (no checklist, pending files, failed files/issues), near-zero nesting; high branch COUNT, each trivial; vendored commit-guard skill script whose review flow owns the complexity, not devkit's core gate
// fallow-ignore-next-line complexity
function finalize(retrieval) {
  const data = loadChecklist();
  if (!data) {
    log('❌ No checklist');
    process.exit(1);
  }

  const pendingFiles = data.files.filter((f) => f.status === 'pending');
  const failedFiles = data.files.filter((f) => f.status === 'fail');
  const allIssues = data.files.flatMap((f) => f.issues);

  if (pendingFiles.length > 0) {
    log(`❌ Incomplete: ${pendingFiles.length} file(s) pending`);
    process.exit(1);
  }

  if (failedFiles.length > 0 || allIssues.length > 0) {
    log(`❌ Failed: ${allIssues.length} issue(s)`);
    for (const issue of allIssues) {
      log(`  - ${issue}`);
    }
    process.exit(1);
  }

  log('✅ All checks passed');
  if (retrieval) {
    data.retrieval = retrieval;
    saveChecklist(data);
    if (retrieval.status === 'unavailable')
      log(`⚠️  Semantic retrieval unavailable: ${retrieval.cause}`);
  }
  // Automatic tidy — same contract as checklist-store.mjs finalize: env guards keep gate/review artifacts.
  tidy();
}

function tidy() {
  if (process.env.DEVKIT_RUN_MODE === 'review') return;
  // Same guard as checklist-store.mjs tidy(): in gate runs the gate owns artifact removal.
  if (process.env.DEVKIT_CHECKLIST_KEEP === '1') return;
  if (existsSync(CHECKLIST_PATH)) {
    unlinkSync(CHECKLIST_PATH);
    log('🗑️  Removed checklist');
  }
}

const FINALIZE_USAGE = 'Usage: finalize [--retrieval ok | --retrieval unavailable --cause "why"]';

// Reason: strict finalize grammar for the retrieval flag the gate reads back (sc-2317): null = no --retrieval (interactive runs stay valid; the gate reads absent as DEGRADED), undefined = refused; each branch rejects one malformed or contradictory shape
// fallow-ignore-next-line complexity
function parseRetrieval(argv) {
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    const known = flag === '--retrieval' || flag === '--cause';
    if (!known || flags.has(flag) || value === undefined || value.startsWith('--'))
      return undefined;
    flags.set(flag, value.trim());
  }
  const status = flags.get('--retrieval');
  const cause = flags.get('--cause');
  if (status === undefined) return cause === undefined ? null : undefined;
  if (status === 'ok') return cause === undefined ? { status: 'ok' } : undefined;
  return status === 'unavailable' && cause ? { status: 'unavailable', cause } : undefined;
}

// ============ MAIN ============

const args = process.argv.slice(2);
const cmd = args[0];

switch (cmd) {
  case 'init':
    init();
    break;
  case 'status':
    status();
    break;
  case 'check-file': {
    const path = args[1];
    const pass = args.includes('--pass');
    const failIdx = args.indexOf('--fail');
    const failReason = failIdx !== -1 ? args[failIdx + 1] : null;
    if (!path || (!pass && failIdx === -1)) {
      log('Usage: check-file <path> --pass OR --fail "reason"');
      process.exit(1);
    }
    checkFile(path, pass, failReason);
    break;
  }
  case 'finalize': {
    const retrieval = parseRetrieval(args.slice(1));
    if (retrieval === undefined) {
      log(FINALIZE_USAGE);
      process.exit(1);
    }
    finalize(retrieval);
    break;
  }
  default:
    log('Commands:');
    log('  init                         Create checklist from staged files');
    log('  status                       Show progress');
    log('  check-file <path> --pass|--fail  Mark file reviewed');
    log('  finalize [--retrieval ok|unavailable --cause "why"]  Verify every item was resolved');
    process.exit(1);
}
