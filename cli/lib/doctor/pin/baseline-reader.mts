/** sc-1934: can the INSTALLED devkit (the one husky runs) read `.devkit/baselines`?
 * Why: decisions/ratchets-blame-the-change-not-the-tree.md, 2026-09-27 note. */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  legacyDevkitBaselines,
  reportRatchetBaselineMigration,
} from '../../../../gate-engine/ratchets/baseline-paths.mts';
import { cmpSemver } from '../../../commands/update.mts';
import { detectGitRoot } from '../../detect-git-root.mts';
import { type CheckResult, check } from '../check-result.mts';
import { installedAt, type RunnerConfig, readConfig } from './runner-identity.mts';

/** The first release whose ratchets read `.devkit/baselines` (c5073b83 is not in v0.52.0). */
export const CANONICAL_BASELINE_READER_FLOOR = '0.53.0';

export const BASELINE_READER_REMEDIATION = `run \`devkit upgrade\` (re-pins and installs @norvalbv/devkit ≥ ${CANONICAL_BASELINE_READER_FLOOR})`;

const SEMVER = /^\d+\.\d+\.\d+$/;

export type BaselineReader = { stale: true; installed: string } | { stale: false };

/** `installedAt` throws on a corrupt manifest; here that is an unknown version, never a crash. */
function installedVersion(cwd: string): string | undefined {
  try {
    return installedAt(cwd).version;
  } catch {
    return undefined;
  }
}

/** Installed devkit below the floor? Never for self-host/overlay; `installed` skips the lookup. */
export function stalePinnedBaselineReader(
  cwd: string,
  installed: string | undefined = installedVersion(cwd),
  cfg: RunnerConfig = readConfig(cwd),
): BaselineReader {
  if (cfg.selfHost || cfg.overlay) return { stale: false };
  if (installed === undefined || !SEMVER.test(installed)) return { stale: false };
  return cmpSemver(installed, CANONICAL_BASELINE_READER_FLOOR) < 0
    ? { stale: true, installed }
    : { stale: false };
}

/**
 * The canonical baselines a legacy-only reader would miss: present under `.devkit/`, with no legacy
 * copy for the old reader to fall back on. A pair where both exist is still readable by it.
 */
export function canonicalOnlyRatchetBaselines(root: string): string[] {
  return legacyDevkitBaselines(root)
    .filter(({ from, to }) => existsSync(join(root, to)) && !existsSync(join(root, from)))
    .map(({ to }) => to);
}

/** Every devkit package dir in the repo: the root, `extra`, and each tracked `.devkit/config.json`. */
function packageDirs(gitRoot: string, extra: string[]): string[] {
  const dirs = new Set(['', ...extra]);
  try {
    const listed = execFileSync(
      'git',
      ['-C', gitRoot, 'ls-files', '-z', '--', ':(glob)**/.devkit/config.json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    for (const path of listed.split('\0').filter(Boolean)) {
      const pkg = dirname(dirname(path));
      dirs.add(pkg === '.' ? '' : pkg);
    }
  } catch {
    // Not a git checkout: the root (and `extra`) is all there is to scan.
  }
  return [...dirs].sort();
}

/** `canonicalOnlyRatchetBaselines` across every package of a (mono)repo, as repo-relative paths. */
export function canonicalOnlyRatchetBaselinesInRepo(
  gitRoot: string,
  extra: string[] = [],
): string[] {
  return packageDirs(gitRoot, extra).flatMap((pkg) =>
    canonicalOnlyRatchetBaselines(join(gitRoot, pkg)).map((rel) => (pkg ? `${pkg}/${rel}` : rel)),
  );
}

/** Both halves at once: the reader is too old AND there is state it cannot see. */
export function baselineReaderMismatch(
  cwd: string,
  installed?: string,
  cfg?: RunnerConfig,
): { installed: string; unread: string[] } | null {
  const reader = stalePinnedBaselineReader(cwd, installed ?? installedVersion(cwd), cfg);
  if (!reader.stale) return null;
  const { gitRoot, pkgRel } = detectGitRoot(cwd);
  const unread = canonicalOnlyRatchetBaselinesInRepo(gitRoot, pkgRel ? [pkgRel] : []);
  return unread.length > 0 ? { installed: reader.installed, unread } : null;
}

export function describeBaselineReaderMismatch(installed: string, unread: string[]): string {
  return `installed devkit ${installed} predates ${CANONICAL_BASELINE_READER_FLOOR} and reads only eslint/baselines, so it cannot see ${unread.join(', ')} — every grandfathered entry reads as new`;
}

/** The package-mode doctor row. Not `fixable`: the repair is an install, which --fix does not do. */
export function baselineReaderCheck(root: string): CheckResult | null {
  const mismatch = baselineReaderMismatch(root);
  if (!mismatch) return null;
  return check(
    'ratchet baseline reader',
    'DRIFT',
    describeBaselineReaderMismatch(mismatch.installed, mismatch.unread),
    BASELINE_READER_REMEDIATION,
  );
}

/** init's baseline step: skip the move under a pre-floor reader, whose freeze it would blank. */
export function reportBaselineStorage(cwd: string, dryRun: boolean): void {
  const reader = stalePinnedBaselineReader(cwd);
  if (!reader.stale) {
    reportRatchetBaselineMigration(cwd, dryRun);
    return;
  }
  console.log(
    `0. devkit baseline storage — left in eslint/baselines: pinned devkit ${reader.installed} cannot read .devkit/baselines; ${BASELINE_READER_REMEDIATION}\n`,
  );
}
