import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExperimentSpec } from '../performance/model.mts';
import { persistentFixtureKey, runPerformanceExperiment } from '../performance/runner.mts';

const roots: string[] = [];

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
}

function sourceFixture(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'performance-runner-test-')));
  roots.push(root);
  mkdirSync(join(root, 'gate-engine'), { recursive: true });
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'gate-engine/config.mts'), 'export const config = true;\n');
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'test@invalid.example']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['config', 'core.hooksPath', '/dev/null']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '--no-verify', '-m', 'base']);
  return root;
}

const command = (id: string) => ({
  id,
  label: id.toUpperCase(),
  command: {
    executable: 'node',
    args: ['-e', 'process.exitCode = 0'],
    versionArgs: ['--version'],
    expectedExit: 0,
    analyzer: 'none' as const,
  },
});

function spec(): ExperimentSpec {
  return {
    schemaVersion: 1,
    id: 'runner-integration',
    sourceTree: 'HEAD',
    minimumNodeVersion: '22.0.0',
    timeoutMs: 10_000,
    warmupsPerContender: 3,
    measurementsPerContender: 10,
    localPatch: { path: 'gate-engine/config.mts', append: '\n// probe\n' },
    lanes: [
      {
        id: 'local',
        label: 'Local',
        scope: 'local-staged',
        cwd: '.',
        inputs: { mode: 'changed', include: ['gate-engine/**/*.mts'], appendToArgs: false },
        contenders: [command('a'), command('b')],
      },
    ],
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('performance runner', () => {
  it('uses collision-resistant fixture keys for distinct lane/contender tuples', () => {
    const first = persistentFixtureKey({ id: 'x' }, { id: 'y--z' });
    const second = persistentFixtureKey({ id: 'x--y' }, { id: 'z' });
    const sanitizedCollision = persistentFixtureKey({ id: 'x' }, { id: 'a/b' });
    const sanitizedPeer = persistentFixtureKey({ id: 'x' }, { id: 'a-b' });
    expect(new Set([first, second, sanitizedCollision, sanitizedPeer])).toHaveLength(4);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it('runs supervised balanced samples in a disposable staged fixture', async () => {
    const result = await runPerformanceExperiment(spec(), { sourceRoot: sourceFixture() });
    expect(result.acceptance.accepted).toBe(true);
    expect(result.accounting).toMatchObject({
      wall: 'monotonic-wrapper',
      cpu: 'wait-accounted-command',
      memory: 'timed-command-maxrss',
    });
    const lane = result.lanes[0];
    expect(lane?.requestedFiles).toEqual(['gate-engine/config.mts']);
    expect(lane?.inputsAppliedToCommand).toBe(false);
    expect(lane?.parity.comparable).toBe(true);
    for (const contender of lane?.contenders ?? []) {
      expect(contender.samples).toHaveLength(13);
      expect(contender.samples.filter((sample) => sample.phase === 'measured')).toHaveLength(10);
      expect(contender.summary.wallSeconds.p95NearestRank).toBeGreaterThan(0);
      expect(contender.summary.maxResidentSetBytes.median).toBeGreaterThan(0);
    }
    expect(result.fixture.localPatchDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('preserves a measured command natural exit that overlaps the supervisor timeout status', async () => {
    const reservedExitSpec = spec();
    const lane = reservedExitSpec.lanes[0];
    const contender = lane?.contenders[0];
    if (!contender) throw new Error('fixture contender missing');
    contender.command.args = ['-e', 'process.exit(124)'];
    contender.command.expectedExit = 124;
    lane.contenders = [contender];

    const result = await runPerformanceExperiment(reservedExitSpec, {
      sourceRoot: sourceFixture(),
    });
    expect(result.lanes[0]?.contenders[0]?.samples.every((sample) => sample.exitCode === 124)).toBe(
      true,
    );
  });
});
