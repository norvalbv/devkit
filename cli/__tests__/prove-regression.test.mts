import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CLI, testSpawnSync } from './_helpers.mts';
import {
  parseVitestRegressionReport,
  type RegressionEvidence,
} from '../lib/baseline-status/regression-evidence.mts';
import * as windowsSupervisor from '../lib/baseline-status/regression-windows-supervisor.mts';
import {
  createRegressionClone,
  linkRegressionDependencies,
  localizedDependencyLink,
  snapshotRegressionCaller,
  splitNulPathBytes,
} from '../lib/baseline-status/regression-repository.mts';

const roots: string[] = [];

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', root, ...args], {
    encoding: 'utf8',
  }).trim();
}

function write(root: string, path: string, contents: string): void {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, contents);
}

function commit(root: string, message: string): string {
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', message);
  return git(root, 'rev-parse', 'HEAD');
}

interface Fixture {
  root: string;
  cwd: string;
  red: string;
  green: string;
}

function fixture(prefix = ''): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'prove-regression-'));
  roots.push(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Devkit Test');
  git(root, 'config', 'user.email', 'devkit@example.test');
  write(root, '.gitignore', 'node_modules\n.proof.json\nignored.txt\n');
  write(root, 'package.json', '{"name":"proof-fixture","private":true,"type":"module"}\n');
  write(root, `${prefix}value.txt`, 'broken\n');
  write(root, `${prefix}note.txt`, 'clean\n');
  commit(root, 'base with bug');
  write(
    root,
    `${prefix}check.mjs`,
    `import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
const actual = readFileSync('value.txt', 'utf8').trim();
const passed = actual === 'fixed';
if (process.env.MUTATE_CALLER) writeFileSync(process.env.MUTATE_CALLER, 'mutated\\n');
if (process.env.MUTATE_NON_UTF8_ROOT) {
  const root = Buffer.from(process.env.MUTATE_NON_UTF8_ROOT);
  const entry = readdirSync(root, { encoding: 'buffer' }).find((name) => name.includes(0xff));
  if (!entry) throw new Error('non-UTF-8 caller fixture is missing');
  writeFileSync(Buffer.concat([root, Buffer.from('/'), entry]), 'mutated\\n');
}
if (process.env.MUTATE_GIT_INDEX && process.env.GIT_INDEX_FILE) {
  writeFileSync(process.env.GIT_INDEX_FILE, 'command inherited caller Git state\\n');
}
if (process.env.MUTATE_GIT_CONFIG) {
  const config = readFileSync(process.env.MUTATE_GIT_CONFIG);
  writeFileSync(
    process.env.MUTATE_GIT_CONFIG,
    Buffer.concat([config, Buffer.from('\\n# mutated by exact proof command\\n')]),
  );
}
if (!process.argv.includes('--no-report')) {
  const badCounts = process.argv.includes('--bad-counts');
  const emptyAssertions = process.argv.includes('--empty-assertions');
  const hostile = process.argv.includes('--hostile-markdown');
  const malformedFailureMessages = process.argv.includes('--malformed-failure-messages');
  const impossibleSuccess = process.argv.includes('--impossible-success');
  const falseSuccess = process.argv.includes('--false-success');
  const suiteFailure = process.argv.includes('--suite-failure') && !passed;
  const message = 'AssertionError: expected ' + actual + ' to equal fixed at ' + process.cwd();
  writeFileSync('.proof.json', JSON.stringify({
    success: falseSuccess ? false : impossibleSuccess ? !passed : passed,
    numTotalTests: suiteFailure ? 0 : badCounts ? 2 : 1,
    numPassedTests: suiteFailure ? 0 : passed ? 1 : 0,
    numFailedTests: suiteFailure ? 0 : passed ? 0 : 1,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: [{ assertionResults: emptyAssertions || suiteFailure ? [] : [{
      fullName: hostile ? 'ticket **\\n\\n## forged \`heading\`' : 'ticket behavior returns the fixed value',
      status: passed ? 'passed' : 'failed',
      failureMessages: malformedFailureMessages ? [message, 7] : passed ? [] : [message],
    }] }],
  }));
}
console.log(passed ? 'PASS ticket behavior' : 'FAIL ticket behavior');
process.exitCode = passed ? 0 : 1;
`,
  );
  write(
    root,
    `${prefix}linger.mjs`,
    `import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const actual = readFileSync('value.txt', 'utf8').trim();
if (actual !== 'fixed') {
  const readyMarker = process.env.LINGER_MARKER + '.ready';
  const childSource = "const fs = require('node:fs'); process.on('SIGTERM', () => { fs.writeFileSync(process.argv[1], 'reaped'); process.exit(0); }); fs.writeFileSync(process.argv[2], 'ready'); setInterval(() => {}, 1000);";
  const child = spawn(process.execPath, ['-e', childSource, process.env.LINGER_MARKER, readyMarker], {
    detached: true,
    env: process.env,
    stdio: ['ignore', 1, 2],
  });
  const deadline = Date.now() + 5_000;
  while (!existsSync(readyMarker)) {
    if (child.exitCode !== null || child.signalCode !== null || Date.now() >= deadline) {
      child.kill();
      throw new Error('lingering child did not signal readiness');
    }
    await new Promise((resolveReady) => setTimeout(resolveReady, 5));
  }
  child.unref();
}
process.exitCode = process.argv.includes('--pass') || actual === 'fixed' ? 0 : 1;
`,
  );
  const red = commit(root, 'test: demonstrate the regression');
  write(root, `${prefix}value.txt`, 'fixed\n');
  const green = commit(root, 'fix: correct the behavior');
  return { root, cwd: resolve(root, prefix), red, green };
}

