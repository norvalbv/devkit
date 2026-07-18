import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { PlanCritiqueContractResult, PlanCritiqueResponseV1 } from './contract.mts';
import { critiqueEligibility } from './contract.mts';
import type { RepositoryContext } from './evidence-bindings.mts';
import {
  evidenceRoot,
  isPlanCritiqueBlobPath,
  isPlanCritiqueId,
  isSha256,
  sha256Text,
  withEvidenceLock,
  writeContentBlob,
} from './evidence-files.mts';
import { atomicWrite } from './immutable-file.mts';
import {
  applyProviderLifecycleStatus,
  type PlanCritiqueProvider,
  type PlanCritiqueProviderStatus,
} from './provider-lifecycle.mts';

export {
  evidenceRoot,
  isPlanCritiqueBlobPath,
  isPlanCritiqueId,
  isSha256,
  persistImmutableJson,
  sha256Text,
  withEvidenceLock,
  writeContentBlob,
} from './evidence-files.mts';

const RECORD_VERSION = 1 as const;
const SECRET_KEY = /(?:api[_-]?key|authorization|cookie|password|secret|token)/i;
const SECRET_VALUE =
  /\b(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|Bearer\s+[^\s,;]+)/gi;
const URL_CREDENTIALS = /(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
const EXACT_RESPONSE_RAW = Symbol('planCritiqueExactResponseRaw');

type PreparedPlanCritiqueRecordV1 = PlanCritiqueRecordV1 & {
  [EXACT_RESPONSE_RAW]?: string;
};

export interface PlanCritiqueRecordV1 {
  schemaVersion: typeof RECORD_VERSION;
  kind: 'plan_critique_record';
  critiqueId: string;
  workId: string;
  lineage: { pass: number; parentCritiqueId: string | null };
  provider: PlanCritiqueProvider;
  /** Absent only on pre-capture-adapter v1 records; see legacy validation in evidence-bindings. */
  providerStatus?: PlanCritiqueProviderStatus;
  model: string | null;
  modelHash: string | null;
  promptHash: string | null;
  responseHash: string;
  exactResponseBlob: string;
  transcriptBlob: string | null;
  transcriptExpiresAt: string | null;
  repositoryFingerprint: string;
  repositoryLocator: string;
  branch: string | null;
  head: string;
  capturedAt: string;
  completedAt: string | null;
  contract: {
    state: PlanCritiqueContractResult['state'];
    errors: string[];
    eligible: boolean;
    eligibilityReason: string;
    criticalCount: number;
  };
  exactResponse: unknown;
  sanitizedProjection: PlanCritiqueProjectionV1 | null;
}

export interface PlanCritiqueProjectionV1 {
  schemaVersion: 1;
  kind: 'plan_critique_projection';
  critiqueId: string;
  verdict: string | null;
  summary: string;
  findings: Array<{
    severity: string;
    lens: string;
    claim: string;
    impact: string;
    recommendation: string;
  }>;
  edgeCases: Array<{
    risk: string;
    scenario: string;
    expectedBehavior: string;
    testType: string;
  }>;
  actions: string[];
  truncated: boolean;
}

export interface PlanCritiqueCommitProjectionV1 {
  schemaVersion: 1;
  kind: 'plan_critique_commit_projection';
  critiqueId: string;
  verdict: string | null;
  findings: PlanCritiqueProjectionV1['findings'];
  edgeCases: PlanCritiqueProjectionV1['edgeCases'];
  truncated: boolean;
}

function sanitizeString(value: string): string {
  const withoutControls = [...value]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return !(
        code <= 8 ||
        code === 11 ||
        code === 12 ||
        (code >= 14 && code <= 31) ||
        code === 127
      );
    })
    .join('');
  return withoutControls
    .replace(SECRET_VALUE, '[REDACTED]')
    .replace(URL_CREDENTIALS, '$1[REDACTED]@')
    .trim();
}

export function sanitizeEvidenceValue(value: unknown, key = ''): unknown {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return sanitizeString(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeEvidenceValue(item));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [
        childKey,
        sanitizeEvidenceValue(child, childKey),
      ]),
    );
  }
  return value;
}

