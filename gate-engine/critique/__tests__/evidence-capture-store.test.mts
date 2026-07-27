import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  capturePlanCritiqueRecord,
  type PlanCritiqueCaptureInputV1,
} from '../evidence-capture-store.mts';
import {
  derivePlanCritiqueId,
  listPlanCritiqueRecords,
  persistPlanCritiqueRecord,
  readPlanCritiqueExactResponse,
  readPlanCritiqueProjection,
  readPlanCritiqueTranscript,
} from '../evidence-store.mts';
import { bytes, recordFor, sha256Bytes, temporaryRoot } from './evidence-store-fixture.mts';

function captureInput(
  exactResponse: Uint8Array,
  callback = 'callback-1',
): PlanCritiqueCaptureInputV1 {
  return {
    workId: 'work-1',
    execution: {
      provider: 'codex',
      callbackHash: sha256Bytes(bytes(callback)),
      model: 'gpt-5.6',
      promptHash: sha256Bytes(bytes('prompt')),
    },
    repository: {
      fingerprint: sha256Bytes(bytes('repo')),
      fingerprintSource: 'canonical_remote',
      branch: 'codex/example',
      head: 'a'.repeat(40),
    },
    providerCompletedAt: '2026-07-19T01:02:03.000Z',
    contract: {
      state: 'valid',
      error: null,
      status: 'reviewed',
      verdict: 'PROCEED_WITH_CHANGES',
      criticalCount: 0,
    },
    exactResponse,
  };
}

function storedPassOne(root: string, input: PlanCritiqueCaptureInputV1, callback: string): void {
  const exact = input.exactResponse;
  const record = recordFor(exact);
  record.workId = input.workId;
  record.execution.callbackHash = sha256Bytes(bytes(callback));
  record.repository = structuredClone(input.repository);
  record.critiqueId = derivePlanCritiqueId(record);
  persistPlanCritiqueRecord(record, { exactResponse: exact }, { root });
}

interface ChildResult {
  code: number | null;
  stderr: string;
  stdout: string;
}

function runChild(
  script: string,
  root: string,
  callback: string,
  exact: string,
): Promise<ChildResult> {
  const child = spawn(process.execPath, [script, root, callback, exact], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stderr, stdout }));
  });
}

