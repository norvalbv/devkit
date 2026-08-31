import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { testExecFileSync as execFileSync } from '../../__tests__/_helpers.mts';
import { readShipRuntimeIdentity, reportShipRuntimeProvenance } from './runtime-provenance.mts';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { force: true, recursive: true });
});

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function seedRepo(name = '@norvalbv/devkit'): string {
  const root = mkdtempSync(join(tmpdir(), 'ship-runtime-provenance-repo-'));
  dirs.push(root);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'devkit@example.com']);
  git(root, ['config', 'user.name', 'Devkit Test']);
  for (const rel of [
    'cli/commands/ship.mts',
    'cli/lib/ship/ship-branch.sh',
    'gate-engine/run.mts',
  ]) {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), `release ${rel}\n`);
  }
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ name, version: '1.2.3' })}\n`);
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'release: v1.2.3']);
  git(root, ['tag', 'v1.2.3']);
  return root;
}

function runtimeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ship-runtime-provenance-package-'));
  dirs.push(root);
  return root;
}

function commit(root: string, rel: string, contents: string, subject: string): void {
  mkdirSync(join(root, dirname(rel)), { recursive: true });
  writeFileSync(join(root, rel), contents);
  git(root, ['add', rel]);
  git(root, ['commit', '-q', '-m', subject]);
}

function report(root: string, identity: { packageRoot: string; version?: string }): string[] {
  const lines: string[] = [];
  reportShipRuntimeProvenance(root, identity, (line) => lines.push(line));
  return lines;
}

describe('ship runtime provenance', () => {
  it('always names the executing package version and resolved root', () => {
    const root = seedRepo('example-consumer');
    const runtime = runtimeRoot();

    expect(report(root, { packageRoot: runtime, version: '1.2.3' })).toEqual([
      `devkit ship: executing @norvalbv/devkit v1.2.3 from ${realpathSync(runtime)}`,
    ]);
  });

  it('keeps an invalid installed version type advisory instead of throwing', () => {
    const root = seedRepo();
    const runtime = runtimeRoot();
    writeFileSync(join(runtime, 'package.json'), `${JSON.stringify({ version: 42 })}\n`);

    const output = report(root, readShipRuntimeIdentity(runtime)).join('\n');

    expect(output).toContain('version unknown');
    expect(output).toContain('skew check unavailable: running package version is unavailable');
  });

  it('warns when committed self-host ship orchestration differs from the installed release', () => {
    const root = seedRepo();
    commit(
      root,
      'cli/lib/ship/ship-branch.sh',
      'new preflight\n',
      'feat(runtime): expose the new preflight',
    );

    const output = report(root, { packageRoot: runtimeRoot(), version: '1.2.3' }).join('\n');

    expect(output).toContain('1 packaged ship commit');
    expect(output).toContain('feat(runtime): expose the new preflight');
    expect(output).toContain(
      "packaged ship orchestration and preflights below are the installed build's",
    );
    expect(output).toContain('self-host commit gates still execute from the prepared worktree');
  });

  it('does not misclassify self-host source gates as installed runtime skew', () => {
    const root = seedRepo();
    commit(root, 'gate-engine/run.mts', 'new source gate\n', 'feat(gates): source-only gate');

    const lines = report(root, { packageRoot: runtimeRoot(), version: '1.2.3' });

    expect(lines).toHaveLength(1);
  });

  it('uses net scoped bytes so a fully reverted ship change does not warn', () => {
    const root = seedRepo();
    commit(root, 'cli/commands/ship.mts', 'temporary change\n', 'feat(ship): temporary change');
    git(root, ['revert', '--no-edit', 'HEAD']);

    const lines = report(root, { packageRoot: runtimeRoot(), version: '1.2.3' });

    expect(lines).toHaveLength(1);
  });

  it('does not warn when the executing package is this source checkout', () => {
    const root = seedRepo();
    commit(root, 'cli/commands/ship.mts', 'source change\n', 'feat(ship): source change');

    const lines = report(root, { packageRoot: root, version: '1.2.3' });

    expect(lines).toHaveLength(1);
  });

  it('keeps an unreadable committed self-host manifest visible as an unavailable check', () => {
    const root = seedRepo();
    writeFileSync(join(root, 'package.json'), '{ malformed');
    git(root, ['add', 'package.json']);
    git(root, ['commit', '-q', '-m', 'test: malformed manifest']);

    const output = report(root, { packageRoot: runtimeRoot(), version: '1.2.3' }).join('\n');

    expect(output).toContain(
      'skew check unavailable: could not determine whether committed HEAD is Devkit self-host',
    );
  });

  it('classifies self-host identity from committed HEAD when the working manifest is deleted', () => {
    const root = seedRepo();
    commit(root, 'cli/commands/ship.mts', 'new ship runtime\n', 'feat(ship): committed runtime');
    rmSync(join(root, 'package.json'));

    const output = report(root, { packageRoot: runtimeRoot(), version: '1.2.3' }).join('\n');

    expect(output).toContain('1 packaged ship commit');
  });

  it('does not let a working-tree name edit suppress the committed self-host check', () => {
    const root = seedRepo();
    commit(root, 'cli/commands/ship.mts', 'new ship runtime\n', 'feat(ship): committed runtime');
    writeFileSync(
      join(root, 'package.json'),
      `${JSON.stringify({ name: 'example-consumer', version: '1.2.3' })}\n`,
    );

    const output = report(root, { packageRoot: runtimeRoot(), version: '1.2.3' }).join('\n');

    expect(output).toContain('1 packaged ship commit');
  });

  it('does not let a working-tree name edit spuriously enable the self-host check', () => {
    const root = seedRepo('example-consumer');
    commit(root, 'cli/commands/ship.mts', 'consumer ship path\n', 'feat(ship): consumer change');
    writeFileSync(
      join(root, 'package.json'),
      `${JSON.stringify({ name: '@norvalbv/devkit', version: '1.2.3' })}\n`,
    );

    const lines = report(root, { packageRoot: runtimeRoot(), version: '1.2.3' });

    expect(lines).toHaveLength(1);
  });

  it('treats an absent committed root manifest as a confirmed non-self-host repository', () => {
    const root = seedRepo('example-consumer');
    git(root, ['rm', '-q', 'package.json']);
    git(root, ['commit', '-q', '-m', 'chore: remove optional root manifest']);

    const lines = report(root, { packageRoot: runtimeRoot(), version: '1.2.3' });

    expect(lines).toHaveLength(1);
  });

  it.each([
    [{ packageRoot: '', version: undefined }, 'running package version is unavailable'],
    [{ packageRoot: '', version: '9.9.9' }, 'release tag v9.9.9 is unavailable'],
  ])('keeps an unverifiable installed self-host comparison visible (%j)', (partial, reason) => {
    const root = seedRepo();
    const identity = { ...partial, packageRoot: runtimeRoot() };

    const output = report(root, identity).join('\n');

    expect(output).toContain(`skew check unavailable: ${reason}`);
  });

  it('classifies a checkout behind the installed release without calling it newer', () => {
    const root = seedRepo();
    commit(root, 'cli/commands/ship.mts', 'release-side change\n', 'feat(ship): release side');
    git(root, ['tag', 'v1.2.4']);
    git(root, ['reset', '--hard', 'HEAD~1']);

    const output = report(root, { packageRoot: runtimeRoot(), version: '1.2.4' }).join('\n');

    expect(output).toContain('is behind installed v1.2.4');
    expect(output).not.toContain('packaged ship commit');
  });

  it('reports divergent release history as unverifiable instead of calling HEAD newer', () => {
    const root = seedRepo();
    commit(root, 'cli/commands/ship.mts', 'release-side change\n', 'feat(ship): release side');
    git(root, ['tag', 'v1.2.4']);
    git(root, ['reset', '--hard', 'v1.2.3']);
    commit(root, 'cli/commands/ship.mts', 'head-side change\n', 'feat(ship): head side');

    const output = report(root, { packageRoot: runtimeRoot(), version: '1.2.4' }).join('\n');

    expect(output).toContain('release tag v1.2.4 and committed HEAD have divergent histories');
    expect(output).not.toContain('packaged ship commit');
  });

  it('strips terminal controls from commit subjects before printing a shortlog', () => {
    const root = seedRepo();
    commit(root, 'cli/commands/ship.mts', 'unsafe subject\n', 'feat(ship): \u001b[31mred\u0007');

    const output = report(root, { packageRoot: runtimeRoot(), version: '1.2.3' }).join('\n');

    expect(output).toContain('feat(ship): ?[31mred?');
    expect(output).not.toContain('\u001b');
    expect(output).not.toContain('\u0007');
  });
});