function fitProjection(
  projection: PlanCritiqueProjectionV1,
  maxBytes: number,
): PlanCritiqueProjectionV1 {
  const size = () => Buffer.byteLength(JSON.stringify(projection), 'utf8');
  while (size() > maxBytes && projection.actions.length > 0) {
    projection.actions.pop();
    projection.truncated = true;
  }
  if (size() > maxBytes && projection.summary.length > 0) {
    projection.summary = '';
    projection.truncated = true;
  }
  while (size() > maxBytes && projection.edgeCases.length > 0) {
    projection.edgeCases.pop();
    projection.truncated = true;
  }
  while (size() > maxBytes && projection.findings.length > 0) {
    projection.findings.pop();
    projection.truncated = true;
  }
  return projection;
}

/** Allowlisted, control-character-free context. It never contains evidence prose or transcripts. */
export function buildProjection(
  critiqueId: string,
  value: PlanCritiqueResponseV1,
  maxItems = 25,
  maxBytes = 8 * 1024,
): PlanCritiqueProjectionV1 {
  let remaining = maxItems;
  const findings = value.findings.slice(0, remaining).map((finding) => ({
    severity: sanitizeString(finding.severity),
    lens: sanitizeString(finding.lens),
    claim: sanitizeString(finding.claim),
    impact: sanitizeString(finding.impact),
    recommendation: sanitizeString(finding.recommendation),
  }));
  remaining -= findings.length;
  const edgeCases = value.edgeCases.slice(0, remaining).map((edgeCase) => ({
    risk: sanitizeString(edgeCase.risk),
    scenario: sanitizeString(edgeCase.scenario),
    expectedBehavior: sanitizeString(edgeCase.expectedBehavior),
    testType: sanitizeString(edgeCase.testType),
  }));
  remaining -= edgeCases.length;
  const actions = value.actions.slice(0, remaining).map(sanitizeString);
  const truncated =
    findings.length < value.findings.length ||
    edgeCases.length < value.edgeCases.length ||
    actions.length < value.actions.length;
  return fitProjection(
    {
      schemaVersion: 1,
      kind: 'plan_critique_projection',
      critiqueId,
      verdict: value.verdict,
      summary: sanitizeString(value.summary),
      findings,
      edgeCases,
      actions,
      truncated,
    },
    maxBytes,
  );
}

/** Commit-shadow context excludes summaries, actions, raw evidence, prompts, and transcripts. */
export function buildCommitProjection(
  projection: PlanCritiqueProjectionV1,
): PlanCritiqueCommitProjectionV1 {
  return {
    schemaVersion: 1,
    kind: 'plan_critique_commit_projection',
    critiqueId: projection.critiqueId,
    verdict: projection.verdict,
    findings: projection.findings,
    edgeCases: projection.edgeCases,
    truncated: projection.truncated,
  };
}

export function recordPath(critiqueId: string): string {
  if (!isPlanCritiqueId(critiqueId)) throw new Error('invalid plan critique id');
  return join(evidenceRoot(), 'records', `${critiqueId}.json`);
}

export function readRecord(critiqueId: string): PlanCritiqueRecordV1 | null {
  if (!isPlanCritiqueId(critiqueId)) return null;
  try {
    const parsed = JSON.parse(readFileSync(recordPath(critiqueId), 'utf8')) as PlanCritiqueRecordV1;
    return parsed.schemaVersion === 1 && parsed.kind === 'plan_critique_record' ? parsed : null;
  } catch {
    return null;
  }
}

