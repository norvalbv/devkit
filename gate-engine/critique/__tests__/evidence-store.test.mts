import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parsePlanCritiqueResponse } from '../contract.mts';
import {
  persistBinding,
  purgePlanCritiqueBindings,
  repositoryContext,
  resolveEligibleBinding,
} from '../evidence-bindings.mts';
import {
  makeRecord,
  persistImmutableJson,
  persistRecord,
  pruneExpiredTranscriptBlobs,
  purgePlanCritiqueEvidence,
  readRecord,
  recordPath,
  withEvidenceLock,
  writeContentBlob,
} from '../evidence-store.mts';

const roots: string[] = [];
const externalFiles: string[] = [];
let priorEvidenceDir: string | undefined;

const context = {
  root: '/repo',
  gitDir: '/repo/.git',
  repositoryFingerprint: 'a'.repeat(64),
  repositoryLocator: 'remote:github.com/example/repo',
  branch: 'main',
  head: 'b'.repeat(40),
};

const contract = () =>
  parsePlanCritiqueResponse(
    JSON.stringify({
      schemaVersion: 1,
      kind: 'plan_critique',
      phase: 'plan',
      status: 'reviewed',
      verdict: 'PROCEED',
      feasibility: 'Feasible',
      frameMeta: 'SOUND',
      summary: 'The plan is sound.',
      findings: [],
      edgeCases: [],
      actions: [],
    }),
  );

function record(overrides: Partial<Parameters<typeof makeRecord>[0]> = {}) {
  return makeRecord({
    contract: contract(),
    context,
    workId: 'c'.repeat(64),
    provider: 'codex',
    ...overrides,
  });
}

