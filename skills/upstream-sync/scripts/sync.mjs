#!/usr/bin/env node

/**
 * Upstream Sync Helper
 *
 * Manages sync state between frink and the 1code upstream repo.
 * Tracks which commits have been reviewed, accepted, or skipped.
 *
 * Commands:
 *   status                    Show current sync state and pending commit count
 *   list                      List all pending commits (oldest first)
 *   show <hash>               Show full diff for a specific upstream commit
 *                              Use --chunk N to filter to files in chunk N
 *   accept <hash>             Mark commit as accepted, advance sync cursor
 *                              Use --review-file to record partial accept from review file
 *   skip <hash>               Mark commit as skipped, advance sync cursor
 *   frink-delta <hash>        Show frink vs 1code baseline diffs for files in a commit
 *                              Use --chunk N to filter to files in chunk N
 *   check-size <hash>         Check commit size and recommend Path A or Path B
 *   review-init <hash>        Pre-populate review JSON with all files, IDs, and chunk assignments
 *                              Use --budget N to set lines-per-chunk (default 950)
 *   review-merge-chunks       Merge chunk temp files into main review JSON
 *   review-workgroups         Group accepted files into merger workgroups
 *                              Use --budget N to set lines-per-workgroup (default 950)
 *   review-show               Pretty-print the current .upstream-sync-review.json
 *   review-accept <ids>       Set files by ID to "accepted" (comma-separated)
 *   review-reject <ids>       Set files by ID to "rejected" (comma-separated)
 *   review-defer <ids>        Set files by ID to "deferred" (comma-separated)
 *   review-accept-all         Set all files to "accepted"
 *   review-reject-all         Set all files to "rejected"
 *   review-defer-all          Set all files to "deferred"
 *   review-clean              Remove the review file after commit
 *   reset                     Reset sync state (prompts confirmation)
 */

import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const STATE_PATH = '.upstream-sync.json';
const REVIEW_PATH = '.upstream-sync-review.json';

/** Separate-git-repo upstream clone used as baseline. Override with FRINK_ONECODE_DIR. */
function getOneCodeDir() {
  if (process.env.FRINK_ONECODE_DIR) return process.env.FRINK_ONECODE_DIR;
  if (existsSync(join('cloned-projects', '1code', '.git'))) return join('cloned-projects', '1code');
  return '1code';
}

const ONECODE_DIR = getOneCodeDir();

const log = console.log;

function assertOneCodeGitRepo() {
  if (!existsSync(join(ONECODE_DIR, '.git'))) {
    log(`❌ 1code upstream clone not found at ${ONECODE_DIR}/`);
    log(
      '   Clone https://github.com/21st-dev/1code into cloned-projects/1code or ./1code, or set FRINK_ONECODE_DIR.',
    );
    process.exit(1);
  }
}
const HUNK_HEADER_REGEX = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const CHUNK_TEMP_FILE_REGEX = /^\.upstream-sync-chunk-.+?-\d+\.json$/;

// ============ HELPERS ============

function loadState() {
  if (!existsSync(STATE_PATH)) {
    log('❌ No .upstream-sync.json found. Create one first.');
    process.exit(1);
  }
  return JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
}

function saveState(state) {
  state.lastSyncDate = new Date().toISOString();
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

function exec(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf-8', ...opts }).trim();
  } catch (e) {
    if (opts.allowFail) return '';
    log(`❌ Command failed: ${cmd}`);
    log(e.stderr || e.message);
    process.exit(1);
  }
}

// biome-ignore lint/correctness/noUnusedVariables: utility kept for manual upstream sync usage
function ensureUpstreamFetched() {
  const remotes = exec('git remote -v');
  if (!remotes.includes('upstream')) {
    log('❌ No upstream remote. Run:');
    log('   git remote add upstream https://github.com/21st-dev/1code.git');
    process.exit(1);
  }
}

function getPendingCommits(state) {
  const lastHash = state.lastSyncedHash;

  // Get commits from the 1code directory (it's a separate git repo)
  const result = exec(`git -C ${ONECODE_DIR} log --oneline --reverse ${lastHash}..HEAD`, {
    allowFail: true,
  });

  if (!result) return [];

  return result
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, ...rest] = line.split(' ');
      return { hash, subject: rest.join(' ') };
    });
}

function getFullHash(shortHash) {
  return exec(`git -C ${ONECODE_DIR} rev-parse ${shortHash}`);
}

function loadReview() {
  if (!existsSync(REVIEW_PATH)) {
    log('❌ No .upstream-sync-review.json found. Run the reviewer first.');
    process.exit(1);
  }
  return JSON.parse(readFileSync(REVIEW_PATH, 'utf-8'));
}

function saveReview(review) {
  writeFileSync(REVIEW_PATH, `${JSON.stringify(review, null, 2)}\n`);
}

const DEFAULT_CHUNK_BUDGET = 950;

/**
 * Read the chunk file list for a given chunk ID from the review JSON.
 * Returns null if no chunks exist or chunk ID is invalid.
 */
function getChunkFiles(chunkId) {
  if (!existsSync(REVIEW_PATH)) {
    log('❌ No review file found. Run review-init first to use --chunk.');
    process.exit(1);
  }
  const review = loadReview();
  if (!review.chunks || review.chunks.length === 0) return null;
  const chunk = review.chunks.find((c) => c.id === chunkId);
  if (!chunk) {
    log(`❌ Chunk ${chunkId} not found (max: ${review.chunks.length})`);
    process.exit(1);
  }
  return chunk.files;
}

