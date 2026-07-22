import { spawn } from 'node:child_process';
import fs, {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolvePlanCritiqueEvidenceRoot,
  withExistingPlanCritiquePersistenceLock,
  withPlanCritiquePersistenceLock,
} from '../persistence-lock.mts';

const scratchDirectories: string[] = [];
const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function temporaryDirectory(prefix = 'critique-persistence-lock-'): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  scratchDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of scratchDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function lockFiles(parent: string): string[] {
  return readdirSync(parent).filter((name) => /^\.plan-critique-[0-9a-f]{64}\.lock$/.test(name));
}

interface ChildResult {
  code: number | null;
  stderr: string;
}

function runChild(script: string, args: string[]): Promise<ChildResult> {
  const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stderr }));
  });
}

async function waitForFile(file: string): Promise<void> {
  for (let attempt = 0; attempt < 5_000; attempt += 1) {
    if (existsSync(file)) return;
    await delay(2);
  }
  throw new Error(`timed out waiting for ${file}`);
}

function aliasRoots(scratch: string): { alias: string; real: string } {
  const realParent = path.join(scratch, 'real', 'nested');
  mkdirSync(realParent, { recursive: true, mode: 0o700 });
  symlinkSync(path.join(scratch, 'real'), path.join(scratch, 'alias'), 'dir');
  return {
    real: path.join(realParent, 'evidence'),
    alias: path.join(scratch, 'alias', 'nested', 'evidence'),
  };
}

function rootMutationHolderScript(scratch: string): string {
  const script = path.join(scratch, 'root-mutation-holder.mts');
  const moduleUrl = pathToFileURL(
    path.join(import.meta.dirname, '..', 'persistence-lock.mts'),
  ).href;
  writeFileSync(
    script,
    `import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';\n` +
      `import path from 'node:path';\n` +
      `import { withPlanCritiquePersistenceLock } from ${JSON.stringify(moduleUrl)};\n` +
      `const [root, entered, contenderWaiting, mutationComplete, mutation] = process.argv.slice(2);\n` +
      `const wait = new Int32Array(new SharedArrayBuffer(4));\n` +
      `withPlanCritiquePersistenceLock({ root }, (canonicalRoot) => {\n` +
      `  writeFileSync(entered, 'entered');\n` +
      `  while (!existsSync(contenderWaiting)) Atomics.wait(wait, 0, 0, 2);\n` +
      `  rmSync(mutation === 'remove_parent' ? path.dirname(canonicalRoot) : canonicalRoot, { recursive: true, force: true });\n` +
      `  if (mutation === 'replace') mkdirSync(canonicalRoot, { mode: 0o700 });\n` +
      `  writeFileSync(mutationComplete, 'complete');\n` +
      `});\n`,
  );
  return script;
}

function signalMainLockAttempt<Value>(
  signal: string,
  mutationComplete: string,
  action: () => Value,
  failRelease = false,
): Value {
  const originalOpen = fs.openSync;
  const originalUnlink = fs.unlinkSync;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
    if (
      /^\.plan-critique-[0-9a-f]{64}\.lock\.\d+\.[0-9a-f-]+\.candidate$/.test(
        path.basename(String(args[0])),
      )
    ) {
      writeFileSync(signal, 'waiting');
      while (!existsSync(mutationComplete)) Atomics.wait(wait, 0, 0, 2);
    }
    return originalOpen(...args);
  }) as typeof fs.openSync;
  fs.unlinkSync = ((...args: Parameters<typeof fs.unlinkSync>) => {
    if (failRelease && /^\.plan-critique-[0-9a-f]{64}\.lock$/.test(path.basename(String(args[0]))))
      throw Object.assign(new Error('injected release failure'), { code: 'EIO' });
    return originalUnlink(...args);
  }) as typeof fs.unlinkSync;
  syncBuiltinESMExports();
  try {
    return action();
  } finally {
    fs.openSync = originalOpen;
    fs.unlinkSync = originalUnlink;
    syncBuiltinESMExports();
  }
}

