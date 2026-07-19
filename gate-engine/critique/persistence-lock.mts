import { createHash } from 'node:crypto';
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

type PersistenceAction = (canonicalRoot: string) => unknown;
type Synchronous<Action extends PersistenceAction> = Action &
  (unknown extends ReturnType<Action>
    ? never
    : [Extract<ReturnType<Action>, PromiseLike<unknown>>] extends [never]
      ? unknown
      : never);

function invalidRoot(): never {
  throw new Error('invalid plan critique record: $.root');
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
  if (deferredAction(action))
    throw new TypeError('plan critique evidence persistence action must be synchronous');
  const location = rootLocation(options, true) as EvidenceRootLocation;
  const existing = managedPath(location.parent, [location.basename], false);
  const canonicalRoot = existing ?? location.root;
  const digest = createHash('sha256').update(canonicalRoot).digest('hex');
  const lockPath = path.join(location.parent, `.plan-critique-${digest}.lock`);
  return withFileLock(lockPath, OPERATION, () => {
    const lockedRoot = managedPath(location.parent, [location.basename], true) as string;
    if (lockedRoot !== canonicalRoot)
      throw new Error('plan critique evidence root changed while acquiring persistence lock');
    const result = action(lockedRoot);
    if (promiseLike(result))
      throw new TypeError('plan critique evidence persistence action must be synchronous');
    return result as ReturnType<Action>;
  });
}