/**
 * Parse --chunk N from process.argv. Returns null if not present.
 */
function parseChunkArg() {
  const idx = process.argv.indexOf('--chunk');
  if (idx === -1) return null;
  const val = Number(process.argv[idx + 1]);
  if (!Number.isInteger(val) || val < 1) {
    log('❌ --chunk requires a positive integer.');
    process.exit(1);
  }
  return val;
}

/**
 * Parse --budget N from process.argv. Returns defaultBudget if not present.
 */
function parseBudgetArg(defaultBudget = DEFAULT_CHUNK_BUDGET) {
  const idx = process.argv.indexOf('--budget');
  if (idx === -1) return defaultBudget;
  const val = Number(process.argv[idx + 1]);
  if (!Number.isInteger(val) || val < 100) {
    log('❌ --budget requires an integer >= 100.');
    process.exit(1);
  }
  return val;
}

// ============ COMMANDS ============

function status() {
  const state = loadState();
  const pending = getPendingCommits(state);

  log('📊 Upstream Sync Status');
  log('─'.repeat(40));
  log(`Last synced:  ${state.lastSyncedHash.slice(0, 8)}`);
  log(`Sync date:    ${state.lastSyncDate}`);
  const partialCommits = state.partialCommits || [];
  const totalDeferred = partialCommits.reduce((sum, c) => sum + (c.deferred?.length ?? 0), 0);

  log(`Pending:      ${pending.length} commit(s)`);
  log(`Accepted:     ${state.appliedCommits.length}`);
  log(`Partial:      ${partialCommits.length}`);
  log(`Skipped:      ${state.skippedCommits.length}`);
  if (totalDeferred > 0) {
    log(
      `Deferred:     ${totalDeferred} file(s) across ${partialCommits.filter((c) => c.deferred?.length).length} partial commit(s)`,
    );
  }

  if (pending.length > 0) {
    log(`\nNext: ${pending[0].hash} ${pending[0].subject}`);
  } else {
    log('\n✅ Up to date with upstream');
  }
}

function list() {
  const state = loadState();
  const pending = getPendingCommits(state);

  if (pending.length === 0) {
    log('✅ No pending commits. Up to date.');
    return;
  }

  log(`📋 ${pending.length} pending commit(s):\n`);
  for (const { hash, subject } of pending) {
    log(`  ${hash} ${subject}`);
  }
}

function show(hash) {
  if (!hash) {
    log('Usage: show <hash> [--chunk N]');
    process.exit(1);
  }

  const chunkId = parseChunkArg();
  const chunkFiles = chunkId ? getChunkFiles(chunkId) : null;
  const fileFilter = chunkFiles ? `-- ${chunkFiles.map((f) => `"${f}"`).join(' ')}` : '';

  if (chunkId) {
    log(`📄 Commit: ${hash} (chunk ${chunkId})\n`);
  } else {
    log(`📄 Commit: ${hash}\n`);
  }

  // Show commit message (only for chunk 1 or no chunking)
  if (!chunkId || chunkId === 1) {
    const msg = exec(`git -C ${ONECODE_DIR} log --format="%B" -1 ${hash}`);
    log(`Message:\n${msg}\n`);
  }

  // Show files changed (filtered if chunked)
  const files = exec(`git -C ${ONECODE_DIR} diff --name-only ${hash}~1..${hash} ${fileFilter}`);
  log(`Files changed:\n${files}\n`);

  // Show stat (filtered if chunked)
  const stat = exec(`git -C ${ONECODE_DIR} diff --stat ${hash}~1..${hash} ${fileFilter}`);
  log(`Stats:\n${stat}\n`);

  // Show the full diff (filtered if chunked)
  log('─'.repeat(40));
  log('Full diff:\n');
  const diff = exec(`git -C ${ONECODE_DIR} diff ${hash}~1..${hash} ${fileFilter}`);
  log(diff);
}

