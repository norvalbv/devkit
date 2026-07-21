import {
  chmodSync,
  lstatSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { canonicalPlanCritiqueRecordJson } from '../evidence-record.mts';
import {
  derivePlanCritiqueId,
  listPlanCritiqueRecords,
  PLAN_CRITIQUE_EXACT_RESPONSE_MAX_BYTES,
  PLAN_CRITIQUE_PROJECTION_MAX_BYTES,
  persistPlanCritiqueRecord,
  readPlanCritiqueExactResponse,
  readPlanCritiqueProjection,
  readPlanCritiqueRecord,
} from '../evidence-store.mts';
import { withPlanCritiquePersistenceLock } from '../persistence-lock.mts';
import { bytes, recordFor, sha256Bytes, temporaryRoot } from './evidence-store-fixture.mts';

describe('plan critique evidence store', () => {
  it('derives the specified callback identity without timestamps or response bytes', () => {
    const record = recordFor(bytes('{}'));
    const expected = sha256Bytes(
      bytes(
        JSON.stringify([
          'plan_critique_record',
          1,
          record.execution.provider,
          record.execution.callbackHash,
          record.repository.fingerprint,
          record.workId,
          record.lineage.pass,
          record.lineage.parentCritiqueId,
        ]),
      ),
    );
    expect(record.critiqueId).toBe(`pc1_${expected}`);
  });

  it('round-trips exact bytes and keeps records and managed paths private', () => {
    const root = temporaryRoot();
    const exact = bytes('\u0000not JSON\r\n{still exact}');
    const record = recordFor(exact);
    const first = persistPlanCritiqueRecord(record, { exactResponse: exact }, { root });

    expect(first.state).toBe('created');
    expect(readPlanCritiqueRecord(record.critiqueId, { root })).toEqual(record);
    expect(readPlanCritiqueExactResponse(record.critiqueId, { root })).toEqual(Buffer.from(exact));
    expect(listPlanCritiqueRecords({ root })).toEqual([record]);
    expect(lstatSync(root).mode & 0o777).toBe(0o700);
    expect(lstatSync(path.join(root, record.exactResponse.ref)).mode & 0o777).toBe(0o600);
    expect(lstatSync(path.join(root, 'records', `${record.critiqueId}.json`)).mode & 0o777).toBe(
      0o600,
    );
    writeFileSync(path.join(root, record.exactResponse.ref), 'corrupt');
    expect(readPlanCritiqueExactResponse(record.critiqueId, { root })).toBeNull();
  });

  it('publishes nothing when another evidence operation owns the persistence lock', () => {
    const root = temporaryRoot();
    const exact = bytes('serialized response');
    const record = recordFor(exact);

    withPlanCritiquePersistenceLock({ root }, () => {
      expect(() => persistPlanCritiqueRecord(record, { exactResponse: exact }, { root })).toThrow(
        /^Another plan critique evidence persistence is in progress$/,
      );
      expect(readPlanCritiqueRecord(record.critiqueId, { root })).toBeNull();
    });

    expect(persistPlanCritiqueRecord(record, { exactResponse: exact }, { root }).state).toBe(
      'created',
    );
  });

  it('stores response, projection, and optional transcript as independent addressed blobs', () => {
    const root = temporaryRoot();
    const exact = bytes('{"status":"reviewed"}');
    const projection = bytes('{"safe":true}');
    const transcript = bytes('opaque\u0000transcript');
    const record = recordFor(exact, { projection, transcript });

    persistPlanCritiqueRecord(
      record,
      { exactResponse: exact, sanitizedProjection: projection, opaqueTranscript: transcript },
      { root },
    );
    if (!record.sanitizedProjection || !record.opaqueTranscript)
      throw new Error('fixture is incomplete');
    expect(readPlanCritiqueProjection(record.critiqueId, { root })).toEqual(
      Buffer.from(projection),
    );
  });

  it('snapshots shared payload bytes before validation and publication', async () => {
    const root = temporaryRoot();
    const shared = new SharedArrayBuffer(PLAN_CRITIQUE_EXACT_RESPONSE_MAX_BYTES);
    const exact = new Uint8Array(shared);
    exact.fill(1);
    const record = recordFor(exact);
    const worker = new Worker(
      `const { existsSync, watch } = require('node:fs');
       const path = require('node:path');
       const { parentPort, workerData } = require('node:worker_threads');
       const target = path.join(workerData.parent, workerData.name);
       const watcher = watch(workerData.parent, (_event, name) => {
         if (String(name) !== workerData.name || !existsSync(target)) return;
         new Uint8Array(workerData.shared).fill(2);
         watcher.close();
         parentPort.postMessage('mutated');
       });
       parentPort.postMessage('ready');`,
      {
        eval: true,
        workerData: { parent: path.dirname(root), name: path.basename(root), shared },
      },
    );
    const nextMessage = (): Promise<unknown> =>
      new Promise((resolve, reject) => {
        worker.once('message', resolve);
        worker.once('error', reject);
      });

    try {
      await expect(nextMessage()).resolves.toBe('ready');
      persistPlanCritiqueRecord(record, { exactResponse: exact }, { root });
      await expect(nextMessage()).resolves.toBe('mutated');
      expect(
        readPlanCritiqueExactResponse(record.critiqueId, { root })?.equals(
          Buffer.alloc(exact.byteLength, 1),
        ),
      ).toBe(true);
    } finally {
      await worker.terminate();
    }
  });

  it('retains invalid contract evidence without pretending it is eligible', () => {
    const root = temporaryRoot();
    const exact = bytes('not JSON');
    const record = recordFor(exact);
    record.contract = {
      state: 'invalid',
      error: { code: 'MALFORMED_JSON', path: '$' },
      status: null,
      verdict: null,
      criticalCount: null,
      eligibility: { eligible: false, reason: 'invalid_contract' },
    };
    persistPlanCritiqueRecord(record, { exactResponse: exact }, { root });
    expect(readPlanCritiqueRecord(record.critiqueId, { root })).toEqual(record);
  });

  it('is idempotent for an identical callback and never replaces its record inode', () => {
    const root = temporaryRoot();
    const exact = bytes('{}');
    const record = recordFor(exact);
    persistPlanCritiqueRecord(record, { exactResponse: exact }, { root });
    const file = path.join(root, 'records', `${record.critiqueId}.json`);
    const before = lstatSync(file);

    const reordered = Object.fromEntries(
      Object.entries(record).reverse(),
    ) as unknown as PlanCritiqueRecordV1;
    const duplicate = persistPlanCritiqueRecord(reordered, { exactResponse: exact }, { root });
    const after = lstatSync(file);
    expect(duplicate.state).toBe('existing');
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('returns the first stored record when one callback is replayed with new capture metadata', () => {
    const root = temporaryRoot();
    const exact = bytes('{}');
    const record = recordFor(exact);
    persistPlanCritiqueRecord(record, { exactResponse: exact }, { root });
    const replay = structuredClone(record);
    replay.timestamps.capturedAt = '2026-07-19T01:02:04.000Z';
    replay.lineage = { pass: 2, parentCritiqueId: record.critiqueId };
    replay.contract.eligibility = { eligible: false, reason: 'unnecessary_recheck' };
    replay.critiqueId = derivePlanCritiqueId(replay);

    expect(replay.critiqueId).not.toBe(record.critiqueId);
    expect(persistPlanCritiqueRecord(replay, { exactResponse: exact }, { root })).toEqual({
      state: 'existing',
      record,
    });
    expect(listPlanCritiqueRecords({ root })).toEqual([record]);
  });

  it('rejects callback replays that change work identity', () => {
    const root = temporaryRoot();
    const exact = bytes('{}');
    const record = recordFor(exact);
    persistPlanCritiqueRecord(record, { exactResponse: exact }, { root });
    const conflict = structuredClone(record);
    conflict.workId = 'other-work';
    conflict.critiqueId = derivePlanCritiqueId(conflict);

    expect(() => persistPlanCritiqueRecord(conflict, { exactResponse: exact }, { root })).toThrow(
      /callback identity conflict/,
    );
    expect(listPlanCritiqueRecords({ root })).toEqual([record]);
  });

  it('keeps callback identity authoritative when a durable blob is missing', () => {
    const root = temporaryRoot();
    const exact = bytes('{}');
    const record = recordFor(exact);
    persistPlanCritiqueRecord(record, { exactResponse: exact }, { root });
    unlinkSync(path.join(root, record.exactResponse.ref));
    expect(readPlanCritiqueRecord(record.critiqueId, { root })).toBeNull();

    const conflict = structuredClone(record);
    conflict.workId = 'other-work';
    conflict.critiqueId = derivePlanCritiqueId(conflict);
    expect(() => persistPlanCritiqueRecord(conflict, { exactResponse: exact }, { root })).toThrow(
      /callback identity conflict/,
    );
    expect(readdirSync(path.join(root, 'blobs', 'sha256'))).not.toContain(
      record.exactResponse.sha256,
    );
    expect(listPlanCritiqueRecords({ root })).toEqual([]);
  });

  it('repairs matching missing blobs on an identical callback replay', () => {
    const root = temporaryRoot();
    const exact = bytes('{}');
    const projection = bytes('{"safe":true}');
    const record = recordFor(exact, { projection });
    persistPlanCritiqueRecord(
      record,
      { exactResponse: exact, sanitizedProjection: projection },
      { root },
    );
    if (!record.sanitizedProjection) throw new Error('fixture is incomplete');
    unlinkSync(path.join(root, record.exactResponse.ref));
    unlinkSync(path.join(root, record.sanitizedProjection.ref));

    expect(readPlanCritiqueRecord(record.critiqueId, { root })).toBeNull();
    expect(
      persistPlanCritiqueRecord(
        record,
        { exactResponse: exact, sanitizedProjection: projection },
        { root },
      ).state,
    ).toBe('existing');
    expect(readPlanCritiqueRecord(record.critiqueId, { root })).toEqual(record);
    expect(readPlanCritiqueProjection(record.critiqueId, { root })).toEqual(
      Buffer.from(projection),
    );
  });

  it('treats malformed durable blob entries as unreadable', () => {
    const root = temporaryRoot();
    const exact = bytes('{}');
    const record = recordFor(exact);
    persistPlanCritiqueRecord(record, { exactResponse: exact }, { root });
    const blob = path.join(root, record.exactResponse.ref);
    const outside = path.join(path.dirname(root), 'outside-blob');
    writeFileSync(outside, exact, { mode: 0o600 });
    unlinkSync(blob);
    symlinkSync(outside, blob);

    expect(readPlanCritiqueRecord(record.critiqueId, { root })).toBeNull();
    expect(listPlanCritiqueRecords({ root })).toEqual([]);
  });

  it('does not publish a new blob before rejecting a callback response conflict', () => {
    const root = temporaryRoot();
    const original = bytes('original');
    const record = recordFor(original);
    persistPlanCritiqueRecord(record, { exactResponse: original }, { root });
    const before = readdirSync(path.join(root, 'blobs', 'sha256')).sort();

    const replacement = bytes('replacement');
    const conflict = recordFor(replacement);
    conflict.timestamps.capturedAt = '2026-07-19T01:02:04.000Z';
    expect(conflict.critiqueId).toBe(record.critiqueId);
    expect(() =>
      persistPlanCritiqueRecord(conflict, { exactResponse: replacement }, { root }),
    ).toThrow(/callback identity conflict/);

    expect(readdirSync(path.join(root, 'blobs', 'sha256')).sort()).toEqual(before);
    expect(readPlanCritiqueExactResponse(conflict.critiqueId, { root })).toEqual(
      Buffer.from(original),
    );
  });

  it('keeps callback identities isolated by provider and repository', () => {
    const root = temporaryRoot();
    const exact = bytes('{}');
    const first = recordFor(exact);
    persistPlanCritiqueRecord(first, { exactResponse: exact }, { root });

    const otherProvider = structuredClone(first);
    otherProvider.execution.provider = 'claude';
    otherProvider.critiqueId = derivePlanCritiqueId(otherProvider);
    expect(persistPlanCritiqueRecord(otherProvider, { exactResponse: exact }, { root }).state).toBe(
      'created',
    );

    const otherRepository = structuredClone(first);
    otherRepository.repository.fingerprint = sha256Bytes(bytes('other-repository'));
    otherRepository.critiqueId = derivePlanCritiqueId(otherRepository);
    expect(
      persistPlanCritiqueRecord(otherRepository, { exactResponse: exact }, { root }).state,
    ).toBe('created');
    expect(listPlanCritiqueRecords({ root })).toHaveLength(3);
  });

  it('fails closed when historical records make one callback identity ambiguous', () => {
    const root = temporaryRoot();
    const exact = bytes('{}');
    const first = recordFor(exact);
    persistPlanCritiqueRecord(first, { exactResponse: exact }, { root });

    const historicalDuplicate = structuredClone(first);
    historicalDuplicate.workId = 'historical-work';
    historicalDuplicate.critiqueId = derivePlanCritiqueId(historicalDuplicate);
    writeFileSync(
      path.join(root, 'records', `${historicalDuplicate.critiqueId}.json`),
      canonicalPlanCritiqueRecordJson(historicalDuplicate),
      { mode: 0o600 },
    );

    expect(() => persistPlanCritiqueRecord(first, { exactResponse: exact }, { root })).toThrow(
      /ambiguous plan critique callback identity/,
    );
    expect(listPlanCritiqueRecords({ root })).toHaveLength(2);
  });

  it('rejects mismatched ids, hashes, refs, and optional payload presence', () => {
    const root = temporaryRoot();
    const exact = bytes('{}');
    const wrongId = recordFor(exact);
    wrongId.critiqueId = `pc1_${'0'.repeat(64)}`;
    expect(() => persistPlanCritiqueRecord(wrongId, { exactResponse: exact }, { root })).toThrow(
      /critiqueId/,
    );

    const wrongHash = recordFor(exact);
    wrongHash.exactResponse.sha256 = '0'.repeat(64);
    wrongHash.exactResponse.ref = `blobs/sha256/${'0'.repeat(64)}`;
    expect(() => persistPlanCritiqueRecord(wrongHash, { exactResponse: exact }, { root })).toThrow(
      /exactResponse/,
    );

    const missingProjection = recordFor(exact, { projection: bytes('safe') });
    expect(() =>
      persistPlanCritiqueRecord(missingProjection, { exactResponse: exact }, { root }),
    ).toThrow(/sanitizedProjection/);
  });

  it('rejects unknown fields, invalid enums, malformed metadata, and non-integer counts', () => {
    const exact = bytes('{}');
    const cases: Array<(record: PlanCritiqueRecordV1) => void> = [
      (record) => {
        (record as unknown as Record<string, unknown>).unexpected = true;
      },
      (record) => {
        (record.execution as unknown as Record<string, unknown>).unexpected = true;
      },
      (record) => {
        (record.execution as { provider: string }).provider = 'unknown';
      },
      (record) => {
        record.workId = 'bad\u0000work';
      },
      (record) => {
        (record.repository as { fingerprintSource: string }).fingerprintSource = 'origin';
      },
      (record) => {
        record.repository.head = 'abc123';
      },
      (record) => {
        record.contract.criticalCount = 0.5;
      },
      (record) => {
        record.contract.criticalCount = -0;
      },
    ];

    for (const mutate of cases) {
      const record = recordFor(exact);
      mutate(record);
      expect(() =>
        persistPlanCritiqueRecord(record, { exactResponse: exact }, { root: temporaryRoot() }),
      ).toThrow(/invalid plan critique record/);
    }
  });

  it('rejects hidden serialization hooks and accessor-backed fields', () => {
    const exact = bytes('{}');
    const withToJson = recordFor(exact);
    Object.defineProperty(withToJson, 'toJSON', {
      enumerable: false,
      value: () => ({
        ...withToJson,
        timestamps: { ...withToJson.timestamps, capturedAt: '2026-07-19T01:02:04.000Z' },
      }),
    });
    expect(() =>
      persistPlanCritiqueRecord(withToJson, { exactResponse: exact }, { root: temporaryRoot() }),
    ).toThrow(/invalid plan critique record/);

    const withAccessor = recordFor(exact);
    Object.defineProperty(withAccessor.repository, 'branch', {
      enumerable: true,
      get: () => 'codex/example',
    });
    expect(() =>
      persistPlanCritiqueRecord(withAccessor, { exactResponse: exact }, { root: temporaryRoot() }),
    ).toThrow(/invalid plan critique record/);

    const inheritedHook = recordFor(exact);
    const priorToJson = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
    Object.defineProperty(Object.prototype, 'toJSON', {
      configurable: true,
      enumerable: false,
      value(this: unknown) {
        return this === inheritedHook
          ? {
              ...inheritedHook,
              timestamps: {
                ...inheritedHook.timestamps,
                capturedAt: '2026-07-19T01:02:04.000Z',
              },
            }
          : this;
      },
    });
    try {
      expect(() =>
        persistPlanCritiqueRecord(
          inheritedHook,
          { exactResponse: exact },
          { root: temporaryRoot() },
        ),
      ).toThrow(/invalid plan critique record/);
    } finally {
      if (priorToJson) Object.defineProperty(Object.prototype, 'toJSON', priorToJson);
      else Reflect.deleteProperty(Object.prototype, 'toJSON');
    }
  });

  it('enforces lineage, timestamp, model-hash, transcript, and contract invariants', () => {
    const exact = bytes('{}');
    const invalidRecords: PlanCritiqueRecordV1[] = [];

    const missingParent = recordFor(exact);
    missingParent.lineage.pass = 2;
    missingParent.critiqueId = derivePlanCritiqueId(missingParent);
    invalidRecords.push(missingParent);

    const mismatchedModel = recordFor(exact);
    mismatchedModel.execution.modelHash = null;
    invalidRecords.push(mismatchedModel);

    const nonCanonicalTimestamp = recordFor(exact);
    nonCanonicalTimestamp.timestamps.capturedAt = '2026-07-19T01:02:03Z';
    invalidRecords.push(nonCanonicalTimestamp);

    const completionAfterCapture = recordFor(exact);
    completionAfterCapture.timestamps.providerCompletedAt = '2026-07-19T01:02:04.000Z';
    invalidRecords.push(completionAfterCapture);

    const staleTranscript = recordFor(exact, { transcript: bytes('opaque') });
    if (!staleTranscript.opaqueTranscript) throw new Error('fixture is incomplete');
    staleTranscript.opaqueTranscript.expiresAt = staleTranscript.timestamps.capturedAt;
    invalidRecords.push(staleTranscript);

    const wrongPhaseEligible = recordFor(exact);
    wrongPhaseEligible.contract.status = 'wrong_phase';
    wrongPhaseEligible.contract.verdict = null;
    wrongPhaseEligible.contract.criticalCount = null;
    invalidRecords.push(wrongPhaseEligible);

    const proceedWithCritical = recordFor(exact);
    proceedWithCritical.contract.verdict = 'PROCEED';
    proceedWithCritical.contract.criticalCount = 1;
    proceedWithCritical.contract.eligibility = {
      eligible: false,
      reason: 'critical_findings',
    };
    invalidRecords.push(proceedWithCritical);

    for (const record of invalidRecords) {
      expect(() =>
        persistPlanCritiqueRecord(record, { exactResponse: exact }, { root: temporaryRoot() }),
      ).toThrow(/invalid plan critique record/);
    }
  });

  it('rejects parseable but non-canonical or extended record bytes on read', () => {
    const root = temporaryRoot();
    const exact = bytes('{}');
    const record = recordFor(exact);
    persistPlanCritiqueRecord(record, { exactResponse: exact }, { root });
    const file = path.join(root, 'records', `${record.critiqueId}.json`);
    const extended = { ...record, unexpected: true };
    writeFileSync(file, `${JSON.stringify(extended)}\n`, { mode: 0o600 });

    expect(readPlanCritiqueRecord(record.critiqueId, { root })).toBeNull();
    expect(listPlanCritiqueRecords({ root })).toEqual([]);
  });

  it('rejects an explicitly empty root instead of selecting the home spool', () => {
    const exact = bytes('{}');
    const record = recordFor(exact);

    expect(() => persistPlanCritiqueRecord(record, { exactResponse: exact }, { root: '' })).toThrow(
      /\$\.root/,
    );
    expect(() => readPlanCritiqueRecord(record.critiqueId, { root: '' })).toThrow(/\$\.root/);
    expect(() => listPlanCritiqueRecords({ root: '' })).toThrow(/\$\.root/);
    expect(() =>
      persistPlanCritiqueRecord(record, { exactResponse: exact }, { root: 'relative/evidence' }),
    ).toThrow(/\$\.root/);
  });

  it('rejects oversized response and projection blobs before creating the store', () => {
    const root = temporaryRoot();
    const exact = Buffer.alloc(PLAN_CRITIQUE_EXACT_RESPONSE_MAX_BYTES + 1);
    const oversizedResponse = recordFor(exact);
    expect(() =>
      persistPlanCritiqueRecord(oversizedResponse, { exactResponse: exact }, { root }),
    ).toThrow(/exactResponse payload/);

    const small = bytes('{}');
    const projection = Buffer.alloc(PLAN_CRITIQUE_PROJECTION_MAX_BYTES + 1);
    const oversizedProjection = recordFor(small, { projection });
    expect(() =>
      persistPlanCritiqueRecord(
        oversizedProjection,
        { exactResponse: small, sanitizedProjection: projection },
        { root },
      ),
    ).toThrow(/sanitizedProjection payload/);
    expect(listPlanCritiqueRecords({ root })).toEqual([]);
  });

  it('rejects spoofed byte lengths before allocating or creating the store', () => {
    const root = temporaryRoot();
    const exact = bytes('{}');
    const record = recordFor(exact);
    const spoofed = {
      byteLength: 1,
      length: PLAN_CRITIQUE_EXACT_RESPONSE_MAX_BYTES + 1,
      0: 65,
    } as unknown as Uint8Array;

    expect(() => persistPlanCritiqueRecord(record, { exactResponse: spoofed }, { root })).toThrow(
      /exactResponse payload/,
    );
    expect(listPlanCritiqueRecords({ root })).toEqual([]);
  });

  it('rejects an impossible blob size before publishing any record', () => {
    const root = temporaryRoot();
    const exact = bytes('{}');
    const record = recordFor(exact);
    record.exactResponse.byteLength = -1;
    expect(() => persistPlanCritiqueRecord(record, { exactResponse: exact }, { root })).toThrow(
      /byteLength/,
    );
    expect(readPlanCritiqueRecord(record.critiqueId, { root })).toBeNull();

    const negativeZero = recordFor(exact);
    negativeZero.exactResponse.byteLength = -0;
    expect(() =>
      persistPlanCritiqueRecord(negativeZero, { exactResponse: exact }, { root }),
    ).toThrow(/byteLength/);
  });

  it('rejects a symlink substituted for a content-addressed blob', () => {
    const root = temporaryRoot();
    const exact = bytes('{}');
    const record = recordFor(exact);
    const blob = path.join(root, record.exactResponse.ref);
    const outside = path.join(path.dirname(root), 'outside');
    writeFileSync(outside, 'do not replace');
    const directory = path.dirname(blob);
    chmodSync(path.dirname(root), 0o700);
    // Create only the managed layout needed to stage the hostile destination.
    const bootstrap = recordFor(bytes('bootstrap'));
    bootstrap.execution.callbackHash = sha256Bytes(bytes('bootstrap-callback'));
    bootstrap.critiqueId = derivePlanCritiqueId(bootstrap);
    persistPlanCritiqueRecord(bootstrap, { exactResponse: bytes('bootstrap') }, { root });
    symlinkSync(outside, blob);
    expect(() => persistPlanCritiqueRecord(record, { exactResponse: exact }, { root })).toThrow(
      /symlink/,
    );
    expect(readPlanCritiqueRecord(record.critiqueId, { root })).toBeNull();
    unlinkSync(blob);
    expect(persistPlanCritiqueRecord(record, { exactResponse: exact }, { root }).state).toBe(
      'created',
    );
    expect(readPlanCritiqueRecord(record.critiqueId, { root })).toEqual(record);
    expect(readFileSync(outside, 'utf8')).toBe('do not replace');
    expect(directory).toContain(path.join('blobs', 'sha256'));
  });

  it('lists valid records deterministically and skips malformed files', () => {
    const root = temporaryRoot();
    const first = recordFor(bytes('one'));
    const second = recordFor(bytes('two'));
    second.execution.callbackHash = sha256Bytes(bytes('callback-2'));
    second.critiqueId = derivePlanCritiqueId(second);
    persistPlanCritiqueRecord(second, { exactResponse: bytes('two') }, { root });
    persistPlanCritiqueRecord(first, { exactResponse: bytes('one') }, { root });
    writeFileSync(path.join(root, 'records', `pc1_${'f'.repeat(64)}.json`), '{bad', {
      mode: 0o600,
    });

    expect(listPlanCritiqueRecords({ root }).map((item) => item.critiqueId)).toEqual(
      [first.critiqueId, second.critiqueId].sort(),
    );
  });
});
