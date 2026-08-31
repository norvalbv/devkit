import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectDistIntegrity, printDistIntegrityFailure } from '../lib/ship/dist-integrity.mts';
import { rootRegistry } from './_helpers.mts';

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const preflightScript = fileURLToPath(new URL('../lib/ship/dist-integrity.mts', import.meta.url));
const shipScript = fileURLToPath(new URL('../lib/ship/ship-branch.sh', import.meta.url));
const reshipScript = fileURLToPath(new URL('../lib/ship/reship.sh', import.meta.url));
const packageJson = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
) as { dependencies: Record<string, string> };
const CLEAN_ACTIVE = {
  active: true,
  unresolved: [],
  unbriefed: [],
  untracked: [],
  unlexable: [],
};
const { mkTmp, cleanup } = rootRegistry();
afterEach(cleanup);

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV },
  }).trim();
}

function repo(name = '@norvalbv/devkit'): { base: string; root: string } {
  const root = mkTmp('dist-integrity-');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'a@b.c');
  git(root, 'config', 'user.name', 'a');
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ name })}\n`);
  writeFileSync(join(root, '.gitignore'), 'dist/\n');
  mkdirSync(join(root, 'dist'));
  writeFileSync(join(root, 'dist/index.mjs'), 'export const ready = true;\n');
  git(root, 'add', 'package.json', '.gitignore');
  git(root, 'add', '-f', 'dist/index.mjs');
  git(root, 'commit', '-q', '-m', 'base');
  return { base: git(root, 'rev-parse', 'HEAD'), root };
}

describe('inspectDistIntegrity', () => {
  it('declares its dynamic parser as a runtime dependency', () => {
    expect(packageJson.dependencies['es-module-lexer']).toBeDefined();
  });

  it('reports an ignored generated artifact missing from the Git index', async () => {
    const { base, root } = repo();
    mkdirSync(join(root, 'dist/cli'));
    writeFileSync(join(root, 'dist/cli/new.mjs'), 'export const value = 1;\n');

    const report = await inspectDistIntegrity(root, base, ['cli/new.mts']);

    expect(report.untracked).toEqual(['dist/cli/new.mjs']);
  });

  it('reports a force-added artifact omitted from the explicit ship paths', async () => {
    const { base, root } = repo();
    mkdirSync(join(root, 'dist/cli'));
    writeFileSync(join(root, 'dist/cli/new.mjs'), 'export const value = 1;\n');
    git(root, 'add', '-f', 'dist/cli/new.mjs');

    const report = await inspectDistIntegrity(root, base, ['cli/new.mts']);

    expect(report.unbriefed).toEqual(['dist/cli/new.mjs']);
  });

  it('passes once the new artifact is tracked and explicitly briefed', async () => {
    const { base, root } = repo();
    mkdirSync(join(root, 'dist/cli'));
    writeFileSync(join(root, 'dist/cli/new.mjs'), 'export const value = 1;\n');
    git(root, 'add', '-f', 'dist/cli/new.mjs');

    const report = await inspectDistIntegrity(root, base, ['cli/new.mts', 'dist/cli/new.mjs']);

    expect(report).toEqual(CLEAN_ACTIVE);
  });

  it("ignores another agent's unrelated dist artifacts", async () => {
    const { base, root } = repo();
    writeFileSync(join(root, 'dist/unrelated-untracked.mjs'), 'export {};\n');
    writeFileSync(join(root, 'dist/unrelated-added.mjs'), 'export {};\n');
    git(root, 'add', '-f', 'dist/unrelated-added.mjs');

    const report = await inspectDistIntegrity(root, base, ['dist/index.mjs']);

    expect(report).toEqual(CLEAN_ACTIVE);
  });

  it('finds missing static and string-literal dynamic imports but skips templates', async () => {
    const { base, root } = repo();
    writeFileSync(
      join(root, 'dist/index.mjs'),
      [
        "import './missing-static.mjs';",
        "import('./missing-dynamic.mjs');",
        ['import(`./$', '{runtimeName}.mjs`);'].join(''),
      ].join('\n'),
    );

    const report = await inspectDistIntegrity(root, base, ['dist/index.mjs']);

    expect(report.unresolved.map(({ specifier }) => specifier)).toEqual([
      './missing-dynamic.mjs',
      './missing-static.mjs',
    ]);
  });

  it('accepts a newly generated artifact this ship explicitly briefs', async () => {
    const { base, root } = repo();
    mkdirSync(join(root, 'dist/cli'));
    writeFileSync(join(root, 'dist/cli/new.mjs'), 'export const value = 1;\n');

    // The shape `devkit release` briefs: every tracked dist file plus the ones the build just
    // generated, which are by definition still absent from the index.
    const report = await inspectDistIntegrity(root, base, [
      'package.json',
      'dist/index.mjs',
      'dist/cli/new.mjs',
    ]);

    expect(report).toEqual(CLEAN_ACTIVE);
  });

  it('still reports a briefed artifact whose deletion this ship would commit', async () => {
    const { base, root } = repo();
    // Dropped from the index but still on disk under the gitignored dist/ — ship stages that as a
    // deletion and skips the force-add, so briefing it does NOT put it in the commit.
    git(root, 'rm', '-q', '--cached', 'dist/index.mjs');

    const report = await inspectDistIntegrity(root, base, ['dist/index.mjs']);

    expect(report.untracked).toEqual(['dist/index.mjs']);
  });

  it('follows the imports of a briefed artifact that is not yet tracked', async () => {
    const { base, root } = repo();
    mkdirSync(join(root, 'dist/cli'));
    writeFileSync(join(root, 'dist/cli/new.mjs'), "import './missing.mjs';\n");

    const report = await inspectDistIntegrity(root, base, ['dist/cli/new.mjs']);

    expect(report.unresolved).toEqual([
      { importer: 'dist/cli/new.mjs', specifier: './missing.mjs', target: 'dist/cli/missing.mjs' },
    ]);
  });

  it('reports the full physical closure behind an untracked generated artifact', async () => {
    const { base, root } = repo();
    mkdirSync(join(root, 'dist/cli'));
    writeFileSync(join(root, 'dist/cli/new.mjs'), "import './middle.mjs';\n");
    writeFileSync(join(root, 'dist/cli/middle.mjs'), "import './leaf.mjs';\n");
    writeFileSync(join(root, 'dist/cli/leaf.mjs'), 'export const leaf = true;\n');

    const report = await inspectDistIntegrity(root, base, ['cli/new.mts']);

    expect(report.untracked).toEqual([
      'dist/cli/leaf.mjs',
      'dist/cli/middle.mjs',
      'dist/cli/new.mjs',
    ]);
    expect(report.unresolved).toEqual([
      {
        importer: 'dist/cli/middle.mjs',
        specifier: './leaf.mjs',
        target: 'dist/cli/leaf.mjs',
      },
      {
        importer: 'dist/cli/new.mjs',
        specifier: './middle.mjs',
        target: 'dist/cli/middle.mjs',
      },
    ]);
  });

  it('terminates when reachable untracked artifacts import each other', async () => {
    const { base, root } = repo();
    mkdirSync(join(root, 'dist/cli'));
    writeFileSync(join(root, 'dist/cli/new.mjs'), "import './peer.mjs';\n");
    writeFileSync(join(root, 'dist/cli/peer.mjs'), "import './new.mjs';\n");

    const report = await inspectDistIntegrity(root, base, ['cli/new.mts']);

    expect(report.untracked).toEqual(['dist/cli/new.mjs', 'dist/cli/peer.mjs']);
    expect(report.unresolved).toHaveLength(2);
  });

  it('does not expand the graph through an explicitly deleted artifact', async () => {
    const { base, root } = repo();
    mkdirSync(join(root, 'dist/cli'));
    writeFileSync(join(root, 'dist/index.mjs'), "import './cli/unused.mjs';\n");
    writeFileSync(join(root, 'dist/cli/unused.mjs'), 'export const unused = true;\n');
    git(root, 'rm', '-q', '--cached', 'dist/index.mjs');

    const report = await inspectDistIntegrity(root, base, ['dist/index.mjs']);

    expect(report.untracked).toEqual(['dist/index.mjs']);
    expect(report.unresolved).toEqual([]);
  });

  it('does not traverse through a physical module outside dist', async () => {
    const { base, root } = repo();
    mkdirSync(join(root, 'dist/cli'));
    writeFileSync(join(root, 'dist/cli/new.mjs'), "import '../../outside.mjs';\n");
    writeFileSync(join(root, 'outside.mjs'), "import './outside-child.mjs';\n");
    writeFileSync(join(root, 'outside-child.mjs'), 'export const child = true;\n');

    const report = await inspectDistIntegrity(root, base, ['cli/new.mts']);

    expect(report.untracked).toEqual(['dist/cli/new.mjs']);
    expect(report.unresolved).toEqual([
      {
        importer: 'dist/cli/new.mjs',
        specifier: '../../outside.mjs',
        target: 'outside.mjs',
      },
    ]);
  });

  it('resolves a briefed untracked artifact against an already-tracked import', async () => {
    const { base, root } = repo();
    mkdirSync(join(root, 'dist/cli'));
    writeFileSync(join(root, 'dist/cli/new.mjs'), "import '../index.mjs';\n");

    const report = await inspectDistIntegrity(root, base, ['dist/cli/new.mjs']);

    expect(report).toEqual(CLEAN_ACTIVE);
  });

  it('matches a brief spelled the way git pathspecs also accept it', async () => {
    const { base, root } = repo();
    mkdirSync(join(root, 'dist/cli'));
    writeFileSync(join(root, 'dist/cli/new.mjs'), 'export const value = 1;\n');
    writeFileSync(join(root, 'dist/index.mjs'), "import './cli/new.mjs';\n");

    const report = await inspectDistIntegrity(root, base, ['dist/index.mjs', './dist/cli/new.mjs']);

    expect(report).toEqual(CLEAN_ACTIVE);
  });

  it('blocks on an unparseable artifact rather than shipping its unchecked imports', async () => {
    const { base, root } = repo();
    mkdirSync(join(root, 'dist/cli'));
    // Unterminated string literal: the lexer runs to EOF and throws.
    writeFileSync(join(root, 'dist/cli/new.mjs'), "const broken = 'oops;\n");

    const report = await inspectDistIntegrity(root, base, ['dist/cli/new.mjs', 'dist/index.mjs']);

    expect(report).toEqual({ ...CLEAN_ACTIVE, unlexable: ['dist/cli/new.mjs'] });
    expect(printDistIntegrityFailure(report)).toBe(1);
  });

  it('blocks an unparseable artifact even when it hides a broken import', async () => {
    const { base, root } = repo();
    mkdirSync(join(root, 'dist/cli'));
    // The lexer gives up at the unterminated string, so './missing.mjs' is never reported. Passing
    // here would ship an unresolved import behind a parse error.
    writeFileSync(
      join(root, 'dist/cli/new.mjs'),
      "import './missing.mjs';\nconst broken = 'oops;\n",
    );

    const report = await inspectDistIntegrity(root, base, ['dist/cli/new.mjs']);

    expect(report.unlexable).toEqual(['dist/cli/new.mjs']);
    expect(printDistIntegrityFailure(report)).toBe(1);
  });

  it('reports an importer left pointing at an artifact this ship deletes', async () => {
    const { root } = repo();
    mkdirSync(join(root, 'dist/cli'));
    writeFileSync(join(root, 'dist/cli/keep.mjs'), "import '../index.mjs';\n");
    git(root, 'add', '-f', 'dist/cli/keep.mjs');
    git(root, 'commit', '-q', '-m', 'importer');
    const head = git(root, 'rev-parse', 'HEAD');
    // The importer stays; the module it needs is dropped from the index while its regenerable copy
    // sits on disk. Briefing the removal must not make the dangling import invisible.
    git(root, 'rm', '-q', '--cached', 'dist/index.mjs');

    const report = await inspectDistIntegrity(root, head, ['dist/cli/keep.mjs', 'dist/index.mjs']);

    expect(report.unresolved).toEqual([
      { importer: 'dist/cli/keep.mjs', specifier: '../index.mjs', target: 'dist/index.mjs' },
    ]);
  });

  it('keeps walking the queue after an unparseable artifact', async () => {
    const { base, root } = repo();
    mkdirSync(join(root, 'dist/cli'));
    // `a` sorts first and throws; `b` must still be parsed, or one bad asset silently blinds the
    // rest of the ship.
    writeFileSync(join(root, 'dist/cli/a.mjs'), "const broken = 'oops;\n");
    writeFileSync(join(root, 'dist/cli/b.mjs'), "import './missing.mjs';\n");

    const report = await inspectDistIntegrity(root, base, ['dist/cli/a.mjs', 'dist/cli/b.mjs']);

    expect(report.unlexable).toEqual(['dist/cli/a.mjs']);
    expect(report.unresolved).toEqual([
      { importer: 'dist/cli/b.mjs', specifier: './missing.mjs', target: 'dist/cli/missing.mjs' },
    ]);
  });

  it('refuses to vouch for an absolute brief, which reship cannot stage', async () => {
    const { base, root } = repo();
    mkdirSync(join(root, 'dist/cli'));
    writeFileSync(join(root, 'dist/cli/new.mjs'), 'export const value = 1;\n');
    writeFileSync(join(root, 'dist/index.mjs'), "import './cli/new.mjs';\n");
    // reship.sh probes `[ -e "$ROOT/$p" ]`, so an absolute $p builds /repo//repo/… , misses, and
    // takes the `git rm` branch: the file never reaches the commit. Folding this spelling into the
    // brief would make the preflight vouch for it anyway, so the same brief spelled relatively
    // passes (asserted above) while this one must still block.
    const report = await inspectDistIntegrity(root, base, [
      'dist/index.mjs',
      join(root, 'dist/cli/new.mjs'),
    ]);

    expect(report.untracked).toEqual(['dist/cli/new.mjs']);
    expect(report.unresolved).toEqual([
      { importer: 'dist/index.mjs', specifier: './cli/new.mjs', target: 'dist/cli/new.mjs' },
    ]);
  });

  it('does not affect consumer repositories', async () => {
    const { base, root } = repo('consumer');
    writeFileSync(join(root, 'dist/new.mjs'), 'export const value = 1;\n');

    await expect(inspectDistIntegrity(root, base, [])).resolves.toEqual({
      active: false,
      unresolved: [],
      unbriefed: [],
      untracked: [],
      unlexable: [],
    });
  });
});

describe('printDistIntegrityFailure', () => {
  function capture(report: Parameters<typeof printDistIntegrityFailure>[0]) {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      return { code: printDistIntegrityFailure(report), lines: errors.mock.calls.map(([l]) => l) };
    } finally {
      errors.mockRestore();
    }
  }

  it('names every bucket and shell-quotes the remedy paths', () => {
    const { code, lines } = capture({
      active: true,
      untracked: ["dist/it's.mjs"],
      unbriefed: ['dist/added.mjs'],
      unresolved: [{ importer: 'dist/a.mjs', specifier: './b.mjs', target: 'dist/b.mjs' }],
      unlexable: [],
    });

    expect(code).toBe(1);
    expect(lines.join('\n')).toContain("git add -f -- 'dist/it'\\''s.mjs'");
    expect(lines.join('\n')).toContain('deletion to land');
    expect(lines.join('\n')).toContain('dist/added.mjs');
    expect(lines.join('\n')).toContain('dist/a.mjs: ./b.mjs -> dist/b.mjs');
    expect(lines.join('\n')).toContain(
      "Include after -- in the next devkit ship: 'dist/it'\\''s.mjs' 'dist/added.mjs'",
    );
  });

  it('fails on an unparseable file and names it', () => {
    const { code, lines } = capture({
      active: true,
      untracked: [],
      unbriefed: [],
      unresolved: [],
      unlexable: ['dist/asset.mjs'],
    });

    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('preflight failed');
    expect(lines.join('\n')).toContain('imports are unchecked');
    expect(lines.join('\n')).toContain('dist/asset.mjs');
  });

  it('stays silent for an inactive report', () => {
    const { code, lines } = capture({
      active: false,
      untracked: ['dist/x.mjs'],
      unbriefed: [],
      unresolved: [],
      unlexable: ['dist/y.mjs'],
    });

    expect(code).toBe(0);
    expect(lines).toEqual([]);
  });
});

function seedShipRepo(): { base: string; root: string } {
  const fixture = repo();
  mkdirSync(join(fixture.root, 'cli'));
  mkdirSync(join(fixture.root, 'dist/cli'));
  writeFileSync(join(fixture.root, 'cli/new.mts'), 'export const value = 1;\n');
  writeFileSync(join(fixture.root, 'dist/cli/new.mjs'), 'export const value = 1;\n');
  return fixture;
}

describe('dist-integrity CLI', () => {
  function preflight(root: string, args: string[]) {
    return spawnSync(process.execPath, [preflightScript, ...args], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ...GIT_ENV },
    });
  }

  it('exits 0 for a brief that carries its own newly generated artifact', () => {
    const { base, root } = seedShipRepo();

    const result = preflight(root, [
      '--root',
      root,
      '--base',
      base,
      '--',
      'cli/new.mts',
      'dist/cli/new.mjs',
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain('dist integrity preflight failed');
  });

  it('exits 1 for a brief that leaves its generated artifact behind', () => {
    const { base, root } = seedShipRepo();

    const result = preflight(root, ['--root', root, '--base', base, '--', 'cli/new.mts']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('dist/cli/new.mjs');
  });

  it('refuses an incomplete invocation instead of scanning nothing and passing', () => {
    const { root } = seedShipRepo();

    const result = preflight(root, ['--root', root, '--']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('usage: dist-integrity');
  });
});

describe('ship dist-integrity preflight', () => {
  it('blocks a new ship before creating its worktree', () => {
    const { root } = seedShipRepo();
    git(root, 'remote', 'add', 'origin', 'git@github.com:acme/app.git');
    const result = spawnSync(
      '/bin/bash',
      [shipScript, 'feat/dist-check', 'test', '--', 'cli/new.mts'],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, ...GIT_ENV, SHIP_DRY_RUN: '1' },
      },
    );

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('dist/cli/new.mjs');
    expect(result.stderr).toContain("git add -f -- 'dist/cli/new.mjs'");
    expect(result.stderr).toContain("Include after -- in the next devkit ship: 'dist/cli/new.mjs'");
    expect(git(root, 'branch', '--list', 'feat/dist-check')).toBe('');
    expect(git(root, 'worktree', 'list', '--porcelain')).not.toContain('devkit-ship-');
  });

  it('blocks a reship before creating its worktree', () => {
    const { root } = seedShipRepo();
    const bare = mkTmp('dist-integrity-origin-');
    execFileSync('git', ['init', '-q', '--bare', bare], {
      env: { ...process.env, ...GIT_ENV },
    });
    git(root, 'remote', 'add', 'origin', bare);
    git(root, 'push', '-q', 'origin', 'HEAD:feat/open');

    const result = spawnSync(
      '/bin/bash',
      [reshipScript, 'feat/open', 'test', '--pr', '--', 'cli/new.mts'],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, ...GIT_ENV, SHIP_DRY_RUN: '1' },
      },
    );

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('dist/cli/new.mjs');
    expect(git(root, 'worktree', 'list', '--porcelain')).not.toContain('devkit-reship-');
  });
});
