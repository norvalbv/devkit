/** Overlay's staged format step runs the repo's own Oxfmt when its config exists, so an unformatted
 *  staged file is fixed in a sub-second step rather than found by an LLM reviewer minutes later. */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildGuardBlock, buildOverlayHook } from '../lib/husky/husky-block.mts';
import { hasDash } from './_husky-hook-harness.mts';

const OXFMT = resolve('node_modules/.bin/oxfmt');
const UNFORMATTED = 'const a  =  {b:1}\n';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const formatStep = (biome: boolean) =>
  buildOverlayHook({ biome, guards: [] }).match(
    /# devkit:biome-format[\s\S]*?# \/devkit:biome-format/,
  )?.[0] ?? '';

function repoWith(files: Record<string, string>, { oxfmtBin = true } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'dk-overlay-fmt-'));
  dirs.push(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'a');
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
  git('add', '.gitignore');
  git('commit', '-qm', 'init');
  if (oxfmtBin) {
    mkdirSync(join(repo, 'node_modules', '.bin'), { recursive: true });
    symlinkSync(OXFMT, join(repo, 'node_modules', '.bin', 'oxfmt'));
  }
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(repo, name, '..'), { recursive: true });
    writeFileSync(join(repo, name), body);
    git('add', name);
  }
  return { repo, git };
}

function runStep(repo: string, { biome = false, env = {}, shell = 'sh' } = {}) {
  const hook = join(repo, '..', `${repo.split('/').pop()}-pre-commit`);
  dirs.push(hook);
  writeFileSync(hook, `${formatStep(biome)}\nexit 0\n`);
  chmodSync(hook, 0o755);
  const r = spawnSync(shell, ['-e', hook], {
    cwd: repo,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return { status: r.status, stdout: `${r.stdout}${r.stderr}` };
}

describe('overlay format step — render', () => {
  it('probes the repo Oxfmt config with biome:false, and biome first when it is selected', () => {
    expect(formatStep(false)).toContain(
      '"node_modules/.bin/oxfmt" --no-error-on-unmatched-pattern',
    );
    expect(formatStep(false)).not.toContain('biome.jsonc');
    const both = formatStep(true);
    expect(both.indexOf('[ -f biome.json ]')).toBeGreaterThan(-1);
    expect(both.indexOf('[ -f biome.json ]')).toBeLessThan(both.indexOf('[ -f .oxfmtrc.json ]'));
  });

  it('leaves package and standalone blocks without an Oxfmt arm', () => {
    expect(buildGuardBlock({ biome: true, guards: [] })).not.toContain('oxfmt');
    expect(buildGuardBlock({ biome: false, guards: [] })).not.toContain('biome-format');
    expect(
      buildGuardBlock({ biome: true, guards: [] }, '', { binDir: 'global-optional' }),
    ).not.toContain('oxfmt');
  });
});

describe('overlay format step — real git and the real oxfmt binary', () => {
  it('formats and re-stages an unformatted staged file under the repo Oxfmt config', () => {
    const { repo, git } = repoWith({ '.oxfmtrc.json': '{}\n', 'src/a.ts': UNFORMATTED });
    const r = runStep(repo);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toContain('🎨 oxfmt formatted and re-staged 2 staged file(s).');
    expect(git('show', ':src/a.ts')).toBe('const a = { b: 1 };\n');
  });

  // Linux CI runs hooks under dash; an if/elif chain that defines a function per arm must parse there.
  it.skipIf(!hasDash)('formats under dash, the POSIX sh Linux hooks run with', () => {
    const { repo, git } = repoWith({ '.oxfmtrc.json': '{}\n', 'a.ts': UNFORMATTED });
    const r = runStep(repo, { shell: '/bin/dash' });
    expect(r.status, r.stdout).toBe(0);
    expect(git('show', ':a.ts')).toBe('const a = { b: 1 };\n');
  });

  // Catches a chain that stops at the selected biome arm instead of falling through to Oxfmt.
  it('falls through to the repo Oxfmt when biome is selected but has no config here', () => {
    const { repo, git } = repoWith({ '.oxfmtrc.json': '{}\n', 'a.ts': UNFORMATTED });
    const r = runStep(repo, { biome: true });
    expect(r.stdout).toContain('🎨 oxfmt formatted and re-staged');
    expect(git('show', ':a.ts')).toBe('const a = { b: 1 };\n');
  });

  // Preserves overlay's existing behaviour: a selected biome with its config keeps formatting.
  it('runs biome, never oxfmt, when biome is selected and both configs exist', () => {
    const { repo, git } = repoWith({
      'biome.json': '{}\n',
      '.oxfmtrc.json': '{}\n',
      'a.ts': UNFORMATTED,
    });
    writeFileSync(join(repo, 'node_modules', '.bin', 'biome'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(repo, 'node_modules', '.bin', 'biome'), 0o755);
    const r = runStep(repo, { biome: true });
    expect(r.stdout).toContain('🎨 biome formatted and re-staged');
    expect(git('show', ':a.ts')).toBe(UNFORMATTED);
  });

  it('runs the same way in review mode, so devkit review sees the step', () => {
    const { repo } = repoWith({ '.oxfmtrc.json': '{}\n', 'a.ts': UNFORMATTED });
    const r = runStep(repo, { env: { DEVKIT_RUN_MODE: 'review' } });
    expect(r.stdout).toContain('🎨 oxfmt formatted and re-staged');
  });

  it('does not fail when every staged path is excluded by the repo ignorePatterns', () => {
    const { repo, git } = repoWith({
      '.oxfmtrc.json': '{ "ignorePatterns": ["gen/**", ".oxfmtrc.json"] }\n',
      'gen/a.ts': UNFORMATTED,
    });
    const r = runStep(repo);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).not.toContain('failed');
    expect(git('show', ':gen/a.ts')).toBe(UNFORMATTED);
  });

  it('stands down and says so when the repo has no formatter config', () => {
    const { repo, git } = repoWith({ 'a.ts': UNFORMATTED });
    const r = runStep(repo);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toContain('🎨 No formatter config here');
    expect(git('show', ':a.ts')).toBe(UNFORMATTED);
  });

  it('never runs biome when it is not selected, even with a biome config present', () => {
    const { repo } = repoWith({ 'biome.json': '{}\n', 'a.ts': UNFORMATTED });
    const r = runStep(repo, { biome: false });
    expect(r.stdout).toContain('🎨 No formatter config here');
  });

  it('names the missing binary and the install remedy instead of failing the commit', () => {
    const { repo, git } = repoWith(
      { '.oxfmtrc.json': '{}\n', 'a.ts': UNFORMATTED },
      { oxfmtBin: false },
    );
    const r = runStep(repo);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toContain(
      "node_modules/.bin/oxfmt is missing — install this repo's dependencies",
    );
    expect(existsSync(join(repo, 'node_modules'))).toBe(false);
    expect(git('show', ':a.ts')).toBe(UNFORMATTED);
  });
});
