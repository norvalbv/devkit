import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { withFileLock } from '../eval/publish-lock.mts';
import { managedParentPath, managedPath } from './immutable-file.mts';

const DEFAULT_ROOT = ['.devkit', 'evidence', 'plan-critiques', 'v1'] as const;
const DEFAULT_PARENT = DEFAULT_ROOT.slice(0, -1);
const OPERATION = 'plan critique evidence persistence';

interface EvidenceRootLocation {
  basename: string;
  parent: string;
  root: string;
}

interface EvidenceRootIdentity {
  device: bigint;
  inode: bigint;
}

type PersistenceAction = (canonicalRoot: string) => unknown;
type Synchronous<Action extends PersistenceAction> = Action &
  (unknown extends ReturnType<Action>
    ? never
    : [Extract<ReturnType<Action>, PromiseLike<unknown>>] extends [never]
      ? unknown
      : never);

export type ExistingPlanCritiquePersistenceLockResult<Value> =
  | { status: 'absent' }
  | { status: 'locked'; value: Value };

function invalidRoot(): never {
  throw new Error('invalid plan critique record: $.root');
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function rootLocation(
  options: { root?: string },
  createDefaultParent: boolean,
): EvidenceRootLocation | null {
  if (options.root === undefined) {
    const parent = managedParentPath(homedir(), DEFAULT_PARENT, createDefaultParent);
    return parent ? { basename: 'v1', parent, root: path.join(parent, 'v1') } : null;
  }
  if (typeof options.root !== 'string' || !options.root || !path.isAbsolute(options.root))
    invalidRoot();
  const requested = path.normalize(options.root);
  const basename = path.basename(requested);
  if (!basename) invalidRoot();
  const parent = managedParentPath(path.dirname(requested), [], false) as string;
  return { basename, parent, root: path.join(parent, basename) };
}

function promiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    ((typeof value === 'object' && value !== null) || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function deferredAction(action: PersistenceAction): boolean {
  const name = Object.getPrototypeOf(action)?.constructor?.name;
  return (
    name === 'AsyncFunction' || name === 'GeneratorFunction' || name === 'AsyncGeneratorFunction'
  );
}

function assertSynchronousAction(action: PersistenceAction): void {
  if (deferredAction(action))
    throw new TypeError('plan critique evidence persistence action must be synchronous');
}

function runSynchronousAction<Action extends PersistenceAction>(
  action: Action,
  canonicalRoot: string,
): ReturnType<Action> {
  const result = action(canonicalRoot);
  if (promiseLike(result))
    throw new TypeError('plan critique evidence persistence action must be synchronous');
  return result as ReturnType<Action>;
}

function persistenceLockPath(location: EvidenceRootLocation, canonicalRoot: string): string {
  const digest = createHash('sha256').update(canonicalRoot).digest('hex');
  return path.join(location.parent, `.plan-critique-${digest}.lock`);
}

function rootIdentity(root: string): EvidenceRootIdentity | null {
  try {
    const stat = lstatSync(root, { bigint: true });
    return { device: stat.dev, inode: stat.ino };
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

function sameRootIdentity(left: EvidenceRootIdentity, right: EvidenceRootIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function existingRoot(location: EvidenceRootLocation): string | null {
  try {
    return managedPath(location.parent, [location.basename], false);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

/** Resolve the evidence root through the private managed-path boundary. */
export function resolvePlanCritiqueEvidenceRoot(
  options: { root?: string },
  create: boolean,
): string | null {
  const location = rootLocation(options, create);
  return location && managedPath(location.parent, [location.basename], create);
}

/** Serialize synchronous evidence writers and cleanup against one canonical root identity. */
export function withPlanCritiquePersistenceLock<Action extends PersistenceAction>(
  options: { root?: string },
  action: Synchronous<Action>,
): ReturnType<Action> {
  assertSynchronousAction(action);
  const location = rootLocation(options, true) as EvidenceRootLocation;
  const existing = managedPath(location.parent, [location.basename], false);
  const canonicalRoot = existing ?? location.root;
  const lockPath = persistenceLockPath(location, canonicalRoot);
  return withFileLock(lockPath, OPERATION, () => {
    const lockedRoot = managedPath(location.parent, [location.basename], true) as string;
    if (lockedRoot !== canonicalRoot)
      throw new Error('plan critique evidence root changed while acquiring persistence lock');
    return runSynchronousAction(action, lockedRoot);
  });
}

/** Lock an existing evidence root without creating any missing evidence directories. */
export function withExistingPlanCritiquePersistenceLock<Action extends PersistenceAction>(
  options: { root?: string },
  action: Synchronous<Action>,
): ExistingPlanCritiquePersistenceLockResult<ReturnType<Action>> {
  assertSynchronousAction(action);
  let location: EvidenceRootLocation | null;
  try {
    location = rootLocation(options, false);
  } catch (error) {
    if (missing(error)) return { status: 'absent' };
    throw error;
  }
  if (!location) return { status: 'absent' };
  const canonicalRoot = existingRoot(location);
  if (!canonicalRoot) return { status: 'absent' };
  const identity = rootIdentity(canonicalRoot);
  if (!identity) return { status: 'absent' };
  const lockPath = persistenceLockPath(location, canonicalRoot);
  let lockActionEntered = false;
  try {
    return withFileLock(
      lockPath,
      OPERATION,
      () => {
        lockActionEntered = true;
        const lockedRoot = existingRoot(location);
        if (!lockedRoot) return { status: 'absent' };
        const lockedIdentity = rootIdentity(lockedRoot);
        if (!lockedIdentity) return { status: 'absent' };
        if (lockedRoot !== canonicalRoot || !sameRootIdentity(identity, lockedIdentity))
          throw new Error('plan critique evidence root changed while acquiring persistence lock');
        return { status: 'locked', value: runSynchronousAction(action, lockedRoot) };
      },
      { createParent: false },
    );
  } catch (error) {
    if (!lockActionEntered) {
      try {
        if (!existingRoot(location)) return { status: 'absent' };
      } catch {}
    }
    throw error;
  }
}
