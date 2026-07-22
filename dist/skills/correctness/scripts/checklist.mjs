#!/usr/bin/env node

/**
 * Correctness Review Checklist
 *
 * Checks a staged diff for correctness bug classes: state-machine integrity, concurrency/races,
 * writer/reader contracts, recovery/failure modes, classifier edge cases.
 *
 * Scope is the UNION of every declared root (scanRoots ∪ review.backendRoots ∪
 * review.frontendRoots) — correctness is not domain-sliceable: a backend writer and its
 * frontend reader are one concern. Source files only.
 *
 * Unlike the domain checklists, the four lenses are ALWAYS enumerated when any source file is
 * staged — they never regex-gate to zero. A correctness bug has no reliable lexical signature
 * ("no auth keywords → nothing to check" blindness is exactly what this reviewer exists to
 * prevent). Exactly four items, never more: each lens is a pass over the SAME diff, so item
 * count multiplies judge wall-clock — broadcast/dedup rides the contracts lens, retries and
 * discarded returns ride the recovery half of the state lens (see the brief's category text).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createChecklistStore } from '../../_devkit/checklist-store.mjs';
import {
  assertStagedSetSane,
  isNonEmptyStringArray,
  normalizeReviewRoots,
  parseInjectedReviewRoots,
  toGitPathspecs,
} from '../../_devkit/review-roots.mjs';

const CHECKLIST_PATH = '.claude/.correctness-review.json';

const RE_LEADING_DOT = /^\./;
const RE_TEST_INFIX = /\.(test|spec)\./;

// --lens <name>: ship mode runs one judge PER lens; each works a single-item checklist in its
// own lens-scoped state file so parallel judges never collide. Parsed and stripped up front so
// positional args (the command, the item name) stay stable. Must mirror the gate's
// expandPinnedForStrict stateFile/lens list (gate-engine/review/reviewers.mts).
function extractLens(argv) {
  const i = argv.indexOf('--lens');
  if (i === -1) return { lens: null, rest: argv };
  const lens = argv[i + 1];
  const known = ALL_ITEMS.map((it) => it.name);
  if (!lens || !known.includes(lens)) {
    console.error(`❌ --lens must be one of: ${known.join(', ')}`);
    process.exit(1);
  }
  return { lens, rest: [...argv.slice(0, i), ...argv.slice(i + 2)] };
}

const lensPath = (lens) => (lens ? `.claude/.correctness-review-${lens}.json` : CHECKLIST_PATH);

const log = console.log;

// Union of declared roots — from guard.config.json (NOT hardcoded), so the checklist scopes to
// ANY repo's layout. No/unreadable config or no declared roots → all staged files (the gate
// never silently no-ops). A PRESENT but invalid value warns loudly and is ignored (the other
// roots still count), rather than crashing the git call into an empty pass-through.
function unionRoots() {
  // Injected roots are read BEFORE the config, and the config's failure paths fall through to `{}`
  // rather than returning early. A review run carries its effective topology in the environment; the
  // old order returned `['.']` the moment guard.config.json was missing or malformed, discarding an
  // explicit injected scope and silently widening the reviewer to every staged file. The env is the
  // more authoritative source here, so it must not be gated behind the less authoritative one.
  // (resolveReviewRoots in _devkit/review-roots.mjs already orders it this way — this is the local
  // union catching up to the shared helper.)
  const injectedBackend = parseInjectedReviewRoots('DEVKIT_REVIEW_BACKEND_ROOTS');
  const injectedFrontend = parseInjectedReviewRoots('DEVKIT_REVIEW_FRONTEND_ROOTS');
  let c;
  try {
    c = JSON.parse(readFileSync('guard.config.json', 'utf-8'));
  } catch {
    c = {};
  }
  if (!c || typeof c !== 'object') c = {};
  const review = typeof c.review === 'object' && c.review !== null ? c.review : {};
  const backend = injectedBackend ?? review.backendRoots;
  const frontend = injectedFrontend ?? review.frontendRoots;
  const roots = new Set();
  for (const [label, value] of [
    ['scanRoots', c.scanRoots],
    ['review.backendRoots', backend],
    ['review.frontendRoots', frontend],
  ]) {
    if (value === undefined) continue;
    let normalized;
    try {
      normalized = normalizeReviewRoots(value, label);
    } catch {
      console.error(
        `⚠️  correctness: ignoring invalid \`${label}\` in guard.config.json (expected an array of non-empty strings).`,
      );
      continue;
    }
    for (const root of normalized) roots.add(root);
  }
  return roots.size > 0 ? [...roots] : ['.'];
}

// Source extensions from guard.config.json (default ts/tsx, mirroring the gate's sourceMatchers).
function sourceExtensions() {
  try {
    const c = JSON.parse(readFileSync('guard.config.json', 'utf-8'));
    if (isNonEmptyStringArray(c?.sourceExtensions)) return c.sourceExtensions;
  } catch {
    /* defaults stand */
  }
  return ['ts', 'tsx'];
}