function evidenceRoot(): string {
  const root = process.env.DEVKIT_PLAN_CRITIQUE_EVIDENCE_DIR;
  if (!root) throw new Error('test evidence root was not configured');
  return root;
}

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  const api = await import(workerData.moduleUrl);
  let preparedRecord;
  if (workerData.operation === 'persist-record') {
    const contractApi = await import(workerData.contractModuleUrl);
    preparedRecord = api.makeRecord({
      contract: contractApi.parsePlanCritiqueResponse(workerData.rawResponse),
      context: workerData.context,
      workId: workerData.workId,
      provider: 'codex',
    });
  }
  const barrier = new Int32Array(workerData.barrier);
  Atomics.add(barrier, 0, 1);
  Atomics.notify(barrier, 0);
  Atomics.wait(barrier, 1, 0);
  try {
    let result;
    if (workerData.waitForPurge) Atomics.wait(barrier, 2, 0);
    if (workerData.operation === 'persist-record') {
      result = {
        path: api.persistRecord(preparedRecord),
        critiqueId: preparedRecord.critiqueId,
        exactResponseBlob: preparedRecord.exactResponseBlob,
      };
    } else if (workerData.operation === 'atomic') {
      api.atomicWrite(workerData.path, workerData.content);
      result = workerData.content;
    } else if (workerData.operation === 'prune') {
      result = api.pruneExpiredTranscriptBlobs(workerData.now);
    } else if (workerData.operation === 'evidence-purge') {
      result = api.purgePlanCritiqueEvidence();
    } else if (workerData.operation === 'persist-binding') {
      result = api.persistBinding(workerData.context, workerData.record);
    } else {
      result = api.purgePlanCritiqueBindings(workerData.repo);
    }
    parentPort.postMessage({ ok: true, result });
  } catch (error) {
    parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    if (workerData.signalPurge) {
      Atomics.store(barrier, 2, 1);
      Atomics.notify(barrier, 2);
    }
  }
})();`;

async function synchronizedWorkers(
  requests: Array<Record<string, unknown>>,
): Promise<Array<{ ok: boolean; result?: unknown; error?: string }>> {
  const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3);
  const state = new Int32Array(barrier);
  const replies = requests.map(
    (request) =>
      new Promise<{ ok: boolean; result?: unknown; error?: string }>((resolve, reject) => {
        const worker = new Worker(WORKER_SOURCE, {
          eval: true,
          workerData: { ...request, barrier },
        });
        worker.once('message', resolve);
        worker.once('error', reject);
        worker.once('exit', (code) => {
          if (code !== 0) reject(new Error(`evidence worker exited ${code}`));
        });
      }),
  );
  const deadline = Date.now() + 10_000;
  while (Atomics.load(state, 0) < requests.length) {
    if (Date.now() >= deadline) throw new Error('evidence workers did not reach the barrier');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  Atomics.store(state, 1, 1);
  Atomics.notify(state, 1, requests.length);
  return Promise.all(replies);
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function repositoryFixture(): string {
  const repo = mkdtempSync(join(tmpdir(), 'plan-critique-repo-'));
  roots.push(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  writeFileSync(join(repo, 'README.md'), 'fixture\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-qm', 'fixture']);
  return repo;
}

beforeEach(() => {
  priorEvidenceDir = process.env.DEVKIT_PLAN_CRITIQUE_EVIDENCE_DIR;
  const root = mkdtempSync(join(tmpdir(), 'plan-critique-evidence-'));
  roots.push(root);
  process.env.DEVKIT_PLAN_CRITIQUE_EVIDENCE_DIR = root;
});

afterEach(() => {
  if (priorEvidenceDir === undefined) delete process.env.DEVKIT_PLAN_CRITIQUE_EVIDENCE_DIR;
  else process.env.DEVKIT_PLAN_CRITIQUE_EVIDENCE_DIR = priorEvidenceDir;
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
    rmSync(`${root}.locks`, { recursive: true, force: true });
  }
  for (const path of externalFiles.splice(0)) rmSync(path, { force: true });
});

describe('plan critique evidence store', () => {
  it('publishes exactly one immutable winner under concurrent writers', async () => {
    const path = join(evidenceRoot(), 'atomic', 'winner.txt');
    const requests = Array.from({ length: 16 }, (_, index) => ({
      moduleUrl: new URL('../immutable-file.mts', import.meta.url).href,
      operation: 'atomic',
      path,
      content: `writer-${index}`,
    }));
    const replies = await synchronizedWorkers(requests);
    const winners = replies.filter((reply) => reply.ok);

    expect(winners).toHaveLength(1);
    expect(readFileSync(path, 'utf8')).toBe(winners[0]?.result);
    expect(
      replies.filter((reply) => !reply.ok).every((reply) => reply.error?.includes('exists')),
    ).toBe(true);
    expect(readdirSync(dirname(path)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('persists a record immutably while retaining its exact-response blob', () => {
    const value = record({ model: 'gpt-test', prompt: 'review this plan' });
    const path = persistRecord(value);

    expect(readRecord(value.critiqueId)).toEqual(value);
    expect(readFileSync(path, 'utf8')).toContain(value.responseHash);
    expect(existsSync(join(evidenceRoot(), value.exactResponseBlob))).toBe(true);
    expect(() => persistRecord({ ...value, provider: 'claude' })).toThrow(
      'immutable evidence already exists',
    );
    expect(readRecord('not-a-uuid')).toBeNull();
  });

  it('supports nested public writers inside one evidence transaction', () => {
    const repo = repositoryFixture();
    const repository = repositoryContext(repo);
    const value = record({ context: repository, workId: '8'.repeat(64) });

    expect(() => persistBinding(repository, value)).toThrow(
      'record must be persisted before its binding',
    );
    expect(() =>
      withEvidenceLock(() => {
        persistRecord(value);
        persistBinding(repository, value);
        persistImmutableJson('observations/nested-lock.json', { ok: true });
      }),
    ).not.toThrow();
    expect(resolveEligibleBinding(repo, value.workId)).toMatchObject({ status: 'matched' });
  });

  it('keeps a blob referenced by a fresh record during age-based cleanup', () => {
    const old = record();
    old.capturedAt = new Date(Date.now() - 120_000).toISOString();
    const fresh = record();
    persistRecord(old);
    persistRecord(fresh);
    const blobPath = join(evidenceRoot(), fresh.exactResponseBlob);
    const oldTime = new Date(Date.now() - 120_000);
    utimesSync(blobPath, oldTime, oldTime);

    purgePlanCritiqueEvidence({ olderThanMs: 60_000 });
    expect(readRecord(old.critiqueId)).toBeNull();
    expect(readRecord(fresh.critiqueId)).not.toBeNull();
    expect(existsSync(blobPath)).toBe(true);

    purgePlanCritiqueEvidence({ olderThanMs: 0 });
    expect(readRecord(fresh.critiqueId)).toBeNull();
    expect(existsSync(blobPath)).toBe(false);
  });

  it('keeps a shared transcript blob while any record retains it, then removes it after expiry', () => {
    const transcriptBlob = writeContentBlob('private transcript', 'txt');
    const now = Date.now();
    const expired = record({
      transcriptBlob,
      transcriptExpiresAt: new Date(now - 1_000).toISOString(),
    });
    const active = record({
      transcriptBlob,
      transcriptExpiresAt: new Date(now + 60_000).toISOString(),
    });
    persistRecord(expired);
    persistRecord(active);

    expect(pruneExpiredTranscriptBlobs(now)).toEqual({ files: 0, bytes: 0 });
    expect(existsSync(join(evidenceRoot(), transcriptBlob))).toBe(true);

    unlinkSync(recordPath(active.critiqueId));
    expect(pruneExpiredTranscriptBlobs(now)).toMatchObject({ files: 1 });
    expect(existsSync(join(evidenceRoot(), transcriptBlob))).toBe(false);
    expect(readRecord(expired.critiqueId)).not.toBeNull();
  });

  it('rejects a transcript path outside the evidence root without touching it', () => {
    const root = evidenceRoot();
    const outside = join(root, '..', 'outside-transcript.txt');
    externalFiles.push(outside);
    writeFileSync(outside, 'must survive');
    const value = record({
      transcriptBlob: '../outside-transcript.txt',
      transcriptExpiresAt: new Date(0).toISOString(),
    });
    expect(() => persistRecord(value)).toThrow('transcript blob path is invalid');

    expect(readFileSync(outside, 'utf8')).toBe('must survive');
    expect(readRecord(value.critiqueId)).toBeNull();
  });

  it('publishes a complete record when a full purge lands between preparation and persistence', async () => {
    const rawResponse = contract().exactRaw;
    const replies = await synchronizedWorkers([
      {
        moduleUrl: new URL('../evidence-store.mts', import.meta.url).href,
        contractModuleUrl: new URL('../contract.mts', import.meta.url).href,
        operation: 'persist-record',
        rawResponse,
        context,
        workId: '9'.repeat(64),
        waitForPurge: true,
      },
      {
        moduleUrl: new URL('../evidence-store.mts', import.meta.url).href,
        operation: 'evidence-purge',
        signalPurge: true,
      },
    ]);

    expect(replies.every((reply) => reply.ok)).toBe(true);
    const persisted = replies[0]?.result as
      | { critiqueId: string; exactResponseBlob: string }
      | undefined;
    expect(persisted).toBeDefined();
    expect(readRecord(persisted?.critiqueId ?? '')).not.toBeNull();
    expect(existsSync(join(evidenceRoot(), persisted?.exactResponseBlob ?? 'missing'))).toBe(true);
  });

  it('serializes concurrent transcript pruning without errors or double-counting', async () => {
    const transcriptBlob = writeContentBlob('expired transcript', 'transcript');
    const now = Date.now();
    persistRecord(
      record({
        transcriptBlob,
        transcriptExpiresAt: new Date(now - 1_000).toISOString(),
      }),
    );
    const replies = await synchronizedWorkers(
      Array.from({ length: 16 }, () => ({
        moduleUrl: new URL('../evidence-store.mts', import.meta.url).href,
        operation: 'prune',
        now,
      })),
    );

    expect(replies.every((reply) => reply.ok)).toBe(true);
    expect(
      replies.reduce(
        (sum, reply) => sum + Number((reply.result as { files?: number } | undefined)?.files ?? 0),
        0,
      ),
    ).toBe(1);
    expect(existsSync(join(evidenceRoot(), transcriptBlob))).toBe(false);
  });

  it('continues transcript pruning past a malformed record', () => {
    const transcriptBlob = writeContentBlob('expired beside malformed metadata', 'transcript');
    persistRecord(
      record({
        transcriptBlob,
        transcriptExpiresAt: new Date(0).toISOString(),
      }),
    );
    writeFileSync(join(evidenceRoot(), 'records', 'malformed.json'), '{not json');

    expect(pruneExpiredTranscriptBlobs()).toMatchObject({ files: 1 });
    expect(existsSync(join(evidenceRoot(), transcriptBlob))).toBe(false);
  });

  it('rejects internally inconsistent or malformed eligible records', () => {
    const repo = repositoryFixture();
    const repository = repositoryContext(repo);
    const workId = 'd'.repeat(64);
    const value = record({ context: repository, workId });
    persistRecord(value);
    expect(persistBinding(repository, value)).not.toBeNull();
    const pristine = JSON.parse(readFileSync(recordPath(value.critiqueId), 'utf8')) as Record<
      string,
      unknown
    >;
    const mutations = [
      (stored: Record<string, unknown>) => {
        (stored.contract as Record<string, unknown>).state = 'invalid';
      },
      (stored: Record<string, unknown>) => {
        (stored.sanitizedProjection as Record<string, unknown>).findings = [null];
      },
      (stored: Record<string, unknown>) => {
        stored.responseHash = 'f'.repeat(64);
      },
      (stored: Record<string, unknown>) => {
        stored.exactResponseBlob = 42;
      },
    ];
    for (const mutate of mutations) {
      const stored = structuredClone(pristine);
      mutate(stored);
      writeFileSync(recordPath(value.critiqueId), `${JSON.stringify(stored)}\n`);
      expect(resolveEligibleBinding(repo, workId)).toMatchObject({
        status: 'skipped',
        reason: 'malformed_record',
      });
    }
    writeFileSync(recordPath(value.critiqueId), `${JSON.stringify(pristine)}\n`);
    writeFileSync(join(evidenceRoot(), value.exactResponseBlob), '{}');
    expect(resolveEligibleBinding(repo, workId)).toMatchObject({
      status: 'skipped',
      reason: 'malformed_record',
    });
  });

  it('recomputes eligibility and verifies a requested work id', () => {
    const repo = repositoryFixture();
    const repository = repositoryContext(repo);
    const wrongPhase = parsePlanCritiqueResponse(
      JSON.stringify({
        ...JSON.parse(contract().exactRaw),
        status: 'wrong_phase',
        verdict: null,
        findings: [],
        edgeCases: [],
      }),
    );
    const forged = record({ contract: wrongPhase, context: repository, workId: 'e'.repeat(64) });
    forged.contract.eligible = true;
    forged.contract.eligibilityReason = 'eligible';
    persistRecord(forged);
    expect(persistBinding(repository, forged)).not.toBeNull();
    expect(resolveEligibleBinding(repo, forged.workId)).toMatchObject({
      status: 'skipped',
      reason: 'malformed_record',
    });

    const valid = record({ context: repository, workId: '1'.repeat(64) });
    persistRecord(valid);
    const bindingPath = persistBinding(repository, valid);
    if (!bindingPath) throw new Error('eligible fixture should create a binding');
    const requested = '2'.repeat(64);
    const moved = join(dirname(dirname(bindingPath)), requested, `${valid.critiqueId}.json`);
    mkdirSync(dirname(moved), { recursive: true });
    renameSync(bindingPath, moved);
    expect(resolveEligibleBinding(repo, requested)).toMatchObject({
      status: 'skipped',
      reason: 'malformed_binding',
    });
  });

  it('fails open when the binding root is blocked by a non-directory', () => {
    const repo = repositoryFixture();
    writeFileSync(join(repo, '.git', 'devkit'), 'blocks the binding directory');

    expect(resolveEligibleBinding(repo)).toMatchObject({
      status: 'skipped',
      reason: 'no_matching_binding',
      candidates: 0,
    });
    expect(purgePlanCritiqueBindings(repo)).toEqual({ files: 0, bytes: 0 });
  });

  it('keeps concurrent binding publication, traversal, and purge fail-open', async () => {
    const repo = repositoryFixture();
    const repository = repositoryContext(repo);
    const workIds = Array.from({ length: 24 }, (_, index) => index.toString(16).padStart(64, '0'));
    const records = workIds.map((workId) => record({ context: repository, workId }));
    for (const value of records) persistRecord(value);
    for (const value of records.slice(0, 16)) {
      expect(persistBinding(repository, value)).not.toBeNull();
    }
    const moduleUrl = new URL('../evidence-bindings.mts', import.meta.url).href;
    const replies = await synchronizedWorkers([
      ...records.slice(16).map((value) => ({
        moduleUrl,
        operation: 'persist-binding',
        context: repository,
        record: value,
      })),
      ...Array.from({ length: 8 }, () => ({
        moduleUrl,
        operation: 'binding-purge',
        repo,
      })),
    ]);

    expect(replies.every((reply) => reply.ok)).toBe(true);
    expect(purgePlanCritiqueBindings(repo).files).toBeGreaterThanOrEqual(0);
    expect(purgePlanCritiqueBindings(repo)).toEqual({ files: 0, bytes: 0 });
  });

  it('purges each binding at most once across concurrent cleaners', async () => {
    const repo = repositoryFixture();
    const repository = repositoryContext(repo);
    const workIds = Array.from({ length: 64 }, (_, index) => index.toString(16).padStart(64, '0'));
    for (const workId of workIds) {
      const value = record({ context: repository, workId });
      persistRecord(value);
      expect(persistBinding(repository, value)).not.toBeNull();
    }
    const moduleUrl = new URL('../evidence-bindings.mts', import.meta.url).href;
    const replies = await synchronizedWorkers(
      Array.from({ length: 16 }, () => ({ moduleUrl, operation: 'binding-purge', repo })),
    );

    expect(replies.every((reply) => reply.ok)).toBe(true);
    expect(purgePlanCritiqueBindings(repo)).toEqual({ files: 0, bytes: 0 });
  });

  it('uses one local fingerprint while isolating linked-worktree bindings', () => {
    const repo = repositoryFixture();
    const linked = join(tmpdir(), `plan-critique-linked-${Date.now()}`);
    roots.push(linked);
    git(repo, ['worktree', 'add', '-q', '-b', 'linked', linked]);

    const primary = repositoryContext(repo);
    const worktree = repositoryContext(linked);
    expect(worktree.repositoryFingerprint).toBe(primary.repositoryFingerprint);
    expect(worktree.gitDir).not.toBe(primary.gitDir);

    const primaryRecord = record({ context: primary, workId: '3'.repeat(64) });
    const worktreeRecord = record({ context: worktree, workId: '4'.repeat(64) });
    persistRecord(primaryRecord);
    persistRecord(worktreeRecord);
    const primaryBinding = persistBinding(primary, primaryRecord);
    const worktreeBinding = persistBinding(worktree, worktreeRecord);
    expect(primaryBinding?.startsWith(primary.gitDir)).toBe(true);
    expect(worktreeBinding?.startsWith(worktree.gitDir)).toBe(true);
    expect(worktreeBinding).not.toBe(primaryBinding);
  });
});
