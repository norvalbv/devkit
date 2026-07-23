import { describe, expect, it } from 'vitest';
import { PLAN_CRITIQUE_PROVIDERS } from '../evidence-record.mts';
import { PLAN_EVIDENCE_CAPTURE_CAPABILITIES } from './plan-evidence.mts';

describe('plan evidence capture capabilities', () => {
  it('covers every evidence provider in canonical order', () => {
    expect(Object.keys(PLAN_EVIDENCE_CAPTURE_CAPABILITIES)).toEqual(PLAN_CRITIQUE_PROVIDERS);
  });

  it('allows exact parent-bound Claude capture', () => {
    expect(PLAN_EVIDENCE_CAPTURE_CAPABILITIES.claude).toEqual({ availability: 'available' });
  });

  it('skips Codex v0.145 because the child callback cannot be joined to its parent plan', () => {
    expect(PLAN_EVIDENCE_CAPTURE_CAPABILITIES.codex).toEqual({
      availability: 'unavailable',
      reason: 'parent_plan_correlation_unavailable',
      assessedProviderContract: 'rust-v0.145.0-alpha.18',
    });
  });

  it('skips Cursor without a verbatim response and completion identity', () => {
    expect(PLAN_EVIDENCE_CAPTURE_CAPABILITIES.cursor).toEqual({
      availability: 'unavailable',
      reason: 'verbatim_response_and_completion_identity_unavailable',
    });
  });
});