function accept(hash) {
  if (!hash) {
    log('Usage: accept <hash> [--review-file]');
    process.exit(1);
  }

  const useReviewFile = process.argv.includes('--review-file');
  const state = loadState();
  const fullHash = getFullHash(hash);
  const pending = getPendingCommits(state);

  // Verify this is the next pending commit
  if (pending.length === 0) {
    log('❌ No pending commits.');
    process.exit(1);
  }

  const nextFull = getFullHash(pending[0].hash);
  if (nextFull !== fullHash) {
    log(`⚠️  Expected next commit: ${pending[0].hash}`);
    log(`   Got: ${hash}`);
    log('   Commits must be processed in order.');
    process.exit(1);
  }

  // Initialize partialCommits array if not present
  if (!state.partialCommits) {
    state.partialCommits = [];
  }

  if (useReviewFile) {
    // Partial accept — read the review file and record per-file decisions
    const review = loadReview();

    // Validate the review file matches the commit being accepted
    const reviewHash = getFullHash(review.commit);
    if (reviewHash !== fullHash) {
      log(`❌ Review file is for commit ${review.commit}, not ${hash}. Run review-clean first.`);
      process.exit(1);
    }

    // Block if any files are still pending — force explicit resolution
    const pendingFiles = review.files.filter((f) => f.status === 'pending');
    if (pendingFiles.length > 0) {
      log(
        `❌ ${pendingFiles.length} file(s) still pending. Accept, reject, or defer all before accepting.`,
      );
      for (const f of pendingFiles) log(`   [${f.id}] ${f.path}`);
      process.exit(1);
    }

    const accepted = review.files.filter((f) => f.status === 'accepted').map((f) => f.path);
    const rejected = review.files.filter((f) => f.status === 'rejected').map((f) => f.path);
    const deferred = review.files.filter((f) => f.status === 'deferred').map((f) => f.path);

    if (accepted.length === 0) {
      log('⚠️  All files are rejected/deferred — this is effectively a skip.');
      log('   Consider using `skip <hash>` instead.');
      log('   Proceeding anyway...');
    }

    const partialEntry = {
      hash: fullHash,
      subject: pending[0].subject,
      date: new Date().toISOString(),
      accepted,
      rejected,
    };
    if (deferred.length > 0) partialEntry.deferred = deferred;

    state.partialCommits.push(partialEntry);

    log(`✅ Partially accepted: ${hash} — ${pending[0].subject}`);
    log(`   ${accepted.length} accepted, ${rejected.length} rejected, ${deferred.length} deferred`);
  } else {
    // Full accept
    state.appliedCommits.push({
      hash: fullHash,
      subject: pending[0].subject,
      date: new Date().toISOString(),
    });

    log(`✅ Accepted: ${hash} — ${pending[0].subject}`);
  }

  state.lastSyncedHash = fullHash;
  saveState(state);
  log(`   ${pending.length - 1} commit(s) remaining`);
}

function skip(hash) {
  if (!hash) {
    log('Usage: skip <hash>');
    process.exit(1);
  }

  const state = loadState();
  const fullHash = getFullHash(hash);
  const pending = getPendingCommits(state);

  // Verify this is the next pending commit
  if (pending.length === 0) {
    log('❌ No pending commits.');
    process.exit(1);
  }

  const nextFull = getFullHash(pending[0].hash);
  if (nextFull !== fullHash) {
    log(`⚠️  Expected next commit: ${pending[0].hash}`);
    log(`   Got: ${hash}`);
    log('   Commits must be processed in order.');
    process.exit(1);
  }

  state.skippedCommits.push({
    hash: fullHash,
    subject: pending[0].subject,
    date: new Date().toISOString(),
  });
  state.lastSyncedHash = fullHash;
  saveState(state);

  log(`⏭️  Skipped: ${hash} — ${pending[0].subject}`);
  log(`   ${pending.length - 1} commit(s) remaining`);
}

/**
 * Parse unified diff hunk headers to extract line ranges.
 * Returns array of { oldStart, oldCount, newStart, newCount } from @@ lines.
 */
function parseHunkRanges(diffText) {
  const hunks = [];
  const hunkRegex = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
  for (const match of diffText.matchAll(hunkRegex)) {
    hunks.push({
      oldStart: Number(match[1]),
      oldCount: Number(match[2] ?? 1),
      newStart: Number(match[3]),
      newCount: Number(match[4] ?? 1),
    });
  }
  return hunks;
}

/**
 * Filter a unified diff to only include hunks that overlap with given line ranges.
 * `ranges` are upstream hunk ranges (old-side, since 1code baseline = upstream's parent).
 * `margin` adds extra lines around each range for overlap detection.
 */
function filterDiffHunks(diffText, ranges, margin = 30) {
  if (ranges.length === 0) return diffText;

  const lines = diffText.split('\n');
  const filteredLines = [];
  let inHunk = false;
  let currentHunkLines = [];
  let keepHunk = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isHunkHeader = line.startsWith('@@');
    const isDiffHeader =
      line.startsWith('---') || line.startsWith('+++') || line.startsWith('diff ');

    if (isDiffHeader) {
      // Flush previous hunk if kept
      if (inHunk && keepHunk) {
        filteredLines.push(...currentHunkLines);
      }
      filteredLines.push(line);
      inHunk = false;
      currentHunkLines = [];
      continue;
    }

    if (isHunkHeader) {
      // Flush previous hunk if kept
      if (inHunk && keepHunk) {
        filteredLines.push(...currentHunkLines);
      }

      // Parse this hunk's range (old-side = 1code baseline lines)
      const hunkMatch = line.match(HUNK_HEADER_REGEX);
      if (hunkMatch) {
        const hunkOldStart = Number(hunkMatch[1]);
        const hunkOldCount = Number(hunkMatch[2] ?? 1);
        const hunkEnd = hunkOldStart + hunkOldCount;

        // Check if this hunk overlaps with any upstream range (with margin)
        keepHunk = ranges.some((r) => {
          const rEnd = r.oldStart + r.oldCount;
          return hunkOldStart <= rEnd + margin && hunkEnd >= r.oldStart - margin;
        });
      } else {
        keepHunk = true;
      }

      inHunk = true;
      currentHunkLines = [line];
      continue;
    }

    if (inHunk) {
      currentHunkLines.push(line);
    }
  }

  // Flush last hunk
  if (inHunk && keepHunk) {
    filteredLines.push(...currentHunkLines);
  }

  return filteredLines.join('\n');
}

