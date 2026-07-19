import { unlinkSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as evidenceStore from '../evidence-store.mts';
import { bytes, recordFor, temporaryRoot } from './evidence-store-fixture.mts';

describe('plan critique transcript retention', () => {
  it('enforces expiry from the real clock and keeps the durable record after cleanup', () => {
    const root = temporaryRoot();
    const exact = bytes('{"status":"reviewed"}');
    const transcript = bytes('opaque\u0000transcript');
    const record = recordFor(exact, { transcript });
    if (!record.opaqueTranscript) throw new Error('fixture is incomplete');
    evidenceStore.persistPlanCritiqueRecord(
      record,
      { exactResponse: exact, opaqueTranscript: transcript },
      { root },
    );

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-20T00:00:00.000Z'));
      expect(evidenceStore.readPlanCritiqueTranscript(record.critiqueId, { root })).toEqual(
        Buffer.from(transcript),
      );
      vi.setSystemTime(new Date(record.opaqueTranscript.expiresAt));
      expect(evidenceStore.readPlanCritiqueTranscript(record.critiqueId, { root })).toBeNull();
    } finally {
      vi.useRealTimers();
    }

    unlinkSync(path.join(root, record.opaqueTranscript.ref));
    expect(evidenceStore.readPlanCritiqueRecord(record.critiqueId, { root })).toEqual(record);
  });

  it('does not export a generic blob reader that can bypass transcript expiry', () => {
    expect('readPlanCritiqueBlob' in evidenceStore).toBe(false);
  });
});
