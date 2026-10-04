import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { subtractionTrial } from '../lib/baseline-status/subtraction-trial.mts';
import { CLI, testSpawnSync } from './_helpers.mts';

const roots: string[] = [];

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', root, ...args], {
    encoding: 'utf8',
  }).trim();
}

function commit(root: string, message: string): string {
  git(root, 'add', '-A');
  git(
    root,
    '-c',
    'user.name=Devkit Test',
    '-c',
    'user.email=devkit@example.test',
    'commit',
    '-qm',
    message,
  );
  return git(root, 'rev-parse', 'HEAD');
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'subtraction-trial-'));
  roots.push(root);
  git(root, 'init', '-q');
  writeFileSync(join(root, '.gitignore'), '.trial.json\nnode_modules\n');
  writeFileSync(join(root, 'behavior.json'), '{"feature":true,"workaround":true}\n');
  writeFileSync(
    join(root, 'check.mjs'),
    `
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const behavior = JSON.parse(readFileSync('behavior.json', 'utf8'));
let passed = true;
try { assert.equal(behavior.feature, true); } catch { passed = false; }
const blind = process.argv.includes('--blind');
const empty = process.argv.includes('--empty');
if (blind) passed = true;
if (existsSync('node_modules/oracle.json') && JSON.parse(readFileSync('node_modules/oracle.json', 'utf8')).blind) passed = true;
if (process.env.MUTATE_DEPS_PATH && !behavior.workaround) writeFileSync(process.env.MUTATE_DEPS_PATH, '{"blind":false}');
if (!process.argv.includes('--no-report')) writeFileSync('.trial.json', JSON.stringify({
  success: passed, numTotalTests: empty ? 0 : 1,
  numPassedTests: empty ? 0 : passed ? 1 : 0,
  numFailedTests: empty ? 0 : passed ? 0 : 1, numPendingTests: 0, numTodoTests: 0,
  testResults: [{ assertionResults: empty ? [] : [{ fullName: 'required feature',
    status: passed ? 'passed' : 'failed', failureMessages: passed ? [] : ['required feature absent'] }] }],
}));
console.log(passed ? 'PASS required feature' : 'FAIL required feature');
process.exitCode = passed ? 0 : 1;
`,
  );
  const baseline = commit(root, 'baseline with workaround');
  writeFileSync(join(root, 'behavior.json'), '{"feature":true,"workaround":false}\n');
  const candidate = commit(root, 'remove unnecessary workaround');
  writeFileSync(join(root, 'behavior.json'), '{"feature":false,"workaround":false}\n');
  const control = commit(root, 'remove required behavior');
  return { root, baseline, candidate, control };
}

function trial(f: ReturnType<typeof fixture>, extra: string[] = [], env = process.env) {
  const before = git(f.root, 'status', '--porcelain=v2');
  const result = testSpawnSync(
    process.execPath,
    [
      CLI,
      'subtraction-trial',
      '--baseline',
      f.baseline,
      '--candidate',
      f.candidate,
      '--control',
      f.control,
      '--oracle',
      'check.mjs',
      '--vitest-report',
      '.trial.json',
      '--',
      process.execPath,
      'check.mjs',
      ...extra,
    ],
    { cwd: f.root, encoding: 'utf8', env },
  );
  expect(git(f.root, 'status', '--porcelain=v2')).toBe(before);
  const location = result.stdout.match(/^subtraction evidence: (.+)$/m)?.[1];
  for (const match of result.stdout.matchAll(/^evidence: (.+)$/gm)) roots.push(dirname(match[1]!));
  return {
    result,
    evidence: location
      ? JSON.parse(readFileSync(join(location, 'subtraction.json'), 'utf8'))
      : null,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('subtraction-trial consumer CLI', () => {
  it('captures a passing deletion with a failing sensitivity control without changing the caller', () => {
    const { result, evidence } = trial(fixture());
    expect(result.status, result.stderr).toBe(0);
    expect(evidence).toMatchObject({ status: 'tests-preserved', redundancyProven: false });
    expect(evidence.baseline.exitCode).toBe(0);
    expect(evidence.candidate.exitCode).toBe(0);
    expect(evidence.control.exitCode).toBe(1);
  });

  it('does not claim preservation when the selected command is blind to the invalid control', () => {
    const { result, evidence } = trial(fixture(), ['--blind']);
    expect(result.status).toBe(1);
    expect(evidence).toMatchObject({ status: 'oracle_blind' });
    expect(evidence.reason).toContain('control');
  });

  it('uses one dependency snapshot when caller dependencies change between comparisons', () => {
    const f = fixture();
    mkdirSync(join(f.root, 'node_modules'));
    const dependency = join(f.root, 'node_modules/oracle.json');
    writeFileSync(dependency, '{"blind":true}');
    const { result, evidence } = trial(f, [], { ...process.env, MUTATE_DEPS_PATH: dependency });
    expect(result.status).toBe(1);
    expect(evidence).toMatchObject({ status: 'oracle_blind' });
    expect(evidence.control.exitCode).toBe(0);
    expect(evidence.reason).toContain('control');
  });

  it.each([['--no-report'], ['--empty']])(
    'does not accept unavailable or empty assertion evidence (%s)',
    (...extra) => {
      const { result, evidence } = trial(fixture(), extra);
      expect(result.status).toBe(1);
      expect(evidence).toMatchObject({
        status: extra[0] === '--empty' ? 'oracle_blind' : 'inconclusive',
      });
    },
  );

  it('rejects a candidate that changes the declared oracle before executing any tests', () => {
    const f = fixture();
    writeFileSync(join(f.root, 'check.mjs'), 'process.exit(0);\n');
    f.candidate = commit(f.root, 'weaken oracle');
    const { result, evidence } = trial(f);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('oracle changed');
    expect(evidence).toBeNull();
  });

  it('reports inconclusive when a capture ends before producing evidence', async () => {
    const f = fixture();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const argv = ['--baseline', f.baseline, '--candidate', f.candidate, '--control', f.control];
    const rest = [
      '--oracle',
      'check.mjs',
      '--vitest-report',
      '.trial.json',
      '--',
      'node',
      'check.mjs',
    ];
    const noEvidence = async () => ({ exitCode: 1 });
    expect(await subtractionTrial([...argv, ...rest], f.root, noEvidence)).toBe(1);
    expect(log).toHaveBeenCalledWith(
      'subtraction: inconclusive — the candidate capture produced no evidence',
    );
    log.mockRestore();
  });

  it('reports a candidate that removes required behavior as tests-failed', () => {
    const f = fixture();
    writeFileSync(join(f.root, 'behavior.json'), '{"feature":false}\n');
    f.candidate = commit(f.root, 'remove required behavior differently');
    const { result, evidence } = trial(f);
    expect(result.status).toBe(1);
    expect(evidence).toMatchObject({ status: 'tests-failed', redundancyProven: false });
  });
});