function frinkDelta(hash) {
  if (!hash) {
    log('Usage: frink-delta <hash> [--chunk N]');
    process.exit(1);
  }

  const chunkId = parseChunkArg();
  const chunkFileSet = chunkId ? new Set(getChunkFiles(chunkId)) : null;

  // Get files changed in the upstream commit
  const filesRaw = exec(`git -C ${ONECODE_DIR} diff --name-only ${hash}~1..${hash}`);
  if (!filesRaw) {
    log('No files changed in this commit.');
    return;
  }

  let files = filesRaw.split('\n').filter(Boolean);
  if (chunkFileSet) {
    files = files.filter((f) => chunkFileSet.has(f));
  }

  // Get the upstream diff to know which regions were changed (filtered if chunked)
  const fileFilter = chunkFileSet ? `-- ${[...chunkFileSet].map((f) => `"${f}"`).join(' ')}` : '';
  const upstreamDiff = exec(`git -C ${ONECODE_DIR} diff ${hash}~1..${hash} ${fileFilter}`);

  const chunkLabel = chunkId ? ` chunk ${chunkId}` : '';
  log(`🔍 Frink delta for ${hash}${chunkLabel} (${files.length} file(s)):\n`);

  for (const file of files) {
    const onecodePath = `${ONECODE_DIR}/${file}`;
    const frinkPath = file;

    const onecodeExists = existsSync(onecodePath);
    const frinkExists = existsSync(frinkPath);

    log(`━━━ ${file} ━━━`);

    if (!onecodeExists && !frinkExists) {
      log('  ⚠️  File does not exist in 1code baseline or frink\n');
      continue;
    }

    if (!onecodeExists) {
      log('  📄 New file in upstream — no baseline to diff against');
      log('  Check if frink has equivalent: grep for key exports/functions\n');
      continue;
    }

    if (!frinkExists) {
      log('  ❌ File exists in 1code baseline but NOT in frink (deleted or moved)\n');
      continue;
    }

    // Compute full diff between 1code baseline and frink's current version
    const delta = exec(`diff -u "${onecodePath}" "${frinkPath}" || true`, { allowFail: true });

    if (!delta) {
      log('  ✅ Identical to 1code baseline (no frink-specific changes)\n');
    } else {
      const allLines = delta.split('\n');
      const totalAdded = allLines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
      const totalRemoved = allLines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;

      // Extract upstream hunk ranges for this file
      const filePrefix = `a/${file}`;
      const upstreamFileSection = extractFileDiff(upstreamDiff, filePrefix);
      const upstreamRanges = parseHunkRanges(upstreamFileSection);

      // Filter frink delta to only hunks near upstream's changed regions
      const filtered = filterDiffHunks(delta, upstreamRanges, 15);
      const filteredLines = filtered.split('\n');
      const filteredContentLines = filteredLines.filter(
        (l) => !l.startsWith('---') && !l.startsWith('+++') && !l.startsWith('diff '),
      );
      const shownAdded = filteredContentLines.filter((l) => l.startsWith('+')).length;
      const shownRemoved = filteredContentLines.filter((l) => l.startsWith('-')).length;

      log(`  Frink total delta: +${totalAdded} -${totalRemoved} lines from baseline`);

      const MAX_LINES_PER_FILE = 80;
      if (filteredLines.length <= MAX_LINES_PER_FILE) {
        if (shownAdded !== totalAdded || shownRemoved !== totalRemoved) {
          log(
            `  Showing only hunks near upstream's changed regions (+${shownAdded} -${shownRemoved}):`,
          );
        }
        log(filtered);
      } else {
        log(
          `  ⚠️  Heavily diverged — showing first/last ${MAX_LINES_PER_FILE / 2} lines of relevant hunks (+${shownAdded} -${shownRemoved}):`,
        );
        const half = MAX_LINES_PER_FILE / 2;
        log(filteredLines.slice(0, half).join('\n'));
        log(`  ... (${filteredLines.length - MAX_LINES_PER_FILE} lines omitted) ...`);
        log(filteredLines.slice(-half).join('\n'));
      }
      log('');
    }
  }
}

/**
 * Extract the diff section for a specific file from a combined diff output.
 */
function extractFileDiff(fullDiff, filePrefix) {
  const lines = fullDiff.split('\n');
  let capture = false;
  const result = [];

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      if (capture) break;
      if (line.includes(filePrefix)) {
        capture = true;
      }
    }
    if (capture) {
      result.push(line);
    }
  }

  return result.join('\n');
}

const SIZE_THRESHOLD_LINES = 950;
const SIZE_THRESHOLD_FILES = 6;

function checkSize(hash) {
  if (!hash) {
    log('Usage: check-size <hash>');
    process.exit(1);
  }

  const numstatRaw = exec(`git -C ${ONECODE_DIR} diff --no-renames --numstat ${hash}~1..${hash}`);
  if (!numstatRaw) {
    log('SMALL (0 files, 0 lines) → Path A');
    return;
  }

  const lines = numstatRaw.split('\n').filter(Boolean);
  const filesCount = lines.length;
  let totalLines = 0;
  for (const line of lines) {
    const [add, del] = line.split('\t');
    totalLines += (add === '-' ? 0 : Number(add)) + (del === '-' ? 0 : Number(del));
  }

  const isLarge = totalLines >= SIZE_THRESHOLD_LINES || filesCount >= SIZE_THRESHOLD_FILES;
  const verdict = isLarge ? 'LARGE' : 'SMALL';
  const path = isLarge ? 'Path B (chunked review)' : 'Path A (standard review)';

  log(`${verdict} (${filesCount} files, ${totalLines} lines) → ${path}`);
}

