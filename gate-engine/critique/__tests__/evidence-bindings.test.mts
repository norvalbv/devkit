import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs, {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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
  readPlanCritiqueRecord,
} from '../evidence-store.mts';
import { persistPlanCritiqueWorkQuarantine } from '../lifecycle/work-quarantine.mts';
import { withPlanCritiquePersistenceLock } from '../persistence-lock.mts';
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

function quarantine(record: PlanCritiqueRecordV1, root: string): void {
  persistPlanCritiqueWorkQuarantine(
    {
      provider: record.execution.provider,
      repositoryFingerprint: record.repository.fingerprint,
      workId: record.workId,
    },
    { root },
  );
}

function quarantineFiles(root: string, expectedCount = 1): string[] {
  const directory = path.join(root, 'work-quarantines');
  const files = readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(directory, name));
  expect(files).toHaveLength(expectedCount);
  return files;
}

function lockAttemptInstrumentation(): string {
  return (
    `import fs from 'node:fs';\n` +
    `import { syncBuiltinESMExports } from 'node:module';\n` +
    `import path from 'node:path';\n` +
    `const originalOpen = fs.openSync; let lockAttemptSignaled = false;\n` +
    `fs.openSync = ((...args) => {\n` +
    `  if (!lockAttemptSignaled && /^\\.plan-critique-[0-9a-f]{64}\\.lock\\.\\d+\\.[0-9a-f-]+\\.candidate$/.test(path.basename(String(args[0])))) { lockAttemptSignaled = true; process.stdout.write('waiting\\n'); }\n` +
    `  return originalOpen(...args);\n` +
    `});\n` +
    `syncBuiltinESMExports();\n`
  );
}