interface EvidenceCapture {
  evidence: RegressionEvidence;
  directory: string;
}

function runProof(
  fx: Fixture,
  options: {
    report?: boolean;
    command?: string[];
    commandArgs?: string[];
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  const report = options.report ?? true;
  const command = options.command ?? [
    process.execPath,
    'check.mjs',
    ...(options.commandArgs ?? []),
  ];
  return testSpawnSync(
    process.execPath,
    [
      CLI,
      'prove-regression',
      '--red',
      fx.red,
      '--green',
      fx.green,
      ...(report ? ['--vitest-report', '.proof.json'] : []),
      '--',
      ...command,
    ],
    { cwd: fx.cwd, encoding: 'utf8', env: options.env ?? process.env, timeout: 90_000 },
  );
}

function readEvidence(stdout: string): EvidenceCapture {
  const match = /^evidence: (.+)$/m.exec(stdout);
  if (!match?.[1]) throw new Error(`capture did not name its evidence directory:\n${stdout}`);
  const directory = match[1];
  roots.push(dirname(directory));
  // SAFETY: prove-regression writes evidence.json from the RegressionEvidence owner contract; this
  // test helper reads that exact artifact so its observable fields can be asserted below.
  const evidence = JSON.parse(
    readFileSync(join(directory, 'evidence.json'), 'utf8'),
  ) as RegressionEvidence;
  return {
    evidence,
    directory,
  };
}

function gitAdminFile(
  root: string,
  directory: '--git-common-dir' | '--git-dir',
  name: string,
): string {
  return join(git(root, 'rev-parse', '--path-format=absolute', directory), name);
}

function expectGitConfigMutationDetected(fx: Fixture, config: string): void {
  const before = readFileSync(config);
  const result = runProof(fx, {
    env: { ...process.env, MUTATE_GIT_CONFIG: config },
  });

  expect(result.status).toBe(1);
  const { evidence } = readEvidence(result.stdout);
  expect(evidence.status).toBe('inconclusive');
  expect(evidence.reason).toMatch(/caller boundary fingerprints differ/i);
  expect(evidence.callerBoundarySamples.matched).toBe(false);
  expect(readFileSync(config)).not.toEqual(before);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('devkit prove-regression', () => {
  it('signals only a live Windows helper through its retained process handle', () => {
    expect(windowsSupervisor.windowsHelperCanBeSignalled(false)).toBe(true);
    expect(windowsSupervisor.windowsHelperCanBeSignalled(true)).toBe(false);
  });

  it('retries a Windows helper signal that was not delivered', () => {
    let attempts = 0;
    let started = windowsSupervisor.attemptWindowsHelperSignal(false, false, () => {
      attempts += 1;
      return false;
    });
    expect(started).toBe(false);

    started = windowsSupervisor.attemptWindowsHelperSignal(started, false, () => {
      attempts += 1;
      return true;
    });
    expect(started).toBe(true);
    expect(windowsSupervisor.attemptWindowsHelperSignal(started, false, () => false)).toBe(true);
    expect(attempts).toBe(2);
  });

  it('registers only signals Windows can deliver to the supervisor', () => {
    expect(windowsSupervisor.WINDOWS_REGRESSION_SIGNALS).toEqual(['SIGHUP', 'SIGINT', 'SIGBREAK']);
    expect(windowsSupervisor.regressionCaptureSignals('win32').map(([signal]) => signal)).toEqual([
      'SIGHUP',
      'SIGINT',
      'SIGBREAK',
    ]);
    expect(windowsSupervisor.regressionCaptureSignals('linux')).toEqual([
      ['SIGHUP', 129],
      ['SIGINT', 130],
      ['SIGQUIT', 131],
      ['SIGTERM', 143],
    ]);
  });

  it('gives red and green independent dependency copies', () => {
    const root = mkdtempSync(join(tmpdir(), 'regression-dependencies-'));
    roots.push(root);
    const source = join(root, 'source');
    const red = join(root, 'red');
    const green = join(root, 'green');
    for (const path of [source, join(red, 'packages/widget'), join(green, 'packages/widget')]) {
      mkdirSync(path, { recursive: true });
    }
    writeFileSync(join(source, 'cache.txt'), 'caller\n');
    mkdirSync(join(source, 'internal'));
    writeFileSync(join(source, 'internal/data.txt'), 'caller link target\n');
    symlinkSync(join(source, 'internal'), join(source, 'absolute-link'), 'dir');

    const dependencySnapshot = linkRegressionDependencies(
      red,
      'packages/widget',
      realpathSync(source),
    );
    writeFileSync(join(source, 'cache.txt'), 'caller changed after snapshot\n');
    linkRegressionDependencies(green, 'packages/widget', dependencySnapshot);
    writeFileSync(join(red, 'node_modules/cache.txt'), 'red\n');
    writeFileSync(join(red, 'node_modules/absolute-link/data.txt'), 'red link target\n');

    expect(lstatSync(join(red, 'node_modules')).isDirectory()).toBe(true);
    expect(lstatSync(join(green, 'node_modules')).isDirectory()).toBe(true);
    expect(readFileSync(join(source, 'cache.txt'), 'utf8')).toBe('caller changed after snapshot\n');
    expect(readFileSync(join(green, 'node_modules/cache.txt'), 'utf8')).toBe('caller\n');
    expect(realpathSync(join(red, 'node_modules/absolute-link'))).toBe(
      realpathSync(join(red, 'node_modules/internal')),
    );
    expect(readFileSync(join(source, 'internal/data.txt'), 'utf8')).toBe('caller link target\n');
    expect(readFileSync(join(green, 'node_modules/internal/data.txt'), 'utf8')).toBe(
      'caller link target\n',
    );
    expect(realpathSync(join(red, 'packages/widget/node_modules'))).toBe(
      realpathSync(join(red, 'node_modules')),
    );
  });

  it('copies Git objects so source pruning cannot invalidate an operand clone', () => {
    const fx = fixture();
    const cloneRoot = mkdtempSync(join(tmpdir(), 'regression-object-copy-'));
    roots.push(cloneRoot);
    const clone = join(cloneRoot, 'operand');

    createRegressionClone(fx.root, clone, fx.red);

    expect(existsSync(join(clone, '.git/objects/info/alternates'))).toBe(false);
    rmSync(fx.root, { recursive: true, force: true });
    expect(git(clone, 'show', 'HEAD:value.txt')).toBe('broken');
  });

  it('recreates Windows dependency directories as unprivileged junctions', () => {
    const link = '/clone/node_modules/absolute-link';
    const target = '/clone/node_modules/internal';
    expect(localizedDependencyLink(link, target, true, 'win32')).toEqual({
      target,
      type: 'junction',
    });
    expect(localizedDependencyLink(link, target, true, 'linux')).toEqual({
      target: 'internal',
      type: 'dir',
    });
  });

  it('refuses dependency links that escape the copied store', () => {
    const root = mkdtempSync(join(tmpdir(), 'regression-dependency-link-'));
    roots.push(root);
    const source = join(root, 'source');
    const outside = join(root, 'outside');
    const clone = join(root, 'clone');
    for (const path of [source, outside, clone]) mkdirSync(path, { recursive: true });
    writeFileSync(join(outside, 'package.json'), '{}\n');
    symlinkSync(outside, join(source, 'external'), 'dir');

    expect(() => linkRegressionDependencies(clone, '', realpathSync(source))).toThrow(
      /symlink escapes its root/i,
    );
    expect(existsSync(join(clone, 'node_modules'))).toBe(false);
  });

  it('keeps Git NUL-delimited repository paths byte-exact', () => {
    const rawPath = Buffer.from([0x6e, 0x6f, 0x6e, 0x2d, 0x75, 0x74, 0x66, 0x38, 0x2d, 0xff]);
    const output = Buffer.concat([Buffer.from('ordinary.txt\0'), rawPath, Buffer.from([0])]);

    expect(splitNulPathBytes(output)).toEqual([Buffer.from('ordinary.txt'), rawPath]);
  });

  it.skipIf(process.platform === 'win32')(
    'fingerprints oversized ignored files without reading them into one Buffer',
    () => {
      const fx = fixture();
      const ignored = join(fx.root, 'ignored.txt');
      writeFileSync(ignored, '');
      truncateSync(ignored, 2 ** 31);

      const before = snapshotRegressionCaller(fx.root);
      truncateSync(ignored, 2 ** 31 + 1);

      expect(snapshotRegressionCaller(fx.root)).not.toBe(before);
    },
  );

  it('runs one exact command at a test-only red ref and fixed green ref without changing caller bytes', () => {
    const fx = fixture();
    write(fx.root, 'note.txt', 'dirty tracked bytes\n');
    write(fx.root, 'untracked.txt', 'untracked bytes\n');
    write(fx.root, 'ignored.txt', 'ignored bytes\n');
    const beforeStatus = git(fx.root, 'status', '--short');

    const result = runProof(fx);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const { evidence, directory } = readEvidence(result.stdout);
    expect(evidence.schema).toBe(3);
    expect(evidence.status).toBe('captured');
    expect(evidence.red).toMatchObject({
      sha: fx.red,
      exitCode: 1,
      testCounts: { total: 1, passed: 0, failed: 1 },
    });
    expect(evidence.green).toMatchObject({
      sha: fx.green,
      exitCode: 0,
      testCounts: { total: 1, passed: 1, failed: 0 },
    });
    expect(evidence.command.argv).toEqual([process.execPath, 'check.mjs']);
    expect(evidence.red.failures[0]).toMatchObject({
      fullName: 'ticket behavior returns the fixed value',
      message: expect.stringContaining('expected broken to equal fixed'),
    });
    expect(evidence.red.failures[0]?.message).toContain('<checkout>');
    expect(evidence.cleanup).toEqual({ redCloneRemoved: true, greenCloneRemoved: true });
    expect(evidence.callerBoundarySamples.matched).toBe(true);
    const markdown = readFileSync(join(directory, 'evidence.md'), 'utf8');
    expect(markdown).toContain('**CAPTURED**');
    expect(markdown).toContain('not automatic proof of causality');
    expect(markdown).toContain('boundary fingerprints matched: yes');
    expect(markdown).toContain('expected broken to equal fixed');
    expect(git(fx.root, 'status', '--short')).toBe(beforeStatus);
    expect(readFileSync(join(fx.root, 'note.txt'), 'utf8')).toBe('dirty tracked bytes\n');
    expect(readFileSync(join(fx.root, 'untracked.txt'), 'utf8')).toBe('untracked bytes\n');
    expect(readFileSync(join(fx.root, 'ignored.txt'), 'utf8')).toBe('ignored bytes\n');
  });

  it('ignores an inherited external Git index without changing its bytes', () => {
    const fx = fixture();
    const externalRoot = mkdtempSync(join(tmpdir(), 'prove-regression-external-index-'));
    roots.push(externalRoot);
    const externalIndex = join(externalRoot, 'index');
    execFileSync('git', ['-C', fx.root, 'read-tree', fx.green], {
      env: { ...process.env, GIT_INDEX_FILE: externalIndex },
    });
    const before = readFileSync(externalIndex);

    const result = runProof(fx, {
      env: { ...process.env, GIT_INDEX_FILE: externalIndex, MUTATE_GIT_INDEX: '1' },
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(readEvidence(result.stdout).evidence.status).toBe('captured');
    expect(readFileSync(externalIndex)).toEqual(before);
  });

  it('supports arbitrary commands without a runner-specific report', () => {
    const fx = fixture();
    const result = runProof(fx, { report: false, commandArgs: ['--no-report'] });

    expect(result.status, result.stderr).toBe(0);
    const { evidence } = readEvidence(result.stdout);
    expect(evidence.status).toBe('captured');
    expect(evidence.command.argv).toEqual([process.execPath, 'check.mjs', '--no-report']);
    expect(evidence.command.vitestReport).toBeNull();
    expect(evidence.red.testCounts).toBeNull();
    expect(evidence.green.testCounts).toBeNull();
  });

  it('makes an explicitly requested but missing report inconclusive', () => {
    const fx = fixture();
    const result = runProof(fx, { commandArgs: ['--no-report'] });

    expect(result.status, result.stderr).toBe(1);
    const { evidence, directory } = readEvidence(result.stdout);
    expect(evidence.status).toBe('inconclusive');
    expect(evidence.red.reportError).toMatch(/did not write a regular Vitest report/i);
    expect(evidence.green.reportError).toMatch(/did not write a regular Vitest report/i);
    expect(result.stderr).toMatch(/red Vitest report/i);
    const markdown = readFileSync(join(directory, 'evidence.md'), 'utf8');
    expect(markdown).toContain('Optional structured report');
    expect(markdown).toMatch(/Red: warning:.*did not write a regular Vitest report/i);
  });

  it('quotes report and argv text without allowing Markdown section injection', () => {
    const fx = fixture();
    const result = runProof(fx, { commandArgs: ['--hostile-markdown', '`arg`'] });

    expect(result.status, result.stderr).toBe(0);
    const { directory } = readEvidence(result.stdout);
    const markdown = readFileSync(join(directory, 'evidence.md'), 'utf8');
    expect(markdown).not.toMatch(/^## forged/m);
    expect(markdown).toContain('forged `heading`');
    expect(markdown).toContain('`arg`');
  });

  it('keeps malformed requested counts out of evidence and returns inconclusive', () => {
    const fx = fixture();
    const result = runProof(fx, { commandArgs: ['--bad-counts'] });

    expect(result.status, result.stderr).toBe(1);
    const { evidence, directory } = readEvidence(result.stdout);
    expect(evidence.status).toBe('inconclusive');
    expect(evidence.red.reportError).toMatch(/counts do not add up/i);
    expect(evidence.green.reportError).toMatch(/counts do not add up/i);
    expect(evidence.red.testCounts).toBeNull();
    expect(evidence.red.reportFile).toBe('red.vitest.json');
    expect(readFileSync(join(directory, 'red.vitest.json'))).not.toHaveLength(0);
  });

  it('rejects aggregate counts that are unsupported by assertion rows', () => {
    const fx = fixture();
    const result = runProof(fx, { commandArgs: ['--empty-assertions'] });

    expect(result.status, result.stderr).toBe(1);
    const { evidence } = readEvidence(result.stdout);
    expect(evidence.status).toBe('inconclusive');
    expect(evidence.red.reportError).toMatch(/aggregate counts do not match assertion results/i);
    expect(evidence.green.reportError).toMatch(/aggregate counts do not match assertion results/i);
    expect(evidence.red.testCounts).toBeNull();
  });

  it('makes a requested report with a non-string failure message inconclusive', () => {
    const fx = fixture();
    const result = runProof(fx, { commandArgs: ['--malformed-failure-messages'] });

    expect(result.status, result.stderr).toBe(1);
    const { evidence } = readEvidence(result.stdout);
    expect(evidence.status).toBe('inconclusive');
    expect(evidence.red.reportError).toMatch(/malformed assertion/i);
    expect(evidence.red.testCounts).toBeNull();
    expect(evidence.green.reportError).toMatch(/malformed assertion/i);
    expect(evidence.green.testCounts).toBeNull();
  });

  it('rejects success with failed assertions', () => {
    const fx = fixture();
    const result = runProof(fx, { commandArgs: ['--impossible-success'] });

    expect(result.status, result.stderr).toBe(1);
    const { evidence } = readEvidence(result.stdout);
    expect(evidence.status).toBe('inconclusive');
    expect(evidence.red.reportError).toMatch(/success is true despite failed assertion results/i);
    expect(evidence.red.testCounts).toBeNull();
  });

  it('admits success false with no failed assertions for a failing suite', () => {
    const fx = fixture();
    const result = runProof(fx, { commandArgs: ['--suite-failure'] });

    expect(result.status, result.stderr).toBe(0);
    const { evidence } = readEvidence(result.stdout);
    expect(evidence.status).toBe('captured');
    expect(evidence.red.reportError).toBeNull();
    expect(evidence.red.testCounts).toEqual({
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      todo: 0,
    });
  });

  it('makes a passing command with Vitest success false inconclusive', () => {
    const fx = fixture();
    const result = runProof(fx, { commandArgs: ['--false-success'] });

    expect(result.status, result.stderr).toBe(1);
    const { evidence } = readEvidence(result.stdout);
    expect(evidence.status).toBe('inconclusive');
    expect(evidence.red.reportError).toBeNull();
    expect(evidence.red.testCounts).toMatchObject({ total: 1, failed: 1 });
    expect(evidence.green.reportError).toMatch(/success is false despite command exiting 0/i);
    expect(evidence.green.testCounts).toBeNull();
  });

  it('scrubs checkout and shared dependency paths from structured failure summaries', () => {
    const checkout = '/tmp/proof clone';
    const dependency = '/Users/example/shared dependencies';
    const report = parseVitestRegressionReport(
      JSON.stringify({
        success: false,
        numTotalTests: 1,
        numPassedTests: 0,
        numFailedTests: 1,
        numPendingTests: 0,
        numTodoTests: 0,
        testResults: [
          {
            assertionResults: [
              {
                fullName: `fails at ${checkout}`,
                status: 'failed',
                failureMessages: [`at ${pathToFileURL(dependency).href}/vitest.js`],
              },
            ],
          },
        ],
      }),
      checkout,
      dependency,
    );

    expect(report.failures).toEqual([
      {
        fullName: 'fails at <checkout>',
        message: 'at <dependency-store>/vitest.js',
      },
    ]);
  });

  it('returns inconclusive unless red is nonzero and green is zero', () => {
    const fx = fixture();
    const result = runProof(fx, {
      report: false,
      command: [process.execPath, '-e', 'process.exit(0)'],
    });

    expect(result.status).toBe(1);
    const { evidence } = readEvidence(result.stdout);
    expect(evidence.status).toBe('inconclusive');
    expect(evidence.reason).toMatch(/expected red nonzero and green zero; got 0\/0/i);
  });

  it('detects an unsandboxed command mutating ignored caller state', () => {
    const fx = fixture();
    const ignored = join(fx.root, 'ignored.txt');
    writeFileSync(ignored, 'original\n');
    const result = runProof(fx, {
      env: { ...process.env, MUTATE_CALLER: ignored },
    });

    expect(result.status).toBe(1);
    const { evidence } = readEvidence(result.stdout);
    expect(evidence.status).toBe('inconclusive');
    expect(evidence.reason).toMatch(/caller boundary fingerprints differ/i);
    expect(evidence.callerBoundarySamples.matched).toBe(false);
    expect(readFileSync(ignored, 'utf8')).toBe('mutated\n');
  });

  it('detects an exact command mutating the caller common Git config', () => {
    const fx = fixture();

    expectGitConfigMutationDetected(fx, gitAdminFile(fx.root, '--git-common-dir', 'config'));
  });

  it('detects an exact command mutating the caller worktree Git config in a linked checkout', () => {
    const fx = fixture();
    git(fx.root, 'config', 'extensions.worktreeConfig', 'true');
    const parent = mkdtempSync(join(tmpdir(), 'prove-regression-worktree-config-'));
    roots.push(parent);
    const checkout = join(parent, 'checkout');
    git(fx.root, 'worktree', 'add', '--quiet', '--detach', checkout, fx.green);
    const linked = { ...fx, root: checkout, cwd: checkout };
    git(linked.root, 'config', '--worktree', 'proof.initial', 'true');

    expectGitConfigMutationDetected(
      linked,
      gitAdminFile(linked.root, '--git-dir', 'config.worktree'),
    );
  });

  it.skipIf(process.platform === 'darwin' || process.platform === 'win32')(
    'detects caller mutations through a non-UTF-8 repository filename',
    () => {
      const fx = fixture();
      const rawPath = Buffer.concat([Buffer.from(`${fx.root}/non-utf8-`), Buffer.from([0xff])]);
      writeFileSync(rawPath, 'original\n');

      const result = runProof(fx, {
        env: { ...process.env, MUTATE_NON_UTF8_ROOT: fx.root },
      });

      expect(result.status).toBe(1);
      const { evidence } = readEvidence(result.stdout);
      expect(evidence.status).toBe('inconclusive');
      expect(evidence.reason).toMatch(/caller boundary fingerprints differ/i);
      expect(evidence.callerBoundarySamples.matched).toBe(false);
      expect(readFileSync(rawPath, 'utf8')).toBe('mutated\n');
    },
  );

  it('rejects a temporary directory inside the caller repository before writing evidence', () => {
    const fx = fixture();
    const callerTmp = join(fx.root, '.tmp');
    mkdirSync(callerTmp);

    const result = runProof(fx, {
      report: false,
      env: { ...process.env, TMPDIR: callerTmp },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/temporary directory must be outside the caller repository/i);
    expect(result.stdout).not.toContain('evidence:');
    expect(readdirSync(callerTmp)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'removes disposable clones when interrupted during clone setup',
    () => {
      const fx = fixture();
      const bin = join(fx.root, 'fake-bin');
      const captureTmp = mkdtempSync(join(tmpdir(), 'prove-regression-interrupt-'));
      roots.push(captureTmp);
      const marker = join(fx.root, 'first-clone-finished');
      mkdirSync(bin);
      const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
      const wrapper = join(bin, 'git');
      writeFileSync(
        wrapper,
        `#!/bin/sh
case " $* " in
  *" clone "*)
    if [ -e "$PROOF_GIT_MARKER" ]; then
      kill -TERM "$PPID"
    else
      : > "$PROOF_GIT_MARKER"
    fi
    ;;
esac
exec ${JSON.stringify(realGit)} "$@"
`,
      );
      chmodSync(wrapper, 0o755);

      const result = runProof(fx, {
        report: false,
        commandArgs: ['--no-report'],
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          PROOF_GIT_MARKER: marker,
          TMPDIR: captureTmp,
        },
      });

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(143);
      expect(readdirSync(captureTmp)).toEqual([]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'reaps an escaped descendant before hashing logs and removing clones',
    () => {
      const fx = fixture();
      const markerRoot = mkdtempSync(join(tmpdir(), 'prove-regression-linger-'));
      roots.push(markerRoot);
      const marker = join(markerRoot, 'reaped');

      const result = runProof(fx, {
        report: false,
        command: [process.execPath, 'linger.mjs'],
        env: { ...process.env, LINGER_MARKER: marker },
      });

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(readFileSync(marker, 'utf8')).toBe('reaped');
      const { evidence, directory } = readEvidence(result.stdout);
      expect(evidence.red.exitCode).toBe(1);
      expect(readFileSync(join(directory, 'red.stdout.log'))).toHaveLength(0);
      expect(readFileSync(join(directory, 'red.stderr.log'))).toHaveLength(0);
      expect(evidence.red.stdoutSha256).toBe(
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      );
      expect(evidence.red.stderrSha256).toBe(evidence.red.stdoutSha256);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'does not turn a passing red leader with a leaked child into captured evidence',
    () => {
      const fx = fixture();
      const markerRoot = mkdtempSync(join(tmpdir(), 'prove-regression-linger-pass-'));
      roots.push(markerRoot);
      const result = runProof(fx, {
        report: false,
        command: [process.execPath, 'linger.mjs', '--pass'],
        env: { ...process.env, LINGER_MARKER: join(markerRoot, 'reaped') },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(
        /process tree did not drain cleanly.*command 0, supervisor 124/i,
      );
      expect(result.stdout).not.toContain('evidence:');
    },
  );

  it('distinguishes an explicit reserved exit code from a genuine signal', () => {
    const fx = fixture();
    const explicit = runProof(fx, {
      report: false,
      command: [
        process.execPath,
        '-e',
        "const fixed=require('node:fs').readFileSync('value.txt','utf8').trim()==='fixed';process.exit(fixed?0:143)",
      ],
    });

    expect(explicit.status, explicit.stderr).toBe(0);
    const explicitEvidence = readEvidence(explicit.stdout).evidence;
    expect(explicitEvidence.red.exitCode).toBe(143);
    expect(explicitEvidence.red.signal).toBeNull();

    const signalled = runProof(fx, {
      report: false,
      command: [
        process.execPath,
        '-e',
        "const fixed=require('node:fs').readFileSync('value.txt','utf8').trim()==='fixed';if(!fixed)process.kill(process.platform==='win32'?process.pid:0,'SIGTERM')",
      ],
    });
    expect(signalled.status).toBe(1);
    const signalledEvidence = readEvidence(signalled.stdout).evidence;
    expect(signalledEvidence.status).toBe('inconclusive');
    expect(signalledEvidence.red.exitCode).toBeNull();
    expect(signalledEvidence.red.signal).toBe('SIGTERM');
  });

  it('preserves the caller package directory in both clones', () => {
    const fx = fixture('packages/widget/');
    const result = runProof(fx);

    expect(result.status, result.stderr).toBe(0);
    const { evidence } = readEvidence(result.stdout);
    expect(evidence.command.callerPrefix).toBe('packages/widget');
    expect(evidence.red.testCounts).toMatchObject({ failed: 1 });
  });

  it('rejects a historical caller directory that escapes through a symlink', () => {
    const fx = fixture('packages/widget/');
    const safe = fx.green;
    const outside = join(fx.root, 'outside');
    mkdirSync(outside);
    mkdirSync(join(fx.root, 'node_modules'));
    rmSync(fx.cwd, { recursive: true });
    symlinkSync(outside, fx.cwd);
    const escaping = commit(fx.root, 'replace package directory with an escaping symlink');
    rmSync(fx.cwd);
    git(fx.root, 'checkout', safe, '--', 'packages/widget');
    const restored = commit(fx.root, 'restore package directory');

    const result = testSpawnSync(
      process.execPath,
      [
        CLI,
        'prove-regression',
        '--red',
        escaping,
        '--green',
        restored,
        '--',
        process.execPath,
        'check.mjs',
      ],
      { cwd: fx.cwd, encoding: 'utf8' },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/caller directory is not a real directory at this ref/i);
    expect(existsSync(join(outside, 'node_modules'))).toBe(false);
  });

  it('rejects unsafe report paths and equal refs before creating evidence', () => {
    const fx = fixture();
    const unsafe = testSpawnSync(
      process.execPath,
      [
        CLI,
        'prove-regression',
        '--red',
        fx.red,
        '--green',
        fx.green,
        '--vitest-report',
        '../proof.json',
        '--',
        process.execPath,
        'check.mjs',
      ],
      { cwd: fx.cwd, encoding: 'utf8' },
    );
    const equal = testSpawnSync(
      process.execPath,
      [
        CLI,
        'prove-regression',
        '--red',
        fx.red,
        '--green',
        fx.red,
        '--',
        process.execPath,
        'check.mjs',
      ],
      { cwd: fx.cwd, encoding: 'utf8' },
    );

    expect(unsafe.status).toBe(1);
    expect(unsafe.stderr).toMatch(/unsafe repository path/i);
    expect(unsafe.stdout).not.toContain('evidence:');
    expect(equal.status).toBe(1);
    expect(equal.stderr).toMatch(/resolve to the same commit/i);
    expect(equal.stdout).not.toContain('evidence:');
  });
});