export function persistRecord(record: PlanCritiqueRecordV1): string {
  return withEvidenceLock(() => {
    const prepared = record as PreparedPlanCritiqueRecordV1;
    const exactRaw = prepared[EXACT_RESPONSE_RAW];
    if (!isPlanCritiqueId(record.critiqueId)) throw new Error('invalid plan critique id');
    if (!isSha256(record.responseHash)) throw new Error('invalid plan critique response hash');
    const expectedExactBlob = `blobs/${record.responseHash}.json`;
    if (record.exactResponseBlob !== expectedExactBlob)
      throw new Error('exact response blob does not match the response hash');
    const exactPath = join(evidenceRoot(), record.exactResponseBlob);
    if (!existsSync(exactPath)) {
      if (typeof exactRaw !== 'string' || sha256Text(exactRaw) !== record.responseHash)
        throw new Error('exact response blob is unavailable for this record');
      writeContentBlob(exactRaw, 'json');
    }
    if (record.transcriptBlob) {
      if (!isPlanCritiqueBlobPath(record.transcriptBlob))
        throw new Error('transcript blob path is invalid for this record');
      if (!existsSync(join(evidenceRoot(), record.transcriptBlob)))
        throw new Error('transcript blob is unavailable for this record');
    }
    const path = recordPath(record.critiqueId);
    atomicWrite(path, `${JSON.stringify(record, null, 2)}\n`);
    return path;
  });
}

export function makeRecord(input: {
  contract: PlanCritiqueContractResult;
  context: RepositoryContext;
  workId: string;
  provider: PlanCritiqueProvider;
  providerStatus?: PlanCritiqueProviderStatus;
  model?: string | null;
  prompt?: string | null;
  parentCritiqueId?: string | null;
  pass?: number;
  transcriptBlob?: string | null;
  transcriptExpiresAt?: string | null;
  completedAt?: string | null;
}): PlanCritiqueRecordV1 {
  const critiqueId = randomUUID();
  const providerStatus = input.providerStatus ?? null;
  const contract = applyProviderLifecycleStatus(input.contract, input.provider, providerStatus);
  const eligibility = critiqueEligibility(contract);
  const pass = input.pass ?? 1;
  const retryLimitExceeded = pass > 2;
  const record: PreparedPlanCritiqueRecordV1 = {
    schemaVersion: RECORD_VERSION,
    kind: 'plan_critique_record',
    critiqueId,
    workId: input.workId,
    lineage: {
      pass,
      parentCritiqueId: input.parentCritiqueId ?? null,
    },
    provider: input.provider,
    providerStatus,
    model: input.model ?? null,
    modelHash: input.model ? sha256Text(input.model) : null,
    promptHash: input.prompt ? sha256Text(input.prompt) : null,
    responseHash: sha256Text(contract.exactRaw),
    exactResponseBlob: `blobs/${sha256Text(contract.exactRaw)}.json`,
    transcriptBlob: input.transcriptBlob ?? null,
    transcriptExpiresAt: input.transcriptExpiresAt ?? null,
    repositoryFingerprint: input.context.repositoryFingerprint,
    repositoryLocator: input.context.repositoryLocator,
    branch: input.context.branch,
    head: input.context.head,
    capturedAt: new Date().toISOString(),
    completedAt: input.completedAt ?? null,
    contract: {
      state: contract.state,
      errors: contract.errors,
      eligible: eligibility.eligible && !retryLimitExceeded,
      eligibilityReason: retryLimitExceeded ? 'retry_limit_exceeded' : eligibility.reason,
      criticalCount: eligibility.criticalCount,
    },
    // The exact parsed response is retained for reproducibility. Consumers must use only the
    // allowlisted sanitizedProjection below; exactResponse is never injected into another prompt.
    exactResponse: contract.exactResponse,
    sanitizedProjection:
      contract.value && contract.state === 'valid'
        ? buildProjection(critiqueId, contract.value)
        : null,
  };
  // The non-enumerable symbol is omitted from JSON and structural comparisons, so persistRecord
  // can publish the exact-response blob and record in one lock without storing a second raw body.
  Object.defineProperty(record, EXACT_RESPONSE_RAW, { value: contract.exactRaw });
  return record;
}