function reviewInit(hash) {
  if (!hash) {
    log('Usage: review-init <hash> [--budget N]');
    process.exit(1);
  }

  if (existsSync(REVIEW_PATH)) {
    log('⚠️  Review file already exists. Run review-clean first to start fresh.');
    process.exit(1);
  }

  // Validate this is the next pending commit (same check as accept/skip)
  const state = loadState();
  const fullHash = getFullHash(hash);
  const pending = getPendingCommits(state);
  if (pending.length === 0) {
    log('❌ No pending commits.');
    process.exit(1);
  }
  const nextFull = getFullHash(pending[0].hash);
  if (nextFull !== fullHash) {
    log(`⚠️  Expected next commit: ${pending[0].hash}`);
    log(`   Got: ${hash}`);
    log('   Commits must be processed in order.');
    process.exit(1);
  }

  const budget = parseBudgetArg();

  // Get per-file stats
  const numstatRaw = exec(`git -C ${ONECODE_DIR} diff --no-renames --numstat ${hash}~1..${hash}`);
  if (!numstatRaw) {
    log('No files changed in this commit.');
    return;
  }

  // Binary files report '-' for additions/deletions in numstat; treat as 0 lines.
  // They contribute 0 to the chunk budget and cluster into whichever chunk is being filled.
  const fileStats = numstatRaw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [add, del, path] = line.split('\t');
      return {
        path,
        additions: add === '-' ? 0 : Number(add),
        deletions: del === '-' ? 0 : Number(del),
      };
    });

  // Get commit metadata
  const subject = exec(`git -C ${ONECODE_DIR} log --format="%s" -1 ${hash}`);
  const message = exec(`git -C ${ONECODE_DIR} log --format="%B" -1 ${hash}`);
  const totalAdditions = fileStats.reduce((s, f) => s + f.additions, 0);
  const totalDeletions = fileStats.reduce((s, f) => s + f.deletions, 0);

  // Group files into chunks by budget
  const chunks = [];
  let currentChunk = { id: 1, files: [], lines: 0 };

  for (const f of fileStats) {
    const fileLines = f.additions + f.deletions;
    // Start a new chunk if adding this file would exceed budget (unless chunk is empty)
    if (currentChunk.files.length > 0 && currentChunk.lines + fileLines > budget) {
      chunks.push(currentChunk);
      currentChunk = { id: chunks.length + 1, files: [], lines: 0 };
    }
    currentChunk.files.push(f.path);
    currentChunk.lines += fileLines;
  }
  if (currentChunk.files.length > 0) {
    chunks.push(currentChunk);
  }

  // Build chunk lookup for file entries
  const fileToChunk = {};
  for (const chunk of chunks) {
    for (const path of chunk.files) {
      fileToChunk[path] = chunk.id;
    }
  }

  // Pre-populate all files as pending with IDs
  const files = fileStats.map((f, i) => ({
    id: i + 1,
    path: f.path,
    additions: f.additions,
    deletions: f.deletions,
    chunk: fileToChunk[f.path],
    summary: null,
    context: null,
    inFrink: null,
    conflictRisk: null,
    status: 'pending',
  }));

  const review = {
    commit: hash,
    subject,
    message,
    reviewedAt: new Date().toISOString(),
    stats: {
      additions: totalAdditions,
      deletions: totalDeletions,
      filesChanged: fileStats.length,
    },
    chunks,
    files,
  };

  saveReview(review);

  log(`📋 Pre-populated ${files.length} files in ${chunks.length} chunk(s) (budget: ${budget})`);
  log('─'.repeat(60));
  for (const chunk of chunks) {
    const overBudget = chunk.files.length === 1 && chunk.lines > budget * 2;
    const warning = overBudget ? ' ⚠️  exceeds 2x budget — may overwhelm reviewer context' : '';
    log(`  Chunk ${chunk.id}: ${chunk.files.length} files, ${chunk.lines} lines${warning}`);
  }
  log(`\nInvoke reviewer with --chunk 1..${chunks.length}`);
}

function logFileEntry(f) {
  const label = f.summary || '(no summary)';
  const chunkTag = f.chunk ? ` (chunk ${f.chunk})` : '';
  log(`   [${f.id}] ${f.path} (+${f.additions}/-${f.deletions})${chunkTag} — ${label}`);
  if (f.context) {
    log(`       → ${f.context}`);
  }
}

