import { describe, expect, it } from 'vitest';
import { derivePlanCritiqueId, persistPlanCritiqueRecord } from '../evidence-store.mts';
import { bytes, recordFor, sha256Bytes, temporaryRoot } from './evidence-store-fixture.mts';

describe('plan critique evidence lineage', () => {
  it.each([
    'blocking_verdict',
    'critical_findings',
  ] as const)('requires contiguous parents after a %s while retaining later attempts', (parentReason) => {
    const root = temporaryRoot();
    const parentBytes = bytes('{"pass":1}');
    const parent = recordFor(parentBytes);
    parent.contract.verdict =
      parentReason === 'blocking_verdict' ? 'RETHINK' : 'PROCEED_WITH_CHANGES';
    parent.contract.criticalCount = 1;
    parent.contract.eligibility = { eligible: false, reason: parentReason };
    persistPlanCritiqueRecord(parent, { exactResponse: parentBytes }, { root });

    const childBytes = bytes('{"pass":2}');
    const child = recordFor(childBytes);
    child.lineage = { pass: 2, parentCritiqueId: parent.critiqueId };
    child.critiqueId = derivePlanCritiqueId(child);
    child.contract.eligibility = { eligible: false, reason: 'unnecessary_recheck' };
    expect(() => persistPlanCritiqueRecord(child, { exactResponse: childBytes }, { root })).toThrow(
      /contract\.eligibility/,
    );
    child.contract.eligibility = { eligible: true, reason: 'eligible' };
    expect(persistPlanCritiqueRecord(child, { exactResponse: childBytes }, { root }).state).toBe(
      'created',
    );

    const thirdBytes = bytes('{"pass":3}');
    const third = recordFor(thirdBytes);
    third.lineage = { pass: 3, parentCritiqueId: child.critiqueId };
    third.contract.eligibility = { eligible: false, reason: 'retry_limit_exceeded' };
    third.critiqueId = derivePlanCritiqueId(third);
    expect(persistPlanCritiqueRecord(third, { exactResponse: thirdBytes }, { root }).state).toBe(
      'created',
    );

    const fourthBytes = bytes('{"pass":4}');
    const fourth = recordFor(fourthBytes);
    fourth.lineage = { pass: 4, parentCritiqueId: third.critiqueId };
    fourth.contract.eligibility = { eligible: false, reason: 'retry_limit_exceeded' };
    fourth.critiqueId = derivePlanCritiqueId(fourth);
    expect(persistPlanCritiqueRecord(fourth, { exactResponse: fourthBytes }, { root }).state).toBe(
      'created',
    );

    const missingParent = recordFor(bytes('missing'));
    missingParent.lineage = { pass: 2, parentCritiqueId: `pc1_${'f'.repeat(64)}` };
    missingParent.critiqueId = derivePlanCritiqueId(missingParent);
    expect(() =>
      persistPlanCritiqueRecord(missingParent, { exactResponse: bytes('missing') }, { root }),
    ).toThrow(/parentCritiqueId/);

    const skippedPass = recordFor(bytes('skip'));
    skippedPass.lineage = { pass: 3, parentCritiqueId: parent.critiqueId };
    skippedPass.contract.eligibility = { eligible: false, reason: 'retry_limit_exceeded' };
    skippedPass.critiqueId = derivePlanCritiqueId(skippedPass);
    expect(() =>
      persistPlanCritiqueRecord(skippedPass, { exactResponse: bytes('skip') }, { root }),
    ).toThrow(/lineage\.pass/);

    for (const mismatch of ['work', 'repository'] as const) {
      const mismatchBytes = bytes(`mismatch:${mismatch}`);
      const mismatched = recordFor(mismatchBytes);
      mismatched.lineage = { pass: 2, parentCritiqueId: parent.critiqueId };
      if (mismatch === 'work') mismatched.workId = 'other-work';
      else mismatched.repository.fingerprint = '0'.repeat(64);
      mismatched.critiqueId = derivePlanCritiqueId(mismatched);
      expect(() =>
        persistPlanCritiqueRecord(mismatched, { exactResponse: mismatchBytes }, { root }),
      ).toThrow(/parentCritiqueId/);
    }
  });

  it.each([
    'sound',
    'invalid',
    'wrong_phase',
    'aborted',
  ] as const)('retains a pass 2 after a %s parent as an unnecessary recheck', (parentState) => {
    const root = temporaryRoot();
    const parentBytes = bytes(`parent:${parentState}`);
    const parent = recordFor(parentBytes);
    parent.execution.callbackHash = sha256Bytes(bytes(`parent:${parentState}`));
    if (parentState === 'invalid') {
      parent.contract = {
        state: 'invalid',
        error: { code: 'MALFORMED_JSON', path: '$' },
        status: null,
        verdict: null,
        criticalCount: null,
        eligibility: { eligible: false, reason: 'invalid_contract' },
      };
    } else if (parentState === 'wrong_phase' || parentState === 'aborted') {
      parent.contract = {
        state: 'valid',
        error: null,
        status: parentState,
        verdict: null,
        criticalCount: null,
        eligibility: { eligible: false, reason: parentState },
      };
    }
    parent.critiqueId = derivePlanCritiqueId(parent);
    persistPlanCritiqueRecord(parent, { exactResponse: parentBytes }, { root });

    const childBytes = bytes(`child:${parentState}`);
    const child = recordFor(childBytes);
    child.lineage = { pass: 2, parentCritiqueId: parent.critiqueId };
    child.critiqueId = derivePlanCritiqueId(child);
    expect(() => persistPlanCritiqueRecord(child, { exactResponse: childBytes }, { root })).toThrow(
      /contract\.eligibility/,
    );

    child.contract.eligibility = { eligible: false, reason: 'unnecessary_recheck' };
    expect(persistPlanCritiqueRecord(child, { exactResponse: childBytes }, { root }).state).toBe(
      'created',
    );

    const thirdBytes = bytes(`third:${parentState}`);
    const third = recordFor(thirdBytes);
    third.lineage = { pass: 3, parentCritiqueId: child.critiqueId };
    third.contract.eligibility = { eligible: false, reason: 'retry_limit_exceeded' };
    third.critiqueId = derivePlanCritiqueId(third);
    expect(persistPlanCritiqueRecord(third, { exactResponse: thirdBytes }, { root }).state).toBe(
      'created',
    );
  });
});
