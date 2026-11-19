/** decision-scope-brief on PostToolUse(Bash): the files a Claude Bash call wrote (bashWrites) are
 * briefed once, sharing the Edit path's per-(session, file) stamp. */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bashWrites } from '../../agents-hooks/edit-targets-lib.mjs';
import { mainWithWorktree } from './_worktree-fixture.mts';

const HOOK = fileURLToPath(new URL('../../agents-hooks/decision-scope-brief.mjs', import.meta.url));
// The hook's git must judge the fixture repo, never one a surrounding git hook exported.
const GIT_ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'brief-bash-'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], {
    cwd,
    env: GIT_ENV,
    encoding: 'utf8',
  });

/** `dir` as a git repository with one commit, so status separates a call's writes from HEAD. */
function gitRepo(dir = root) {
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\nargv.log\n');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base');
}

function write(rel: string, dir = root) {
  const file = join(dir, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, 'export const x = 1;\n');
  return file;
}

/** Backdate a file to before any Bash call's window, the way an earlier write would sit. */
const backdate = (file: string) =>
  utimesSync(file, Date.now() / 1000 - 3600, Date.now() / 1000 - 3600);

/** A guard-decisions that logs each spawn and answers per file: `governed` get `axes` rulings each. */
function stub(
  dir: string,
  governed: string[],
  mode: 'ok' | 'fail' = 'ok',
  axes = 1,
  ruling = 'Do.',
) {
  mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
  const bin = join(dir, 'node_modules', '.bin', 'guard-decisions');
  const rulings = (f: string) =>
    JSON.stringify(
      Array.from({ length: axes }, (_, i) => ({ slug: `rule-${f}${i || ''}`, ruling })),
    );
  const cases = governed.map((f) => `  ${f}) echo '${rulings(f)}';;`);
  const answer =
    mode === 'fail' ? 'exit 1' : `case "$3" in\n${cases.join('\n')}\n  *) echo '[]';;\nesac`;
  writeFileSync(bin, `#!/bin/sh\necho "$*" >> '${join(root, 'argv.log')}'\n${answer}\n`, {
    mode: 0o755,
  });
  backdate(bin);
}

const calls = () =>
  existsSync(join(root, 'argv.log'))
    ? readFileSync(join(root, 'argv.log'), 'utf8').trim().split('\n')
    : [];

interface Call {
  duration?: number | null;
  project?: string;
  cwd?: string;
}

function runBash(session: string, { duration = 60_000, project = root, cwd }: Call = {}) {
  return spawnSync('node', [HOOK], {
    cwd: project,
    encoding: 'utf8',
    env: { ...GIT_ENV, CLAUDE_PROJECT_DIR: project },
    input: JSON.stringify({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      session_id: session,
      cwd,
      tool_input: { command: "python3 - <<'EOF'" },
      duration_ms: duration,
    }),
  }).stdout.trim();
}

function runEdit(session: string, file: string, project = root) {
  return spawnSync('node', [HOOK], {
    cwd: project,
    encoding: 'utf8',
    env: { ...GIT_ENV, CLAUDE_PROJECT_DIR: project },
    input: JSON.stringify({
      tool_name: 'Edit',
      session_id: session,
      tool_input: { file_path: file },
    }),
  }).stdout.trim();
}

const context = (out: string): string => JSON.parse(out).hookSpecificOutput.additionalContext;