describe('plan critique capture transaction', () => {
  it('derives immutable metadata and content-addressed refs from normalized input', () => {
    const root = temporaryRoot();
    const exact = bytes('{"status":"reviewed"}');
    const projection = bytes('{"safe":true}');
    const transcript = bytes('opaque transcript');
    const input = captureInput(exact);
    input.sanitizedProjection = projection;
    input.opaqueTranscript = {
      bytes: transcript,
      expiresAt: '2030-01-01T00:00:00.000Z',
    };

    const result = capturePlanCritiqueRecord(input, { root });

    expect(result.state).toBe('created');
    expect(result.record.lineage).toEqual({ pass: 1, parentCritiqueId: null });
    expect(result.record.contract.eligibility).toEqual({ eligible: true, reason: 'eligible' });
    expect(result.record.execution.modelHash).toBe(sha256Bytes(bytes('gpt-5.6')));
    expect(result.record.timestamps.capturedAt).toMatch(/\.\d{3}Z$/);
    expect(result.record.exactResponse.sha256).toBe(sha256Bytes(exact));
    expect(result.record.sanitizedProjection?.projectionSchemaVersion).toBe(1);
    expect(readPlanCritiqueExactResponse(result.record.critiqueId, { root })).toEqual(exact);
    expect(readPlanCritiqueProjection(result.record.critiqueId, { root })).toEqual(projection);
    expect(readPlanCritiqueTranscript(result.record.critiqueId, { root })).toEqual(transcript);
  });

  it('derives parent-aware eligibility without allowing replays to consume a pass', () => {
    const root = temporaryRoot();
    const firstInput = captureInput(bytes('first'), 'first');
    const first = capturePlanCritiqueRecord(firstInput, { root });
    const replay = capturePlanCritiqueRecord(structuredClone(firstInput), { root });
    const second = capturePlanCritiqueRecord(captureInput(bytes('second'), 'second'), { root });
    const third = capturePlanCritiqueRecord(captureInput(bytes('third'), 'third'), { root });

    expect(replay).toEqual({ state: 'existing', record: first.record });
    expect(second.record.lineage).toEqual({
      pass: 2,
      parentCritiqueId: first.record.critiqueId,
    });
    expect(second.record.contract.eligibility).toEqual({
      eligible: false,
      reason: 'unnecessary_recheck',
    });
    expect(third.record.lineage).toEqual({
      pass: 3,
      parentCritiqueId: second.record.critiqueId,
    });
    expect(third.record.contract.eligibility).toEqual({
      eligible: false,
      reason: 'retry_limit_exceeded',
    });
    expect(listPlanCritiqueRecords({ root })).toHaveLength(3);

    const requiredRoot = temporaryRoot();
    const blocking = captureInput(bytes('blocking'), 'blocking');
    blocking.contract.verdict = 'RETHINK';
    blocking.contract.criticalCount = 1;
    const parent = capturePlanCritiqueRecord(blocking, { root: requiredRoot });
    const child = capturePlanCritiqueRecord(captureInput(bytes('child'), 'child'), {
      root: requiredRoot,
    });
    expect(parent.record.contract.eligibility.reason).toBe('blocking_verdict');
    expect(child.record.contract.eligibility).toEqual({ eligible: true, reason: 'eligible' });
  });

  it.each([
    [
      'invalid contract',
      {
        state: 'invalid',
        error: { code: 'MALFORMED_JSON', path: '$' },
        status: null,
        verdict: null,
        criticalCount: null,
      },
      'invalid_contract',
    ],
    [
      'wrong phase',
      { state: 'valid', error: null, status: 'wrong_phase', verdict: null, criticalCount: null },
      'wrong_phase',
    ],
    [
      'aborted',
      { state: 'valid', error: null, status: 'aborted', verdict: null, criticalCount: null },
      'aborted',
    ],
    [
      'blocking verdict',
      { state: 'valid', error: null, status: 'reviewed', verdict: 'REJECT', criticalCount: 1 },
      'blocking_verdict',
    ],
    [
      'critical finding',
      {
        state: 'valid',
        error: null,
        status: 'reviewed',
        verdict: 'PROCEED_WITH_CHANGES',
        criticalCount: 1,
      },
      'critical_findings',
    ],
  ] as const)('preserves intrinsic eligibility precedence for %s', (_label, contract, reason) => {
    const input = captureInput(bytes(reason), reason);
    input.contract = structuredClone(contract);
    const result = capturePlanCritiqueRecord(input, { root: temporaryRoot() });
    expect(result.record.contract.eligibility).toEqual({ eligible: false, reason });
  });

  it('rejects callback conflicts and historical lineage forks before publication', () => {
    const root = temporaryRoot();
    const exact = bytes('first');
    const input = captureInput(exact, 'shared-callback');
    capturePlanCritiqueRecord(input, { root });
    const before = readdirSync(path.join(root, 'blobs', 'sha256')).sort();

    const workConflict = captureInput(exact, 'shared-callback');
    workConflict.workId = 'other-work';
    expect(() => capturePlanCritiqueRecord(workConflict, { root })).toThrow(
      /callback identity conflict/,
    );
    expect(() =>
      capturePlanCritiqueRecord(captureInput(bytes('replacement'), 'shared-callback'), { root }),
    ).toThrow(/callback identity conflict/);
    expect(readdirSync(path.join(root, 'blobs', 'sha256')).sort()).toEqual(before);

    const forkRoot = temporaryRoot();
    const forkInput = captureInput(bytes('fork-one'), 'fork-one');
    storedPassOne(forkRoot, forkInput, 'fork-one');
    const secondFork = captureInput(bytes('fork-two'), 'fork-two');
    storedPassOne(forkRoot, secondFork, 'fork-two');
    const rejected = captureInput(bytes('rejected'), 'rejected');
    expect(() => capturePlanCritiqueRecord(rejected, { root: forkRoot })).toThrow(
      /ambiguous plan critique lineage/,
    );
    expect(
      existsSync(path.join(forkRoot, 'blobs', 'sha256', sha256Bytes(rejected.exactResponse))),
    ).toBe(false);
    expect(listPlanCritiqueRecords({ root: forkRoot })).toHaveLength(2);
  });

  it('rejects accessor-backed capture metadata before invoking it', () => {
    const input = captureInput(bytes('hostile'), 'hostile');
    let invoked = false;
    Object.defineProperty(input.execution, 'model', {
      enumerable: true,
      get() {
        invoked = true;
        return 'hostile';
      },
    });

    expect(() => capturePlanCritiqueRecord(input, { root: temporaryRoot() })).toThrow(
      /execution\.model/,
    );
    expect(invoked).toBe(false);
  });

  it('serializes identical and distinct callbacks across processes', async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), 'critique-capture-process-'));
    const script = path.join(scratch, 'capture-child.mts');
    const captureModule = pathToFileURL(
      path.join(import.meta.dirname, '..', 'evidence-capture-store.mts'),
    ).href;
    const recordModule = pathToFileURL(
      path.join(import.meta.dirname, '..', 'evidence-record.mts'),
    ).href;
    writeFileSync(
      script,
      `import { capturePlanCritiqueRecord } from ${JSON.stringify(captureModule)};\n` +
        `import { sha256Bytes } from ${JSON.stringify(recordModule)};\n` +
        `const [root, callback, value] = process.argv.slice(2);\n` +
        `const bytes = Buffer.from(value);\n` +
        `const hash = (text) => sha256Bytes(Buffer.from(text));\n` +
        `const result = capturePlanCritiqueRecord({\n` +
        `  workId: 'work-1',\n` +
        `  execution: { provider: 'codex', callbackHash: hash(callback), model: 'gpt-5.6', promptHash: hash('prompt') },\n` +
        `  repository: { fingerprint: hash('repo'), fingerprintSource: 'canonical_remote', branch: 'codex/example', head: 'a'.repeat(40) },\n` +
        `  providerCompletedAt: '2026-07-19T01:02:03.000Z',\n` +
        `  contract: { state: 'valid', error: null, status: 'reviewed', verdict: 'PROCEED_WITH_CHANGES', criticalCount: 0 },\n` +
        `  exactResponse: bytes,\n` +
        `}, { root });\n` +
        `process.stdout.write(JSON.stringify(result));\n`,
      { mode: 0o600 },
    );

    const sameRoot = path.join(scratch, 'same');
    const same = await Promise.all([
      runChild(script, sameRoot, 'same', 'same response'),
      runChild(script, sameRoot, 'same', 'same response'),
    ]);
    expect(same.map(({ code, stderr }) => ({ code, stderr }))).toEqual([
      { code: 0, stderr: '' },
      { code: 0, stderr: '' },
    ]);
    expect(same.map(({ stdout }) => JSON.parse(stdout).state).sort()).toEqual([
      'created',
      'existing',
    ]);
    expect(listPlanCritiqueRecords({ root: sameRoot })).toHaveLength(1);

    const distinctRoot = path.join(scratch, 'distinct');
    const distinct = await Promise.all([
      runChild(script, distinctRoot, 'first', 'first response'),
      runChild(script, distinctRoot, 'second', 'second response'),
    ]);
    expect(distinct.map(({ code, stderr }) => ({ code, stderr }))).toEqual([
      { code: 0, stderr: '' },
      { code: 0, stderr: '' },
    ]);
    const records = listPlanCritiqueRecords({ root: distinctRoot }).sort(
      (left, right) => left.lineage.pass - right.lineage.pass,
    );
    expect(records.map((record) => record.lineage.pass)).toEqual([1, 2]);
    expect(records[1]?.lineage.parentCritiqueId).toBe(records[0]?.critiqueId);
  });
});
