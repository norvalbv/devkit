/** Conflict-safe copying of frozen setup inputs into the private review worktree. */

import { chmodSync, copyFileSync, lstatSync, mkdirSync, readdirSync, type Stats } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { reviewRuntimeFingerprint } from '../runtime-fingerprint.mts';
import { safeReviewDestination } from '../runtime-paths.mts';

function fail(message: string): never {
  throw new Error(`devkit review: ${message}`);
}

export function reviewSetupStat(path: string): Stats | undefined {
  try {
    return lstatSync(path, { throwIfNoEntry: false });
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw cause;
  }
}

function verifyDirectory(stat: Stats, message: string): void {
  if (stat.isSymbolicLink()) fail(message);
  if (!stat.isDirectory()) fail(message);
}

/** Resolve a private destination without traversing a snapshot-controlled parent link. */
export function safeReviewSetupDestination(root: string, path: string): string {
  return safeReviewDestination(
    root,
    path,
    'private setup path escapes its worktree',
    'private setup has an unsafe destination parent',
  );
}

function ensureDirectory(root: string, path: string, created: string[]): void {
  let current = root;
  for (const segment of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, segment);
    const stat = reviewSetupStat(current);
    if (stat === undefined) {
      mkdirSync(current, { mode: 0o700 });
      created.push(current);
      continue;
    }
    verifyDirectory(
      stat,
      `private setup has an unsafe destination parent: ${relative(root, path)}`,
    );
  }
}

function destinationConflict(root: string, destination: string): never {
  return fail(`private setup conflicts with snapshot entry: ${relative(root, destination)}`);
}

function verifyMergedFile(
  source: string,
  destination: string,
  root: string,
  destinationStat: Stats,
): void {
  if (destinationStat.isSymbolicLink()) destinationConflict(root, destination);
  if (!destinationStat.isFile()) destinationConflict(root, destination);
  if (reviewRuntimeFingerprint(source) !== reviewRuntimeFingerprint(destination)) {
    destinationConflict(root, destination);
  }
}

function copyMergedFile(
  source: string,
  destination: string,
  root: string,
  created: string[],
  sourceStat: Stats,
): void {
  const destinationStat = reviewSetupStat(destination);
  ensureDirectory(root, dirname(destination), created);
  if (destinationStat !== undefined) {
    verifyMergedFile(source, destination, root, destinationStat);
    return;
  }
  copyFileSync(source, destination);
  chmodSync(destination, (sourceStat.mode & 0o111) === 0 ? 0o600 : 0o700);
  created.push(destination);
}

function ensureMergedDirectory(destination: string, root: string, created: string[]): void {
  const destinationStat = reviewSetupStat(destination);
  if (destinationStat === undefined) {
    ensureDirectory(root, destination, created);
    return;
  }
  verifyDirectory(
    destinationStat,
    `private setup conflicts with snapshot entry: ${relative(root, destination)}`,
  );
}

/** Merge setup into snapshot bytes, accepting only byte-and-mode-identical existing files. */
export function copyMergedReviewSetup(
  source: string,
  destination: string,
  root: string,
  created: string[],
): void {
  const sourceStat = lstatSync(source);
  if (sourceStat.isFile()) {
    copyMergedFile(source, destination, root, created, sourceStat);
    return;
  }
  if (!sourceStat.isDirectory()) {
    fail(`frozen setup contains an unsupported special file: ${source}`);
  }
  ensureMergedDirectory(destination, root, created);
  for (const name of readdirSync(source).sort()) {
    copyMergedReviewSetup(join(source, name), join(destination, name), root, created);
  }
}
