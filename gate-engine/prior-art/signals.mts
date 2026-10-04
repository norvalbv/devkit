import { execFileSync } from 'node:child_process';
import { extname } from 'node:path';
import { insideRoots, normalizedRoot } from '../comment-firewall/detect.mts';
import type { GuardConfig } from '../config.mts';
import { commitIndexEnv } from '../ratchets/commit-index.mts';
import { headHash, stagedFiles } from '../review/evidence/staged-git.mts';

export interface PriorArtSignal {
  kind: 'recovery_addition' | 'fix_chain';
  file: string;
  commits?: string[];
  score?: number;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: commitIndexEnv(cwd),
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 128 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/** Coarse investigation signals only; they never establish a defect or a wrong frame. */
export function collectPriorArtSignals(cwd: string, cfg: GuardConfig) {
  const roots = cfg.scanRoots.map((root) => normalizedRoot(cwd, root));
  const files = stagedFiles(cwd).filter(
    (file) => insideRoots(file, roots) && cfg.sourceExtensions.includes(extname(file).slice(1)),
  );
  if (files.length > 100)
    throw new Error('more than 100 staged source files; advisory scan skipped');
  const signals: PriorArtSignal[] = [];
  const diffs: string[] = [];
  let bytes = 0;
  for (const file of files) {
    const diff = git(cwd, [
      'diff',
      '--cached',
      '--no-ext-diff',
      '--no-textconv',
      '--unified=0',
      '--',
      `:(top,literal)${file}`,
    ]);
    bytes += Buffer.byteLength(diff);
    if (bytes > 128 * 1024) throw new Error('staged source diff exceeds 128 KiB');
    diffs.push(diff);
    if (
      diff
        .split('\n')
        .some(
          (line) =>
            line.startsWith('+') &&
            !line.startsWith('+++') &&
            /retry|reopen|restart|fallback|recovery/i.test(line),
        )
    ) {
      signals.push({ kind: 'recovery_addition', file });
    }
  }
  const diff = diffs.join('\n');
  const head = headHash(cwd);
  if (files.length && head && !head.startsWith('unborn:')) {
    const entries = git(cwd, ['log', '-12', '--format=%H%x00%s']).trim().split('\n');
    const fixes = new Map<string, { commits: string[]; score: number }>();
    for (const [index, entry] of entries.entries()) {
      const [sha, subject] = entry.split('\0');
      if (!sha || !/^fix(?:\([^()\s]+\))?!?:/i.test(subject ?? '')) continue;
      const touched = new Set(
        git(cwd, ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-z', sha]).split(
          '\0',
        ),
      );
      for (const file of files)
        if (touched.has(file)) {
          const previous = fixes.get(file) ?? { commits: [], score: 0 };
          fixes.set(file, {
            commits: [...previous.commits, sha],
            score: previous.score + (12 - index) / 12,
          });
        }
    }
    for (const [file, { commits, score }] of fixes)
      if (commits.length >= 3 && score >= 2)
        signals.push({ kind: 'fix_chain', file, commits, score });
  }
  return { signals, diff };
}
