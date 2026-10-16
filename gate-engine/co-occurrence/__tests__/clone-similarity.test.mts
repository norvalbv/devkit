import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// The commit gate (`scan --changed --gate`) on a real git repo: a clone blocks only when it touches
// a staged file AND is absent from HEAD, and `--similarity` catches helpers copied under new names.
const here = dirname(fileURLToPath(import.meta.url));
const DETECTOR = resolve(here, '..', 'clone-detector.mts');
const JSCPD_BIN = resolve(here, '..', '..', '..', 'node_modules/.bin/jscpd');
const HAS_JSCPD = existsSync(JSCPD_BIN);
const HASH_RE = /add-clone "([0-9a-f]{16})"/;
const PINNED = JSON.parse(readFileSync(resolve(here, '..', '..', '..', 'package.json'), 'utf8'))
  .optionalDependencies.jscpd;

const IS_FILE = (name: string) => `export function ${name}(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
`;
const HASH_TEXT = (name: string) => `export function ${name}(text: string): string {
  const normalised = text.replace(/\\s+/g, ' ').trim();
  return createHash('sha256').update(normalised).digest('hex').slice(0, 16);
}
`;
const PRELUDE = `import { createHash } from 'node:crypto';\nimport { statSync } from 'node:fs';\n`;

let repo: string;
afterEach(() => rmSync(repo, { recursive: true, force: true }));

const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });

interface GuardConfig {
  scanRoots: string[];
  thresholds?: { minTokens?: number; similarity?: number };
}

function makeRepo(config: GuardConfig = { scanRoots: ['src'] }): void {
  // A space in the path, as in the primary consumer's checkout, so every case runs through it.
  repo = mkdtempSync(join(tmpdir(), 'clone sim '));
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  write('guard.config.json', JSON.stringify(config));
}

function write(file: string, body: string): void {
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), body);
}

function commit(): void {
  git('add', '-A');
  git('commit', '-qm', 'base');
}

function fakeJscpd(script: string): string {
  const fake = join(repo, 'fake-jscpd');
  writeFileSync(fake, `#!/bin/sh\n${script}\n`);
  chmodSync(fake, 0o755);
  return fake;
}

