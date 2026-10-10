// The red side of the evidence: the PR base plus only the PR's test and support files, written as an
// unreferenced commit so prove-regression can check it out without any ref, branch or worktree.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { resolveGuardConfig, sourceMatchers } from '../../../../gate-engine/config.mts';
import { matchesRepoGlob } from '../../../../skills/_devkit/review-roots.mjs';
import { gitEnvironment } from '../review/shared/common.mts';

/** One `diff-tree` record. Paths stay latin1 so every byte round-trips back into Git unchanged. */
export interface ChangedPath {
  mode: string;
  oid: string;
  status: string;
  path: string;
}

export interface ClassifiedChange {
  overlay: ChangedPath[];
  tests: string[];
  docsOnly: boolean;
}

const DOCS = /\.mdx?$/i;
// A fixed identity and date make the same base and test files always produce the same red SHA.
const RED_IDENTITY = {
  GIT_AUTHOR_NAME: 'devkit evidence',
  GIT_AUTHOR_EMAIL: 'evidence@devkit.invalid',
  GIT_AUTHOR_DATE: '1970-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'devkit evidence',
  GIT_COMMITTER_EMAIL: 'evidence@devkit.invalid',
  GIT_COMMITTER_DATE: '1970-01-01T00:00:00Z',
};

function git(root: string, args: string[], env: Record<string, string> = {}, input?: Buffer) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'latin1',
    env: gitEnvironment({ GIT_LITERAL_PATHSPECS: '1', ...env }),
    input,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export const displayPath = (path: string): string => Buffer.from(path, 'latin1').toString('utf8');

export function changedPaths(root: string, base: string, head: string): ChangedPath[] {
  const fields = git(root, ['diff-tree', '-r', '-z', '--no-renames', base, head]).split('\0');
  const changes: ChangedPath[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const [, mode = '', , oid = '', status = ''] = (fields[index] ?? '').slice(1).split(' ');
    changes.push({ mode, oid, status, path: fields[index + 1] ?? '' });
  }
  return changes;
}

/** Added or modified tests drive the run; support globs only ride along onto the red tree. */
export function classifyChange(
  root: string,
  base: string,
  head: string,
  supportPaths: readonly string[],
): ClassifiedChange {
  const changes = changedPaths(root, base, head);
  const { isTest } = sourceMatchers(resolveGuardConfig(root).sourceExtensions);
  const present = changes.filter((change) => change.status !== 'D');
  const testOf = (change: ChangedPath) => isTest(basename(displayPath(change.path)));
  return {
    overlay: present.filter(
      (change) =>
        testOf(change) ||
        supportPaths.some((glob) => matchesRepoGlob(displayPath(change.path), glob)),
    ),
    tests: present.filter(testOf).map((change) => displayPath(change.path)),
    docsOnly: changes.length > 0 && changes.every((change) => DOCS.test(change.path)),
  };
}

/** Base tree plus the overlay blobs, committed on top of base; no ref is created. */
export function buildRedCommit(
  root: string,
  base: string,
  overlay: readonly ChangedPath[],
): string {
  const dir = mkdtempSync(join(tmpdir(), 'devkit-evidence-index-'));
  const index = { GIT_INDEX_FILE: join(dir, 'index') };
  try {
    git(root, ['read-tree', base], index);
    const entries = overlay.map((change) => `${change.mode} ${change.oid}\t${change.path}\0`);
    git(
      root,
      ['update-index', '-z', '--index-info'],
      index,
      Buffer.from(entries.join(''), 'latin1'),
    );
    const tree = git(root, ['write-tree'], index).trim();
    const message = 'devkit evidence: PR base plus the PR test files';
    return git(root, ['commit-tree', tree, '-p', base, '-m', message], RED_IDENTITY).trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const treeOf = (root: string, commit: string): string =>
  git(root, ['rev-parse', `${commit}^{tree}`]).trim();

/** Where the PR forked from its base branch, fetching GitHub's base tip once when it is not local. */
export function prBase(root: string, baseRefOid: string, head: string): string {
  try {
    git(root, ['cat-file', '-e', `${baseRefOid}^{commit}`]);
  } catch {
    git(root, ['fetch', '--quiet', '--no-tags', 'origin', baseRefOid]);
  }
  return git(root, ['merge-base', baseRefOid, head]).trim();
}
