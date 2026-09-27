import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { withFileLock } from './gitignore-cache.mts';

const EXCLUDE_HEADER = '# devkit overlay (local-only) — not committed';
const AGENT_ASSET_RE =
  /^\.(?:(?:claude|cursor)\/(?:skills|agents|hooks)(?:\/|$)|agents\/skills(?:\/|$)|codex\/(?:agents|hooks)(?:\/|$)|(?:cursor|codex)\/hooks\.json$)/;
const CLAUDE_LOCAL_SETTINGS_RE = /^\.claude\/settings\.local\.json$/;
const AGENT_MANIFEST_RE =
  /^\.devkit\/(?:skills|agents|agent-hooks|agent-hook-registrations)-manifest\.json$/;
// Every line devkit has ever added; agent-half + fallow entries are prefix-tolerant (`(.*\/)?`) so
// a monorepo `pkgRel/`-scoped line is pruned too — a miss orphans it.
const DEVKIT_EXCLUDE_LINE =
  /^(# devkit overlay|\.devkit\/|.*\/\.devkit\/|.*guard\.config\.json|.*biome\.devkit\.jsonc|.*eslint\.config\.devkit\.mjs|.*eslint\/baselines\/|(.*\/)?\.claude\/(skills|agents|hooks)\/|(.*\/)?\.agents\/skills\/|(.*\/)?\.codex\/(agents|hooks)\/|(.*\/)?\.(cursor|codex)\/hooks\.json|(.*\/)?\.cursor\/(skills|agents|hooks)\/|(.*\/)?\.claude\/settings\.local\.json|(.*\/)?\.fallow\/|(.*\/)?fallow-baselines\/|(.*\/)?oxlint\.devkit\.json$|(.*\/)?\.anti-slop-baseline\.json$)/;
const BLANK_RUN_RE = /\n{3,}/g;
const LEADING_BLANKS_RE = /^\n+/;

const isManagedAgentPath = (line: string) =>
  AGENT_ASSET_RE.test(line) || CLAUDE_LOCAL_SETTINGS_RE.test(line) || AGENT_MANIFEST_RE.test(line);

/** The exclude file git actually reads for `gitRoot`. A linked worktree's `.git` is a FILE and its
 * exclude lives under the shared common dir, so ask git; outside a repo, fall back to the plain path. */
export function gitExcludeFile(gitRoot: string): string {
  try {
    return execFileSync(
      'git',
      ['-C', gitRoot, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
  } catch {
    return join(gitRoot, '.git', 'info', 'exclude');
  }
}

/** Other checkouts of this clone with a live overlay: every overlay install (`--no-husky` too) writes
 * `.devkit/hooks/pre-commit`. All read ONE exclude file, so no line goes while one still needs it. */
export function siblingOverlayCheckouts(gitRoot: string): string[] {
  let listing: string;
  try {
    listing = execFileSync('git', ['-C', gitRoot, 'worktree', 'list', '--porcelain', '-z'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return [];
  }
  const self = realpathSync(gitRoot);
  return listing
    .split('\0')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
    .filter(
      (path) =>
        existsSync(join(path, '.devkit', 'hooks', 'pre-commit')) && realpathSync(path) !== self,
    );
}

/** Exact-reconcile Devkit's agent paths after its local-only exclude marker. Every checkout of the
 * clone rewrites the same file, so the read-modify-write holds a lock beside it. */
export function addToGitExclude(gitRoot: string, relPaths: string[], dryRun: boolean) {
  const file = gitExcludeFile(gitRoot);
  if (dryRun) {
    reconcileExclude(gitRoot, file, relPaths, true);
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  withFileLock(`${file}.devkit.lock`, () => reconcileExclude(gitRoot, file, relPaths, false));
}

function reconcileExclude(gitRoot: string, file: string, relPaths: string[], dryRun: boolean) {
  // Decided under the lock: a path deselected here may still be live in a sibling's overlay.
  const prune = siblingOverlayCheckouts(gitRoot).length === 0;
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const lines = existing.split('\n');
  const desired = new Set(relPaths);
  const headerAt = lines.indexOf(EXCLUDE_HEADER);
  const kept = lines.filter(
    (line, index) =>
      !(
        prune &&
        headerAt !== -1 &&
        index > headerAt &&
        isManagedAgentPath(line) &&
        !desired.has(line)
      ),
  );
  const pruned = kept.length !== lines.length;
  const missing = relPaths.filter((path) => !kept.includes(path));
  if (!missing.length && !pruned) {
    console.log('  • .git/info/exclude already covers devkit files');
    return;
  }
  if (dryRun) {
    console.log(
      `  [dry-run] reconcile .git/info/exclude${missing.length ? `: add ${missing.join(', ')}` : ''}`,
    );
    return;
  }
  const reconciled = kept.join('\n');
  const header = reconciled.includes(EXCLUDE_HEADER) ? '' : `\n${EXCLUDE_HEADER}\n`;
  const separator = reconciled && !reconciled.endsWith('\n') ? '\n' : '';
  writeFileSync(
    file,
    `${reconciled}${separator}${header}${missing.join('\n')}${missing.length ? '\n' : ''}`,
  );
  console.log('  ✓ reconciled local agent paths in .git/info/exclude');
}

/** Drop devkit's lines (+ its header) from the exclude, leaving the user's own ignores — unless a
 * sibling checkout's overlay still relies on them. */
export function pruneGitExclude(gitRoot: string, dryRun: boolean): void {
  const file = gitExcludeFile(gitRoot);
  if (!existsSync(file)) return;
  if (dryRun) {
    pruneExcludeLines(gitRoot, file, true);
    return;
  }
  withFileLock(`${file}.devkit.lock`, () => pruneExcludeLines(gitRoot, file, false));
}

function pruneExcludeLines(gitRoot: string, file: string, dryRun: boolean) {
  const next = withoutDevkitLines(readFileSync(file, 'utf8'));
  if (next === null) return;
  // Decided under the lock, so a sibling installing meanwhile is seen before its lines are dropped.
  const siblings = siblingOverlayCheckouts(gitRoot);
  if (siblings.length) {
    console.log(
      `  • kept devkit lines in the shared .git/info/exclude — still used by ${siblings.join(', ')}`,
    );
    return;
  }
  if (dryRun) {
    console.log('  [dry-run] prune devkit lines from .git/info/exclude');
    return;
  }
  writeFileSync(file, next);
  console.log('  ✓ pruned devkit lines from .git/info/exclude');
}

/** Does the exclude carry a devkit overlay block that no other checkout of the clone accounts for? */
export function hasOrphanExcludeBlock(gitRoot: string): boolean {
  const file = gitExcludeFile(gitRoot);
  return (
    existsSync(file) &&
    readFileSync(file, 'utf8').includes('# devkit overlay') &&
    siblingOverlayCheckouts(gitRoot).length === 0
  );
}

function withoutDevkitLines(text: string): string | null {
  const lines = text.split('\n');
  const kept = lines.filter((line) => !DEVKIT_EXCLUDE_LINE.test(line));
  if (kept.length === lines.length) return null;
  return kept.join('\n').replace(BLANK_RUN_RE, '\n\n').replace(LEADING_BLANKS_RE, '');
}
