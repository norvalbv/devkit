/**
 * search-code install helper for `devkit init` — the OPT-IN wiring for the dev's own semantic
 * search-code engine (a separate, referenced tool, never vendored). devkit only drops the per-repo
 * opt-in marker + points the dup matcher at the index; the engine + its index are the consumer's.
 *
 * The engine indexes a repo IFF it finds `search-code.config.json` at the root (its opt-in gate),
 * so writing that file is what "enables search-code here" means.
 */
import { appendFileSync, existsSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  indexToInspect,
  usableChunksAt,
} from '../../../gate-engine/co-occurrence/index-refresh.mts';
import { withGitignoreLock } from './gitignore-cache.mts';
import { writeFileAtomic } from '../atomic-write.mts';
import { type CheckResult, check } from '../doctor/check-result.mts';
import { readJson, writeIfAbsent } from '../fs-helpers.mts';

export const SEARCH_CODE_CONFIG = 'search-code.config.json';
const INDEX_LINE = '.search-code/';
const INDEX_PATH = '.search-code/index.db';
/** What an overlay install git-excludes instead of writing the tracked `.gitignore`. */
export const SEARCH_CODE_WRITTEN = [
  { path: SEARCH_CODE_CONFIG, kind: 'file' },
  { path: '.search-code', kind: 'dir' },
] as const;

// Minimal opt-in config: the engine merges this OVER its own defaults, so this is enough to opt the
// repo in. sourceRoots seeded (the engine walks the whole root by default) + left editable.
const STARTER = `{
  "indexing": {
    "sourceRoots": ["."]
  }
}
`;

