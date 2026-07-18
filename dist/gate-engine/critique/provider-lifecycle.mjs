export const PLAN_CRITIQUE_PROVIDER_STATUSES = [
    'completed',
    'aborted',
    'error',
    'unknown',
    null,
];
export const isPlanCritiqueProviderStatus = (value) => PLAN_CRITIQUE_PROVIDER_STATUSES.includes(value);
/** Provider lifecycle failures are retained as evidence but can never become receipts. */
export function applyProviderLifecycleStatus(contract, provider, status) {
    if (provider !== 'cursor' || status === 'completed')
        return contract;
    const reason = status === null || status === 'unknown'
        ? 'cursor subagent status was missing or unsupported'
        : `cursor subagent status was ${status}`;
    return {
        ...contract,
        state: 'invalid',
        errors: [...contract.errors, reason],
        value: null,
    };
}