function evidenceFiles(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name === '.operation-lock') return [];
      const child = join(path, entry.name);
      if (entry.isDirectory()) return evidenceFiles(child);
      return entry.isFile() ? [child] : [];
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function collectBlobReferences(value: unknown, key = '', output = new Set<string>()): Set<string> {
  if (key.endsWith('Blob') && isPlanCritiqueBlobPath(value)) output.add(value);
  else if (Array.isArray(value)) for (const item of value) collectBlobReferences(item, key, output);
  else if (typeof value === 'object' && value !== null)
    for (const [childKey, child] of Object.entries(value))
      collectBlobReferences(child, childKey, output);
  return output;
}

function storedTimestamp(value: unknown, fallback: number): number {
  if (typeof value !== 'object' || value === null) return fallback;
  const item = value as Record<string, unknown>;
  for (const key of ['capturedAt', 'observedAt', 'createdAt', 'completedAt']) {
    const timestamp = typeof item[key] === 'string' ? Date.parse(item[key]) : Number.NaN;
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return fallback;
}

export function purgePlanCritiqueEvidence(
  options: { olderThanMs?: number; dryRun?: boolean } = {},
): { files: number; bytes: number } {
  return withEvidenceLock(() => {
    const root = evidenceRoot();
    if (!existsSync(root)) return { files: 0, bytes: 0 };
    const paths = evidenceFiles(root);
    if (options.olderThanMs === undefined) {
      const stats = paths.flatMap((path) => {
        try {
          return [statSync(path)];
        } catch {
          return [];
        }
      });
      if (!options.dryRun) rmSync(root, { recursive: true, force: true });
      return { files: stats.length, bytes: stats.reduce((sum, stat) => sum + stat.size, 0) };
    }

    const cutoff = Date.now() - options.olderThanMs;
    const expired = new Set<string>();
    const protectedBlobs = new Set<string>();
    let protectAllBlobs = false;
    for (const path of paths) {
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      const rel = relative(root, path);
      let timestamp = stat.mtimeMs;
      if (rel.endsWith('.json') && !rel.startsWith('blobs/')) {
        try {
          const document = JSON.parse(readFileSync(path, 'utf8')) as unknown;
          timestamp = storedTimestamp(document, timestamp);
          if (timestamp > cutoff)
            for (const blob of collectBlobReferences(document)) protectedBlobs.add(blob);
        } catch {
          if (timestamp > cutoff) protectAllBlobs = true;
        }
      }
      if (timestamp <= cutoff) expired.add(path);
    }

    let files = 0;
    let bytes = 0;
    for (const path of expired) {
      const rel = relative(root, path);
      if (rel.startsWith('blobs/') && (protectAllBlobs || protectedBlobs.has(rel))) continue;
      let size: number;
      try {
        size = statSync(path).size;
        if (!options.dryRun) unlinkSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      files++;
      bytes += size;
    }
    return { files, bytes };
  });
}

/** Remove expired optional transcript blobs while retaining immutable record metadata. */
export function pruneExpiredTranscriptBlobs(now = Date.now()): { files: number; bytes: number } {
  return withEvidenceLock(() => {
    const recordsDir = join(evidenceRoot(), 'records');
    if (!existsSync(recordsDir)) return { files: 0, bytes: 0 };
    const expired = new Set<string>();
    const active = new Set<string>();
    for (const entry of readdirSync(recordsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      let record: PlanCritiqueRecordV1;
      try {
        record = JSON.parse(readFileSync(join(recordsDir, entry.name), 'utf8'));
      } catch {
        continue;
      }
      if (!isPlanCritiqueBlobPath(record.transcriptBlob)) continue;
      const expiry = Date.parse(record.transcriptExpiresAt ?? '');
      if (Number.isFinite(expiry) && expiry <= now) expired.add(record.transcriptBlob);
      else active.add(record.transcriptBlob);
    }
    let files = 0;
    let bytes = 0;
    for (const relativePath of expired) {
      if (active.has(relativePath)) continue;
      const path = resolve(evidenceRoot(), relativePath);
      if (!path.startsWith(`${resolve(evidenceRoot())}/`)) continue;
      let size: number;
      try {
        const stat = statSync(path);
        if (!stat.isFile()) continue;
        size = stat.size;
        unlinkSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      files++;
      bytes += size;
    }
    return { files, bytes };
  });
}
