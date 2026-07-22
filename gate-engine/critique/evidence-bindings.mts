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
  readPrivateFileBounded,
} from './immutable-file.mts';
import { getPlanCritiqueWorkQuarantine } from './lifecycle/work-quarantine.mts';
import {
  resolvePlanCritiqueEvidenceRoot,
  withExistingPlanCritiquePersistenceLock,
  withPlanCritiquePersistenceLock,
} from './persistence-lock.mts';
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
  | 'ineligible_record'
  | 'work_quarantined'
  | 'malformed_quarantine'
  | 'evidence_lock_unavailable';

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

function differentRepository(
  left: PlanCritiqueRepositoryContext,
  right: PlanCritiqueRepositoryContext,
): boolean {
  return (
    left.fingerprint !== right.fingerprint ||
    left.fingerprintSource !== right.fingerprintSource ||
    left.gitDir !== right.gitDir ||
    left.gitCommonDir !== right.gitCommonDir
  );
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

function quarantineReason(
  record: PlanCritiqueRecordV1,
  evidenceRoot: string,
): 'work_quarantined' | 'malformed_quarantine' | null {
  const state = getPlanCritiqueWorkQuarantine(
    {
      provider: record.execution.provider,
      repositoryFingerprint: record.repository.fingerprint,
      workId: record.workId,
    },
    { root: evidenceRoot },
  );
  if (state.status === 'clear') return null;
  return state.status === 'quarantined' ? 'work_quarantined' : 'malformed_quarantine';
}

export function persistPlanCritiqueBinding(
  critiqueId: string,
  options: { cwd?: string; evidenceRoot?: string } = {},
): PersistPlanCritiqueBindingResult {
  const repository = getPlanCritiqueRepositoryContext(options.cwd);
  if (repository.status === 'unavailable') return repository;
  let evidenceRoot: string | null;
  try {
    evidenceRoot = resolvePlanCritiqueEvidenceRoot(evidenceOptions(options.evidenceRoot), false);
  } catch {
    evidenceRoot = null;
  }
  if (!evidenceRoot) return { status: 'unavailable', reason: 'malformed_record' };
  const publish = (canonicalRoot: string): PersistPlanCritiqueBindingResult => {
    let record: PlanCritiqueRecordV1 | null;
    try {
      record = readPlanCritiqueRecord(critiqueId, { root: canonicalRoot });
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
    const quarantine = quarantineReason(record, canonicalRoot);
    if (quarantine) return { status: 'unavailable', reason: quarantine };
    const binding = bindingFor(record, context);
    const directory = bindingDirectory(context, true) as string;
    const state = publishImmutable(
      directory,
      `${bindingKey(binding.workId)}.json`,
      canonicalBindingJson(binding),
    );
    return { status: 'bound', state, binding };
  };
  return withPlanCritiquePersistenceLock({ root: evidenceRoot }, publish);
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
    let raw: Buffer | null;
    try {
      raw = readPrivateFileBounded(directory, name, MAX_BINDING_BYTES);
    } catch {
      return { bindings: [], candidates: candidates + 1, malformed: true };
    }
    if (!raw) continue;
    candidates += 1;
    const binding = parseBinding(raw, name);
    if (!binding || (workId !== undefined && binding.workId !== workId))
      return { bindings: [], candidates, malformed: true };
    bindings.push(binding);
  }
  return { bindings, candidates, malformed: false };
}

type BindingSelection =
  | { status: 'selected'; binding: PlanCritiqueBindingV1; candidates: 1 }
  | {
      status: 'unavailable';
      reason: 'malformed_binding' | 'no_matching_binding' | 'ambiguous_matching_bindings';
      candidates: number;
    };

function selectBinding(
  context: PlanCritiqueRepositoryContext,
  workId: string | undefined,
): BindingSelection {
  let loaded: ReturnType<typeof loadBindings>;
  try {
    loaded = loadBindings(context, workId);
  } catch {
    return { status: 'unavailable', reason: 'malformed_binding', candidates: 0 };
  }
  const { bindings, candidates, malformed } = loaded;
  if (malformed) return { status: 'unavailable', reason: 'malformed_binding', candidates };
  if (bindings.length === 0)
    return { status: 'unavailable', reason: 'no_matching_binding', candidates: 0 };
  if (bindings.length !== 1)
    return { status: 'unavailable', reason: 'ambiguous_matching_bindings', candidates };
  return { status: 'selected', binding: bindings[0] as PlanCritiqueBindingV1, candidates: 1 };
}

export function resolvePlanCritiqueBinding(
  options: { cwd?: string; evidenceRoot?: string; workId?: string } = {},
): ResolvePlanCritiqueBindingResult {
  const workId = options.workId;
  if (workId !== undefined && !validText(workId)) return unavailable('malformed_binding', 0);
  const preflightRepository = getPlanCritiqueRepositoryContext(options.cwd);
  if (preflightRepository.status === 'unavailable')
    return { ...preflightRepository, candidates: 0 };
  const preflight = selectBinding(preflightRepository.context, workId);
  if (preflight.status === 'unavailable') return preflight;
  let evidenceRoot: string | null;
  try {
    evidenceRoot = resolvePlanCritiqueEvidenceRoot(evidenceOptions(options.evidenceRoot), false);
  } catch {
    evidenceRoot = null;
  }
  if (!evidenceRoot) return unavailable('malformed_record', 1);
  const resolution = {
    state: 'not_started' as 'not_started' | 'running' | 'completed',
    result: undefined as ResolvePlanCritiqueBindingResult | undefined,
  };
  const resolveLocked = (evidenceRoot: string): ResolvePlanCritiqueBindingResult => {
    const repository = getPlanCritiqueRepositoryContext(options.cwd);
    if (repository.status === 'unavailable') return { ...repository, candidates: 1 };
    if (differentRepository(preflightRepository.context, repository.context))
      return unavailable('repository_mismatch', 1);
    if (preflightRepository.context.branch !== repository.context.branch)
      return unavailable('branch_mismatch', 1);
    const selected = selectBinding(repository.context, workId);
    if (selected.status === 'unavailable') return selected;
    const { binding, candidates } = selected;
    const { context } = repository;
    if (
      binding.repository.fingerprint !== context.fingerprint ||
      binding.repository.fingerprintSource !== context.fingerprintSource
    )
      return unavailable('repository_mismatch', candidates);
    if (binding.repository.branch !== context.branch)
      return unavailable('branch_mismatch', candidates);
    if (
      !isPlanCritiqueAncestor(options.cwd ?? process.cwd(), binding.repository.head, context.head)
    )
      return unavailable('ancestry_mismatch', candidates);
    let record: PlanCritiqueRecordV1 | null;
    try {
      record = readPlanCritiqueRecord(binding.critiqueId, { root: evidenceRoot });
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
    if (differentRepository(context, revalidated.context))
      return unavailable('repository_mismatch', candidates);
    if (revalidated.context.branch !== context.branch)
      return unavailable('branch_mismatch', candidates);
    if (revalidated.context.head !== context.head)
      return unavailable('ancestry_mismatch', candidates);
    const quarantine = quarantineReason(record, evidenceRoot);
    if (quarantine) return unavailable(quarantine, candidates);
    return { status: 'resolved', binding, record };
  };
  const resolve = (evidenceRoot: string): ResolvePlanCritiqueBindingResult => {
    resolution.state = 'running';
    const result = resolveLocked(evidenceRoot);
    resolution.result = result;
    resolution.state = 'completed';
    return result;
  };
  try {
    const transaction = withExistingPlanCritiquePersistenceLock({ root: evidenceRoot }, resolve);
    if (transaction.status === 'absent') return unavailable('malformed_record', 1);
    return transaction.value;
  } catch (error) {
    if (resolution.state === 'running') throw error;
    if (resolution.state === 'completed' && resolution.result) return resolution.result;
    return unavailable('evidence_lock_unavailable', 1);
  }
}