function reviewShow() {
  const review = loadReview();

  log(`📋 Review: ${review.commit} — ${review.subject}`);
  log(
    `   Stats: +${review.stats.additions} -${review.stats.deletions} across ${review.stats.filesChanged} files`,
  );
  log('─'.repeat(60));

  const accepted = review.files.filter((f) => f.status === 'accepted');
  const rejected = review.files.filter((f) => f.status === 'rejected');
  const deferred = review.files.filter((f) => f.status === 'deferred');
  const pending = review.files.filter((f) => f.status === 'pending');

  if (pending.length > 0) {
    log(`\n⏳ Pending (${pending.length}):`);
    for (const f of pending) logFileEntry(f);
  }

  if (accepted.length > 0) {
    log(`\n✅ Accepted (${accepted.length}):`);
    for (const f of accepted) logFileEntry(f);
  }

  if (deferred.length > 0) {
    log(`\n🔜 Deferred (${deferred.length}):`);
    for (const f of deferred) logFileEntry(f);
  }

  if (rejected.length > 0) {
    log(`\n❌ Rejected (${rejected.length}):`);
    for (const f of rejected) logFileEntry(f);
  }

  // Show chunk review progress if chunked
  if (review.chunks && review.chunks.length > 0) {
    const reviewedChunks = review.chunks.filter((c) =>
      c.files.every((path) => {
        const entry = review.files.find((f) => f.path === path);
        return entry && entry.summary !== null;
      }),
    );
    log(`\nChunks reviewed: ${reviewedChunks.length}/${review.chunks.length}`);
  }

  log('');
  const deferredStr = deferred.length > 0 ? `, ${deferred.length} deferred` : '';
  log(
    `Summary: ${accepted.length} accepted, ${rejected.length} rejected${deferredStr}, ${pending.length} pending`,
  );
}

