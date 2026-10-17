/**
 * The one resolver for `research.referenceCheckouts`: declared glob patterns in, the existing
 * directories they name out. Declared-only — it never scans an undeclared sibling (W-3).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, globSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { CONFIG_FILENAME, resolveGuardConfig } from '../config.mts';
import { parsePriorArtResponse } from './response-contract.mts';

export interface ReferenceCheckouts {
  /** Non-blank glob patterns, as declared. */
  declared: string[];
  /** Absolute, real, de-duplicated directories those patterns resolve to. */
  resolved: string[];
}

interface CheckoutCounts {
  declared: number;
  resolved: number;
}

interface WorktreeRoots {
  own: Set<string>;
  counterpart: string | null;
}

export interface CheckoutsCheck {
  checkouts_check: 'match' | 'mismatch' | 'unchecked';
  checkouts_claimed?: CheckoutCounts;
  checkouts_actual?: CheckoutCounts;
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function realDir(candidate: string): string | null {
  try {
    return statSync(candidate).isDirectory() ? realpathSync(candidate) : null;
  } catch {
    return null;
  }
}

/** The main worktree's root: the first `git worktree list` entry, unless that entry is bare. */
function mainWorktreeRoot(cwd: string): string | null {
  const first = git(cwd, ['worktree', 'list', '--porcelain'])?.split('\n\n')[0]?.split('\n');
  const root = first?.find((line) => line.startsWith('worktree '))?.slice('worktree '.length);
  return root && !first?.includes('bare') ? realDir(root) : null;
}

/** Existing directories one pattern names from one base, minus the repository's own roots. */
function matchDirs(pattern: string, base: string, own: Set<string>): string[] {
  let matches: string[];
  try {
    matches = globSync(pattern, { cwd: base });
  } catch {
    return [];
  }
  return matches
    .map((match) => realDir(path.resolve(base, match)))
    .filter((dir): dir is string => dir !== null && !own.has(dir));
}

/** The repository's own roots, and cwd's same directory in the main worktree when cwd is linked. */
function worktreeRoots(cwd: string): WorktreeRoots {
  const top = realDir(git(cwd, ['rev-parse', '--show-toplevel'])?.trim() ?? '');
  const main = top && mainWorktreeRoot(cwd);
  const here = realDir(cwd);
  const own = new Set([top, main].filter((root): root is string => Boolean(root)));
  const counterpart =
    top && main && here && main !== top ? path.join(main, path.relative(top, here)) : null;
  return { own, counterpart };
}

/** cwd's roots when it lacks its git-ignored guard.config.json, so the main worktree's copy is read. */
function borrowedRoots(cwd: string): WorktreeRoots | null {
  if (existsSync(path.join(cwd, CONFIG_FILENAME))) return null;
  return git(cwd, ['check-ignore', '-q', CONFIG_FILENAME]) === null ? null : worktreeRoots(cwd);
}

/**
 * A linked worktree without its git-ignored guard.config.json reads the main worktree's, as
 * projection links it. A broken config throws: its 0 would not be an honest 0.
 */
export function resolveReferenceCheckouts(cwd: string = process.cwd()): ReferenceCheckouts {
  const borrowed = borrowedRoots(cwd);
  const base = borrowed?.counterpart ?? cwd;
  const declared = resolveGuardConfig(base).research.referenceCheckouts;
  if (!declared.length) return { declared, resolved: [] };
  const { own, counterpart } = borrowed ?? worktreeRoots(cwd);
  const retryBase = base === cwd ? counterpart : null;
  const resolved = new Set<string>();
  for (const pattern of declared) {
    const dirs = matchDirs(pattern, base, own);
    for (const dir of dirs.length || !retryBase ? dirs : matchDirs(pattern, retryBase, own))
      resolved.add(dir);
  }
  return { declared, resolved: [...resolved] };
}

/** Compare a prior-art response's self-reported local-leg counts with the resolver's. */
export function checkReferenceCheckouts(output: string, cwd?: string): CheckoutsCheck {
  const parsed = parsePriorArtResponse(output);
  const local = parsed.ok ? parsed.value.legs.find((leg) => leg.leg === 'local') : undefined;
  if (!parsed.ok || parsed.value.status !== 'reviewed' || !local)
    return { checkouts_check: 'unchecked' };
  let checkouts: ReferenceCheckouts;
  try {
    checkouts = resolveReferenceCheckouts(cwd);
  } catch {
    return { checkouts_check: 'unchecked' };
  }
  const actual = { declared: checkouts.declared.length, resolved: checkouts.resolved.length };
  const claimed = {
    declared: local.declaredCheckouts ?? 0,
    resolved: local.resolvedCheckouts ?? 0,
  };
  if (claimed.declared === actual.declared && claimed.resolved === actual.resolved)
    return { checkouts_check: 'match' };
  return { checkouts_check: 'mismatch', checkouts_claimed: claimed, checkouts_actual: actual };
}
