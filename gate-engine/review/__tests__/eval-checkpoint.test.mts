import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isJsonObject, isJsonString, type JsonValue } from '../../comment-firewall/types.mts';
import { transcriptPath, transcriptsDir } from '../eval/benchmark-config.mts';
import {
  completenessAuditCheckpointIdentity,
  completenessCaseCheckpointIdentity,
  completenessReviewerCheckpointIdentity,
} from '../eval/benchmark-identity.mts';
import {
  acquireCompletenessProgressLock,
  completenessProgressLockPath,
  completenessProgressPath,
  installProgressLockTerminationHandlers,
  openCheckpointStore,
  resetCompletenessProgress,
  type CheckpointStoreOptions,
} from '../eval/checkpoint.mts';

interface Result {
  verdict: string;
  outage?: boolean;
}

function decodeResult(value: JsonValue): Result | undefined {
  if (
    !isJsonObject(value) ||
    !isJsonString(value.verdict) ||
    (value.outage !== undefined && value.outage !== true && value.outage !== false)
  )
    return undefined;
  const result: Result = { verdict: value.verdict };
  if (value.outage !== undefined) result.outage = value.outage;
  return result;
}

type ResultStoreOverrides = Partial<Pick<CheckpointStoreOptions<Result>, 'accept' | 'decode'>>;

