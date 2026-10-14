import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GATE_REASON_ENV, readGateReason } from '../../gate-engine/deterministic/reason.mts';
import { relatedPaths, runRelatedTests } from '../lib/husky/gate-policy/related-tests.mts';

function fakeExec(status: number | null) {
  return vi.fn((_cmd: string, _args: string[], _opts: { cwd: string; stdio: 'inherit' }) => ({
    status,
  }));
}

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

// A committed a.mts + b.mts, both then edited on disk, with nothing staged yet.
function editedRepo(): string {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'related-tests-')));
  dirs.push(repo);
  git(repo, 'init', '-q');
  writeFileSync(join(repo, 'a.mts'), 'export const a = 1;\n');
  writeFileSync(join(repo, 'b.mts'), 'export const b = 1;\n');
  git(repo, 'add', '.');
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  writeFileSync(join(repo, 'a.mts'), 'export const a = 2;\n');
  writeFileSync(join(repo, 'b.mts'), 'export const b = 2;\n');
  return repo;
}

describe('relatedPaths', () => {
  it('drops the full-suite triggers and sorts the rest', () => {
    expect(
      relatedPaths([
        'src/b.mts',
        'package.json',
        'vitest.config.mjs',
        'src/a.mts',
        'vitest.setup.mjs',
      ]),
    ).toEqual(['src/a.mts', 'src/b.mts']);
  });

  // vitest's triggers are `**/package.json` and `**/{vitest,vite}.config.*`; every release stages dist/package.json.
  it('drops nested trigger files too, keeping look-alikes', () => {
    expect(
      relatedPaths([
        'dist/package.json',
        'templates/app/vite.config.ts',
        'vitest.e2e.config.mjs',
        'cli/package-json.mts',
      ]),
    ).toEqual(['cli/package-json.mts', 'vitest.e2e.config.mjs']);
  });
});

describe('runRelatedTests', () => {
  it('passes without running vitest when nothing is staged', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exec = fakeExec(0);
    expect(runRelatedTests('/repo', { staged: null, exec })).toBe(0);
    expect(runRelatedTests('/repo', { staged: ['package.json'], exec })).toBe(0);
    expect(exec).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('related-tests: none selected');
  });

  it('runs vitest related on the staged paths and propagates a failure', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const exec = fakeExec(1);
    expect(runRelatedTests('/repo', { staged: ['cli/a.mts'], exec })).toBe(1);
    expect(exec).toHaveBeenCalledWith(
      join('/repo', 'node_modules', '.bin', 'vitest'),
      ['related', '--run', '--reporter=dot', 'cli/a.mts'],
      expect.objectContaining({ cwd: '/repo', stdio: 'inherit' }),
    );
  });

  it('blocks when vitest is killed or cannot spawn', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const exec = fakeExec(null);
    expect(runRelatedTests('/repo', { staged: ['cli/a.mts'], exec })).toBe(1);
  });

  it('selects from the index, never from unstaged edits', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const repo = editedRepo();
    git(repo, 'add', 'a.mts');
    const exec = fakeExec(0);
    runRelatedTests(repo, { exec });
    expect(exec).toHaveBeenCalledWith(
      expect.any(String),
      ['related', '--run', '--reporter=dot', 'a.mts'],
      expect.anything(),
    );
  });

  // `commit -a` / `commit <path>` stage into an alternate index the hook hands over via the carrier.
  it('selects from the commit index the hook carries, not the default index', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const repo = editedRepo();
    git(repo, 'add', 'a.mts');
    const alt = join(repo, '.git', 'next-index');
    execFileSync('git', ['read-tree', 'HEAD'], {
      cwd: repo,
      env: { ...process.env, GIT_INDEX_FILE: alt },
    });
    execFileSync('git', ['add', 'b.mts'], {
      cwd: repo,
      env: { ...process.env, GIT_INDEX_FILE: alt },
    });
    vi.stubEnv('DEVKIT_COMMIT_INDEX_FILE', alt);
    vi.stubEnv('DEVKIT_COMMIT_GIT_DIR', join(repo, '.git'));
    const exec = fakeExec(0);
    runRelatedTests(repo, { exec });
    expect(exec).toHaveBeenCalledWith(
      expect.any(String),
      ['related', '--run', '--reporter=dot', 'b.mts'],
      expect.anything(),
    );
  });
});

// A vitest stand-in whose passing test calls failLine, as dist-integrity-release-only's tests do.
function chattyExec(status: number | null, error?: Error) {
  return vi.fn((_cmd: string, _args: string[], opts: { env: NodeJS.ProcessEnv }) => {
    const inherited = opts.env[GATE_REASON_ENV];
    if (inherited) appendFileSync(inherited, '✗ devkit ship: this ship rewrites tracked dist\n');
    return { status, error };
  });
}

// guard-deterministic names one reason file per gate; this is the file related-tests owns.
function stubReasonFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'related-tests-reason-'));
  dirs.push(dir);
  vi.stubEnv(GATE_REASON_ENV, join(dir, 'reason.txt'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  return join(dir, 'reason.txt');
}

describe('runRelatedTests failure reason', () => {
  it("records its own reason, never a passing test's output", () => {
    const file = stubReasonFile();
    expect(runRelatedTests('/repo', { staged: ['cli/a.mts'], exec: chattyExec(1) })).toBe(1);
    expect(readGateReason(file)).toEqual([
      'related-tests: vitest exited 1 — the failing tests are in its output above',
    ]);
  });

  it('blanks only the reason channel, so vitest still gets PATH and the rest', () => {
    stubReasonFile();
    vi.stubEnv('RELATED_TESTS_PROBE', 'kept');
    const exec = chattyExec(0);
    runRelatedTests('/repo', { staged: ['cli/a.mts'], exec });
    const { env } = exec.mock.calls[0][2];
    expect(env[GATE_REASON_ENV]).toBe('');
    expect(env.RELATED_TESTS_PROBE).toBe('kept');
  });

  // A vitest that never started printed no output, so the reason must not point the reader at it.
  it('records why vitest could not start, without pointing at output it never printed', () => {
    const file = stubReasonFile();
    const exec = chattyExec(null, new Error('spawn ENOENT'));
    expect(runRelatedTests('/repo', { staged: ['cli/a.mts'], exec })).toBe(1);
    expect(readGateReason(file)).toEqual(['✗ related-tests could not run vitest: spawn ENOENT']);
  });

  it('records a killed vitest as killed, not as a test failure', () => {
    const file = stubReasonFile();
    expect(runRelatedTests('/repo', { staged: ['cli/a.mts'], exec: chattyExec(null) })).toBe(1);
    expect(readGateReason(file)).toEqual([
      'related-tests: vitest was killed before it finished — its partial output is above',
    ]);
  });
});
