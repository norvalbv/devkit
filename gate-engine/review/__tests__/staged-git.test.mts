import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveGuardConfig } from '../../config.mts';
import {
  gitCached,
  headFile,
  indexFile,
  indexPathsNamed,
  stagedFiles,
  stagedTreeHash,
} from '../evidence/staged-git.mts';
import { selectRepositoryReviewers } from '../scope/repository.mts';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'review-staged-git-'));
  roots.push(root);
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 'devkit@example.test']);
  git(['config', 'user.name', 'Devkit Test']);
  writeFileSync(join(root, 'guard.config.json'), '{"scanRoots":["src"]}\n');
  git(['add', 'guard.config.json']);
  git(['commit', '-qm', 'baseline']);
  return root;
}

describe('indexPathsNamed', () => {
  it('finds every staged file of that basename, at the root and nested', () => {
    const root = repo();
    mkdirSync(join(root, 'pkg'), { recursive: true });
    writeFileSync(join(root, 'CLAUDE.md'), '# root\n');
    writeFileSync(join(root, 'pkg', 'CLAUDE.md'), '# nested\n');
    writeFileSync(join(root, 'pkg', 'other.md'), '# not a match\n');
    execFileSync('git', ['add', '-A'], { cwd: root });

    expect(indexPathsNamed(root, 'CLAUDE.md')).toEqual(new Set(['CLAUDE.md', 'pkg/CLAUDE.md']));
  });

  it('keeps a staged path containing a NEWLINE — `-z` preserves it and a regex `.` would not', () => {
    const root = repo();
    mkdirSync(join(root, 'odd\nname'), { recursive: true });
    writeFileSync(join(root, 'odd\nname', 'CLAUDE.md'), '# nested\n');
    execFileSync('git', ['add', '-A'], { cwd: root });

    expect(indexPathsNamed(root, 'CLAUDE.md')).toEqual(new Set(['odd\nname/CLAUDE.md']));
  });

  it('outside a git repository it reports null rather than an empty set', () => {
    // null means "cannot answer" and drives the worktree fallback; an empty set would read as
    // "nothing is staged" and silently drop every governing file.
    const plain = mkdtempSync(join(tmpdir(), 'review-no-git-'));
    roots.push(plain);
    expect(indexPathsNamed(plain, 'CLAUDE.md')).toBeNull();
  });
});