function getStagedFiles() {
  const pathspecs = toGitPathspecs(unionRoots());
  try {
    const output = execFileSync(
      'git',
      ['diff', '--cached', '--name-only', '--diff-filter=ACM', '--', ...pathspecs],
      { encoding: 'utf-8' },
    );
    // ACM hides deletions, so an all-deletions index reads as "nothing staged" here. Never report
    // that as zero items — a reviewer that examined nothing must not read as a pass.
    if (!output.trim()) assertStagedSetSane(pathspecs, 'correctness');
    const exts = sourceExtensions().map((e) => `.${e.replace(RE_LEADING_DOT, '')}`);
    return output
      .trim()
      .split('\n')
      .filter(
        (f) =>
          f.length > 0 &&
          exts.some((x) => f.endsWith(x)) &&
          // impl files only — test hunks can't introduce runtime defects, and excluding them
          // keeps the single opus pass inside its timeout (mirror of the gate's selection)
          !RE_TEST_INFIX.test(f),
      );
  } catch (e) {
    // A git FAILURE (not-a-repo, corrupt index, bad plumbing) must never masquerade as "nothing
    // staged" — that would send generate() down its clean skip/exit(0) path and wave the commit
    // through unreviewed. `git diff --cached` with no matches exits 0 (empty stdout), so reaching
    // this catch is a real failure: surface it loudly and non-zero.
    console.error(`❌ correctness: \`git diff --cached\` failed — ${e.message ?? e}`);
    process.exit(1);
  }
}

// The four lenses: ALWAYS on (whole-brief mode), never more. See module header.
const ALL_ITEMS = [
  { name: 'state-transitions', category: 'State, Recovery & Failure Modes' },
  { name: 'concurrency-races', category: 'Temporal & Concurrency' },
  { name: 'writer-reader-contracts', category: 'Contract, Boundary & Broadcast' },
  { name: 'error-and-edge-classification', category: 'Classifier & Parsing' },
];

function detectCorrectnessItems(lens) {
  return ALL_ITEMS.filter((it) => !lens || it.name === lens).map((it) => ({
    ...it,
    status: 'pending',
    issues: [],
  }));
}

// Set once at dispatch from --lens; every command reads/writes this path.
let ACTIVE_PATH = CHECKLIST_PATH;

const store = createChecklistStore({
  path: () => ACTIVE_PATH,
  label: 'Correctness',
  log,
});
const { save: saveChecklist, status, checkItem, finalize, cleanup } = store;

function generate(lens) {
  const stagedFiles = getStagedFiles();
  if (stagedFiles.length === 0) {
    log('⏭️  No staged source files under the declared roots. Skipping correctness review.');
    process.exit(0);
  }
  const items = detectCorrectnessItems(lens);
  const data = { generated: new Date().toISOString(), files: stagedFiles, items };
  saveChecklist(data);
  log(
    `✅ Correctness${lens ? ` [${lens}]` : ''}: ${stagedFiles.length} files, ${items.length} checks`,
  );
  log('');
  log('Items to review:');
  for (const item of items) log(`  - [${item.category}] ${item.name}`);
}

const { lens, rest } = extractLens(process.argv.slice(2));
ACTIVE_PATH = lensPath(lens);
const args = rest;
const cmd = args[0];
switch (cmd) {
  case 'generate':
    generate(lens);
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
      log('Usage: check-item [--lens <lens>] <name> --pass OR --fail "reason"');
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
    log('Correctness Review Commands (all accept --lens <lens> for a single-lens run):');
    log('  generate                    Create checklist');
    log('  status                      Show progress');
    log('  check-item <name> --pass    Mark passed');
    log('  check-item <name> --fail    Mark failed');
    log('  finalize                    Verify every item was resolved');
    log('  cleanup                     Remove checklist');
    process.exit(1);
}