function withFailedPrimaryLockRelease<Value>(action: () => Value): Value {
  const originalUnlink = fs.unlinkSync;
  fs.unlinkSync = ((...args: Parameters<typeof fs.unlinkSync>) => {
    if (/^\.plan-critique-[0-9a-f]{64}\.lock$/.test(path.basename(String(args[0]))))
      throw Object.assign(new Error('injected release failure'), { code: 'EIO' });
    return originalUnlink(...args);
  }) as typeof fs.unlinkSync;
  syncBuiltinESMExports();
  try {
    return action();
  } finally {
    fs.unlinkSync = originalUnlink;
    syncBuiltinESMExports();
  }
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

    const missingRoot = evidenceRoot();
    const missingId = `pc1_${'0'.repeat(64)}`;
    expect(
      persistPlanCritiqueBinding(missingId, { cwd: repository, evidenceRoot: missingRoot }),
    ).toEqual({ status: 'unavailable', reason: 'malformed_record' });
    expect(existsSync(missingRoot)).toBe(false);
    expect(resolvePlanCritiqueBinding({ cwd: repository, evidenceRoot: missingRoot })).toEqual({
      status: 'unavailable',
      reason: 'no_matching_binding',
      candidates: 0,
    });
    expect(existsSync(missingRoot)).toBe(false);
    expect(
      persistPlanCritiqueBinding(missingId, { cwd: repository, evidenceRoot: 'relative' }),
    ).toEqual({ status: 'unavailable', reason: 'malformed_record' });
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

  it('blocks only the quarantined work while preserving binding cardinality', () => {
    const repository = createRepository();
    const root = evidenceRoot();
    const blocked = storedRecord(repository, root, 'quarantined-before-binding');
    const available = storedRecord(repository, root, 'available-work');
    const laterQuarantined = storedRecord(repository, root, 'quarantined-after-binding');

    quarantine(blocked, root);
    expect(
      persistPlanCritiqueBinding(blocked.critiqueId, { cwd: repository, evidenceRoot: root }),
    ).toEqual({ status: 'unavailable', reason: 'work_quarantined' });
    expect(existsSync(bindingFile(repository, blocked.workId))).toBe(false);

    expect(
      persistPlanCritiqueBinding(available.critiqueId, { cwd: repository, evidenceRoot: root }),
    ).toMatchObject({ status: 'bound' });
    expect(
      resolvePlanCritiqueBinding({ cwd: repository, evidenceRoot: root, workId: available.workId }),
    ).toMatchObject({ status: 'resolved', binding: { critiqueId: available.critiqueId } });

    persistPlanCritiqueBinding(laterQuarantined.critiqueId, {
      cwd: repository,
      evidenceRoot: root,
    });
    quarantine(laterQuarantined, root);
    expect(
      resolvePlanCritiqueBinding({
        cwd: repository,
        evidenceRoot: root,
        workId: laterQuarantined.workId,
      }),
    ).toEqual({ status: 'unavailable', reason: 'work_quarantined', candidates: 1 });
    expect(resolvePlanCritiqueBinding({ cwd: repository, evidenceRoot: root })).toEqual({
      status: 'unavailable',
      reason: 'ambiguous_matching_bindings',
      candidates: 2,
    });
  });

  it('fails closed only for work with a corrupt matching quarantine', () => {
    const repository = createRepository();
    const root = evidenceRoot();
    const creationBlocked = storedRecord(repository, root, 'corrupt-before-binding');
    const resolutionBlocked = storedRecord(repository, root, 'corrupt-after-binding');
    const available = storedRecord(repository, root, 'corrupt-isolated-work');

    persistPlanCritiqueBinding(resolutionBlocked.critiqueId, {
      cwd: repository,
      evidenceRoot: root,
    });
    quarantine(creationBlocked, root);
    quarantine(resolutionBlocked, root);
    for (const file of quarantineFiles(root, 2)) writeFileSync(file, '{');

    expect(
      persistPlanCritiqueBinding(creationBlocked.critiqueId, {
        cwd: repository,
        evidenceRoot: root,
      }),
    ).toEqual({ status: 'unavailable', reason: 'malformed_quarantine' });
    expect(existsSync(bindingFile(repository, creationBlocked.workId))).toBe(false);
    expect(
      persistPlanCritiqueBinding(available.critiqueId, { cwd: repository, evidenceRoot: root }),
    ).toMatchObject({ status: 'bound' });
    expect(
      resolvePlanCritiqueBinding({
        cwd: repository,
        evidenceRoot: root,
        workId: resolutionBlocked.workId,
      }),
    ).toEqual({ status: 'unavailable', reason: 'malformed_quarantine', candidates: 1 });
    expect(
      resolvePlanCritiqueBinding({ cwd: repository, evidenceRoot: root, workId: available.workId }),
    ).toMatchObject({ status: 'resolved', binding: { critiqueId: available.critiqueId } });
  });

  it.each([
    { state: 'clear', quarantined: false },
    { state: 'quarantined', quarantined: true },
  ])('waits for store publication before binding $state work', async ({ state, quarantined }) => {
    const repository = createRepository();
    const scratch = temporaryDirectory('critique-binding-lock-');
    const root = path.join(scratch, 'evidence');
    const exact = bytes('response with delayed transcript');
    const projection = bytes('{"safe":true}');
    const transcript = bytes('opaque transcript');
    const record = recordFor(exact, { projection, transcript });
    const repositoryContext = context(repository);
    record.workId = `serialized-binding-${state}`;
    record.repository = {
      fingerprint: repositoryContext.fingerprint,
      fingerprintSource: repositoryContext.fingerprintSource,
      branch: repositoryContext.branch,
      head: repositoryContext.head,
    };
    record.critiqueId = derivePlanCritiqueId(record);

    const recordSource = path.join(scratch, 'record.json');
    const exactSource = path.join(scratch, 'exact');
    const projectionSource = path.join(scratch, 'projection');
    const transcriptSource = path.join(scratch, 'transcript');
    writeFileSync(recordSource, canonicalPlanCritiqueRecordJson(record), { mode: 0o600 });
    writeFileSync(exactSource, exact, { mode: 0o600 });
    writeFileSync(projectionSource, projection, { mode: 0o600 });
    writeFileSync(transcriptSource, transcript, { mode: 0o600 });
    let quarantineSource = 'none';
    if (quarantined) {
      const quarantineSourceRoot = path.join(scratch, 'quarantine-source');
      quarantine(record, quarantineSourceRoot);
      [quarantineSource] = quarantineFiles(quarantineSourceRoot);
      if (!quarantineSource) throw new Error('quarantine fixture is incomplete');
    }

    const holderScript = path.join(scratch, 'holder.mts');
    const contenderScript = path.join(scratch, 'contender.mts');
    const lockModule = pathToFileURL(
      path.join(import.meta.dirname, '..', 'persistence-lock.mts'),
    ).href;
    const bindingModule = pathToFileURL(
      path.join(import.meta.dirname, '..', 'evidence-bindings.mts'),
    ).href;
    writeFileSync(
      holderScript,
      `import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';\n` +
        `import path from 'node:path';\n` +
        `import { withPlanCritiquePersistenceLock } from ${JSON.stringify(lockModule)};\n` +
        `const [root, recordSource, critiqueId, exactSource, exactHash, projectionSource, projectionHash, transcriptSource, transcriptHash, quarantineSource, release] = process.argv.slice(2);\n` +
        `const wait = new Int32Array(new SharedArrayBuffer(4));\n` +
        `withPlanCritiquePersistenceLock({ root }, (canonicalRoot) => {\n` +
        `  const records = path.join(canonicalRoot, 'records');\n` +
        `  const blobs = path.join(canonicalRoot, 'blobs', 'sha256');\n` +
        `  mkdirSync(records, { recursive: true, mode: 0o700 });\n` +
        `  mkdirSync(blobs, { recursive: true, mode: 0o700 });\n` +
        `  chmodSync(records, 0o700); chmodSync(path.dirname(blobs), 0o700); chmodSync(blobs, 0o700);\n` +
        `  copyFileSync(recordSource, path.join(records, critiqueId + '.json'));\n` +
        `  copyFileSync(exactSource, path.join(blobs, exactHash));\n` +
        `  copyFileSync(projectionSource, path.join(blobs, projectionHash));\n` +
        `  for (const file of [path.join(records, critiqueId + '.json'), path.join(blobs, exactHash), path.join(blobs, projectionHash)]) chmodSync(file, 0o600);\n` +
        `  process.stdout.write('staged\\n');\n` +
        `  while (!existsSync(release)) Atomics.wait(wait, 0, 0, 2);\n` +
        `  const target = path.join(blobs, transcriptHash); copyFileSync(transcriptSource, target); chmodSync(target, 0o600);\n` +
        `  if (quarantineSource !== 'none') { const quarantines = path.join(canonicalRoot, 'work-quarantines'); mkdirSync(quarantines, { mode: 0o700 }); chmodSync(quarantines, 0o700); const quarantineTarget = path.join(quarantines, path.basename(quarantineSource)); copyFileSync(quarantineSource, quarantineTarget); chmodSync(quarantineTarget, 0o600); }\n` +
        `});\n`,
    );
    writeFileSync(
      contenderScript,
      `import { writeFileSync } from 'node:fs';\n` +
        lockAttemptInstrumentation() +
        `import { persistPlanCritiqueBinding } from ${JSON.stringify(bindingModule)};\n` +
        `const [root, repository, critiqueId, result] = process.argv.slice(2);\n` +
        `try {\n` +
        `writeFileSync(result, JSON.stringify(persistPlanCritiqueBinding(critiqueId, { cwd: repository, evidenceRoot: root })));\n` +
        `} finally { fs.openSync = originalOpen; syncBuiltinESMExports(); }\n`,
    );

    if (!record.sanitizedProjection || !record.opaqueTranscript)
      throw new Error('fixture is incomplete');
    const release = path.join(scratch, 'release');
    const result = path.join(scratch, 'contender-result');
    const holder = spawn(
      process.execPath,
      [
        holderScript,
        root,
        recordSource,
        record.critiqueId,
        exactSource,
        record.exactResponse.sha256,
        projectionSource,
        record.sanitizedProjection.sha256,
        transcriptSource,
        record.opaqueTranscript.sha256,
        quarantineSource,
        release,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const holderClosed = once(holder, 'close');
    if (!holder.stdout) throw new Error('holder stdout unavailable');
    const holderStaged = Promise.race([
      once(holder.stdout, 'data').then(([chunk]) => String(chunk)),
      holderClosed.then(([code]) => {
        throw new Error(`holder exited before staging: ${String(code)}`);
      }),
    ]);
    let contender: ReturnType<typeof spawn> | undefined;
    let contenderClosed: ReturnType<typeof once> | undefined;
    try {
      await expect(holderStaged).resolves.toBe('staged\n');
      expect(readPlanCritiqueRecord(record.critiqueId, { root })).toEqual(record);
      contender = spawn(
        process.execPath,
        [contenderScript, root, repository, record.critiqueId, result],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      contenderClosed = once(contender, 'close');
      if (!contender.stdout) throw new Error('contender stdout unavailable');
      const contenderStarted = Promise.race([
        once(contender.stdout, 'data').then(([chunk]) => String(chunk)),
        contenderClosed.then(([code]) => {
          throw new Error(`contender exited before binding: ${String(code)}`);
        }),
      ]);
      await expect(contenderStarted).resolves.toBe('waiting\n');
      expect(existsSync(result)).toBe(false);
      expect(existsSync(bindingFile(repository, record.workId))).toBe(false);
    } finally {
      writeFileSync(release, 'release');
    }
    expect((await holderClosed)[0]).toBe(0);
    expect((await (contenderClosed as ReturnType<typeof once>))[0]).toBe(0);
    const actual = JSON.parse(readFileSync(result, 'utf8')) as Record<string, unknown>;
    if (quarantined) {
      expect(actual).toEqual({ status: 'unavailable', reason: 'work_quarantined' });
      expect(existsSync(bindingFile(repository, record.workId))).toBe(false);
    } else {
      expect(actual).toMatchObject({ status: 'bound', binding: { critiqueId: record.critiqueId } });
      expect(existsSync(bindingFile(repository, record.workId))).toBe(true);
    }
  });

  it('re-evaluates quarantine after a one-candidate resolver waits for the lock', async () => {
    const repository = createRepository();
    const scratch = temporaryDirectory('critique-binding-resolver-lock-');
    const root = path.join(scratch, 'evidence');
    const record = storedRecord(repository, root, 'serialized-resolution');
    persistPlanCritiqueBinding(record.critiqueId, { cwd: repository, evidenceRoot: root });
    const quarantineSourceRoot = path.join(scratch, 'quarantine-source');
    quarantine(record, quarantineSourceRoot);
    const [quarantineSource] = quarantineFiles(quarantineSourceRoot);
    if (!quarantineSource) throw new Error('quarantine fixture is incomplete');

    const holderScript = path.join(scratch, 'holder.mts');
    const resolverScript = path.join(scratch, 'resolver.mts');
    const lockModule = pathToFileURL(
      path.join(import.meta.dirname, '..', 'persistence-lock.mts'),
    ).href;
    const bindingModule = pathToFileURL(
      path.join(import.meta.dirname, '..', 'evidence-bindings.mts'),
    ).href;
    writeFileSync(
      holderScript,
      `import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';\n` +
        `import path from 'node:path';\n` +
        `import { withPlanCritiquePersistenceLock } from ${JSON.stringify(lockModule)};\n` +
        `const [root, quarantineSource, publish, release] = process.argv.slice(2);\n` +
        `const wait = new Int32Array(new SharedArrayBuffer(4));\n` +
        `withPlanCritiquePersistenceLock({ root }, (canonicalRoot) => {\n` +
        `  process.stdout.write('held\\n');\n` +
        `  while (!existsSync(publish)) Atomics.wait(wait, 0, 0, 2);\n` +
        `  const directory = path.join(canonicalRoot, 'work-quarantines'); mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);\n` +
        `  const target = path.join(directory, path.basename(quarantineSource)); copyFileSync(quarantineSource, target); chmodSync(target, 0o600);\n` +
        `  process.stdout.write('published\\n');\n` +
        `  while (!existsSync(release)) Atomics.wait(wait, 0, 0, 2);\n` +
        `});\n`,
    );
    writeFileSync(
      resolverScript,
      `import { writeFileSync } from 'node:fs';\n` +
        lockAttemptInstrumentation() +
        `import { resolvePlanCritiqueBinding } from ${JSON.stringify(bindingModule)};\n` +
        `const [root, repository, workId, result] = process.argv.slice(2);\n` +
        `try {\n` +
        `writeFileSync(result, JSON.stringify(resolvePlanCritiqueBinding({ cwd: repository, evidenceRoot: root, workId })));\n` +
        `} finally { fs.openSync = originalOpen; syncBuiltinESMExports(); }\n`,
    );

    const publish = path.join(scratch, 'publish');
    const release = path.join(scratch, 'release');
    const result = path.join(scratch, 'resolver-result');
    const holder = spawn(
      process.execPath,
      [holderScript, root, quarantineSource, publish, release],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const holderClosed = once(holder, 'close');
    if (!holder.stdout) throw new Error('holder stdout unavailable');
    await expect(
      Promise.race([
        once(holder.stdout, 'data').then(([chunk]) => String(chunk)),
        holderClosed.then(([code]) => {
          throw new Error(`holder exited before locking: ${String(code)}`);
        }),
      ]),
    ).resolves.toBe('held\n');

    const resolver = spawn(
      process.execPath,
      [resolverScript, root, repository, record.workId, result],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const resolverClosed = once(resolver, 'close');
    if (!resolver.stdout) throw new Error('resolver stdout unavailable');
    try {
      await expect(
        Promise.race([
          once(resolver.stdout, 'data').then(([chunk]) => String(chunk)),
          resolverClosed.then(([code]) => {
            throw new Error(`resolver exited before starting: ${String(code)}`);
          }),
        ]),
      ).resolves.toBe('waiting\n');
      expect(existsSync(result)).toBe(false);
      const published = once(holder.stdout, 'data').then(([chunk]) => String(chunk));
      writeFileSync(publish, 'publish');
      await expect(published).resolves.toBe('published\n');
      expect(existsSync(result)).toBe(false);
    } finally {
      writeFileSync(publish, 'publish');
      writeFileSync(release, 'release');
    }
    expect((await holderClosed)[0]).toBe(0);
    expect((await resolverClosed)[0]).toBe(0);
    expect(JSON.parse(readFileSync(result, 'utf8'))).toEqual({
      status: 'unavailable',
      reason: 'work_quarantined',
      candidates: 1,
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
    rmSync(root, { recursive: true });
    expect(
      resolvePlanCritiqueBinding({ cwd: repository, evidenceRoot: root, workId: first.workId }),
    ).toEqual({ status: 'unavailable', reason: 'malformed_record', candidates: 1 });
    expect(existsSync(root)).toBe(false);
    expect(resolvePlanCritiqueBinding({ cwd: repository, evidenceRoot: root })).toEqual({
      status: 'unavailable',
      reason: 'ambiguous_matching_bindings',
      candidates: 2,
    });
    expect(existsSync(root)).toBe(false);
  });

  it('rejects hostile runtime work scopes before hashing them', () => {
    const repository = createRepository();
    for (const workId of [42, 'x'.repeat(4 * 1024 + 1)])
      expect(
        resolvePlanCritiqueBinding({
          cwd: repository,
          workId: workId as unknown as string,
        }),
      ).toEqual({ status: 'unavailable', reason: 'malformed_binding', candidates: 0 });
    let reads = 0;
    const changingScope: { cwd: string; workId?: string } = { cwd: repository };
    Object.defineProperty(changingScope, 'workId', {
      get: () => {
        reads += 1;
        return reads === 1 ? 'missing' : 'x'.repeat(4 * 1024 + 1);
      },
    });
    expect(resolvePlanCritiqueBinding(changingScope)).toEqual({
      status: 'unavailable',
      reason: 'no_matching_binding',
      candidates: 0,
    });
    expect(reads).toBe(1);
  });

  it('distinguishes an invalid evidence root from lock acquisition failure', () => {
    const repository = createRepository();
    const root = evidenceRoot();
    const record = storedRecord(repository, root, 'busy-evidence-lock');
    persistPlanCritiqueBinding(record.critiqueId, { cwd: repository, evidenceRoot: root });

    expect(
      resolvePlanCritiqueBinding({
        cwd: repository,
        evidenceRoot: 'relative',
        workId: record.workId,
      }),
    ).toEqual({ status: 'unavailable', reason: 'malformed_record', candidates: 1 });

    expect(
      withPlanCritiquePersistenceLock({ root }, () =>
        resolvePlanCritiqueBinding({
          cwd: repository,
          evidenceRoot: root,
          workId: record.workId,
        }),
      ),
    ).toEqual({ status: 'unavailable', reason: 'evidence_lock_unavailable', candidates: 1 });
  });

  it('keeps a completed resolution when lock release fails afterward', () => {
    const repository = createRepository();
    const root = evidenceRoot();
    const record = storedRecord(repository, root, 'release-failure');
    persistPlanCritiqueBinding(record.critiqueId, { cwd: repository, evidenceRoot: root });

    expect(
      withFailedPrimaryLockRelease(() =>
        resolvePlanCritiqueBinding({ cwd: repository, evidenceRoot: root, workId: record.workId }),
      ),
    ).toMatchObject({ status: 'resolved', binding: { critiqueId: record.critiqueId } });
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

  it('pins the preflight repository identity through lock acquisition', () => {
    const firstRepository = createRepository();
    const secondRepository = createRepository();
    const root = evidenceRoot();
    const workId = 'repository-switch';
    const first = storedRecord(firstRepository, root, workId, 'first-repository');
    const second = storedRecord(secondRepository, root, workId, 'second-repository');
    persistPlanCritiqueBinding(first.critiqueId, { cwd: firstRepository, evidenceRoot: root });
    persistPlanCritiqueBinding(second.critiqueId, { cwd: secondRepository, evidenceRoot: root });
    let reads = 0;
    const options: { cwd?: string; evidenceRoot: string; workId: string } = {
      evidenceRoot: root,
      workId,
    };
    Object.defineProperty(options, 'cwd', {
      get: () => {
        reads += 1;
        return reads === 1 ? firstRepository : secondRepository;
      },
    });

    expect(resolvePlanCritiqueBinding(options)).toEqual({
      status: 'unavailable',
      reason: 'repository_mismatch',
      candidates: 1,
    });
    expect(reads).toBe(2);
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
    const missingEvidenceRoot = path.join(root, 'missing');
    git(repository, 'checkout', '-q', '-b', 'other');
    expect(
      resolvePlanCritiqueBinding({
        cwd: repository,
        evidenceRoot: missingEvidenceRoot,
        workId: record.workId,
      }),
    ).toEqual({
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
    expect(
      resolvePlanCritiqueBinding({
        cwd: otherRepository,
        evidenceRoot: missingEvidenceRoot,
        workId: record.workId,
      }),
    ).toEqual({
      status: 'unavailable',
      reason: 'repository_mismatch',
      candidates: 1,
    });
  });

  it.each([
    'corrupt_json',
    'open_schema',
    'oversized',
    'public_mode',
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
    if (corruption === 'oversized') writeFileSync(file, Buffer.alloc(16 * 1024 + 1));
    if (corruption === 'public_mode') chmodSync(file, 0o644);
    if (corruption === 'wrong_filename')
      renameSync(file, path.join(path.dirname(file), `${'0'.repeat(64)}.json`));

    expect(resolvePlanCritiqueBinding({ cwd: repository, evidenceRoot: root })).toEqual({
      status: 'unavailable',
      reason: 'malformed_binding',
      candidates: 1,
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
