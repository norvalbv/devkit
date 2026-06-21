#!/usr/bin/env node

/**
 * Upstream Sync Merge Verification
 *
 * Deterministic check that no frink-specific code was lost during a merge.
 *
 * For each file modified in the staged diff:
 *   1. Gets the file at the fork point from 1code (what both repos started with)
 *   2. Gets frink's version before the merge (HEAD)
 *   3. Computes "frink additions" = lines in frink's pre-merge version that aren't in the fork point
 *   4. Gets the merged version (staged in index)
 *   5. Checks that all frink additions still exist in the merged version
 *
 * Usage:
 *   node .cursor/skills/upstream-sync/scripts/verify-merge.mjs [--verbose]
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function getOneCodeDir() {
  if (process.env.FRINK_ONECODE_DIR) return process.env.FRINK_ONECODE_DIR;
  if (existsSync(join('cloned-projects', '1code', '.git'))) return join('cloned-projects', '1code');
  return '1code';
}

const ONECODE_DIR = getOneCodeDir();
const REVIEW_FILE = '.upstream-sync-review.json';
const VERBOSE = process.argv.includes('--verbose');

const log = console.log;

function exec(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf-8', ...opts }).trim();
  } catch {
    return null;
  }
}

function getFileAtForkPoint(filePath, forkHash) {
  return exec(`git -C ${ONECODE_DIR} show ${forkHash}:${filePath}`);
}

function getFileAtHead(filePath) {
  return exec(`git show HEAD:${filePath}`);
}

function getFileFromIndex(filePath) {
  return exec(`git show :${filePath}`);
}

function getStagedFiles() {
  const output = exec('git diff --cached --name-only --diff-filter=ACMR -- src/');
  if (!output) return [];
  return output.split('\n').filter(Boolean);
}

/**
 * Compute lines that exist in `target` but not in `baseline`.
 * Returns an array of { line, trimmed, lineNumber }.
 * Ignores blank lines and import-only changes.
 */
// Reason: vendored upstream-sync script: this is the line-set diff (build baseline set, scan target lines, skip blanks/dupes); complexity is owned by the skill's merge-verification flow, not devkit's core gate
// fallow-ignore-next-line complexity
function computeAdditions(baselineContent, targetContent) {
  if (!baselineContent || !targetContent) return [];

  const baselineLines = new Set(
    baselineContent
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0),
  );

  const additions = [];
  const targetLines = targetContent.split('\n');

  for (let i = 0; i < targetLines.length; i++) {
    const trimmed = targetLines[i].trim();
    if (trimmed.length === 0) continue;
    if (!baselineLines.has(trimmed)) {
      additions.push({ line: targetLines[i], trimmed, lineNumber: i + 1 });
    }
  }

  return additions;
}

/**
 * Check if a frink addition still exists in the merged content.
 * Uses trimmed comparison to be whitespace-tolerant.
 */
function findInMerged(addition, mergedLines) {
  return mergedLines.has(addition.trimmed);
}

/**
 * Filter out low-signal additions (imports, single braces, comments-only, short lines).
 */
// Reason: the branches ARE the noise-filter classifier: each guard clause rejects one distinct low-signal line category (braces, trivial returns, short comments, imports, tiny lines); merging them hides which category was filtered
// fallow-ignore-next-line complexity
function isSignificantLine(trimmed) {
  if (trimmed === '{' || trimmed === '}' || trimmed === '};' || trimmed === ');') return false;
  if (trimmed === 'return null;' || trimmed === 'return;') return false;
  if (trimmed.startsWith('//') && trimmed.length < 20) return false;
  if (trimmed.startsWith('import ')) return false; // imports change constantly, not meaningful
  if (trimmed.length < 15) return false; // very short lines are noise
  return true;
}

/**
 * Check if a line was "modified" (expanded/tweaked) rather than removed.
 * Extracts significant tokens and checks if most of them exist in the merged content.
 */
function isModifiedNotRemoved(addition, mergedContent) {
  // Extract identifiers and significant tokens (3+ chars, not common keywords)
  const keywords = new Set([
    'const',
    'let',
    'var',
    'function',
    'return',
    'import',
    'export',
    'from',
    'type',
    'interface',
    'class',
    'if',
    'else',
    'for',
    'while',
    'new',
    'this',
    'true',
    'false',
    'null',
    'undefined',
    'void',
  ]);
  const tokens =
    addition.trimmed.match(/[a-zA-Z_$][a-zA-Z0-9_$]{2,}/g)?.filter((t) => !keywords.has(t)) || [];

  if (tokens.length === 0) return true; // no significant tokens = noise

  // Check how many tokens still exist in merged content
  const found = tokens.filter((t) => mergedContent.includes(t));
  const ratio = found.length / tokens.length;

  // If 70%+ of significant tokens still exist, the line was modified not removed
  return ratio >= 0.7;
}

/**
 * Check if functionality exists in another staged file (cross-file move).
 * Searches all staged files for the key identifiers.
 */
// Reason: vendored upstream-sync script: cross-file move detection (tokenize, pick most-unique token, scan every other staged file's index blob); flagged on untested-complexity because it is exercised end-to-end by the merge-verification flow, not unit-tested in devkit
// fallow-ignore-next-line complexity
function existsInOtherStagedFiles(addition, currentFile, stagedFiles) {
  const tokens = addition.trimmed.match(/[a-zA-Z_$][a-zA-Z0-9_$]{4,}/g) || [];
  if (tokens.length === 0) return true;

  // Pick the most unique-looking token (longest)
  const uniqueToken = tokens.sort((a, b) => b.length - a.length)[0];

  for (const file of stagedFiles) {
    if (file === currentFile) continue;
    const content = getFileFromIndex(file);
    if (content?.includes(uniqueToken)) return true;
  }
  return false;
}