describe('review staged Git evidence', () => {
  it('literalizes pathspec-shaped and glob-shaped staged filenames', () => {
    const root = repo();
    const names = [':(exclude)runtime.mts', '[slug].mts', 'ordinary.mts'];
    for (const name of names)
      writeFileSync(join(root, name), `export const file = ${JSON.stringify(name)};\n`);
    execFileSync('git', ['add', '-A'], { cwd: root });

    for (const name of names) {
      const diff = gitCached(root, [], [name]);
      expect(diff).toContain(`b/${name}`);
      for (const other of names.filter((candidate) => candidate !== name))
        expect(diff).not.toContain(`b/${other}`);
    }
  });

  it('reads the committed config independently of the staged copy', () => {
    const root = repo();
    writeFileSync(join(root, 'guard.config.json'), '{"scanRoots":["new"]}\n');
    execFileSync('git', ['add', 'guard.config.json'], { cwd: root });
    expect(headFile(root, 'guard.config.json')).toBe('{"scanRoots":["src"]}\n');
    expect(indexFile(root, 'guard.config.json')).toBe('{"scanRoots":["new"]}\n');
  });

  it('reads an indexed config larger than the former 4 MiB buffer without treating it as absent', () => {
    const root = repo();
    const config = `${JSON.stringify({ padding: 'x'.repeat(4 * 1024 * 1024) })}\n`;
    writeFileSync(join(root, 'guard.config.json'), config);
    execFileSync('git', ['add', 'guard.config.json'], { cwd: root });
    expect(indexFile(root, 'guard.config.json')).toBe(config);
  });

  it('selects every reviewer from staged policy plus HEAD when the worktree has a third policy', () => {
    const root = repo();
    const policy = (path: string) =>
      `${JSON.stringify({
        scanRoots: ['legacy-runtime', 'new-runtime'],
        sourceExtensions: ['sh'],
        review: {
          backendRoots: ['legacy-runtime', 'new-runtime'],
          frontendRoots: [],
          paths: { include: [`${path}/**`], exclude: [] },
        },
      })}\n`;
    writeFileSync(join(root, 'guard.config.json'), policy('legacy-runtime'));
    execFileSync('git', ['add', 'guard.config.json'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'policy a'], { cwd: root });

    writeFileSync(join(root, 'guard.config.json'), policy('new-runtime'));
    for (const file of ['legacy-runtime/a.sh', 'new-runtime/b.sh']) {
      const absolute = join(root, file);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, '#!/bin/sh\n');
    }
    execFileSync('git', ['add', 'guard.config.json', 'legacy-runtime/a.sh', 'new-runtime/b.sh'], {
      cwd: root,
    });
    writeFileSync(join(root, 'guard.config.json'), policy('worktree-only'));

    const selected = selectRepositoryReviewers(stagedFiles(root), resolveGuardConfig(root));
    expect(selected.map((entry) => entry.reviewer.name)).toEqual([
      'api-security-reviewer',
      'backend-performance-reviewer',
      'commit-guard',
      'correctness-reviewer',
      'conventions-reviewer',
    ]);
    for (const entry of selected)
      expect(entry.files).toEqual(['legacy-runtime/a.sh', 'new-runtime/b.sh']);
  });

  it('ignores an unstaged worktree policy that would exempt staged runtime files', () => {
    const root = repo();
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    execFileSync('git', ['add', 'src/a.ts'], { cwd: root });
    writeFileSync(
      join(root, 'guard.config.json'),
      `${JSON.stringify({
        scanRoots: ['other'],
        review: {
          backendRoots: ['other'],
          frontendRoots: [],
          paths: { include: ['other/**'], exclude: [] },
        },
      })}\n`,
    );

    const selected = selectRepositoryReviewers(stagedFiles(root), resolveGuardConfig(root));
    expect(selected.map((entry) => entry.reviewer.name)).toEqual([
      'api-security-reviewer',
      'backend-performance-reviewer',
      'commit-guard',
      'correctness-reviewer',
      'conventions-reviewer',
    ]);
    for (const entry of selected) expect(entry.files).toEqual(['src/a.ts']);
  });
});

const STAGED_GIT = fileURLToPath(new URL('../evidence/staged-git.mts', import.meta.url));

function captureStderr(): string[] {
  const lines: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  return lines;
}

function conflicted(): string {
  const root = repo();
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  writeFileSync(join(root, 'f.txt'), 'base\n');
  git(['add', 'f.txt']);
  git(['-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'f']);
  git(['checkout', '-qb', 'side']);
  writeFileSync(join(root, 'f.txt'), 'side\n');
  git(['-c', 'core.hooksPath=/dev/null', 'commit', '-qam', 'side']);
  git(['checkout', '-q', '-']);
  writeFileSync(join(root, 'f.txt'), 'main\n');
  git(['-c', 'core.hooksPath=/dev/null', 'commit', '-qam', 'main']);
  expect(() => git(['merge', '-q', 'side'])).toThrow();
  return root;
}

describe('stagedTreeHash (sc-3312)', () => {
  it('hashes the staged tree while a concurrent git holds index.lock, printing nothing', () => {
    const root = repo();
    writeFileSync(join(root, 'guard.config.json'), '{"scanRoots":["lib"]}\n');
    execFileSync('git', ['add', 'guard.config.json'], { cwd: root });
    const expected = execFileSync('git', ['write-tree'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    writeFileSync(join(root, '.git', 'index.lock'), 'busy');
    const stderr = captureStderr();
    expect(stagedTreeHash(root, 'held-lock probe')).toBe(expected);
    expect(stderr).toEqual([]);
    expect(readFileSync(join(root, '.git', 'index.lock'), 'utf8')).toBe('busy');
  });

  it('names the caller and git’s reason once per process, however often the read is retried', () => {
    const root = conflicted();
    const stderr = captureStderr();
    for (let attempt = 0; attempt < 3; attempt += 1)
      expect(stagedTreeHash(root, 'dedupe probe')).toBeNull();
    const named = stderr.filter((line) => line.includes('(dedupe probe)'));
    expect(named).toHaveLength(1);
    expect(named[0]).toMatch(/^guard-review: git write-tree failed \(dedupe probe\): .+\n$/);
  });

  it('attributes the same failure separately to each caller that depends on it', () => {
    const root = conflicted();
    const stderr = captureStderr();
    stagedTreeHash(root, 'caller A');
    stagedTreeHash(root, 'caller B');
    expect(stderr.filter((line) => line.includes('(caller A)'))).toHaveLength(1);
    expect(stderr.filter((line) => line.includes('(caller B)'))).toHaveLength(1);
  });

  it('two review lanes hashing at once never collide on index.lock (the ship race)', async () => {
    const root = repo();
    const probe = join(root, 'probe.mts');
    writeFileSync(
      probe,
      `import { stagedTreeHash } from ${JSON.stringify(STAGED_GIT)};
const out = [];
for (let i = 0; i < 20; i += 1) out.push(stagedTreeHash(process.argv[2], 'stress'));
console.log(JSON.stringify(out));
`,
    );
    const runs = await Promise.all(
      Array.from(
        { length: 24 },
        () =>
          new Promise<{ out: string; err: string; code: number | null }>((done) => {
            const child = spawn(process.execPath, [probe, root], {
              stdio: 'pipe',
            });
            let out = '';
            let err = '';
            child.stdout.on('data', (d) => (out += d));
            child.stderr.on('data', (d) => (err += d));
            child.on('close', (code) => done({ out, err, code }));
          }),
      ),
    );
    const expected = execFileSync('git', ['write-tree'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    for (const run of runs) {
      expect(run.err).not.toContain('index.lock');
      expect(run.code).toBe(0);
      expect(new Set(JSON.parse(run.out))).toEqual(new Set([expected]));
    }
  }, 60_000);
});
