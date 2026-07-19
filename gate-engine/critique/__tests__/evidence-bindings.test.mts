import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  getPlanCritiqueRepositoryContext,
  persistPlanCritiqueBinding,
  resolvePlanCritiqueBinding,
} from '../evidence-bindings.mts';
import { canonicalPlanCritiqueRecordJson } from '../evidence-record.mts';
import {
  derivePlanCritiqueId,
  type PlanCritiqueRecordV1,
  persistPlanCritiqueRecord,
} from '../evidence-store.mts';
import { bytes, recordFor, sha256Bytes } from './evidence-store-fixture.mts';
import {
  commit,
  context,
  createRepository,
  git,
  temporaryDirectory,
  temporaryPaths,
  withGitRace,
} from './repository-context-fixture.mts';

function evidenceRoot(): string {
  return path.join(temporaryDirectory('critique-binding-evidence-'), 'evidence');
}

function storedRecord(
  repository: string,
  root: string,
  workId: string,
  callback = workId,
): PlanCritiqueRecordV1 {
  const exact = bytes(`response:${workId}:${callback}`);
  const record = recordFor(exact);
  const repositoryContext = context(repository);
  record.workId = workId;
  record.execution.callbackHash = sha256Bytes(bytes(callback));
  record.repository = {
    fingerprint: repositoryContext.fingerprint,
    fingerprintSource: repositoryContext.fingerprintSource,
    branch: repositoryContext.branch,
    head: repositoryContext.head,
  };
  record.critiqueId = derivePlanCritiqueId(record);
  persistPlanCritiqueRecord(record, { exactResponse: exact }, { root });
  return record;
}

function bindingFile(repository: string, workId: string): string {
  const filename = `${sha256Bytes(bytes(workId))}.json`;
  return path.join(context(repository).gitDir, 'devkit', 'plan-critique-bindings', 'v1', filename);
}

