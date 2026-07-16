import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  fallowAuditArgs,
  normalizeEslintFindings,
  parseNameStatusZ,
  rewriteFallowBaseline,
  subtractFindings,
} from '../baseline-gate.mts';

const SCRIPT = fileURLToPath(new URL('../baseline-gate.mts', import.meta.url));
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function seedWorktrees() {
  const parent = mkdtempSync(join(tmpdir(), 'devkit-baseline-gate-'));
  roots.push(parent);
  const root = join(parent, 'repo');
  mkdirSync(root);
  const git = (cwd: string, args: string[]) =>
    execFileSync('git', args, { cwd, env: { ...process.env, ...GIT_ENV }, encoding: 'utf8' });
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'baseline@test.invalid']);
  git(root, ['config', 'user.name', 'Baseline Test']);
  writeFileSync(join(root, 'app.ts'), 'const BAD = 1;\n');
  writeFileSync(join(root, 'unused.ts'), 'export const unused = 1;\n');
  writeFileSync(join(root, 'eslint.config.devkit.mjs'), 'export default [];\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'base']);

  const base = join(parent, 'base-worktree');
  const final = join(parent, 'final-worktree');
  git(root, ['worktree', 'add', '-q', '--detach', base, 'main']);
  git(root, ['worktree', 'add', '-q', '-b', 'feature', final, 'main']);
  writeFileSync(join(final, 'app.ts'), '// shifted\nconst BAD = 1;\nconst BAD = 2;\n');
  git(final, ['add', 'app.ts']);
  const runtime = join(parent, 'runtime');
  execFileSync(process.execPath, [SCRIPT, 'capture', base, final, runtime]);
  return { root, base, final, runtime };
}

function writeExecutable(path: string, source: string) {
  writeFileSync(path, `#!${process.execPath}\n${source}`);
  chmodSync(path, 0o755);
}

describe('review baseline path/finding comparison', () => {
  it('parses modified, added, renamed, and copied NUL-delimited entries', () => {
    const changes = parseNameStatusZ(
      'M\0src/old.ts\0A\0src/new.ts\0R100\0before.ts\0after.ts\0C100\0source.ts\0copy.ts\0',
    );
    expect(changes).toEqual([
      { status: 'M', basePath: 'src/old.ts', finalPath: 'src/old.ts' },
      { status: 'A', finalPath: 'src/new.ts' },
      { status: 'R100', basePath: 'before.ts', finalPath: 'after.ts' },
      { status: 'C100', finalPath: 'copy.ts' },
    ]);
  });

  it('treats shifted and renamed instances as inherited but preserves duplicate multiplicity', () => {
    const base = normalizeEslintFindings(
      [
        {
          filePath: '/repo/old.ts',
          source: 'const BAD = 1;\n',
          messages: [
            { severity: 2, line: 1, column: 7, ruleId: 'no-bad', message: 'bad', nodeType: 'Id' },
          ],
        },
      ],
      '/repo',
      new Map([['old.ts', 'new.ts']]),
    );
    const current = normalizeEslintFindings(
      [
        {
          filePath: '/repo/new.ts',
          source: '// shifted\nconst BAD = 1;\nconst BAD = 1;\n',
          messages: [
            { severity: 2, line: 2, column: 7, ruleId: 'no-bad', message: 'bad', nodeType: 'Id' },
            { severity: 2, line: 3, column: 7, ruleId: 'no-bad', message: 'bad', nodeType: 'Id' },
          ],
        },
      ],
      '/repo',
    );

    const introduced = subtractFindings(base, current);
    expect(introduced).toHaveLength(1);
    expect(introduced[0]).toMatchObject({ path: 'new.ts', line: 3, ruleId: 'no-bad' });
  });
});