describe('decision-scope-brief — files a Bash command wrote', () => {
  it('briefs a governed file a Bash heredoc wrote, once, as PostToolUse context', () => {
    gitRepo();
    stub(root, ['src/a.ts']);
    write('src/a.ts');
    const out = JSON.parse(runBash('once'));
    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(out.hookSpecificOutput).not.toHaveProperty('permissionDecision');
    expect(out.hookSpecificOutput.additionalContext).toContain('rule-src/a.ts');
    expect(out.hookSpecificOutput.additionalContext).toContain('`src/a.ts`');
    expect(runBash('once')).toBe('');
    expect(calls()).toEqual(['scoped-targets --files src/a.ts --brief Bash,3,2000']);
  });

  it('shares the Edit brief slot: Edit then Bash briefs once', () => {
    gitRepo();
    stub(root, ['src/a.ts']);
    expect(runEdit('edit-first', 'src/a.ts')).toContain('rule-src/a.ts');
    write('src/a.ts');
    expect(runBash('edit-first')).toBe('');
    expect(calls()).toEqual(['scoped-targets --files src/a.ts --brief Edit,3,2000']);
  });

  it('shares the Edit brief slot: Bash then Edit briefs once', () => {
    gitRepo();
    stub(root, ['src/a.ts']);
    write('src/a.ts');
    expect(runBash('bash-first')).toContain('rule-src/a.ts');
    expect(runEdit('bash-first', 'src/a.ts')).toBe('');
    expect(calls()[1]).toMatch(/^scoped-targets --files src\/a\.ts --brief-again Edit,\d+$/);
  });

  it('leaves a dirty file written before the call alone', () => {
    gitRepo();
    stub(root, ['src/old.ts', 'src/new.ts']);
    write('src/old.ts');
    // 4 s back, against a 1.5 s + 2 s window: 3.5 s of slack for a slow hook start.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4000);
    write('src/new.ts');
    runBash('window', { duration: 1500 });
    expect(calls()).toEqual(['scoped-targets --files src/new.ts --brief Bash,3,2000']);
  });

  it('briefs a governed path a Bash mv or cp -p filled, though the file keeps its old mtime', () => {
    write('src/old-name.ts');
    gitRepo();
    stub(root, ['src/a.ts']);
    backdate(join(root, 'src/old-name.ts'));
    renameSync(join(root, 'src/old-name.ts'), join(root, 'src/a.ts'));
    expect(runBash('moved')).toContain('rule-src/a.ts');
  });

  it('never stamps a brief the context cap would cut, so each is shown whole on a later call', () => {
    gitRepo();
    const files = ['src/f0.ts', 'src/f1.ts', 'src/f2.ts'];
    stub(root, files, 'ok', 3, 'r'.repeat(1900)); // about 5,900 chars a brief: two cross 10,000
    for (const file of files) write(file);
    const shown = [runBash('cap'), runBash('cap'), runBash('cap')].map(context);
    expect(shown.map((ctx) => files.filter((f) => ctx.includes(`rule-${f}`)))).toEqual(
      files.map((f) => [f]),
    );
    for (const ctx of shown) expect(ctx.endsWith('…')).toBe(false);
  });

  it('asks nothing without duration_ms, on a clean tree, or outside a git repository', () => {
    stub(root, ['src/a.ts']);
    write('src/a.ts');
    expect(runBash('no-git')).toBe('');
    gitRepo();
    expect(runBash('clean')).toBe('');
    write('src/b.ts');
    expect(runBash('no-duration', { duration: null })).toBe('');
    expect(calls()).toEqual([]);
  });

  it('stops at the first outage in a call, without burning the file brief slot', () => {
    gitRepo();
    stub(root, [], 'fail');
    write('src/a.ts');
    write('src/b.ts');
    expect(runBash('outage')).toContain('DID NOT RUN');
    expect(calls()).toHaveLength(1);
    stub(root, ['src/a.ts']);
    write('src/a.ts');
    expect(runBash('outage')).toContain('rule-src/a.ts');
  });

  it('marks ungoverned files, so a governed file sorting after five of them is briefed next call', () => {
    gitRepo();
    stub(root, ['z/late.ts']);
    for (let i = 0; i < 5; i += 1) write(`a/f${i}.ts`);
    write('z/late.ts');
    expect(runBash('starve')).toBe('');
    expect(context(runBash('starve'))).toContain('rule-z/late.ts');
    expect(calls()).toHaveLength(6);
  });

  it('briefs at most five governed files a single call wrote', () => {
    gitRepo();
    const files = Array.from({ length: 7 }, (_, i) => `src/f${i}.ts`);
    stub(root, files);
    for (const file of files) write(file);
    const ctx = context(runBash('many'));
    expect(files.filter((file) => ctx.includes(`rule-${file}`))).toHaveLength(5);
    expect(calls()).toHaveLength(5);
  });

  it('matches paths against a project root below the git toplevel', () => {
    gitRepo();
    const app = join(root, 'packages', 'app');
    stub(app, ['src/a.ts']);
    write('src/a.ts', app);
    write('other/b.ts');
    expect(runBash('subdir', { project: app })).toContain('rule-src/a.ts');
    expect(calls()).toEqual(['scoped-targets --files src/a.ts --brief Bash,3,2000']);
  });

  it('briefs in the linked worktree the payload cwd names', () => {
    const { main, worktree } = mainWithWorktree((prefix) => mkdtempSync(join(root, prefix)));
    stub(worktree, ['src/a.ts']);
    write('src/a.ts', worktree);
    expect(runBash('wt', { project: main, cwd: worktree })).toContain('rule-src/a.ts');
  });

  it('keys the stamp the way an Edit through a symlinked project root does', () => {
    gitRepo();
    const link = join(mkdtempSync(join(tmpdir(), 'brief-bash-link-')), 'project');
    symlinkSync(root, link);
    try {
      stub(root, ['src/a.ts']);
      write('src/a.ts');
      expect(runBash('link', { project: link })).toContain('rule-src/a.ts');
      expect(runEdit('link', join(link, 'src/a.ts'), link)).toBe('');
    } finally {
      rmSync(dirname(link), { recursive: true, force: true });
    }
  });
});

