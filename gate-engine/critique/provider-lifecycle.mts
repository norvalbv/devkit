import type { PlanCritiqueContractResult } from './contract.mts';

export type PlanCritiqueProvider = 'claude' | 'codex' | 'cursor';
export const PLAN_CRITIQUE_PROVIDER_STATUSES = [
  'completed',
  'aborted',
  'error',
  'unknown',
  null,
] as const;
export type PlanCritiqueProviderStatus = (typeof PLAN_CRITIQUE_PROVIDER_STATUSES)[number];

export const isPlanCritiqueProviderStatus = (value: unknown): value is PlanCritiqueProviderStatus =>
  PLAN_CRITIQUE_PROVIDER_STATUSES.includes(value as PlanCritiqueProviderStatus);

/** Provider lifecycle failures are retained as evidence but can never become receipts. */
export function applyProviderLifecycleStatus(
  contract: PlanCritiqueContractResult,
  provider: PlanCritiqueProvider,
  status: PlanCritiqueProviderStatus,
): PlanCritiqueContractResult {
  if (provider !== 'cursor' || status === 'completed') return contract;
  const reason =
    status === null || status === 'unknown'
      ? 'cursor subagent status was missing or unsupported'
      : `cursor subagent status was ${status}`;
  return {
    ...contract,
    state: 'invalid',
    errors: [...contract.errors, reason],
    value: null,
  };
}