describe('plan critique persistence lock', () => {
  it('keeps asynchronous callbacks outside the type contract', () => {
    const compileOnly = () =>
      // @ts-expect-error persistence callbacks must finish before the file lock is released
      withPlanCritiquePersistenceLock({ root: '/unused' }, async () => undefined);
    const maybeAsync = (): string | Promise<string> => 'sync';
    const compileOnlyUnion = () =>
      // @ts-expect-error promise unions are asynchronous persistence callbacks too
      withPlanCritiquePersistenceLock({ root: '/unused' }, maybeAsync);
    const opaqueAsync: (root: string) => unknown = async () => undefined;
    const compileOnlyOpaque = () =>
      // @ts-expect-error unknown return types cannot prove synchronous completion
      withPlanCritiquePersistenceLock({ root: '/unused' }, opaqueAsync);
    const compileOnlyExisting = () =>
      // @ts-expect-error existing-root callbacks must finish before the file lock is released
      withExistingPlanCritiquePersistenceLock({ root: '/unused' }, async () => undefined);
    expect(compileOnly).toBeTypeOf('function');
    expect(compileOnlyUnion).toBeTypeOf('function');
    expect(compileOnlyOpaque).toBeTypeOf('function');
    expect(compileOnlyExisting).toBeTypeOf('function');
  });

  it('does not create missing default or custom roots', () => {
    const scratch = temporaryDirectory();
    const home = path.join(scratch, 'home');
    const customParent = path.join(scratch, 'custom-parent');
    const missingCustomParent = path.join(scratch, 'missing-custom-parent');
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(customParent, { mode: 0o700 });
    let actions = 0;
    const action = () => {
      actions += 1;
      return 'called';
    };
    const defaultResult = (() => {
      const previousHome = process.env.HOME;
      try {
        process.env.HOME = home;
        return withExistingPlanCritiquePersistenceLock({}, action);
      } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
      }
    })();

    const customResult = withExistingPlanCritiquePersistenceLock(
      { root: path.join(customParent, 'evidence') },
      action,
    );
    const missingParentResult = withExistingPlanCritiquePersistenceLock(
      { root: path.join(missingCustomParent, 'evidence') },
      action,
    );

    expect(defaultResult).toEqual({ status: 'absent' });
    expect(customResult).toEqual({ status: 'absent' });
    expect(missingParentResult).toEqual({ status: 'absent' });
    expect(actions).toBe(0);
    expect(readdirSync(home)).toEqual([]);
    expect(readdirSync(customParent)).toEqual([]);
    expect(existsSync(missingCustomParent)).toBe(false);
  });

  it('resolves a private home root and rejects unsafe custom roots', () => {
    const scratch = temporaryDirectory();
    const home = path.join(scratch, 'home');
    const otherCwd = path.join(scratch, 'elsewhere');
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(otherCwd, { mode: 0o700 });
    const previousHome = process.env.HOME;
    const previousCwd = process.cwd();
    const defaultParent = path.join(home, '.devkit', 'evidence', 'plan-critiques');
    mkdirSync(defaultParent, { recursive: true, mode: 0o755 });
    chmodSync(defaultParent, 0o755);
    let resolved: string | null;
    try {
      process.env.HOME = home;
      process.chdir(otherCwd);
      resolved = resolvePlanCritiqueEvidenceRoot({}, true);
    } finally {
      process.chdir(previousCwd);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
    const expected = path.join(realpathSync(home), '.devkit', 'evidence', 'plan-critiques', 'v1');
    expect(resolved).toBe(expected);
    expect(statSync(defaultParent).mode & 0o777).toBe(0o755);
    expect(statSync(expected).mode & 0o777).toBe(0o700);

    expect(() => resolvePlanCritiqueEvidenceRoot({ root: '' }, true)).toThrow(/\$\.root/);
    expect(() => resolvePlanCritiqueEvidenceRoot({ root: 'relative' }, true)).toThrow(/\$\.root/);
    expect(() => resolvePlanCritiqueEvidenceRoot({ root: path.parse(scratch).root }, true)).toThrow(
      /\$\.root/,
    );

    const outside = path.join(scratch, 'outside');
    const symlinkRoot = path.join(scratch, 'symlink-root');
    mkdirSync(outside, { mode: 0o700 });
    symlinkSync(outside, symlinkRoot, 'dir');
    expect(() => resolvePlanCritiqueEvidenceRoot({ root: symlinkRoot }, true)).toThrow(/symlink/);

    const writableParent = path.join(scratch, 'writable');
    mkdirSync(writableParent, { mode: 0o700 });
    chmodSync(writableParent, 0o777);
    expect(() =>
      resolvePlanCritiqueEvidenceRoot({ root: path.join(writableParent, 'evidence') }, true),
    ).toThrow(/writable by another user/);

    const publicRoot = path.join(scratch, 'public-root');
    mkdirSync(publicRoot, { mode: 0o755 });
    expect(() => resolvePlanCritiqueEvidenceRoot({ root: publicRoot }, false)).toThrow(
      /not private/,
    );
  });

  it('uses one canonical sibling lock and cleans it after success or failure', () => {
    const { alias, real } = aliasRoots(temporaryDirectory());
    const canonical = resolvePlanCritiqueEvidenceRoot({ root: real }, true) as string;
    const parent = path.dirname(canonical);
    expect(resolvePlanCritiqueEvidenceRoot({ root: alias }, false)).toBe(canonical);

    expect(
      withPlanCritiquePersistenceLock({ root: real }, (lockedRoot) => {
        expect(lockedRoot).toBe(canonical);
        const names = lockFiles(parent);
        expect(names).toHaveLength(1);
        const lockPath = path.join(parent, names[0]);
        expect(path.relative(canonical, lockPath).startsWith('..')).toBe(true);
        expect(statSync(lockPath).mode & 0o777).toBe(0o600);
        expect(() => withPlanCritiquePersistenceLock({ root: alias }, () => undefined)).toThrow(
          /^Another plan critique evidence persistence is in progress$/,
        );
        return 'complete';
      }),
    ).toBe('complete');
    expect(lockFiles(parent)).toEqual([]);

    expect(() =>
      withPlanCritiquePersistenceLock({ root: alias }, () => {
        throw new Error('action failed');
      }),
    ).toThrow(/^action failed$/);
    expect(lockFiles(parent)).toEqual([]);

    const promiseAction = (() => Promise.resolve('async')) as unknown as () => string;
    expect(() => withPlanCritiquePersistenceLock({ root: real }, promiseAction)).toThrow(
      /must be synchronous/,
    );
    expect(lockFiles(parent)).toEqual([]);

    let invoked = false;
    const opaqueAsync = (async () => {
      invoked = true;
    }) as unknown as () => void;
    expect(() => withPlanCritiquePersistenceLock({ root: real }, opaqueAsync)).toThrow(
      /must be synchronous/,
    );
    expect(invoked).toBe(false);
  });

  it('locks an existing root with the writer identity', () => {
    const { alias, real } = aliasRoots(temporaryDirectory());
    const canonical = resolvePlanCritiqueEvidenceRoot({ root: real }, true) as string;
    const parent = path.dirname(canonical);

    const result = withExistingPlanCritiquePersistenceLock({ root: alias }, (lockedRoot) => {
      expect(lockedRoot).toBe(canonical);
      expect(() => withPlanCritiquePersistenceLock({ root: real }, () => undefined)).toThrow(
        /^Another plan critique evidence persistence is in progress$/,
      );
      return 'complete' as const;
    });
    expect(result).toEqual({ status: 'locked', value: 'complete' });
    expect(lockFiles(parent)).toEqual([]);
  });

  it.each([
    'remove',
    'remove_parent',
    'remove_release_failure',
    'replace',
  ] as const)('does not authorize a root %s while waiting', async (mutation) => {
    const scratch = temporaryDirectory(`critique-existing-root-${mutation}-`);
    const { alias, real } = aliasRoots(scratch);
    const canonical = resolvePlanCritiqueEvidenceRoot({ root: real }, true) as string;
    const parent = path.dirname(canonical);
    const entered = path.join(scratch, 'holder-entered');
    const contenderWaiting = path.join(scratch, 'contender-waiting');
    const mutationComplete = path.join(scratch, 'mutation-complete');
    const holder = runChild(rootMutationHolderScript(scratch), [
      real,
      entered,
      contenderWaiting,
      mutationComplete,
      mutation,
    ]);
    await waitForFile(entered);

    let actionCalled = false;
    const contend = () =>
      signalMainLockAttempt(
        contenderWaiting,
        mutationComplete,
        () =>
          withExistingPlanCritiquePersistenceLock({ root: alias }, () => {
            actionCalled = true;
            return 'called';
          }),
        mutation === 'remove_release_failure',
      );
    if (mutation === 'replace')
      expect(contend).toThrow(
        /^plan critique evidence root changed while acquiring persistence lock$/,
      );
    else if (mutation === 'remove_release_failure')
      expect(contend).toThrow(/^injected release failure$/);
    else expect(contend()).toEqual({ status: 'absent' });

    expect(await holder).toEqual({ code: 0, stderr: '' });
    expect(actionCalled).toBe(false);
    expect(existsSync(canonical)).toBe(mutation === 'replace');
    expect(existsSync(parent)).toBe(mutation !== 'remove_parent');
    if (existsSync(parent)) {
      const remainingLocks = readdirSync(parent).filter((name) =>
        name.startsWith('.plan-critique-'),
      );
      expect(remainingLocks).toHaveLength(mutation === 'remove_release_failure' ? 1 : 0);
    }
  });

  it('serializes child processes that use real and alias roots', async () => {
    const scratch = temporaryDirectory('critique-persistence-processes-');
    const { alias, real } = aliasRoots(scratch);
    const canonical = resolvePlanCritiqueEvidenceRoot({ root: real }, true) as string;
    const script = path.join(scratch, 'holder.mts');
    const moduleUrl = pathToFileURL(
      path.join(import.meta.dirname, '..', 'persistence-lock.mts'),
    ).href;
    writeFileSync(
      script,
      `import { existsSync, rmSync, writeFileSync } from 'node:fs';\n` +
        `import { withPlanCritiquePersistenceLock } from ${JSON.stringify(moduleUrl)};\n` +
        `const [root, started, entered, release, removeRoot] = process.argv.slice(2);\n` +
        `writeFileSync(started, 'started');\n` +
        `const wait = new Int32Array(new SharedArrayBuffer(4));\n` +
        `withPlanCritiquePersistenceLock({ root }, (canonicalRoot) => {\n` +
        `  if (removeRoot === 'remove') rmSync(canonicalRoot, { recursive: true, force: true });\n` +
        `  writeFileSync(entered, 'entered');\n` +
        `  while (!existsSync(release)) Atomics.wait(wait, 0, 0, 2);\n` +
        `});\n`,
    );
    const holderStarted = path.join(scratch, 'holder-started');
    const holderEntered = path.join(scratch, 'holder-entered');
    const holderRelease = path.join(scratch, 'holder-release');
    const contenderStarted = path.join(scratch, 'contender-started');
    const contenderEntered = path.join(scratch, 'contender-entered');
    const contenderRelease = path.join(scratch, 'contender-release');
    const holder = runChild(script, [real, holderStarted, holderEntered, holderRelease, 'remove']);
    let contender: Promise<ChildResult> | undefined;
    try {
      await waitForFile(holderEntered);
      expect(existsSync(canonical)).toBe(false);
      contender = runChild(script, [
        alias,
        contenderStarted,
        contenderEntered,
        contenderRelease,
        'keep',
      ]);
      await waitForFile(contenderStarted);
      await delay(50);
      expect(existsSync(contenderEntered)).toBe(false);
      expect(existsSync(canonical)).toBe(false);
      writeFileSync(holderRelease, 'release');
      expect(await holder).toEqual({ code: 0, stderr: '' });
      await waitForFile(contenderEntered);
      expect(existsSync(canonical)).toBe(true);
    } finally {
      writeFileSync(holderRelease, 'release');
      writeFileSync(contenderRelease, 'release');
    }
    expect(await (contender as Promise<ChildResult>)).toEqual({ code: 0, stderr: '' });
    expect(lockFiles(path.dirname(canonical))).toEqual([]);
    expect(readFileSync(holderStarted, 'utf8')).toBe('started');
  });
});