describe('bashWrites', () => {
  const bash = { tool_name: 'Bash', duration_ms: 500 };

  it('lists new and rewritten files relative to the root, and nothing for other tools', () => {
    write('tracked.ts');
    gitRepo();
    write('src/new.ts');
    writeFileSync(join(root, 'tracked.ts'), 'export const x = 2;\n');
    expect(bashWrites(bash, root).sort()).toEqual(['src/new.ts', 'tracked.ts']);
    expect(bashWrites({ ...bash, tool_name: 'Edit' }, root)).toEqual([]);
    expect(bashWrites({ tool_name: 'Bash' }, root)).toEqual([]);
  });

  it('lists a file the call copied in with its old mtime kept, as cp -p and mv do', () => {
    gitRepo();
    backdate(write('copied.ts'));
    expect(bashWrites(bash, root)).toEqual(['copied.ts']);
  });

  it('drops deleted files and paths --files cannot carry', () => {
    write('tracked.ts');
    gitRepo();
    unlinkSync(join(root, 'tracked.ts'));
    write('a,b.ts');
    expect(bashWrites(bash, root)).toEqual([]);
  });

  it('reads a git status larger than 1 MiB', () => {
    gitRepo();
    const dir = join(root, 'd'.repeat(200));
    mkdirSync(dir);
    for (let i = 0; i < 5000; i += 1) writeFileSync(join(dir, `file-${i}.ts`), '');
    expect(bashWrites(bash, root)).toHaveLength(5000);
  });

  it('never takes the optional index lock a concurrent commit needs', () => {
    gitRepo();
    write('src/a.ts');
    const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
    const bin = join(root, 'node_modules', 'git-bin');
    mkdirSync(bin, { recursive: true });
    const log = join(bin, 'git.log');
    writeFileSync(join(bin, 'git'), `#!/bin/sh\necho "$*" >> '${log}'\nexec '${realGit}' "$@"\n`, {
      mode: 0o755,
    });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    expect(bashWrites(bash, root)).toEqual(['src/a.ts']);
    const gitCalls = readFileSync(log, 'utf8').trim().split('\n');
    expect(gitCalls).toHaveLength(2);
    for (const call of gitCalls) expect(call).toMatch(/^--no-optional-locks /);
  });
});
