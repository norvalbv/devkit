import { randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import {
  type CaptureObservationV1,
  captureByInvocation,
  captureObservations,
  cursorProviderStatus,
  type HookInput,
  nextCaptureOrdinal,
  providerSessionHash,
  reliableTurnHash,
  textField,
  workIdentity,
} from './capture-state.mts';
import { parsePlanCritiqueResponse } from './contract.mts';
import { persistBinding, repositoryContext, resolveEligibleBinding } from './evidence-bindings.mts';
import {
  buildCommitProjection,
  makeRecord,
  persistImmutableJson,
  persistRecord,
  pruneExpiredTranscriptBlobs,
  readRecord,
  sha256Text,
  withEvidenceLock,
  writeContentBlob,
} from './evidence-store.mts';
import type { PlanCritiqueProvider } from './provider-lifecycle.mts';

const CRITIQUE_AGENT_RE = /feature[-_ ]critique|plan[-_ ]critique/;
const CAPTURE_ENTRY_RE = /[/\\]capture\.(?:mts|mjs)$/;

export interface CaptureResult {
  status: 'captured' | 'observed' | 'skipped' | 'failed';
  reason: string;
  critiqueId?: string;
  observationId?: string;
  eligible?: boolean;
}

function lastMessage(provider: PlanCritiqueProvider, input: HookInput): string | null {
  if (provider === 'cursor') return textField(input, 'last_assistant_message', 'summary', 'result');
  return textField(input, 'last_assistant_message');
}

function isCritiqueAgent(input: HookInput, raw: string | null): boolean {
  const identity = [
    textField(input, 'agent_type'),
    textField(input, 'subagent_type'),
    textField(input, 'agent_name'),
    textField(input, 'task_name'),
    textField(input, 'task'),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (CRITIQUE_AGENT_RE.test(identity)) return true;
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as { kind?: unknown };
    return parsed?.kind === 'plan_critique';
  } catch {
    return false;
  }
}

function transcriptEvidence(input: HookInput): {
  blob: string | null;
  expiresAt: string | null;
} {
  if (process.env.DEVKIT_PLAN_CRITIQUE_CAPTURE_TRANSCRIPTS !== '1') {
    return { blob: null, expiresAt: null };
  }
  const path = textField(input, 'agent_transcript_path', 'transcript_path');
  if (!path) return { blob: null, expiresAt: null };
  try {
    const daysRaw = Number.parseInt(
      process.env.DEVKIT_PLAN_CRITIQUE_TRANSCRIPT_RETENTION_DAYS ?? '7',
      10,
    );
    const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(daysRaw, 90) : 7;
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    return { blob: writeContentBlob(readFileSync(path, 'utf8'), 'transcript'), expiresAt };
  } catch {
    return { blob: null, expiresAt: null };
  }
}

export function captureSubagentStop(
  provider: PlanCritiqueProvider,
  input: HookInput,
  cwd = textField(input, 'cwd') ?? process.cwd(),
): CaptureResult {
  if (process.env.DEVKIT_NO_TELEMETRY === '1')
    return { status: 'skipped', reason: 'telemetry_disabled' };
  const message = lastMessage(provider, input);
  const providerStatus = cursorProviderStatus(provider, input);
  if (!isCritiqueAgent(input, message)) return { status: 'skipped', reason: 'not_plan_critique' };
  if (!message && providerStatus !== 'aborted' && providerStatus !== 'error')
    return { status: 'skipped', reason: 'missing_final_message' };
  const raw = message ?? '';

  try {
    return withEvidenceLock(() => {
      pruneExpiredTranscriptBlobs();
      const context = repositoryContext(cwd);
      const identity = workIdentity(provider, input, context.repositoryFingerprint);
      const duplicate = captureByInvocation(
        provider,
        context.repositoryFingerprint,
        identity.providerInvocationHash,
        identity.providerSessionHash,
        identity.providerTurnHash,
      );
      const duplicateRecord = duplicate ? readRecord(duplicate.critiqueId) : null;
      if (duplicate && duplicateRecord) {
        return {
          status: 'captured' as const,
          reason: 'duplicate_provider_invocation',
          critiqueId: duplicate.critiqueId,
          observationId: duplicate.observationId,
          eligible: duplicateRecord.contract.eligible,
        };
      }
      const contract = parsePlanCritiqueResponse(raw);
      const transcript = transcriptEvidence(input);
      const record = makeRecord({
        contract,
        context,
        workId: identity.workId,
        provider,
        providerStatus,
        model: textField(input, 'model'),
        prompt: textField(input, 'prompt', 'task'),
        completedAt: textField(input, 'completed_at'),
        parentCritiqueId: identity.parentCritiqueId,
        pass: identity.pass,
        transcriptBlob: transcript.blob,
        transcriptExpiresAt: transcript.expiresAt,
      });
      persistRecord(record);
      const observationId = randomUUID();
      const bindingPath = persistBinding(context, record);
      try {
        persistImmutableJson(`observations/${observationId}.json`, {
          schemaVersion: 1,
          kind: 'plan_critique_capture_observation',
          observationId,
          provider,
          providerStatus,
          providerSessionHash: identity.providerSessionHash,
          providerTurnHash: identity.providerTurnHash,
          providerInvocationHash: identity.providerInvocationHash,
          repositoryFingerprint: context.repositoryFingerprint,
          captureOrdinal: nextCaptureOrdinal(),
          identityCapability: identity.identityCapability,
          workId: identity.workId,
          critiqueId: record.critiqueId,
          pass: identity.pass,
          parentCritiqueId: identity.parentCritiqueId,
          capturedAt: record.capturedAt,
        } satisfies CaptureObservationV1);
      } catch (error) {
        if (bindingPath) unlinkSync(bindingPath);
        throw error;
      }
      return {
        status: 'captured' as const,
        reason: record.contract.eligibilityReason,
        critiqueId: record.critiqueId,
        observationId,
        eligible: record.contract.eligible,
      };
    });
  } catch (error) {
    return {
      status: 'failed',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function observePlanStop(
  provider: PlanCritiqueProvider,
  input: HookInput,
  cwd = textField(input, 'cwd') ?? process.cwd(),
): CaptureResult {
  if (process.env.DEVKIT_NO_TELEMETRY === '1')
    return { status: 'skipped', reason: 'telemetry_disabled' };
  try {
    return withEvidenceLock(() => {
      const context = repositoryContext(cwd);
      const captures = captureObservations(provider, input, context.repositoryFingerprint);
      const observationId = randomUUID();
      if (provider === 'cursor') {
        persistImmutableJson(`observations/${observationId}.json`, {
          schemaVersion: 1,
          kind: 'provider_capability_observation',
          observationId,
          provider,
          capability: 'current_composer_mode_at_stop',
          availability: 'unavailable',
          observedAt: new Date().toISOString(),
          reason: 'composer_mode_capability_unavailable',
          repositoryFingerprint: context.repositoryFingerprint,
          providerSessionHash: providerSessionHash(provider, input),
          providerTurnHash: reliableTurnHash(provider, input),
          consumedCaptureIds: captures.map((capture) => capture.observationId),
          selectedCaptureId: null,
          identityCapability: 'composer_mode_unavailable',
        });
        return {
          status: 'skipped' as const,
          reason: 'composer_mode_capability_unavailable',
          observationId,
        };
      }

      const planMode = textField(input, 'permission_mode') === 'plan';
      if (!planMode) {
        persistImmutableJson(`observations/${observationId}.json`, {
          schemaVersion: 1,
          kind: 'plan_stop_observation',
          observationId,
          workId: null,
          provider,
          providerSessionHash: providerSessionHash(provider, input),
          providerTurnHash: reliableTurnHash(provider, input),
          repositoryFingerprint: context.repositoryFingerprint,
          branch: context.branch,
          head: context.head,
          observedAt: new Date().toISOString(),
          consumedCaptureIds: captures.map((capture) => capture.observationId),
          selectedCaptureId: null,
          identityCapability: 'not_plan_mode',
          critiqueId: null,
          status: 'skipped',
          reason: 'not_plan_mode',
          finalPlanHash: null,
          finalPlanBlob: null,
        });
        return { status: 'skipped' as const, reason: 'not_plan_mode', observationId };
      }

      const latestEligibleCapture = captures
        .filter((capture) => readRecord(capture.critiqueId)?.contract.eligible === true)
        .at(-1);
      const work = latestEligibleCapture?.workId ?? null;
      const resolution = work
        ? resolveEligibleBinding(cwd, work, latestEligibleCapture?.critiqueId)
        : null;
      const latest = resolution?.record ?? null;
      const skippedReason =
        resolution?.reason ??
        (captures.length > 0 ? 'no_eligible_turn_critique' : 'no_turn_critique');
      const finalPlan = lastMessage(provider, input);
      persistImmutableJson(`observations/${observationId}.json`, {
        schemaVersion: 1,
        kind: 'plan_stop_observation',
        observationId,
        workId: work ?? null,
        provider,
        providerSessionHash: providerSessionHash(provider, input),
        providerTurnHash: reliableTurnHash(provider, input),
        repositoryFingerprint: context.repositoryFingerprint,
        branch: context.branch,
        head: context.head,
        observedAt: new Date().toISOString(),
        consumedCaptureIds: captures.map((capture) => capture.observationId),
        selectedCaptureId: latestEligibleCapture?.observationId ?? null,
        identityCapability: latestEligibleCapture?.identityCapability ?? null,
        critiqueId: latest?.critiqueId ?? null,
        status: latest ? 'linked' : 'skipped',
        reason: latest ? 'matched_eligible_binding' : skippedReason,
        finalPlanHash: finalPlan ? sha256Text(finalPlan) : null,
        finalPlanBlob: finalPlan ? writeContentBlob(finalPlan, 'plan') : null,
      });
      return {
        status: 'observed' as const,
        reason: latest ? 'linked' : skippedReason,
        observationId,
        critiqueId: latest?.critiqueId,
      };
    });
  } catch (error) {
    return {
      status: 'failed',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Shadow-only commit observation. The projection is recorded, never added to reviewer input. */
export function observeCommitProjection(cwd = process.cwd()): CaptureResult {
  if (process.env.DEVKIT_NO_TELEMETRY === '1')
    return { status: 'skipped', reason: 'telemetry_disabled' };
  try {
    return withEvidenceLock(() => {
      const explicitWork = process.env.DEVKIT_WORK_ID
        ? sha256Text(`explicit:${process.env.DEVKIT_WORK_ID}`)
        : undefined;
      const resolution = resolveEligibleBinding(cwd, explicitWork);
      const observationId = randomUUID();
      persistImmutableJson(`commit-projections/${observationId}.json`, {
        schemaVersion: 1,
        kind: 'plan_critique_commit_projection_observation',
        observationId,
        observedAt: new Date().toISOString(),
        status: resolution.status,
        reason: resolution.reason,
        candidates: resolution.candidates,
        critiqueId: resolution.record?.critiqueId ?? null,
        projection: resolution.record?.sanitizedProjection
          ? buildCommitProjection(resolution.record.sanitizedProjection)
          : null,
      });
      return {
        status: 'observed' as const,
        reason: resolution.reason,
        observationId,
        critiqueId: resolution.record?.critiqueId,
      };
    });
  } catch (error) {
    return { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }
}

// Internal hook entry point. This is intentionally not exported as a devkit command: generated
// commit hooks invoke the shipped module by path and always ignore its exit status.
if (CAPTURE_ENTRY_RE.test(process.argv[1] ?? '') && process.argv[2] === 'commit-projection') {
  observeCommitProjection(process.cwd());
}
