import { types as utilTypes } from 'node:util';
import {
  canonicalPlanCritiqueRecordJson,
  PLAN_CRITIQUE_PROVIDERS,
  type PlanCritiqueProvider,
  sha256Bytes,
} from '../evidence-record.mts';
import { managedPath, publishImmutable, readPrivateFileBounded } from '../immutable-file.mts';
import {
  resolvePlanCritiqueEvidenceRoot,
  withPlanCritiquePersistenceLock,
} from '../persistence-lock.mts';

const SHA256 = /^[0-9a-f]{64}$/;
const MAX_TEXT_BYTES = 4 * 1024;
const QUARANTINE_PATH = ['work-quarantines'] as const;

export interface PlanCritiqueWorkQuarantineV1 {
  schemaVersion: 1;
  kind: 'plan_critique_work_quarantine';
  provider: PlanCritiqueProvider;
  repositoryFingerprint: string;
  workId: string;
  reason: 'hook_continuation';
}

export type PlanCritiqueWorkQuarantineStateV1 =
  | { status: 'clear' }
  | { status: 'quarantined'; quarantine: PlanCritiqueWorkQuarantineV1 }
  | { status: 'unavailable'; reason: 'malformed_quarantine' };

export type PlanCritiqueWorkQuarantineIdentityV1 = Pick<
  PlanCritiqueWorkQuarantineV1,
  'provider' | 'repositoryFingerprint' | 'workId'
>;

function exactObject(value: unknown, fields: readonly string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object') return null;
  try {
    if (utilTypes.isProxy(value) || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== fields.length ||
      keys.some((key) => typeof key !== 'string' || !fields.includes(key))
    )
      return null;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
    }
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function validText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, 'utf8') <= MAX_TEXT_BYTES &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    })
  );
}

function parseIdentity(value: unknown): PlanCritiqueWorkQuarantineIdentityV1 | null {
  const identity = exactObject(value, ['provider', 'repositoryFingerprint', 'workId']);
  if (
    !identity ||
    typeof identity.provider !== 'string' ||
    !PLAN_CRITIQUE_PROVIDERS.includes(identity.provider as PlanCritiqueProvider) ||
    typeof identity.repositoryFingerprint !== 'string' ||
    !SHA256.test(identity.repositoryFingerprint) ||
    !validText(identity.workId)
  )
    return null;
  return identity as unknown as PlanCritiqueWorkQuarantineIdentityV1;
}

function quarantineFor(
  identity: PlanCritiqueWorkQuarantineIdentityV1,
): PlanCritiqueWorkQuarantineV1 {
  return {
    schemaVersion: 1,
    kind: 'plan_critique_work_quarantine',
    provider: identity.provider,
    repositoryFingerprint: identity.repositoryFingerprint,
    workId: identity.workId,
    reason: 'hook_continuation',
  };
}

function canonicalQuarantine(quarantine: PlanCritiqueWorkQuarantineV1): Buffer {
  return Buffer.from(canonicalPlanCritiqueRecordJson(quarantine));
}

function quarantineFilename(identity: PlanCritiqueWorkQuarantineIdentityV1): string {
  const key = JSON.stringify([
    'plan_critique_work_quarantine',
    1,
    identity.provider,
    identity.repositoryFingerprint,
    identity.workId,
  ]);
  return `${sha256Bytes(Buffer.from(key, 'utf8'))}.json`;
}

export function persistPlanCritiqueWorkQuarantine(
  value: PlanCritiqueWorkQuarantineIdentityV1,
  options: { root?: string } = {},
): { state: 'created' | 'existing'; quarantine: PlanCritiqueWorkQuarantineV1 } {
  const identity = parseIdentity(value);
  if (!identity) throw new Error('invalid plan critique work quarantine identity');
  const quarantine = quarantineFor(identity);
  const persist = (
    root: string,
  ): { state: 'created' | 'existing'; quarantine: PlanCritiqueWorkQuarantineV1 } => {
    const directory = managedPath(root, QUARANTINE_PATH, true) as string;
    const state = publishImmutable(
      directory,
      quarantineFilename(identity),
      canonicalQuarantine(quarantine),
    );
    return { state, quarantine };
  };
  return withPlanCritiquePersistenceLock(options, persist);
}

export function getPlanCritiqueWorkQuarantine(
  value: PlanCritiqueWorkQuarantineIdentityV1,
  options: { root?: string } = {},
): PlanCritiqueWorkQuarantineStateV1 {
  const identity = parseIdentity(value);
  if (!identity) return { status: 'unavailable', reason: 'malformed_quarantine' };
  try {
    const root = resolvePlanCritiqueEvidenceRoot(options, false);
    if (!root) return { status: 'clear' };
    const directory = managedPath(root, QUARANTINE_PATH, false);
    if (!directory) return { status: 'clear' };
    const quarantine = quarantineFor(identity);
    const expected = canonicalQuarantine(quarantine);
    const raw = readPrivateFileBounded(
      directory,
      quarantineFilename(identity),
      expected.byteLength,
    );
    if (raw === null) return { status: 'clear' };
    return raw.equals(expected)
      ? { status: 'quarantined', quarantine }
      : { status: 'unavailable', reason: 'malformed_quarantine' };
  } catch {
    return { status: 'unavailable', reason: 'malformed_quarantine' };
  }
}
