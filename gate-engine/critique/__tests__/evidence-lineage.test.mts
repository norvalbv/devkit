import { describe, expect, it } from 'vitest';
import { derivePlanCritiqueId, persistPlanCritiqueRecord } from '../evidence-store.mts';
import { bytes, recordFor, sha256Bytes, temporaryRoot } from './evidence-store-fixture.mts';

describe('plan critique evidence lineage', () => {
  it('accepts only a contiguous recheck whose persisted parent was blocking', () => {
    const root = temporaryRoot();
    const parentBytes = bytes('{"pass":1}');
    const parent = recordFor(parentBytes);
    parent.contract.verdict = 'RETHINK';
    parent.contract.criticalCount = 1;
    parent.contract.eligibility = { eligible: false, reason: 'blocking_verdict' };
    persistPlanCritiqueRecord(parent, { exactResponse: parentBytes }, { root });

    const childBytes = bytes('{"pass":2}');
    const child = recordFor(childBytes);
    child.lineage = { pass: 2, parentCritiqueId: parent.critiqueId };
    child.critiqueId = derivePlanCritiqueId(child);
    expect(persistPlanCritiqueRecord(child, { exactResponse: childBytes }, { root }).state).toBe(
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

    const soundBytes = bytes('{"sound":true}');
    const soundParent = recordFor(soundBytes);
    soundParent.execution.callbackHash = sha256Bytes(bytes('sound-parent'));
    soundParent.critiqueId = derivePlanCritiqueId(soundParent);
    persistPlanCritiqueRecord(soundParent, { exactResponse: soundBytes }, { root });
    const unnecessary = recordFor(bytes('unnecessary'));
    unnecessary.lineage = { pass: 2, parentCritiqueId: soundParent.critiqueId };
    unnecessary.critiqueId = derivePlanCritiqueId(unnecessary);
    expect(() =>
      persistPlanCritiqueRecord(unnecessary, { exactResponse: bytes('unnecessary') }, { root }),
    ).toThrow(/parentCritiqueId/);
  });
});