const INDEXPATH_UNSET_RE = /("indexPath"\s*:\s*)(?:null|"\s*")/;
const INDEXPATH_SET_RE = /"indexPath"\s*:\s*"\s*[^"\s][^"]*"/;
const OPEN_BRACE_RE = /^(\s*\{\s*\n)/;
// The real key only: a `"//indexCommand"` guidance key has a slash before the `i`, not a quote.
const INDEXCOMMAND_KEY_RE = /"indexCommand"\s*:/;
/** Refreshes the index before each dup scan, so an edited function is re-judged rather than dropped.
 * search-code's own --timeout stays under the gate's 60 s indexCommandTimeoutMs kill. */
export const DEFAULT_INDEX_COMMAND =
  'search-code index --timeout 45s --no-wait --seed-files {staged-csv}';

// Append, never rewrite: an edit landing after the read survives, and the lock keeps devkit's own
// whole-file .gitignore rewriters (cache ensure, prune, repair) from overwriting the append.
function ensureGitignoreLine(cwd: string, line: string, dryRun: boolean): void {
  if (dryRun) appendMissingLine(cwd, line, true);
  else withGitignoreLock(cwd, () => appendMissingLine(cwd, line, false));
}

function appendMissingLine(cwd: string, line: string, dryRun: boolean): void {
  const p = join(cwd, '.gitignore');
  const existing = existsSync(p) ? readFileSync(p, 'utf8') : '';
  if (existing.split('\n').some((l) => l.trim() === line)) return;
  const sep = existing && !existing.endsWith('\n') ? '\n' : '';
  if (!dryRun) appendFileSync(p, `${sep}${line}\n`);
  console.log(`  ${dryRun ? '[dry-run] ensure' : '✓ ensured'} ${line} in .gitignore`);
}

// Point guard-dup's matcher at the index via guard.config.json `indexPath` (null = opted out). The
// template ships no indexPath, so insert it; a null or blank is replaced and a configured path kept. Regex
// (not JSON round-trip) preserves the //-comment guidance keys, matching the --scan-root patch in init.
function wireIndex(cwd: string, dryRun: boolean): void {
  const p = join(cwd, 'guard.config.json');
  if (!existsSync(p)) {
    console.log(
      '  • no guard.config.json — skipped indexPath (enable the guards to wire dup search)',
    );
    return;
  }
  const raw = readFileSync(p, 'utf8');
  const keptPath = INDEXPATH_SET_RE.test(raw);
  let next: string;
  if (keptPath) next = raw;
  else if (INDEXPATH_UNSET_RE.test(raw))
    next = raw.replace(INDEXPATH_UNSET_RE, `$1"${INDEX_PATH}"`);
  else if (OPEN_BRACE_RE.test(raw))
    next = raw.replace(OPEN_BRACE_RE, `$1  "indexPath": "${INDEX_PATH}",\n`);
  else {
    console.log('  ! could not wire indexPath into guard.config.json (set it by hand)');
    return;
  }
  // Any existing indexCommand, null included, is the consumer's call and stays as written.
  const keptCommand = INDEXCOMMAND_KEY_RE.test(next);
  const insertable = OPEN_BRACE_RE.test(next);
  if (!keptCommand && insertable)
    next = next.replace(OPEN_BRACE_RE, `$1  "indexCommand": "${DEFAULT_INDEX_COMMAND}",\n`);
  // Through a symlinked config to its target, keeping that file's mode.
  const target = realpathSync(p);
  if (!dryRun && next !== raw) writeFileAtomic(target, next, statSync(target).mode & 0o777);
  const verb = dryRun ? '[dry-run] set' : '✓ set';
  console.log(
    keptPath
      ? '  • kept indexPath in guard.config.json'
      : `  ${verb} indexPath in guard.config.json`,
  );
  if (keptCommand) console.log('  • kept indexCommand in guard.config.json');
  else if (insertable) console.log(`  ${verb} indexCommand in guard.config.json`);
  else
    console.log(`  ! could not wire indexCommand — add "indexCommand": "${DEFAULT_INDEX_COMMAND}"`);
}

/** An `overlay` install edits no tracked file: its caller git-excludes SEARCH_CODE_WRITTEN instead of
 * the `.gitignore` line, and a guard.config.json git tracks keeps its bytes. */
export function installSearchCode(
  cwd: string,
  dryRun: boolean,
  overlay?: { configTracked: boolean },
): void {
  console.log('  search-code (opt-in semantic search)');
  const cfgPath = join(cwd, SEARCH_CODE_CONFIG);
  const existed = !dryRun && writeIfAbsent(cfgPath, STARTER) === 'exists';
  console.log(
    `  ${dryRun ? '[dry-run] write' : existed ? '• kept' : '✓ wrote'} ${SEARCH_CODE_CONFIG}`,
  );
  if (!overlay) ensureGitignoreLine(cwd, INDEX_LINE, dryRun);
  if (overlay?.configTracked)
    console.log(
      `  ! guard.config.json is tracked, so overlay leaves it as is — export GUARD_INDEX_PATH=${INDEX_PATH} GUARD_INDEX_COMMAND='${DEFAULT_INDEX_COMMAND}' to wire the dup matcher`,
    );
  else wireIndex(cwd, dryRun);
  // The engine is REFERENCED, not vendored — print the install/index steps (devkit ships no engine).
  console.log('  ℹ needs the search-code engine + Ollama. Install once, then index this repo:');
  console.log('      bun add -g git+ssh://git@github.com/norvalbv/search-code.git');
  console.log('      search-code index');
}

// clean reversal: remove the devkit-written opt-in config. The `.search-code/` gitignore line is
// pruned by clean's pruneGitignoreLine; the index dir is the engine's data — left in place.
export function removeSearchCode(cwd: string, dryRun: boolean): void {
  const cfgPath = join(cwd, SEARCH_CODE_CONFIG);
  if (!existsSync(cfgPath)) return;
  if (!dryRun) rmSync(cfgPath);
  console.log(`  ${dryRun ? '[dry-run] remove' : '✓ removed'} ${SEARCH_CODE_CONFIG}`);
}

export const INDEX_REFRESH_CHECK = 'search-code refresh';

/** Does guard.config.json literally carry `key`? resolveGuardConfig reads an explicit null (a declared
 * opt-out) and an absent key alike, so only the raw file tells them apart. */
export function guardConfigKeyPresent(cwd: string, key: string): boolean {
  try {
    const raw = readJson<object>(join(cwd, 'guard.config.json'));
    return raw !== null && key in raw;
  } catch {
    // Unparseable is already reported by the validity check; never read a declared opt-out from it.
    return false;
  }
}

/** doctor's advisory for a populated index with no indexCommand, whose edited functions the dup gate
 * drops as stale. Silent on an empty index: a refresh there is a cold build on every commit.
 * `fixable` only where --fix's re-run of init --search-code can add it: search-code is the recorded
 * selection and the config is not on one line (the insert needs a newline after `{`). */
export function indexCommandRows(
  cwd: string,
  indexPath: string | null,
  indexCommand: string | null | undefined,
  searchCodeSelected: boolean,
): CheckResult[] {
  if (!indexPath || indexCommand || guardConfigKeyPresent(cwd, 'indexCommand')) return [];
  if (!usableChunksAt(indexToInspect(indexPath, cwd).indexPath)) return [];
  return [
    check(
      INDEX_REFRESH_CHECK,
      'DRIFT',
      'guard.config.json sets no `indexCommand`, so the dup gate never refreshes the index: a function edited since the last index is dropped from its flagged pair as stale instead of re-judged',
      `add "indexCommand": "${DEFAULT_INDEX_COMMAND}" to guard.config.json (or export GUARD_INDEX_COMMAND). Deliberate? Write "indexCommand": null to declare it.`,
      searchCodeSelected &&
        OPEN_BRACE_RE.test(readFileSync(join(cwd, 'guard.config.json'), 'utf8')),
      true,
    ),
  ];
}
