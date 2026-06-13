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
 *   finalize              Check all done, run approve if passed
 *   cleanup               Remove checklist file
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const CHECKLIST_PATH = '.claude/.pre-commit-review.json';

const log = console.log;

function getStagedFiles() {
  try {
    const output = execSync(
      'git diff --cached --name-only --diff-filter=ACM -- src/ vercel-serverless/ socket-server/',
      { encoding: 'utf-8' },
    );
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
    log('⚠️  No staged files in src/, vercel-serverless/, or socket-server/');
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
  if (!pass && failReason) {
    file.issues.push(failReason);
  }
  saveChecklist(data);
  log(`✓ ${path}: ${file.status}${failReason ? ` (${failReason})` : ''}`);
}

function finalize() {
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
  writeFileSync('.claude/.commit-guard-passed', '');
  log('📝 Created .claude/.commit-guard-passed marker');
  try {
    execSync('./.claude/skills/commit-guard/scripts/approve.sh', { stdio: 'inherit' });
  } catch {
    log('⚠️  Could not run approve script');
  }
}

function cleanup() {
  if (existsSync(CHECKLIST_PATH)) {
    unlinkSync(CHECKLIST_PATH);
    log('🗑️  Removed checklist');
  }
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
  case 'finalize':
    finalize();
    break;
  case 'cleanup':
    cleanup();
    break;
  default:
    log('Commands:');
    log('  init                         Create checklist from staged files');
    log('  status                       Show progress');
    log('  check-file <path> --pass|--fail  Mark file reviewed');
    log('  finalize                     Verify & approve');
    log('  cleanup                      Remove checklist');
    process.exit(1);
}