describe('plan critique evidence bindings', () => {
  it('fails open outside a repository and in a detached worktree', () => {
    const outside = temporaryDirectory('critique-binding-outside-');
    expect(getPlanCritiqueRepositoryContext(outside)).toEqual({
      status: 'unavailable',
      reason: 'not_a_repository',
    });
    expect(resolvePlanCritiqueBinding({ cwd: outside })).toEqual({
      status: 'unavailable',
      reason: 'not_a_repository',
      candidates: 0,
    });

    const repository = createRepository();
    git(repository, 'checkout', '-q', '--detach');
    expect(getPlanCritiqueRepositoryContext(repository)).toEqual({
      status: 'unavailable',
      reason: 'detached_worktree',
    });
    expect(resolvePlanCritiqueBinding({ cwd: repository })).toMatchObject({
      status: 'unavailable',
      reason: 'detached_worktree',
      candidates: 0,
    });
    git(repository, 'checkout', '-q', 'main');
    git(repository, 'checkout', '-q', '-b', '(detached)');
    expect(getPlanCritiqueRepositoryContext(repository)).toMatchObject({
      status: 'available',
      context: { branch: '(detached)' },
    });
  });

  it('publishes one canonical file idempotently and conflicts without ambiguity', () => {
    const repository = createRepository();
    const root = evidenceRoot();
    const first = storedRecord(repository, root, 'opaque work id', 'first callback');
    const second = storedRecord(repository, root, 'opaque work id', 'second callback');

    const created = persistPlanCritiqueBinding(first.critiqueId, {
      cwd: repository,
      evidenceRoot: root,
    });
    expect(created).toMatchObject({
      status: 'bound',
      state: 'created',
      binding: {
        workId: 'opaque work id',
        critiqueId: first.critiqueId,
        recordCapturedAt: first.timestamps.capturedAt,
      },
    });
    const file = bindingFile(repository, first.workId);
    const before = lstatSync(file);
    const originalBytes = readFileSync(file);
    expect(
      persistPlanCritiqueBinding(first.critiqueId, { cwd: repository, evidenceRoot: root }),
    ).toMatchObject({ status: 'bound', state: 'existing' });
    expect(lstatSync(file).ino).toBe(before.ino);
    expect(() =>
      persistPlanCritiqueBinding(second.critiqueId, { cwd: repository, evidenceRoot: root }),
    ).toThrow(/immutable conflict/);
    expect(lstatSync(file).ino).toBe(before.ino);
    expect(readFileSync(file)).toEqual(originalBytes);
    expect(resolvePlanCritiqueBinding({ cwd: repository, evidenceRoot: root })).toMatchObject({
      status: 'resolved',
      binding: { critiqueId: first.critiqueId },
    });
  });

  it('requires a scope when multiple work chains are bound', () => {
    const repository = createRepository();
    const root = evidenceRoot();
    const first = storedRecord(repository, root, 'work-one');
    const second = storedRecord(repository, root, 'work-two');
    persistPlanCritiqueBinding(first.critiqueId, { cwd: repository, evidenceRoot: root });
    persistPlanCritiqueBinding(second.critiqueId, { cwd: repository, evidenceRoot: root });

    expect(resolvePlanCritiqueBinding({ cwd: repository, evidenceRoot: root })).toEqual({
      status: 'unavailable',
      reason: 'ambiguous_matching_bindings',
      candidates: 2,
    });
    expect(
      resolvePlanCritiqueBinding({ cwd: repository, evidenceRoot: root, workId: first.workId }),
    ).toMatchObject({ status: 'resolved', binding: { critiqueId: first.critiqueId } });
    expect(
      resolvePlanCritiqueBinding({ cwd: repository, evidenceRoot: root, workId: 'missing' }),
    ).toEqual({ status: 'unavailable', reason: 'no_matching_binding', candidates: 0 });
  });

  it('accepts a descendant HEAD', () => {
    const repository = createRepository();
    const root = evidenceRoot();
    const record = storedRecord(repository, root, 'advancing-work');
    persistPlanCritiqueBinding(record.critiqueId, { cwd: repository, evidenceRoot: root });
    commit(repository, 'descendant');

    expect(
      resolvePlanCritiqueBinding({ cwd: repository, evidenceRoot: root, workId: record.workId }),
    ).toMatchObject({ status: 'resolved', binding: { critiqueId: record.critiqueId } });
  });

  it('revalidates repository context before returning a resolved record', () => {
    const repository = createRepository();
    const root = evidenceRoot();
    const record = storedRecord(repository, root, 'context-race');
    persistPlanCritiqueBinding(record.critiqueId, { cwd: repository, evidenceRoot: root });
    git(repository, 'branch', 'context-changed');

    const result = withGitRace(repository, 'merge_base', () =>
      resolvePlanCritiqueBinding({ cwd: repository, evidenceRoot: root, workId: record.workId }),
    );
    expect(result).toEqual({ status: 'unavailable', reason: 'branch_mismatch', candidates: 1 });
  });

  it.each(['amend', 'reset', 'rebase'] as const)('rejects a %s-rewritten work chain', (rewrite) => {
    const repository = createRepository();
    commit(repository, 'bound tip');
    const root = evidenceRoot();
    const record = storedRecord(repository, root, `rewritten-${rewrite}`);
    persistPlanCritiqueBinding(record.critiqueId, { cwd: repository, evidenceRoot: root });

    if (rewrite === 'amend') {
      git(repository, 'commit', '--amend', '-q', '--allow-empty', '-m', 'amended tip');
    } else if (rewrite === 'reset') {
      git(repository, 'reset', '-q', '--hard', 'HEAD^');
      commit(repository, 'replacement tip');
    } else {
      git(repository, 'branch', 'new-base', 'HEAD^');
      git(repository, 'checkout', '-q', 'new-base');
      writeFileSync(path.join(repository, 'base.txt'), 'new base\n');
      git(repository, 'add', 'base.txt');
      git(repository, 'commit', '-q', '-m', 'new base');
      git(repository, 'checkout', '-q', 'main');
      git(repository, 'rebase', '-q', 'new-base');
    }

    expect(
      resolvePlanCritiqueBinding({ cwd: repository, evidenceRoot: root, workId: record.workId }),
    ).toEqual({ status: 'unavailable', reason: 'ancestry_mismatch', candidates: 1 });
  });

  it('distinguishes branch and repository mismatches before record lookup', () => {
    const repository = createRepository();
    const root = evidenceRoot();
    const record = storedRecord(repository, root, 'mismatch-work');
    persistPlanCritiqueBinding(record.critiqueId, { cwd: repository, evidenceRoot: root });
    git(repository, 'checkout', '-q', '-b', 'other');
    expect(resolvePlanCritiqueBinding({ cwd: repository, workId: record.workId })).toEqual({
      status: 'unavailable',
      reason: 'branch_mismatch',
      candidates: 1,
    });

    const otherRepository = createRepository();
    const source = bindingFile(repository, record.workId);
    const destination = path.join(
      context(otherRepository).gitDir,
      'devkit',
      'plan-critique-bindings',
      'v1',
      path.basename(source),
    );
    mkdirSync(path.dirname(destination), { mode: 0o700, recursive: true });
    chmodSync(path.dirname(destination), 0o700);
    copyFileSync(source, destination);
    chmodSync(destination, 0o600);
    expect(resolvePlanCritiqueBinding({ cwd: otherRepository, workId: record.workId })).toEqual({
      status: 'unavailable',
      reason: 'repository_mismatch',
      candidates: 1,
    });
  });

  it.each([
    'corrupt_json',
    'open_schema',
    'wrong_filename',
  ] as const)('fails open on a %s binding', (corruption) => {
    const repository = createRepository();
    const root = evidenceRoot();
    const record = storedRecord(repository, root, `binding-${corruption}`);
    persistPlanCritiqueBinding(record.critiqueId, { cwd: repository, evidenceRoot: root });
    const file = bindingFile(repository, record.workId);
    if (corruption === 'corrupt_json') writeFileSync(file, '{');
    if (corruption === 'open_schema') {
      const binding = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      binding.unexpected = true;
      writeFileSync(file, canonicalPlanCritiqueRecordJson(binding));
    }
    if (corruption === 'wrong_filename')
      renameSync(file, path.join(path.dirname(file), `${'0'.repeat(64)}.json`));

    expect(resolvePlanCritiqueBinding({ cwd: repository, evidenceRoot: root })).toMatchObject({
      status: 'unavailable',
      reason: 'malformed_binding',
    });
  });

  it.each([
    'missing_record',
    'corrupt_record',
    'corrupt_blob',
  ] as const)('fails open on a %s after binding', (corruption) => {
    const repository = createRepository();
    const root = evidenceRoot();
    const record = storedRecord(repository, root, `record-${corruption}`);
    persistPlanCritiqueBinding(record.critiqueId, { cwd: repository, evidenceRoot: root });
    const recordFile = path.join(root, 'records', `${record.critiqueId}.json`);
    if (corruption === 'missing_record') unlinkSync(recordFile);
    if (corruption === 'corrupt_record') writeFileSync(recordFile, '{}\n');
    if (corruption === 'corrupt_blob')
      writeFileSync(path.join(root, record.exactResponse.ref), 'x');

    expect(
      resolvePlanCritiqueBinding({ cwd: repository, evidenceRoot: root, workId: record.workId }),
    ).toEqual({ status: 'unavailable', reason: 'malformed_record', candidates: 1 });
  });

  it('does not bind an ineligible record and rechecks eligibility during resolution', () => {
    const repository = createRepository();
    const root = evidenceRoot();
    const rejected = storedRecord(repository, root, 'rejected-work');
    rejected.contract = {
      state: 'valid',
      error: null,
      status: 'reviewed',
      verdict: 'RETHINK',
      criticalCount: 1,
      eligibility: { eligible: false, reason: 'blocking_verdict' },
    };
    writeFileSync(
      path.join(root, 'records', `${rejected.critiqueId}.json`),
      canonicalPlanCritiqueRecordJson(rejected),
    );
    expect(
      persistPlanCritiqueBinding(rejected.critiqueId, { cwd: repository, evidenceRoot: root }),
    ).toEqual({ status: 'unavailable', reason: 'ineligible_record' });

    const eligible = storedRecord(repository, root, 'eligibility-recheck');
    persistPlanCritiqueBinding(eligible.critiqueId, { cwd: repository, evidenceRoot: root });
    eligible.contract = structuredClone(rejected.contract);
    writeFileSync(
      path.join(root, 'records', `${eligible.critiqueId}.json`),
      canonicalPlanCritiqueRecordJson(eligible),
    );
    expect(
      resolvePlanCritiqueBinding({ cwd: repository, evidenceRoot: root, workId: eligible.workId }),
    ).toEqual({ status: 'unavailable', reason: 'ineligible_record', candidates: 1 });
  });

  it('isolates bindings by linked-worktree gitDir while sharing repository identity', () => {
    const repository = createRepository();
    const linked = `${repository}-linked`;
    temporaryPaths.push(linked);
    git(repository, 'worktree', 'add', '-q', '-b', 'linked', linked);
    try {
      const mainContext = context(repository);
      const linkedContext = context(linked);
      expect(linkedContext.fingerprint).toBe(mainContext.fingerprint);
      expect(linkedContext.gitDir).not.toBe(mainContext.gitDir);

      const root = evidenceRoot();
      const mainRecord = storedRecord(repository, root, 'main-work');
      persistPlanCritiqueBinding(mainRecord.critiqueId, { cwd: repository, evidenceRoot: root });
      expect(resolvePlanCritiqueBinding({ cwd: linked, evidenceRoot: root })).toEqual({
        status: 'unavailable',
        reason: 'no_matching_binding',
        candidates: 0,
      });
      const linkedRecord = storedRecord(linked, root, 'linked-work');
      persistPlanCritiqueBinding(linkedRecord.critiqueId, { cwd: linked, evidenceRoot: root });
      expect(resolvePlanCritiqueBinding({ cwd: repository, evidenceRoot: root })).toMatchObject({
        status: 'resolved',
        binding: { workId: 'main-work' },
      });
      expect(resolvePlanCritiqueBinding({ cwd: linked, evidenceRoot: root })).toMatchObject({
        status: 'resolved',
        binding: { workId: 'linked-work' },
      });
    } finally {
      git(repository, 'worktree', 'remove', '--force', linked);
    }
  });
});
