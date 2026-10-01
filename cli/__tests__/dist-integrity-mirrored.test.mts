/** Mirrored half of the dist-integrity seed (sc-2266): a NEW mirrored file ships its dist copy,
 * a MODIFIED one stays release-only. See typescript-source-prebuilt-mjs. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ANTI_SLOP_FILES, PACKAGED_ROOT_DIRS, PACKAGED_ROOT_FILES } from '../lib/fs-helpers.mts';
import { inspectDistIntegrity } from '../lib/ship/dist-integrity.mts';
import {
  ANTI_SLOP_FILES as SCRIPT_ANTI_SLOP_FILES,
  ROOT_DIRS,
  ROOT_FILES,
} from '../../scripts/shipped-assets.mjs';
import { rootRegistry } from './_helpers.mts';

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const CLEAN = { active: true, unresolved: [], unbriefed: [], untracked: [], unlexable: [] };
const { mkTmp, cleanup } = rootRegistry();
afterEach(cleanup);

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV },
  }).trim();
}

function write(root: string, file: string, body: string): void {
  mkdirSync(join(root, dirname(file)), { recursive: true });
  writeFileSync(join(root, file), body);
}

/** A devkit-shaped repo whose base commit tracks one template and its dist copy. */
function repo() {
  const root = mkTmp('dist-integrity-mirrored-');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'a@b.c');
  git(root, 'config', 'user.name', 'a');
  const pkg = `${JSON.stringify({ name: '@norvalbv/devkit' })}\n`;
  write(root, 'package.json', pkg);
  write(root, 'dist/package.json', pkg);
  write(root, '.gitignore', 'dist/\n');
  write(root, 'templates/base.md', 'base\n');
  write(root, 'dist/templates/base.md', 'base\n');
  git(root, 'add', 'package.json', '.gitignore', 'templates/base.md');
  git(root, 'add', '-f', 'dist/package.json', 'dist/templates/base.md');
  git(root, 'commit', '-q', '-m', 'base');
  return { base: git(root, 'rev-parse', 'HEAD'), root };
}

describe('inspectDistIntegrity — mirrored assets', () => {
  it('demands the dist copy of a new template briefed without it', async () => {
    const { base, root } = repo();
    write(root, 'templates/new.md', 'new\n');
    write(root, 'dist/templates/new.md', 'new\n');

    const report = await inspectDistIntegrity(root, base, ['templates/new.md']);

    expect(report.untracked).toEqual(['dist/templates/new.md']);
  });

  it('passes once the new template ships with its dist copy', async () => {
    const { base, root } = repo();
    write(root, 'templates/new.md', 'new\n');
    write(root, 'dist/templates/new.md', 'new\n');

    const report = await inspectDistIntegrity(root, base, [
      'templates/new.md',
      'dist/templates/new.md',
    ]);

    expect(report).toEqual(CLEAN);
  });

  it('reports a force-added mirrored copy the brief leaves out', async () => {
    const { base, root } = repo();
    write(root, 'skills/x/SKILL.md', 'x\n');
    write(root, 'dist/skills/x/SKILL.md', 'x\n');
    git(root, 'add', '-f', 'dist/skills/x/SKILL.md');

    const report = await inspectDistIntegrity(root, base, ['skills/x/SKILL.md']);

    expect(report.unbriefed).toEqual(['dist/skills/x/SKILL.md']);
  });

  it('keeps a modified package.json release-only (typescript-source-prebuilt-mjs, 2026-07-26)', async () => {
    const { base, root } = repo();
    const bumped = `${JSON.stringify({ name: '@norvalbv/devkit', version: '9.9.9' })}\n`;
    write(root, 'package.json', bumped);
    write(root, 'dist/package.json', bumped);
    write(root, 'templates/base.md', 'edited\n');
    write(root, 'dist/templates/base.md', 'edited\n');

    const report = await inspectDistIntegrity(root, base, ['package.json', 'templates/base.md']);

    expect(report).toEqual(CLEAN);
  });

  it('maps a mirrored .mts verbatim instead of applying the tsc rewrite', async () => {
    const { base, root } = repo();
    write(root, 'skills/_devkit/new.d.mts', 'export {};\n');
    write(root, 'dist/skills/_devkit/new.d.mts', 'export {};\n');
    write(root, 'dist/skills/_devkit/new.d.mjs', 'export {};\n');

    const report = await inspectDistIntegrity(root, base, ['skills/_devkit/new.d.mts']);

    expect(report.untracked).toEqual(['dist/skills/_devkit/new.d.mts']);
  });

  it('maps anti-slop sources to their tsc emit and its two copied files verbatim', async () => {
    const { base, root } = repo();
    write(root, 'dist/anti-slop/src/rules/new.js', 'export {};\n');
    write(root, 'dist/anti-slop/LICENSE', 'MIT\n');
    // anti-slop/tests is not shipped: a physical build artefact there is never demanded.
    write(root, 'dist/anti-slop/tests/new.test.js', 'export {};\n');

    const report = await inspectDistIntegrity(root, base, [
      'anti-slop/src/rules/new.ts',
      'anti-slop/LICENSE',
      'anti-slop/tests/new.test.ts',
    ]);

    expect(report.untracked).toEqual(['dist/anti-slop/LICENSE', 'dist/anti-slop/src/rules/new.js']);
  });

  it('matches a mirrored dir on a path boundary, not a name prefix', async () => {
    const { base, root } = repo();
    write(root, 'dist/templates-old/x.md', 'x\n');
    write(root, 'dist/READMEs/x.md', 'x\n');

    const report = await inspectDistIntegrity(root, base, ['templates-old/x.md', 'READMEs/x.md']);

    expect(report).toEqual(CLEAN);
  });

  it("ignores another agent's unrelated mirrored output in a shared checkout", async () => {
    const { base, root } = repo();
    write(root, 'dist/templates/theirs.md', 'theirs\n');
    write(root, 'templates/mine.md', 'mine\n');
    write(root, 'dist/templates/mine.md', 'mine\n');

    const report = await inspectDistIntegrity(root, base, [
      'templates/mine.md',
      'dist/templates/mine.md',
    ]);

    expect(report).toEqual(CLEAN);
  });

  it('seeds the shell walk from a new mirrored hook briefed by its source alone', async () => {
    const { base, root } = repo();
    // The spelling the shipped agent hooks use (agents-hooks/lint-check.sh).
    const hook = [
      'HOOK_DIR=$(cd "$(dirname "$0")" 2>/dev/null && pwd)',
      'source "$HOOK_DIR/new-lib.sh"',
      '',
    ].join('\n');
    write(root, 'agents-hooks/new-hook.sh', hook);
    write(root, 'dist/agents-hooks/new-hook.sh', hook);

    const report = await inspectDistIntegrity(root, base, ['agents-hooks/new-hook.sh']);

    expect(report.untracked).toEqual(['dist/agents-hooks/new-hook.sh']);
    expect(report.unresolved.map(({ target }) => target)).toEqual(['dist/agents-hooks/new-lib.sh']);
  });
});

describe('mirrored asset list', () => {
  it('is the one list copy-dist-assets builds from', () => {
    expect(ROOT_DIRS).toBe(PACKAGED_ROOT_DIRS);
    expect(ROOT_FILES).toBe(PACKAGED_ROOT_FILES);
    expect(SCRIPT_ANTI_SLOP_FILES).toBe(ANTI_SLOP_FILES);
  });
});
