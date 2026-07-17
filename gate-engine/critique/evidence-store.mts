import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { PlanCritiqueContractResult, PlanCritiqueResponseV1 } from './contract.mts';
import { critiqueEligibility } from './contract.mts';
import type { RepositoryContext } from './evidence-bindings.mts';
import { atomicWrite } from './immutable-file.mts';

const RECORD_VERSION = 1 as const;
const SECRET_KEY = /(?:api[_-]?key|authorization|cookie|password|secret|token)/i;
const SECRET_VALUE =
  /\b(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|Bearer\s+[^\s,;]+)/gi;
const URL_CREDENTIALS = /(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type PlanCritiqueProvider = 'claude' | 'codex' | 'cursor';

export interface PlanCritiqueRecordV1 {
  schemaVersion: typeof RECORD_VERSION;
  kind: 'plan_critique_record';
  critiqueId: string;
  workId: string;
  lineage: { pass: number; parentCritiqueId: string | null };
  provider: PlanCritiqueProvider;
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

export function evidenceRoot(): string {
  return (
    process.env.DEVKIT_PLAN_CRITIQUE_EVIDENCE_DIR ??
    join(homedir(), '.devkit', 'evidence', 'plan-critiques', 'v1')
  );
}

export const sha256Text = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

export function persistImmutableJson(relativePath: string, value: unknown): string {
  const path = join(evidenceRoot(), relativePath);
  atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

export function writeContentBlob(content: string, extension = 'txt'): string {
  const hash = sha256Text(content);
  const rel = `blobs/${hash}.${extension}`;
  const path = join(evidenceRoot(), rel);
  if (existsSync(path)) return rel;
  try {
    atomicWrite(path, content);
  } catch (error) {
    if (!existsSync(path)) throw error;
  }
  return rel;
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
  return join(evidenceRoot(), 'records', `${critiqueId}.json`);
}

export function readRecord(critiqueId: string): PlanCritiqueRecordV1 | null {
  if (!UUID.test(critiqueId)) return null;
  try {
    const parsed = JSON.parse(readFileSync(recordPath(critiqueId), 'utf8')) as PlanCritiqueRecordV1;
    return parsed.schemaVersion === 1 && parsed.kind === 'plan_critique_record' ? parsed : null;
  } catch {
    return null;
  }
}

export function persistRecord(record: PlanCritiqueRecordV1): string {
  const path = recordPath(record.critiqueId);
  atomicWrite(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

export function makeRecord(input: {
  contract: PlanCritiqueContractResult;
  context: RepositoryContext;
  workId: string;
  provider: PlanCritiqueProvider;
  model?: string | null;
  prompt?: string | null;
  parentCritiqueId?: string | null;
  pass?: number;
  transcriptBlob?: string | null;
  transcriptExpiresAt?: string | null;
  completedAt?: string | null;
}): PlanCritiqueRecordV1 {
  const critiqueId = randomUUID();
  const eligibility = critiqueEligibility(input.contract);
  const pass = input.pass ?? 1;
  const retryLimitExceeded = pass > 2;
  return {
    schemaVersion: RECORD_VERSION,
    kind: 'plan_critique_record',
    critiqueId,
    workId: input.workId,
    lineage: {
      pass,
      parentCritiqueId: input.parentCritiqueId ?? null,
    },
    provider: input.provider,
    model: input.model ?? null,
    modelHash: input.model ? sha256Text(input.model) : null,
    promptHash: input.prompt ? sha256Text(input.prompt) : null,
    responseHash: sha256Text(input.contract.exactRaw),
    exactResponseBlob: writeContentBlob(input.contract.exactRaw, 'json'),
    transcriptBlob: input.transcriptBlob ?? null,
    transcriptExpiresAt: input.transcriptExpiresAt ?? null,
    repositoryFingerprint: input.context.repositoryFingerprint,
    repositoryLocator: input.context.repositoryLocator,
    branch: input.context.branch,
    head: input.context.head,
    capturedAt: new Date().toISOString(),
    completedAt: input.completedAt ?? null,
    contract: {
      state: input.contract.state,
      errors: input.contract.errors,
      eligible: eligibility.eligible && !retryLimitExceeded,
      eligibilityReason: retryLimitExceeded ? 'retry_limit_exceeded' : eligibility.reason,
      criticalCount: eligibility.criticalCount,
    },
    // The exact parsed response is retained for reproducibility. Consumers must use only the
    // allowlisted sanitizedProjection below; exactResponse is never injected into another prompt.
    exactResponse: input.contract.exactResponse,
    sanitizedProjection:
      input.contract.value && input.contract.state === 'valid'
        ? buildProjection(critiqueId, input.contract.value)
        : null,
  };
}

export function purgePlanCritiqueEvidence(
  options: { olderThanMs?: number; dryRun?: boolean } = {},
): { files: number; bytes: number } {
  const root = evidenceRoot();
  if (!existsSync(root)) return { files: 0, bytes: 0 };
  const cutoff = options.olderThanMs ? Date.now() - options.olderThanMs : Number.POSITIVE_INFINITY;
  let files = 0;
  let bytes = 0;
  const walk = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && statSync(child).mtimeMs <= cutoff) {
        files++;
        bytes += statSync(child).size;
        if (!options.dryRun) rmSync(child, { force: true });
      }
    }
  };
  walk(root);
  if (!options.dryRun && !options.olderThanMs) rmSync(root, { recursive: true, force: true });
  return { files, bytes };
}

/** Remove expired optional transcript blobs while retaining immutable record metadata. */
export function pruneExpiredTranscriptBlobs(now = Date.now()): { files: number; bytes: number } {
  const recordsDir = join(evidenceRoot(), 'records');
  if (!existsSync(recordsDir)) return { files: 0, bytes: 0 };
  const expired = new Set<string>();
  const active = new Set<string>();
  for (const entry of readdirSync(recordsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const record = JSON.parse(
        readFileSync(join(recordsDir, entry.name), 'utf8'),
      ) as PlanCritiqueRecordV1;
      if (!record.transcriptBlob) continue;
      const expiry = Date.parse(record.transcriptExpiresAt ?? '');
      if (Number.isFinite(expiry) && expiry <= now) expired.add(record.transcriptBlob);
      else active.add(record.transcriptBlob);
    } catch {
      // Malformed records are preserved and do not authorize deleting any referenced blob.
    }
  }
  let files = 0;
  let bytes = 0;
  for (const relativePath of expired) {
    if (active.has(relativePath)) continue;
    const path = resolve(evidenceRoot(), relativePath);
    if (!path.startsWith(`${resolve(evidenceRoot())}/`) || !existsSync(path)) continue;
    const stat = statSync(path);
    if (!stat.isFile()) continue;
    files++;
    bytes += stat.size;
    rmSync(path, { force: true });
  }
  return { files, bytes };
}