// ============ MAIN ============

/**
 * Load the review file and return the set of accepted file paths.
 * Returns null if no review file exists (full accept mode).
 */
function loadAcceptedFiles() {
  if (!existsSync(REVIEW_FILE)) return null;

  try {
    const review = JSON.parse(readFileSync(REVIEW_FILE, 'utf-8'));
    const accepted = new Set(
      review.files.filter((f) => f.status === 'accepted').map((f) => f.path),
    );
    if (VERBOSE) {
      const rejected = review.files.filter((f) => f.status === 'rejected').length;
      const pending = review.files.filter((f) => f.status === 'pending').length;
      log(
        `📋 Review file found: ${accepted.size} accepted, ${rejected} rejected, ${pending} pending files`,
      );
    }
    return accepted;
  } catch {
    log('⚠️  Could not parse .upstream-sync-review.json — verifying all files');
    return null;
  }
}

// Reason: flat orchestration: load review, gather staged files, then a single loop that classifies each frink addition into preserved/missing/modified/moved buckets and tallies a report; high branch COUNT across sequential near-zero-nesting steps, each trivial
// fallow-ignore-next-line complexity
function main() {
  // The fork point is the commit frink was originally cloned from (v0.0.40)
  const forkHash = '7cf0dc0e7fca4196437a43be9982b12a182aeb7e';

  const acceptedFiles = loadAcceptedFiles();

  let stagedFiles = getStagedFiles();
  if (stagedFiles.length === 0) {
    log('No staged src/ files to verify.');
    process.exit(0);
  }

  // If review file exists, only verify accepted files
  if (acceptedFiles !== null) {
    const before = stagedFiles.length;
    stagedFiles = stagedFiles.filter((f) => acceptedFiles.has(f));
    if (VERBOSE && before !== stagedFiles.length) {
      log(`   Filtered to ${stagedFiles.length}/${before} staged files (accepted only)\n`);
    }
  }

  if (stagedFiles.length === 0) {
    log('No accepted staged src/ files to verify.');
    process.exit(0);
  }

  log(`🔍 Verifying ${stagedFiles.length} staged file(s)...\n`);

  let totalMissing = 0;
  let totalChecked = 0;
  let filesWithIssues = 0;
  const issues = [];

  for (const file of stagedFiles) {
    // Get the file at the fork point (what both repos started with)
    const forkContent = getFileAtForkPoint(file, forkHash);

    // Get frink's version before the merge
    const premergeContent = getFileAtHead(file);

    // Get the merged version (from git index)
    const mergedContent = getFileFromIndex(file);

    if (!premergeContent || !mergedContent) {
      // New file or deleted file — skip
      if (VERBOSE) log(`  ⏭️  ${file} — new or deleted, skipping`);
      continue;
    }

    // Compute frink-specific additions (lines frink added that weren't in the fork point)
    const frinkAdditions = computeAdditions(forkContent || '', premergeContent);

    // Filter to significant lines only
    const significantAdditions = frinkAdditions.filter((a) => isSignificantLine(a.trimmed));

    if (significantAdditions.length === 0) {
      if (VERBOSE) log(`  ✅ ${file} — no frink-specific additions to verify`);
      continue;
    }

    // Build a set of trimmed lines from the merged version for fast lookup
    const mergedLines = new Set(
      mergedContent
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0),
    );

    // Check each frink addition exists in the merged version
    const missing = [];
    const modified = [];
    const movedToOtherFile = [];
    for (const addition of significantAdditions) {
      totalChecked++;
      if (!findInMerged(addition, mergedLines)) {
        // Check if the line was modified (tokens still present) rather than truly removed
        if (isModifiedNotRemoved(addition, mergedContent)) {
          modified.push(addition);
        } else if (existsInOtherStagedFiles(addition, file, stagedFiles)) {
          movedToOtherFile.push(addition);
        } else {
          missing.push(addition);
          totalMissing++;
        }
      }
    }

    if (missing.length > 0) {
      filesWithIssues++;
      issues.push({ file, missing, total: significantAdditions.length });
      log(
        `  ❌ ${file} — ${missing.length} truly missing, ${modified.length} modified, ${movedToOtherFile.length} moved`,
      );
      if (VERBOSE) {
        for (const m of missing.slice(0, 10)) {
          log(`     L${m.lineNumber}: ${m.trimmed.slice(0, 100)}`);
        }
        if (missing.length > 10) log(`     ... and ${missing.length - 10} more`);
      }
    } else {
      const extra = modified.length + movedToOtherFile.length;
      const extraMsg =
        extra > 0 ? ` (${modified.length} modified, ${movedToOtherFile.length} moved)` : '';
      log(`  ✅ ${file} — ${significantAdditions.length} frink additions preserved${extraMsg}`);
    }
  }

  log('');
  log('─'.repeat(50));
  log(`📊 Results: ${totalChecked} frink additions checked across ${stagedFiles.length} files`);
  log(`   ✅ Preserved: ${totalChecked - totalMissing}`);
  log(`   ❌ Missing: ${totalMissing}`);
  log(`   📁 Files with issues: ${filesWithIssues}`);

  if (totalMissing > 0) {
    log('\n⚠️  VERIFICATION FAILED — frink code may have been lost.');
    log('Missing additions by file:\n');
    for (const { file, missing, total } of issues) {
      log(`  ${file} (${missing.length}/${total} missing):`);
      for (const m of missing) {
        log(`    L${m.lineNumber}: ${m.trimmed.slice(0, 120)}`);
      }
      log('');
    }
    process.exit(1);
  } else {
    log('\n✅ VERIFICATION PASSED — all frink-specific code preserved.');
    process.exit(0);
  }
}

main();