function gate(env: Record<string, string> = {}) {
  git('add', '-A');
  const base = { ...process.env, JSCPD_BIN, CO_OCCURRENCE_ALLOWLIST: join(repo, 'allow.json') };
  delete base.MATCHER_CHANGED_FILES;
  const r = spawnSync('node', [DETECTOR, 'scan', '--changed', '--gate'], {
    cwd: repo,
    env: { ...base, ...env },
    encoding: 'utf8',
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe.skipIf(!HAS_JSCPD)('clone gate: renamed helpers and HEAD novelty', () => {
  it('blocks two helpers copied under new names into one new file, naming both', () => {
    makeRepo();
    write('src/lib.ts', `${PRELUDE}${IS_FILE('isFile')}${HASH_TEXT('hashFragment')}`);
    commit();
    write('src/new.ts', `${PRELUDE}${IS_FILE('isRegularFile')}${HASH_TEXT('digestSnippet')}`);
    const { status, out } = gate();
    expect(status).toBe(1);
    expect(out).toContain('src/lib.ts:3 <> src/new.ts:3');
    expect(out).toContain('src/lib.ts:10 <> src/new.ts:10');
  });

  it('blocks a name-only copy of a 4-line helper under a lower token floor', () => {
    makeRepo({ scanRoots: ['src'], thresholds: { minTokens: 30 } });
    write('src/lib.ts', `${PRELUDE}${HASH_TEXT('hashFragment')}`);
    commit();
    write('src/new.ts', `${PRELUDE}${HASH_TEXT('hashSnippet')}`);
    expect(gate().status).toBe(1);
  });

  it('an approval covers its own pair only: a third copy elsewhere still blocks', () => {
    makeRepo();
    write('src/lib.ts', `${PRELUDE}${IS_FILE('isFile')}`);
    commit();
    write('src/copy1.ts', `${PRELUDE}${IS_FILE('isPlainFile')}`);
    const hash = gate().out.match(HASH_RE)?.[1];
    expect(hash).toBeTruthy();
    const today = new Date().toISOString().slice(0, 10);
    const entry = { fragmentHash: hash, date: today, decayDays: 3650 };
    write('allow.json', JSON.stringify({ pairs: [], clones: [entry] }));
    expect(gate().status).toBe(0);
    commit();
    write('src/copy2.ts', `${PRELUDE}${IS_FILE('isOrdinaryFile')}`);
    expect(gate().status).toBe(1);
  });

  it('a pair already at HEAD does not block an unrelated edit to its file', () => {
    makeRepo();
    write('src/lib.ts', `${PRELUDE}${IS_FILE('isFile')}`);
    write('src/copy.ts', `${PRELUDE}${IS_FILE('isPlainFile')}`);
    commit();
    write('src/copy.ts', `${PRELUDE}${IS_FILE('isPlainFile')}export const LIMIT = 3;\n`);
    expect(gate().status).toBe(0);
  });

  it('moving one side of a pair to a new file is not a new clone', () => {
    makeRepo();
    write('src/lib.ts', `${PRELUDE}${IS_FILE('isFile')}`);
    write('src/copy.ts', `${PRELUDE}${IS_FILE('isPlainFile')}`);
    commit();
    rmSync(join(repo, 'src/copy.ts'));
    write('src/moved.ts', `${PRELUDE}${IS_FILE('isPlainFile')}`);
    // git stages this as a rename, which the staged set drops; name the file so jscpd judges it.
    expect(gate({ MATCHER_CHANGED_FILES: 'src/moved.ts' }).status).toBe(0);
  });

  it('gates the second scan root and reports repo-relative paths', () => {
    makeRepo({ scanRoots: ['src', 'tools'] });
    write('src/lib.ts', `${PRELUDE}${IS_FILE('isFile')}`);
    commit();
    write('tools/new.ts', `${PRELUDE}${IS_FILE('isRegularFile')}`);
    const { status, out } = gate();
    expect(status).toBe(1);
    expect(out).toContain('src/lib.ts:3 <> tools/new.ts:3');
  });

  it('a new clone between files outside the staged set does not block', () => {
    makeRepo();
    write('src/other.ts', 'export const OTHER = 1;\n');
    commit();
    write('src/a.ts', `${PRELUDE}${IS_FILE('isFile')}`);
    write('src/b.ts', `${PRELUDE}${IS_FILE('isRegularFile')}`);
    write('src/other.ts', 'export const OTHER = 2;\n');
    expect(gate({ MATCHER_CHANGED_FILES: 'src/other.ts' }).status).toBe(0);
  });

  it('on an unborn branch every clone is new', () => {
    makeRepo();
    write('src/a.ts', `${PRELUDE}${IS_FILE('isFile')}`);
    write('src/b.ts', `${PRELUDE}${IS_FILE('isRegularFile')}`);
    expect(gate().status).toBe(1);
  });

  it('a jscpd other than the pinned version fails open, naming the mismatch', () => {
    makeRepo();
    write('src/lib.ts', `${PRELUDE}${IS_FILE('isFile')}`);
    const { status, out } = gate({ JSCPD_BIN: fakeJscpd('echo "jscpd 5.0.12"') });
    expect(status).toBe(2);
    expect(out).toContain('devkit expects jscpd');
    expect(out).toContain('reports 5.0.12');
  });

  it("a jscpd failure fails open naming jscpd's own reason", () => {
    makeRepo();
    write('src/lib.ts', `${PRELUDE}${IS_FILE('isFile')}`);
    const script = `[ "$1" = --version ] && echo "jscpd ${PINNED}" && exit 0\necho "fatal: boom" >&2; exit 1`;
    const { status, out } = gate({ JSCPD_BIN: fakeJscpd(script) });
    expect(status).toBe(2);
    expect(out).toContain('jscpd could not run: fatal: boom');
  });

  // jscpd only warns on a ratio outside (0, 1] and skips the similarity pass: a silently weaker gate.
  it.each([0, 1.5])('thresholds.similarity %s is a named could-not-run', (similarity) => {
    makeRepo({ scanRoots: ['src'], thresholds: { similarity } });
    write('src/lib.ts', `${PRELUDE}${IS_FILE('isFile')}`);
    commit();
    write('src/new.ts', `${PRELUDE}${IS_FILE('isRegularFile')}`);
    const { status, out } = gate();
    expect(status).toBe(2);
    expect(out).toContain('thresholds.similarity');
  });

  it('a "." scan root gates files at the repo root', () => {
    makeRepo({ scanRoots: ['.'] });
    write('lib.ts', `${PRELUDE}${IS_FILE('isFile')}`);
    commit();
    write('new.ts', `${PRELUDE}${IS_FILE('isRegularFile')}`);
    expect(gate().status).toBe(1);
  });

  it('exits 0 without running jscpd when no staged code is under the clone roots', () => {
    makeRepo();
    write('README.md', '# readme\n');
    expect(gate({ JSCPD_BIN: '/nonexistent/jscpd' }).status).toBe(0);
  });
});
