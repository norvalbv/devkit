/**
 * Audited provider-contract support for exact, parent-bound plan-critique capture. This registry is
 * orthogonal to install/default policy and does not probe, register, or activate provider hooks.
 */
export const PLAN_EVIDENCE_CAPTURE_CAPABILITIES = {
    claude: { availability: 'available' },
    codex: {
        availability: 'unavailable',
        reason: 'parent_plan_correlation_unavailable',
        assessedProviderContract: 'rust-v0.145.0-alpha.18',
    },
    cursor: {
        availability: 'unavailable',
        reason: 'verbatim_response_and_completion_identity_unavailable',
    },
};
