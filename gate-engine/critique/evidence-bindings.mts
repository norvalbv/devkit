import {
  canonicalPlanCritiqueRecordJson,
  type PlanCritiqueRecordV1,
  sha256Bytes,
} from './evidence-record.mts';
import { readPlanCritiqueRecord } from './evidence-store.mts';
import {
  listPrivateFiles,
  managedPath,
  publishImmutable,
  readPrivateFile,
} from './immutable-file.mts';
import {
  getPlanCritiqueRepositoryContext,
  isPlanCritiqueAncestor,
  type PlanCritiqueRepositoryContext,
  type PlanCritiqueRepositoryContextResult,
} from './repository-context.mts';

export {
  getPlanCritiqueRepositoryContext,
  type PlanCritiqueRepositoryContext,
  type PlanCritiqueRepositoryContextResult,
};

const SHA256 = /^[0-9a-f]{64}$/;
const CRITIQUE_ID = /^pc1_[0-9a-f]{64}$/;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const BINDING_FILE = /^[0-9a-f]{64}\.json$/;
const MAX_TEXT_BYTES = 4 * 1024;
const MAX_BINDING_BYTES = 16 * 1024;
const BINDING_PATH = ['devkit', 'plan-critique-bindings', 'v1'] as const;

export type PlanCritiqueBindingUnavailableReason =
  | 'not_a_repository'
  | 'detached_worktree'
  | 'no_matching_binding'
  | 'ambiguous_matching_bindings'
  | 'repository_mismatch'
  | 'branch_mismatch'
  | 'ancestry_mismatch'
  | 'malformed_binding'
  | 'malformed_record'
  | 'ineligible_record';

export interface PlanCritiqueBindingV1 {
  schemaVersion: 1;
  kind: 'plan_critique_binding';
  workId: string;
  critiqueId: `pc1_${string}`;
  recordCapturedAt: string;
  repository: {
    fingerprint: string;
    fingerprintSource: 'canonical_remote' | 'local_path';
    branch: string;
    head: string;
  };
}

export type PersistPlanCritiqueBindingResult =
  | {
      status: 'bound';
      state: 'created' | 'existing';
      binding: PlanCritiqueBindingV1;
    }
  | { status: 'unavailable'; reason: PlanCritiqueBindingUnavailableReason };

export type ResolvePlanCritiqueBindingResult =
  | {
      status: 'resolved';
      binding: PlanCritiqueBindingV1;
      record: PlanCritiqueRecordV1;
    }
  | {
      status: 'unavailable';
      reason: PlanCritiqueBindingUnavailableReason;
      candidates: number;
    };