describe('completeness-eval checkpoint store', () => {
  let dir: string;
  const identity = { model: 'sol', runnerHash: 'runner-1' };
  const open = (over: ResultStoreOverrides = {}) =>
    openCheckpointStore<Result>({ kind: 'reviewer', identity, dir, decode: decodeResult, ...over });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'completeness-checkpoint-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('reuses only an exact kind, global identity, id, and input hash', () => {
    open().record('case-a', 'input-a', { verdict: 'PASS' });

    const matching = open();
    expect(matching.size).toBe(1);
    expect(matching.take('case-a', 'input-a')).toEqual({ verdict: 'PASS' });
    expect(matching.take('case-a', 'input-b')).toBeUndefined();
    expect(
      openCheckpointStore<Result>({ kind: 'matcher', identity, dir, decode: decodeResult }).take(
        'case-a',
        'input-a',
      ),
    ).toBeUndefined();
    expect(
      openCheckpointStore<Result>({
        kind: 'reviewer',
        identity: { ...identity, runnerHash: 'runner-2' },
        dir,
        decode: decodeResult,
      }).take('case-a', 'input-a'),
    ).toBeUndefined();
  });

  it('binds paid evidence to noLlm and keeps arbitrary case ids inside transcripts', () => {
    const shared = {
      reviewerModel: 'gpt-5.6-sol',
      mcpCapabilityFingerprint: 'mcp-a',
      retryBaselineHash: 'none',
    };
    expect(completenessCaseCheckpointIdentity({ ...shared, noLlm: false })).not.toEqual(
      completenessCaseCheckpointIdentity({ ...shared, noLlm: true }),
    );
    expect(completenessReviewerCheckpointIdentity('gpt-5.6-sol', 'mcp-a', false)).not.toEqual(
      completenessReviewerCheckpointIdentity('gpt-5.6-sol', 'mcp-a', true),
    );
    expect(completenessAuditCheckpointIdentity('gpt-5.6-sol', 'mcp-a')).not.toEqual(
      completenessAuditCheckpointIdentity('gpt-5.6-sol', 'mcp-b'),
    );
    expect(dirname(transcriptPath('../../../../package'))).toBe(transcriptsDir);
    expect(transcriptPath('../../../../package')).toMatch(/sha256-[a-f0-9]{64}\.json$/);
  });

  it('prevents concurrent processes from sharing one progress ledger', () => {
    const release = acquireCompletenessProgressLock(dir);
    try {
      expect(() => acquireCompletenessProgressLock(dir)).toThrow(/another process .* owns/);
    } finally {
      release();
    }

    const releaseNext = acquireCompletenessProgressLock(dir);
    releaseNext();
  });

  it('fails safely on an unreadable stale lease instead of deleting it', () => {
    writeFileSync(completenessProgressLockPath(dir), '{}');

    expect(() => acquireCompletenessProgressLock(dir)).toThrow(/stale or unreadable/);
    expect(readFileSync(completenessProgressLockPath(dir), 'utf8')).toBe('{}');
  });

  it('recognizes PID reuse from a different process start and preserves the stale lease', () => {
    const owner = {
      pid: process.pid,
      processStart: 'ps:an older process start',
      token: '00000000-0000-4000-8000-000000000000',
    };
    writeFileSync(completenessProgressLockPath(dir), JSON.stringify(owner));

    expect(() => acquireCompletenessProgressLock(dir, () => 'a newer process start')).toThrow(
      /stale or unreadable/,
    );
    expect(JSON.parse(readFileSync(completenessProgressLockPath(dir), 'utf8'))).toEqual(owner);
  });

  it('rejects an out-of-range PID before probing process liveness', () => {
    writeFileSync(
      completenessProgressLockPath(dir),
      JSON.stringify({
        pid: 2_147_483_648,
        processStart: 'ps:impossible',
        token: '00000000-0000-4000-8000-000000000000',
      }),
    );

    expect(() => acquireCompletenessProgressLock(dir)).toThrow(/stale or unreadable/);
  });

  it('releases the progress lock before terminating on SIGTERM', () => {
    const listeners = new Map<string, () => void>();
    const release = acquireCompletenessProgressLock(dir);
    const target = {
      once: (event: string, listener: () => void) => listeners.set(event, listener),
      exit: (code?: number): never => {
        throw new Error(`exit ${code}`);
      },
    };
    installProgressLockTerminationHandlers(release, () => {}, target);

    expect(() => listeners.get('SIGTERM')?.()).toThrow('exit 143');
    expect(() => readFileSync(completenessProgressLockPath(dir), 'utf8')).toThrow();
  });

  it('returns an owned release closure when temporary owner cleanup fails', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const release = acquireCompletenessProgressLock(
      dir,
      () => 'start',
      () => {
        throw new Error('cleanup failed');
      },
    );

    expect(readFileSync(completenessProgressLockPath(dir), 'utf8')).toContain(`${process.pid}`);
    release();
    expect(() => readFileSync(completenessProgressLockPath(dir), 'utf8')).toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cleanup failed'));
  });

  it('uses the last matching write for a key', () => {
    const checkpoint = open();
    checkpoint.record('case-a', 'input-a', { verdict: 'FAIL' });
    checkpoint.record('case-a', 'input-a', { verdict: 'PASS' });

    expect(open().take('case-a', 'input-a')).toEqual({ verdict: 'PASS' });
  });

  it('keeps intact rows and warns once when the JSONL tail is torn', () => {
    const checkpoint = open();
    checkpoint.record('case-a', 'input-a', { verdict: 'PASS' });
    appendFileSync(completenessProgressPath(dir), '{"kind":"reviewer"\nnot-json');
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});

    const resumed = open();

    expect(resumed.take('case-a', 'input-a')).toEqual({ verdict: 'PASS' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('2 unreadable line(s)'));
  });

  it('fences the next durable row from a torn non-newline-terminated tail', () => {
    open().record('case-a', 'input-a', { verdict: 'PASS' });
    appendFileSync(completenessProgressPath(dir), '{"kind":"reviewer"');
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});

    const recovered = open();
    recovered.record('case-b', 'input-b', { verdict: 'PASS' });
    const reopened = open();

    expect(reopened.take('case-a', 'input-a')).toEqual({ verdict: 'PASS' });
    expect(reopened.take('case-b', 'input-b')).toEqual({ verdict: 'PASS' });
    expect(warn).toHaveBeenCalled();
  });

  it('reset removes progress durably', () => {
    open().record('case-a', 'input-a', { verdict: 'PASS' });

    resetCompletenessProgress(dir);

    expect(open().size).toBe(0);
    expect(() => readFileSync(completenessProgressPath(dir), 'utf8')).toThrow();
  });

  it('does not salvage values rejected by the accept predicate', () => {
    open().record('case-a', 'input-a', { verdict: 'OUTAGE', outage: true });

    const resumed = open({ accept: (value: Result) => !value.outage });

    expect(resumed.size).toBe(0);
    expect(resumed.take('case-a', 'input-a')).toBeUndefined();
  });

  it('warns once and continues when progress cannot be written', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const checkpoint = openCheckpointStore<Result>({
      kind: 'reviewer',
      identity,
      dir: join(dir, 'missing'),
      decode: decodeResult,
    });

    expect(() => {
      checkpoint.record('case-a', 'input-a', { verdict: 'PASS' });
      checkpoint.record('case-b', 'input-b', { verdict: 'PASS' });
    }).not.toThrow();
    expect(checkpoint.size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('NOT resumable'));
  });
});