function parseIds(idsArg) {
  if (!idsArg) {
    log('Usage: review-accept <ids> or review-reject <ids> (comma-separated, 1-based)');
    process.exit(1);
  }
  const raw = [
    ...new Set(
      idsArg
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  const ids = raw.map(Number);
  for (const id of ids) {
    if (!Number.isInteger(id) || id < 1) {
      log(`❌ Invalid ID: ${id}. IDs are 1-based integers.`);
      process.exit(1);
    }
  }
  return ids;
}

const REVIEW_ALLOWED_STATUSES = new Set(['accepted', 'rejected', 'deferred']);

function reviewSetStatus(idsArg, targetStatus) {
  if (!REVIEW_ALLOWED_STATUSES.has(targetStatus)) {
    log(`❌ Invalid status "${targetStatus}". Use: accepted, rejected, or deferred.`);
    process.exit(1);
  }
  const review = loadReview();
  const ids = parseIds(idsArg);
  const maxId = review.files.length;
  let changed = 0;

  for (const id of ids) {
    const file = review.files.find((f) => f.id === id);
    if (!file) {
      log(`⚠️  ID ${id} not found (max: ${maxId})`);
      continue;
    }
    file.status = targetStatus;
    changed++;
  }

  if (changed > 0) {
    saveReview(review);
    log(`✅ Set ${changed} file(s) to "${targetStatus}"`);
  } else {
    log('⚠️  No files changed.');
  }

  log('');
  reviewShow();
}

function reviewAcceptAll() {
  const review = loadReview();
  for (const f of review.files) f.status = 'accepted';
  saveReview(review);
  log(`✅ Set all ${review.files.length} file(s) to "accepted"\n`);
  reviewShow();
}

function reviewRejectAll() {
  const review = loadReview();
  for (const f of review.files) f.status = 'rejected';
  saveReview(review);
  log(`✅ Set all ${review.files.length} file(s) to "rejected"\n`);
  reviewShow();
}

function reviewDeferAll() {
  const review = loadReview();
  for (const f of review.files) f.status = 'deferred';
  saveReview(review);
  log(`✅ Set all ${review.files.length} file(s) to "deferred"\n`);
  reviewShow();
}

function reviewClean() {
  let cleaned = 0;

  if (existsSync(REVIEW_PATH)) {
    unlinkSync(REVIEW_PATH);
    log('🧹 Removed .upstream-sync-review.json');
    cleaned++;
  }

  // Also clean chunk temp files and workgroups file
  const chunkTemps = getChunkTempFiles();
  for (const f of chunkTemps) {
    unlinkSync(f);
    cleaned++;
  }
  if (chunkTemps.length > 0) {
    log(`🧹 Removed ${chunkTemps.length} chunk temp file(s)`);
  }

  const workgroupsPath = '.upstream-sync-workgroups.json';
  if (existsSync(workgroupsPath)) {
    unlinkSync(workgroupsPath);
    log('🧹 Removed .upstream-sync-workgroups.json');
    cleaned++;
  }

  if (cleaned === 0) {
    log('ℹ️  Nothing to clean.');
  }
}

/**
 * Find all chunk temp files matching .upstream-sync-chunk-*-*.json
 */
function getChunkTempFiles() {
  const files = readdirSync('.');
  return files.filter((f) => CHUNK_TEMP_FILE_REGEX.test(f));
}

/**
 * Merge chunk temp files into the main review JSON.
 * Validates schema, merges findings, reports completeness.
 * Does NOT delete temp files — review-clean handles cleanup.
 */
function reviewMergeChunks() {
  const review = loadReview();
  const tempFiles = getChunkTempFiles();

  if (tempFiles.length === 0) {
    log('❌ No chunk temp files found (.upstream-sync-chunk-*-*.json)');
    process.exit(1);
  }

  // Determine expected chunks from review JSON
  const expectedChunks = review.chunks ? review.chunks.map((c) => c.id) : [];
  const receivedChunks = new Set();
  let filesUpdated = 0;
  const errors = [];

  for (const tempFile of tempFiles) {
    let tempData;
    try {
      tempData = JSON.parse(readFileSync(tempFile, 'utf-8'));
    } catch (e) {
      errors.push(`${tempFile}: invalid JSON — ${e.message}`);
      continue;
    }

    // Validate commit hash matches
    if (tempData.commit !== review.commit) {
      errors.push(
        `${tempFile}: commit mismatch (expected ${review.commit}, got ${tempData.commit})`,
      );
      continue;
    }

    // Validate chunkId
    if (!Number.isInteger(tempData.chunkId) || tempData.chunkId < 1) {
      errors.push(`${tempFile}: missing or invalid chunkId`);
      continue;
    }

    // Validate files array
    if (!Array.isArray(tempData.files)) {
      errors.push(`${tempFile}: missing files array`);
      continue;
    }

    receivedChunks.add(tempData.chunkId);

    // Merge each file entry into the main review JSON
    for (const entry of tempData.files) {
      if (!entry.path) {
        errors.push(`${tempFile}: file entry missing path`);
        continue;
      }

      const reviewFile = review.files.find((f) => f.path === entry.path);
      if (!reviewFile) {
        errors.push(`${tempFile}: path "${entry.path}" not found in review JSON`);
        continue;
      }

      // Update reviewer-provided fields only (never touch status)
      if (entry.summary !== undefined) reviewFile.summary = entry.summary;
      if (entry.context !== undefined) reviewFile.context = entry.context;
      if (entry.inFrink !== undefined) reviewFile.inFrink = entry.inFrink;
      if (entry.conflictRisk !== undefined) reviewFile.conflictRisk = entry.conflictRisk;

      filesUpdated++;
    }
  }

  // Save merged review
  saveReview(review);

  // Report errors
  if (errors.length > 0) {
    log('⚠️  Validation errors:');
    for (const e of errors) log(`   ${e}`);
    log('');
  }

  // Detect missing chunks
  const missingChunks = expectedChunks.filter((id) => !receivedChunks.has(id));
  if (missingChunks.length > 0) {
    log('❌ Missing chunks:');
    for (const chunkId of missingChunks) {
      const chunk = review.chunks.find((c) => c.id === chunkId);
      const chunkFilePaths = chunk ? chunk.files.join(', ') : '(unknown)';
      log(`   Chunk ${chunkId}: ${chunkFilePaths}`);
    }
    log('   Re-invoke reviewer for missing chunks.\n');
  }

  // Post-merge completeness validation: check for null summary/context
  const incomplete = review.files.filter((f) => f.summary === null || f.context === null);
  if (incomplete.length > 0) {
    // Group incomplete files by chunk for targeted re-invocation
    const byChunk = {};
    for (const f of incomplete) {
      const chunkId = f.chunk || 'unknown';
      if (!byChunk[chunkId]) byChunk[chunkId] = [];
      byChunk[chunkId].push(f.path);
    }
    log(`⚠️  ${incomplete.length} file(s) still have null summary/context after merge:`);
    for (const [chunkId, paths] of Object.entries(byChunk)) {
      log(`   Chunk ${chunkId}: ${paths.join(', ')}`);
    }
    log('   Re-invoke reviewer for those chunks.\n');
  }

  const total = expectedChunks.length || '?';
  const received = receivedChunks.size;
  log(
    `Merged ${received}/${total} chunks. ${filesUpdated} files updated, ${incomplete.length} files still incomplete.`,
  );
}

const DEFAULT_WORKGROUP_BUDGET = 950;

/** Shared path prefixes that should be grouped first in workgroup 1 */
const SHARED_PATH_PREFIXES = ['src/lib/', 'src/types/', 'src/constants/'];

/**
 * Group accepted files into bounded workgroups for the merger.
 * Shared dependencies go first (workgroup 1), then remaining files by line budget.
 */
function reviewWorkgroups() {
  const review = loadReview();
  const budget = parseBudgetArg(DEFAULT_WORKGROUP_BUDGET);

  const accepted = review.files.filter((f) => f.status === 'accepted');
  if (accepted.length === 0) {
    log('❌ No accepted files. Accept some files first.');
    process.exit(1);
  }

  // Check for pending files — block if any remain (deferred counts as resolved)
  const pending = review.files.filter((f) => f.status === 'pending');
  if (pending.length > 0) {
    log(
      `❌ ${pending.length} file(s) still pending. Accept, reject, or defer all before generating workgroups.`,
    );
    for (const f of pending) log(`   [${f.id}] ${f.path}`);
    process.exit(1);
  }

  // Partition: shared deps vs feature files
  const shared = [];
  const remaining = [];
  for (const f of accepted) {
    const isShared =
      SHARED_PATH_PREFIXES.some((prefix) => f.path.startsWith(prefix)) || !f.path.includes('/'); // root config files
    if (isShared) {
      shared.push(f);
    } else {
      remaining.push(f);
    }
  }

  const workgroups = [];

  // Workgroup 1: shared deps (always first so downstream workgroups have deps available)
  if (shared.length > 0) {
    const lines = shared.reduce((s, f) => s + f.additions + f.deletions, 0);
    workgroups.push({
      id: 1,
      name: 'shared-deps',
      files: shared.map((f) => f.path),
      lines,
    });
  }

  // Group remaining by line budget, soft-preferring same directory
  // Sort by directory to increase chance of co-location
  remaining.sort((a, b) => {
    const dirA = a.path.substring(0, a.path.lastIndexOf('/'));
    const dirB = b.path.substring(0, b.path.lastIndexOf('/'));
    return dirA.localeCompare(dirB);
  });

  let current = { files: [], lines: 0 };
  for (const f of remaining) {
    const fileLines = f.additions + f.deletions;
    if (current.files.length > 0 && current.lines + fileLines > budget) {
      workgroups.push({
        id: workgroups.length + 1,
        name: `group-${workgroups.length + 1}`,
        files: current.files,
        lines: current.lines,
      });
      current = { files: [], lines: 0 };
    }
    current.files.push(f.path);
    current.lines += fileLines;
  }
  if (current.files.length > 0) {
    workgroups.push({
      id: workgroups.length + 1,
      name: `group-${workgroups.length + 1}`,
      files: current.files,
      lines: current.lines,
    });
  }

  const result = {
    commit: review.commit,
    workgroups,
  };

  writeFileSync('.upstream-sync-workgroups.json', `${JSON.stringify(result, null, 2)}\n`);

  log(
    `📦 Generated ${workgroups.length} workgroup(s) from ${accepted.length} accepted files (budget: ${budget})`,
  );
  log('─'.repeat(60));
  for (const wg of workgroups) {
    log(`  Workgroup ${wg.id} (${wg.name}): ${wg.files.length} files, ${wg.lines} lines`);
  }
  log('\nInvoke merger sequentially, starting with workgroup 1.');
}

function reset() {
  const args = process.argv.slice(2);
  if (!args.includes('--confirm')) {
    log('⚠️  This will reset all sync state.');
    log('   Run with --confirm to proceed.');
    process.exit(1);
  }

  const state = loadState();
  state.skippedCommits = [];
  state.appliedCommits = [];
  state.partialCommits = [];
  saveState(state);

  log('🔄 Sync state reset. Hash preserved at:', state.lastSyncedHash.slice(0, 8));
}

// ============ MAIN ============

const args = process.argv.slice(2);
const cmd = args[0];

/** Commands that only touch sync JSON files — no upstream git clone required */
const ONECODE_OPTIONAL_COMMANDS = new Set([
  'reset',
  'review-show',
  'review-accept',
  'review-reject',
  'review-defer',
  'review-accept-all',
  'review-reject-all',
  'review-defer-all',
  'review-clean',
  'review-merge-chunks',
  'review-workgroups',
]);

if (cmd && !ONECODE_OPTIONAL_COMMANDS.has(cmd)) {
  assertOneCodeGitRepo();
}

switch (cmd) {
  case 'status':
    status();
    break;
  case 'list':
    list();
    break;
  case 'show':
    show(args[1]);
    break;
  case 'accept':
    accept(args[1]);
    break;
  case 'skip':
    skip(args[1]);
    break;
  case 'frink-delta':
    frinkDelta(args[1]);
    break;
  case 'check-size':
    checkSize(args[1]);
    break;
  case 'review-init':
    reviewInit(args[1]);
    break;
  case 'review-show':
    reviewShow();
    break;
  case 'review-accept':
    reviewSetStatus(args[1], 'accepted');
    break;
  case 'review-reject':
    reviewSetStatus(args[1], 'rejected');
    break;
  case 'review-defer':
    reviewSetStatus(args[1], 'deferred');
    break;
  case 'review-accept-all':
    reviewAcceptAll();
    break;
  case 'review-reject-all':
    reviewRejectAll();
    break;
  case 'review-defer-all':
    reviewDeferAll();
    break;
  case 'review-merge-chunks':
    reviewMergeChunks();
    break;
  case 'review-workgroups':
    reviewWorkgroups();
    break;
  case 'review-clean':
    reviewClean();
    break;
  case 'reset':
    reset();
    break;
  default:
    log('Upstream Sync Helper\n');
    log('Commands:');
    log('  status                    Current sync state');
    log('  list                      Pending commits');
    log('  show <hash> [--chunk N]   Full diff for a commit (optionally filtered by chunk)');
    log('  frink-delta <hash> [--chunk N]  Frink vs baseline diffs (optionally by chunk)');
    log('  check-size <hash>         Check commit size → Path A (standard) or Path B (chunked)');
    log('  accept <hash>             Accept and advance (--review-file for partial)');
    log('  skip <hash>               Skip and advance');
    log('  review-init <hash>        Pre-populate review JSON with files and chunks');
    log('                            Use --budget N to set lines-per-chunk (default 950)');
    log('  review-show               Show current review file status');
    log('  review-accept <ids>       Set files by ID to "accepted" (comma-separated)');
    log('  review-reject <ids>       Set files by ID to "rejected" (comma-separated)');
    log('  review-defer <ids>        Set files by ID to "deferred" (comma-separated)');
    log('  review-accept-all         Set all files to "accepted"');
    log('  review-reject-all         Set all files to "rejected"');
    log('  review-defer-all          Set all files to "deferred"');
    log('  review-merge-chunks       Merge chunk temp files into main review JSON');
    log('  review-workgroups         Group accepted files into merger workgroups');
    log('                            Use --budget N to set lines-per-workgroup (default 950)');
    log('  review-clean              Remove review + chunk temp + workgroup files');
    log('  reset --confirm           Reset sync history');
    process.exit(1);
}