const bindingKey = (workId: string): string => sha256Bytes(Buffer.from(workId, 'utf8'));

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function exactObject(value: unknown, fields: readonly string[]): Record<string, unknown> | null {
  if (!isObject(value)) return null;
  const keys = Object.keys(value);
  return keys.length === fields.length && keys.every((key) => fields.includes(key)) ? value : null;
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

function canonicalBindingJson(binding: PlanCritiqueBindingV1): Buffer {
  return Buffer.from(canonicalPlanCritiqueRecordJson(binding));
}

function parseBinding(raw: Buffer, filename: string): PlanCritiqueBindingV1 | null {
  if (raw.byteLength > MAX_BINDING_BYTES || !BINDING_FILE.test(filename)) return null;
  try {
    const value: unknown = JSON.parse(raw.toString('utf8'));
    const root = exactObject(value, [
      'schemaVersion',
      'kind',
      'workId',
      'critiqueId',
      'recordCapturedAt',
      'repository',
    ]);
    if (root?.schemaVersion !== 1 || root.kind !== 'plan_critique_binding') return null;
    if (!validText(root.workId) || filename !== `${bindingKey(root.workId)}.json`) return null;
    if (typeof root.critiqueId !== 'string' || !CRITIQUE_ID.test(root.critiqueId)) return null;
    if (
      typeof root.recordCapturedAt !== 'string' ||
      !ISO_TIMESTAMP.test(root.recordCapturedAt) ||
      new Date(root.recordCapturedAt).toISOString() !== root.recordCapturedAt
    )
      return null;
    const repository = exactObject(root.repository, [
      'fingerprint',
      'fingerprintSource',
      'branch',
      'head',
    ]);
    if (
      !repository ||
      typeof repository.fingerprint !== 'string' ||
      !SHA256.test(repository.fingerprint) ||
      (repository.fingerprintSource !== 'canonical_remote' &&
        repository.fingerprintSource !== 'local_path') ||
      !validText(repository.branch) ||
      typeof repository.head !== 'string' ||
      !GIT_OBJECT_ID.test(repository.head)
    )
      return null;
    const binding = value as PlanCritiqueBindingV1;
    return raw.equals(canonicalBindingJson(binding)) ? binding : null;
  } catch {
    return null;
  }
}

function bindingDirectory(context: PlanCritiqueRepositoryContext, create: boolean): string | null {
  return managedPath(context.gitDir, BINDING_PATH, create);
}

function unavailable(
  reason: PlanCritiqueBindingUnavailableReason,
  candidates: number,
): ResolvePlanCritiqueBindingResult {
  return { status: 'unavailable', reason, candidates };
}

function evidenceOptions(evidenceRoot: string | undefined): { root?: string } {
  return evidenceRoot === undefined ? {} : { root: evidenceRoot };
}

function bindingFor(
  record: PlanCritiqueRecordV1,
  context: PlanCritiqueRepositoryContext,
): PlanCritiqueBindingV1 {
  return {
    schemaVersion: 1,
    kind: 'plan_critique_binding',
    workId: record.workId,
    critiqueId: record.critiqueId,
    recordCapturedAt: record.timestamps.capturedAt,
    repository: {
      fingerprint: context.fingerprint,
      fingerprintSource: context.fingerprintSource,
      branch: context.branch,
      head: context.head,
    },
  };
}

export function persistPlanCritiqueBinding(
  critiqueId: string,
  options: { cwd?: string; evidenceRoot?: string } = {},
): PersistPlanCritiqueBindingResult {
  const repository = getPlanCritiqueRepositoryContext(options.cwd);
  if (repository.status === 'unavailable') return repository;
  let record: PlanCritiqueRecordV1 | null;
  try {
    record = readPlanCritiqueRecord(critiqueId, evidenceOptions(options.evidenceRoot));
  } catch {
    record = null;
  }
  if (!record) return { status: 'unavailable', reason: 'malformed_record' };
  const { context } = repository;
  if (
    record.repository.fingerprint !== context.fingerprint ||
    record.repository.fingerprintSource !== context.fingerprintSource
  )
    return { status: 'unavailable', reason: 'repository_mismatch' };
  if (record.repository.branch !== context.branch)
    return { status: 'unavailable', reason: 'branch_mismatch' };
  if (record.repository.head !== context.head)
    return { status: 'unavailable', reason: 'ancestry_mismatch' };
  if (!record.contract.eligibility.eligible)
    return { status: 'unavailable', reason: 'ineligible_record' };
  const binding = bindingFor(record, context);
  const directory = bindingDirectory(context, true) as string;
  const state = publishImmutable(
    directory,
    `${bindingKey(binding.workId)}.json`,
    canonicalBindingJson(binding),
  );
  return { status: 'bound', state, binding };
}

function loadBindings(
  context: PlanCritiqueRepositoryContext,
  workId: string | undefined,
): {
  bindings: PlanCritiqueBindingV1[];
  candidates: number;
  malformed: boolean;
} {
  const directory = bindingDirectory(context, false);
  if (!directory) return { bindings: [], candidates: 0, malformed: false };
  const names = workId === undefined ? listPrivateFiles(directory) : [`${bindingKey(workId)}.json`];
  const bindings: PlanCritiqueBindingV1[] = [];
  let candidates = 0;
  for (const name of names) {
    const raw = readPrivateFile(directory, name);
    if (!raw) continue;
    candidates += 1;
    const binding = parseBinding(raw, name);
    if (!binding || (workId !== undefined && binding.workId !== workId))
      return { bindings: [], candidates, malformed: true };
    bindings.push(binding);
  }
  return { bindings, candidates, malformed: false };
}

export function resolvePlanCritiqueBinding(
  options: { cwd?: string; evidenceRoot?: string; workId?: string } = {},
): ResolvePlanCritiqueBindingResult {
  const repository = getPlanCritiqueRepositoryContext(options.cwd);
  if (repository.status === 'unavailable') return { ...repository, candidates: 0 };
  let loaded: ReturnType<typeof loadBindings>;
  try {
    loaded = loadBindings(repository.context, options.workId);
  } catch {
    return unavailable('malformed_binding', 0);
  }
  const { bindings, candidates, malformed } = loaded;
  if (malformed) return unavailable('malformed_binding', candidates);
  if (bindings.length === 0) return unavailable('no_matching_binding', 0);
  if (bindings.length !== 1) return unavailable('ambiguous_matching_bindings', candidates);
  const [binding] = bindings;
  const { context } = repository;
  if (
    binding.repository.fingerprint !== context.fingerprint ||
    binding.repository.fingerprintSource !== context.fingerprintSource
  )
    return unavailable('repository_mismatch', candidates);
  if (binding.repository.branch !== context.branch)
    return unavailable('branch_mismatch', candidates);
  if (!isPlanCritiqueAncestor(options.cwd ?? process.cwd(), binding.repository.head, context.head))
    return unavailable('ancestry_mismatch', candidates);
  let record: PlanCritiqueRecordV1 | null;
  try {
    record = readPlanCritiqueRecord(binding.critiqueId, evidenceOptions(options.evidenceRoot));
  } catch {
    record = null;
  }
  if (
    !record ||
    record.critiqueId !== binding.critiqueId ||
    record.workId !== binding.workId ||
    record.timestamps.capturedAt !== binding.recordCapturedAt ||
    record.repository.fingerprint !== binding.repository.fingerprint ||
    record.repository.fingerprintSource !== binding.repository.fingerprintSource ||
    record.repository.branch !== binding.repository.branch ||
    record.repository.head !== binding.repository.head
  )
    return unavailable('malformed_record', candidates);
  if (!record.contract.eligibility.eligible) return unavailable('ineligible_record', candidates);
  const revalidated = getPlanCritiqueRepositoryContext(options.cwd);
  if (revalidated.status === 'unavailable') return { ...revalidated, candidates };
  if (
    revalidated.context.fingerprint !== context.fingerprint ||
    revalidated.context.fingerprintSource !== context.fingerprintSource ||
    revalidated.context.gitDir !== context.gitDir ||
    revalidated.context.gitCommonDir !== context.gitCommonDir
  )
    return unavailable('repository_mismatch', candidates);
  if (revalidated.context.branch !== context.branch)
    return unavailable('branch_mismatch', candidates);
  if (revalidated.context.head !== context.head)
    return unavailable('ancestry_mismatch', candidates);
  return { status: 'resolved', binding, record };
}
