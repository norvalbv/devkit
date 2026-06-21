/**
 * search-code install helper for `devkit init` — the OPT-IN wiring for the dev's own semantic
 * search-code engine (a separate, referenced tool, never vendored). devkit only drops the per-repo
 * opt-in marker + points the dup matcher at the index; the engine + its index are the consumer's.
 *
 * The engine indexes a repo IFF it finds `search-code.config.json` at the root (its opt-in gate),
 * so writing that file is what "enables search-code here" means.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CONFIG_FILE = 'search-code.config.json';
const INDEX_LINE = '.search-code/';
const INDEX_PATH = '.search-code/index.db';

// Minimal opt-in config: the engine merges this OVER its own defaults, so this is enough to opt the
// repo in. sourceRoots seeded (the engine walks the whole root by default) + left editable.
const STARTER = `{
  "indexing": {
    "sourceRoots": ["."]
  }
}
`;

const INDEXPATH_VALUE_RE = /("indexPath"\s*:\s*)(?:null|"[^"]*")/;
const OPEN_BRACE_RE = /^(\s*\{\s*\n)/;

function ensureGitignoreLine(cwd, line, dryRun) {
  const p = join(cwd, '.gitignore');
  const existing = existsSync(p) ? readFileSync(p, 'utf8') : '';
  if (existing.split('\n').some((l) => l.trim() === line)) return;
  const sep = existing && !existing.endsWith('\n') ? '\n' : '';
  const next = `${existing}${sep}${line}\n`;
  if (!dryRun) writeFileSync(p, next);
  console.log(`  ${dryRun ? '[dry-run] ensure' : '✓ ensured'} ${line} in .gitignore`);
}

// Point guard-dup's matcher at the index via guard.config.json `indexPath` (null = opted out). The
// template ships no indexPath, so insert it; an existing value is replaced. Regex (not JSON
// round-trip) preserves the //-comment guidance keys, matching the --scan-root patch in init.
function setIndexPath(cwd, dryRun) {
  const p = join(cwd, 'guard.config.json');
  if (!existsSync(p)) {
    console.log(
      '  • no guard.config.json — skipped indexPath (enable the guards to wire dup search)',
    );
    return;
  }
  const raw = readFileSync(p, 'utf8');
  let next;
  if (INDEXPATH_VALUE_RE.test(raw)) next = raw.replace(INDEXPATH_VALUE_RE, `$1"${INDEX_PATH}"`);
  else next = raw.replace(OPEN_BRACE_RE, `$1  "indexPath": "${INDEX_PATH}",\n`);
  if (next === raw) {
    console.log('  ! could not wire indexPath into guard.config.json (set it by hand)');
    return;
  }
  if (!dryRun) writeFileSync(p, next);
  console.log(`  ${dryRun ? '[dry-run] set' : '✓ set'} indexPath in guard.config.json`);
}

export function installSearchCode(cwd, dryRun) {
  console.log('  search-code (opt-in semantic search)');
  const cfgPath = join(cwd, CONFIG_FILE);
  const existed = existsSync(cfgPath);
  if (!existed && !dryRun) writeFileSync(cfgPath, STARTER);
  console.log(`  ${dryRun ? '[dry-run] write' : existed ? '• kept' : '✓ wrote'} ${CONFIG_FILE}`);
  ensureGitignoreLine(cwd, INDEX_LINE, dryRun);
  setIndexPath(cwd, dryRun);
  // The engine is REFERENCED, not vendored — print the install/index steps (devkit ships no engine).
  console.log('  ℹ needs the search-code engine + Ollama. Install once, then index this repo:');
  console.log('      bun add -g git+ssh://git@github.com/norvalbv/search-code.git');
  console.log('      search-code index');
}

// clean reversal: remove the devkit-written opt-in config. The `.search-code/` gitignore line is
// pruned by clean's pruneGitignoreLine; the index dir is the engine's data — left in place.
export function removeSearchCode(cwd, dryRun) {
  const cfgPath = join(cwd, CONFIG_FILE);
  if (!existsSync(cfgPath)) return;
  if (!dryRun) rmSync(cfgPath);
  console.log(`  ${dryRun ? '[dry-run] remove' : '✓ removed'} ${CONFIG_FILE}`);
}
