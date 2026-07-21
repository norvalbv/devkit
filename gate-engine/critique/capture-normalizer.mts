import { TextDecoder } from 'node:util';
import { capturePlanCritiqueRecord } from './evidence-capture-store.mts';
import {
  PLAN_CRITIQUE_PROVIDERS,
  type PlanCritiqueCaptureInputV1,
  type PlanCritiqueContractFactsV1,
  type PlanCritiqueProvider,
  type Sha256,
  sha256Bytes,
  snapshotPlanCritiquePayloads,
} from './evidence-record.mts';
import { parsePlanCritiqueResponse } from './response-contract.mts';

export const PLAN_CRITIQUE_CALLBACK_IDENTITY_MAX_BYTES = 4 * 1024;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

export interface PlanCritiqueCompletedCallbackV1
  extends Pick<
    PlanCritiqueCaptureInputV1,
    'workId' | 'repository' | 'providerCompletedAt' | 'exactResponse' | 'opaqueTranscript'
  > {
  provider: PlanCritiqueProvider;
  callbackIdentity: string;
  model: string | null;
  promptHash: Sha256 | null;
}

function callbackHash(provider: PlanCritiqueProvider, identity: string): Sha256 {
  const containsControl =
    typeof identity === 'string' &&
    [...identity].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    });
  if (
    !PLAN_CRITIQUE_PROVIDERS.includes(provider) ||
    typeof identity !== 'string' ||
    identity.trim().length === 0 ||
    Buffer.byteLength(identity, 'utf8') > PLAN_CRITIQUE_CALLBACK_IDENTITY_MAX_BYTES ||
    containsControl
  )
    throw new Error('invalid plan critique callback identity');
  return sha256Bytes(
    Buffer.from(JSON.stringify(['plan_critique_callback', 1, provider, identity]), 'utf8'),
  );
}

function invalidContract(code = 'INVALID_JSON', path = '$'): PlanCritiqueContractFactsV1 {
  return {
    state: 'invalid',
    error: { code, path },
    status: null,
    verdict: null,
    criticalCount: null,
  };
}

function contractFacts(exactResponse: Uint8Array): PlanCritiqueContractFactsV1 {
  let raw: string;
  try {
    raw = UTF8.decode(exactResponse);
  } catch {
    return invalidContract();
  }
  const parsed = parsePlanCritiqueResponse(raw);
  if (!parsed.ok) return invalidContract(parsed.error.code, parsed.error.path);
  return {
    state: 'valid',
    error: null,
    status: parsed.value.status,
    verdict: parsed.value.verdict,
    criticalCount:
      parsed.value.status === 'reviewed'
        ? parsed.value.findings.filter((finding) => finding.severity === 'CRITICAL').length
        : null,
  };
}

function normalizePlanCritiqueCompletedCallback(
  input: PlanCritiqueCompletedCallbackV1,
): PlanCritiqueCaptureInputV1 {
  const derivedCallbackHash = callbackHash(input.provider, input.callbackIdentity);
  const transcript = input.opaqueTranscript;
  const snapshots = snapshotPlanCritiquePayloads({
    exactResponse: input.exactResponse,
    opaqueTranscript: transcript?.bytes,
  });
  return {
    workId: input.workId,
    execution: {
      provider: input.provider,
      callbackHash: derivedCallbackHash,
      model: input.model,
      promptHash: input.promptHash,
    },
    repository: input.repository,
    providerCompletedAt: input.providerCompletedAt,
    contract: contractFacts(snapshots.exactResponse),
    exactResponse: snapshots.exactResponse,
    opaqueTranscript: snapshots.opaqueTranscript
      ? { bytes: snapshots.opaqueTranscript, expiresAt: transcript?.expiresAt as string }
      : undefined,
  };
}

/** Normalize trusted provider-adapter fields and persist them without exposing mutable bytes. */
export function capturePlanCritiqueCompletedCallback(
  input: PlanCritiqueCompletedCallbackV1,
  options: { root?: string } = {},
) {
  return capturePlanCritiqueRecord(normalizePlanCritiqueCompletedCallback(input), options);
}