describe('ESLint merge-base baseline', () => {
  it('reports only the newly introduced error, not a shifted inherited error', () => {
    const { root, final, runtime } = seedWorktrees();
    const eslint = join(root, '..', 'fake-eslint');
    writeExecutable(
      eslint,
      `const fs = require('node:fs');
const path = require('node:path');
const split = process.argv.indexOf('--');
const files = process.argv.slice(split + 1);
const out = files.map((file) => {
  const abs = path.resolve(process.cwd(), file);
  const source = fs.readFileSync(abs, 'utf8');
  const messages = source.split(/\\r?\\n/).flatMap((line, index) => line.includes('BAD') ? [{ severity: 2, line: index + 1, column: 7, ruleId: 'no-bad', message: 'bad', nodeType: 'Identifier' }] : []);
  return { filePath: abs, source, messages };
});
process.stdout.write(JSON.stringify(out));
process.exit(out.some((item) => item.messages.length) ? 1 : 0);
`,
    );

    const result = spawnSync(process.execPath, [SCRIPT, 'eslint', runtime], {
      cwd: final,
      env: { ...process.env, DEVKIT_REVIEW_ESLINT_BIN: eslint },
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('1 new error(s)');
    expect(result.stderr).toContain('app.ts:3:7');
    expect(result.stderr).not.toContain('app.ts:2:7');
  });

  it('fails loudly when the overlay config exists but the ESLint binary is missing', () => {
    const { final, runtime } = seedWorktrees();
    const result = spawnSync(process.execPath, [SCRIPT, 'eslint', runtime], {
      cwd: final,
      env: { ...process.env, DEVKIT_REVIEW_ESLINT_BIN: '' },
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/eslint\.config\.devkit\.mjs.*eslint.*missing/);
  });
});

describe('Fallow merge-base baseline', () => {
  it('builds an audit with the exact staged diff and all three analysis baselines', () => {
    expect(fallowAuditArgs('/tmp/base', '/tmp/change.diff')).toEqual([
      'audit',
      '--gate',
      'new-only',
      '--no-cache',
      '--diff-file',
      '/tmp/change.diff',
      '--dead-code-baseline',
      '/tmp/base/dead-code.json',
      '--health-baseline',
      '/tmp/base/health.json',
      '--dupes-baseline',
      '/tmp/base/dupes.json',
    ]);
  });

  it('remaps native dead-code, health, and clone identities across renames', () => {
    const baseline = {
      unused_files: ['src/old.ts'],
      unused_exports: ['src/old.ts:unused'],
      finding_counts: { 'src/old.ts': { crap_critical: { count: 1 } } },
      clone_groups: ['src/old.ts:1-10|src/peer.ts:2-11'],
    };

    expect(rewriteFallowBaseline(baseline, new Map([['src/old.ts', 'src/new.ts']]))).toEqual({
      unused_files: ['src/new.ts'],
      unused_exports: ['src/new.ts:unused'],
      finding_counts: { 'src/new.ts': { crap_critical: { count: 1 } } },
      clone_groups: ['src/new.ts:1-10|src/peer.ts:2-11'],
    });
  });

  it('saves all three base analyses and audits the final diff against them', () => {
    const { root, base, final, runtime } = seedWorktrees();
    const fallow = join(root, '..', 'fake-fallow');
    const calls = join(root, '..', 'fallow-calls.jsonl');
    writeExecutable(
      fallow,
      `const fs = require('node:fs');
const path = require('node:path');
fs.appendFileSync(process.env.FALLOW_CALLS, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n');
const args = process.argv.slice(2);
const save = args.indexOf('--save-baseline');
if (save >= 0) {
  const payload = args[0] === 'dead-code'
    ? { unused_files: ['unused.ts'], unused_exports: ['unused.ts:unused'] }
    : args[0] === 'health'
      ? { finding_counts: { 'unused.ts': { crap_critical: { count: 1 } } } }
      : { clone_groups: ['unused.ts:1-2|app.ts:1-2'] };
  fs.writeFileSync(args[save + 1], JSON.stringify(payload));
  process.exit(1);
}
if (args[0] === 'audit') process.exit(1);
`,
    );
    const config = join(final, '.fallowrc.json');
    writeFileSync(config, '{"audit":{"gate":"new-only"}}\n');
    execFileSync('git', ['mv', 'unused.ts', 'renamed.ts'], {
      cwd: final,
      env: { ...process.env, ...GIT_ENV },
    });
    execFileSync('git', ['add', '.fallowrc.json'], {
      cwd: final,
      env: { ...process.env, ...GIT_ENV },
    });

    const result = spawnSync(process.execPath, [SCRIPT, 'fallow', runtime], {
      cwd: final,
      env: {
        ...process.env,
        DEVKIT_REVIEW_FALLOW_BIN: fallow,
        FALLOW_CALLS: calls,
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    const recorded = readFileSync(calls, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(recorded.slice(0, 3).map((call) => [call.cwd, call.args[0]])).toEqual([
      [realpathSync(base), 'dead-code'],
      [realpathSync(base), 'health'],
      [realpathSync(base), 'dupes'],
    ]);
    for (const call of recorded.slice(0, 3)) {
      expect(call.args).toEqual(expect.arrayContaining(['--config', realpathSync(config)]));
    }
    expect(recorded[3].cwd).toBe(realpathSync(final));
    expect(recorded[3].args[0]).toBe('audit');
    expect(recorded[3].args).toEqual(
      expect.arrayContaining([
        '--gate',
        'new-only',
        '--no-cache',
        '--diff-file',
        '--dead-code-baseline',
        '--health-baseline',
        '--dupes-baseline',
        '--config',
        realpathSync(config),
      ]),
    );
    const diffIndex = recorded[3].args.indexOf('--diff-file');
    expect(readFileSync(recorded[3].args[diffIndex + 1], 'utf8')).toContain('+const BAD = 2;');
    for (const option of ['--dead-code-baseline', '--health-baseline', '--dupes-baseline']) {
      const index = recorded[3].args.indexOf(option);
      const normalized = readFileSync(recorded[3].args[index + 1], 'utf8');
      expect(normalized).toContain('renamed.ts');
      expect(normalized).not.toContain('unused.ts');
    }
  });
});
