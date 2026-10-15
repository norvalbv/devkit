/** anti-slop-preflight.sh (sc-3469) against a stub devkit bin: blocks only on the check's FAIL
 * verdict, forwards both streams, parses JSON payloads, and fails open everywhere else. */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { rootRegistry } from './_helpers.mts';

const HOOK = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'agents-hooks',
  'anti-slop-preflight.sh',
);
// macOS ships bash 3.2 at /bin/bash — the shell a consumer's hook actually runs under when Homebrew
// bash is not first on PATH. Run it there when present so a bash-4-only construct fails here.
const BASH = existsSync('/bin/bash') ? '/bin/bash' : 'bash';
// A PATH with node (the hook may parse JSON with it) and coreutils, but no global `devkit`.
const ISOLATED_PATH = [dirname(process.execPath), '/usr/bin', '/bin'].join(':');

const { mkTmp, cleanup } = rootRegistry();
afterEach(cleanup);

const FAIL_OUTPUT = {
  stdout: 'ERROR anti-slop/no-module-mocking src/a.test.ts:2:1 (+1)\n    Replace module mocking',
  stderr: 'anti-slop: FAIL — 1 new error finding(s); baseline unchanged',
};

type StubMode = 'fail' | 'pass' | 'crash';

/** An installed-anti-slop repo whose devkit bin logs its argv (one arg per line) and acts per mode. */
function repo(mode: StubMode = 'fail', options: { manifest?: boolean; bin?: boolean } = {}) {
  const root = mkTmp('anti-slop-preflight-');
  if (options.manifest !== false) {
    mkdirSync(join(root, '.devkit', 'anti-slop'), { recursive: true });
    writeFileSync(join(root, '.devkit', 'anti-slop', 'manifest.json'), '{}\n');
  }
  const log = join(root, 'stub.log');
  if (options.bin !== false) {
    const body = {
      fail: `echo '${FAIL_OUTPUT.stdout}'\necho '${FAIL_OUTPUT.stderr}' >&2\nexit 1`,
      pass: `echo 'anti-slop: PASS'\nexit 0`,
      crash: `echo 'Error: anti-slop is not installed — run devkit init --anti-slop' >&2\necho '    at resolveRunner (runner.mts:82)' >&2\nexit 1`,
    }[mode];
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    const bin = join(root, 'node_modules', '.bin', 'devkit');
    writeFileSync(
      bin,
      `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> "${log}"; done\n${body}\n`,
    );
    chmodSync(bin, 0o755);
  }
  return { root, log };
}

function write(
  root: string,
  rel: string,
  source = "import { vi } from 'vitest';\nvi.mock('node:fs');\n",
) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, source);
  return abs;
}

function run(root: string, input: string, projectDir = root, args: string[] = []) {
  return spawnSync(BASH, [HOOK, ...args], {
    input,
    cwd: root,
    env: { ...process.env, PATH: ISOLATED_PATH, CLAUDE_PROJECT_DIR: projectDir },
    encoding: 'utf8',
    timeout: 30_000,
  });
}

const claudePayload = (file: string) =>
  JSON.stringify({ session_id: 's1', tool_name: 'Write', tool_input: { file_path: file } });
const argv = (log: string) =>
  existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];

// The hook's git must judge the fixture repo, never one a surrounding git hook exported.
const GIT_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
);
const GIT_IDENTITY = [
  '-c',
  'user.email=t@example.com',
  '-c',
  'user.name=t',
  '-c',
  'commit.gpgsign=false',
];
const git = (cwd: string, ...args: string[]) =>
  spawnSync('git', [...GIT_IDENTITY, ...args], { cwd, env: GIT_ENV, encoding: 'utf8' });

/** repo() as a git repository with one commit, so status separates this call's writes from HEAD. */
function gitRepo(mode: StubMode = 'fail') {
  const made = repo(mode);
  writeFileSync(join(made.root, '.gitignore'), 'node_modules/\nstub.log\ndist/\n');
  git(made.root, 'init', '-q', '-b', 'main');
  git(made.root, 'add', '-A');
  git(made.root, 'commit', '-qm', 'base');
  return made;
}

const bashPayload = (cwd: string, durationMs?: number) =>
  JSON.stringify({
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command: "python3 - <<'EOF'" },
    cwd,
    duration_ms: durationMs,
  });
const runBash = (root: string, input: string, projectDir = root) =>
  run(root, input, projectDir, ['--bash-writes']);
/** Backdate a file to before any Bash call's window, the way an earlier write would sit. */
const backdate = (path: string) =>
  utimesSync(path, Date.now() / 1000 - 600, Date.now() / 1000 - 600);

describe('anti-slop-preflight.sh', () => {
  it('blocks with exit 2 and forwards BOTH streams when the check reports a FAIL', () => {
    const { root, log } = repo('fail');
    const r = run(root, claudePayload(write(root, 'src/a.test.ts')));
    expect(r.status).toBe(2);
    // The ERROR line (stdout of the check) is the part naming the file and rule — it must reach
    // stderr, the only stream Claude Code shows the agent on exit 2.
    expect(r.stderr).toContain('ERROR anti-slop/no-module-mocking src/a.test.ts:2:1');
    expect(r.stderr).toContain('anti-slop: FAIL');
    expect(argv(log)).toEqual(['anti-slop', 'check', '--', 'src/a.test.ts']);
  });

  it('passes a repo-relative path so the check scopes to the project, not an absolute tmp path', () => {
    const { root, log } = repo('pass');
    expect(run(root, claudePayload(write(root, 'packages/app/src/b.ts'))).status).toBe(0);
    expect(argv(log).at(-1)).toBe('packages/app/src/b.ts');
  });

  it('fails open when the bin exits non-zero WITHOUT a FAIL verdict (crash, uninstalled, old devkit)', () => {
    const { root } = repo('crash');
    const r = run(root, claudePayload(write(root, 'src/a.ts')));
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('runner.mts');
  });

  it('fails open when a crash merely echoes the FAIL marker inside a filename', () => {
    const { root } = repo('pass');
    const bin = join(root, 'node_modules', '.bin', 'devkit');
    writeFileSync(
      bin,
      "#!/bin/sh\necho 'Error: ENOENT: cannot read src/anti-slop: FAIL —.ts' >&2\nexit 1\n",
    );
    chmodSync(bin, 0o755);
    expect(run(root, claudePayload(write(root, 'src/a.ts'))).status).toBe(0);
  });

  it('stays silent when the check passes', () => {
    const { root } = repo('pass');
    const r = run(root, claudePayload(write(root, 'src/a.ts')));
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });

  it.each(['README.md', 'styles/app.css', 'config/settings.json', 'scripts/run.sh'])(
    'never runs the check for a non-JS/TS file (%s)',
    (rel) => {
      const { root, log } = repo('fail');
      expect(run(root, claudePayload(write(root, rel, 'x\n'))).status).toBe(0);
      expect(argv(log)).toEqual([]);
    },
  );

  it.each(['a.ts', 'a.tsx', 'a.mts', 'a.cts', 'a.js', 'a.jsx', 'a.mjs', 'a.cjs'])(
    'runs the check for %s',
    (name) => {
      const { root } = repo('fail');
      expect(run(root, claudePayload(write(root, `src/${name}`))).status).toBe(2);
    },
  );

  it('fails open without running anything when anti-slop is not installed (no manifest)', () => {
    const { root, log } = repo('fail', { manifest: false });
    expect(run(root, claudePayload(write(root, 'src/a.ts'))).status).toBe(0);
    expect(argv(log)).toEqual([]);
  });

  it('fails open when no devkit bin resolves locally or on PATH (never fetches via bunx/npx)', () => {
    const { root } = repo('fail', { bin: false });
    const r = run(root, claudePayload(write(root, 'src/a.ts')));
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });

  it('resolves a PATH-only devkit (overlay: global install, no node_modules)', () => {
    const { root, log } = repo('fail', { bin: false });
    const globalBin = mkTmp('anti-slop-preflight-global-');
    const bin = join(globalBin, 'devkit');
    writeFileSync(
      bin,
      `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> "${log}"; done\necho '${FAIL_OUTPUT.stderr}' >&2\nexit 1\n`,
    );
    chmodSync(bin, 0o755);
    const r = spawnSync(BASH, [HOOK], {
      input: claudePayload(write(root, 'src/a.ts')),
      cwd: root,
      env: { ...process.env, PATH: `${globalBin}:${ISOLATED_PATH}`, CLAUDE_PROJECT_DIR: root },
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(r.status).toBe(2);
    expect(argv(log)).toEqual(['anti-slop', 'check', '--', 'src/a.ts']);
  });

  it('ignores a file outside every root (a sibling checkout, payload without cwd)', () => {
    const { root, log } = repo('fail');
    const sibling = mkTmp('anti-slop-preflight-sibling-');
    expect(run(root, claudePayload(write(sibling, 'src/a.ts'))).status).toBe(0);
    expect(argv(log)).toEqual([]);
  });

  it('ignores a path that merely shares the project prefix (/repo-other vs /repo)', () => {
    const { root, log } = repo('fail');
    const lookalike = `${root}-other`;
    mkdirSync(lookalike, { recursive: true });
    try {
      expect(run(root, claudePayload(write(lookalike, 'src/a.ts'))).status).toBe(0);
      expect(argv(log)).toEqual([]);
    } finally {
      spawnSync('rm', ['-rf', lookalike]);
    }
  });

  it('fails open when the edited file no longer exists (written then removed)', () => {
    const { root, log } = repo('fail');
    expect(run(root, claudePayload(join(root, 'src', 'gone.ts'))).status).toBe(0);
    expect(argv(log)).toEqual([]);
  });

  it('fails open on an empty or non-JSON payload', () => {
    const { root, log } = repo('fail');
    expect(run(root, '').status).toBe(0);
    expect(run(root, 'not json').status).toBe(0);
    expect(argv(log)).toEqual([]);
  });

  it('reads the Cursor afterFileEdit mirror, whose payload is spaced JSON with a top-level file_path', () => {
    const { root, log } = repo('fail');
    const file = write(root, 'src/a.ts');
    const cursor = JSON.stringify({ conversation_id: 'c1', file_path: file, edits: [] }, null, 2);
    expect(run(root, cursor).status).toBe(2);
    expect(argv(log).at(-1)).toBe('src/a.ts');
  });

  it('checks every file a MultiEdit payload names under tool_input.edits[].file_path', () => {
    const { root, log } = repo('fail');
    const a = write(root, 'src/a.ts');
    const b = write(root, 'src/b.ts');
    const multi = JSON.stringify({
      tool_name: 'MultiEdit',
      tool_input: { edits: [{ file_path: a }, { file_path: b }, { file_path: a }] },
    });
    expect(run(root, multi).status).toBe(2);
    expect(argv(log)).toEqual(['anti-slop', 'check', '--', 'src/a.ts', 'src/b.ts']);
  });

  it('keeps the in-project JS/TS paths of a mixed payload and drops the rest', () => {
    const { root, log } = repo('fail');
    const sibling = mkTmp('anti-slop-preflight-sibling-');
    const multi = JSON.stringify({
      tool_input: {
        file_path: write(root, 'src/a.ts'),
        edits: [
          { file_path: write(root, 'README.md', 'x\n') },
          { file_path: write(sibling, 'src/b.ts') },
        ],
      },
    });
    expect(run(root, multi).status).toBe(2);
    expect(argv(log)).toEqual(['anti-slop', 'check', '--', 'src/a.ts']);
  });

  it.each([
    ['top-level path (Cursor afterFileEdit)', (file: string) => ({ path: file })],
    ['tool_input.path', (file: string) => ({ tool_input: { path: file } })],
    ['edits[].path', (file: string) => ({ tool_input: { edits: [{ path: file }] } })],
  ])('reads the edited file from %s', (_source, payload) => {
    const { root, log } = repo('fail');
    expect(run(root, JSON.stringify(payload(write(root, 'src/a.ts')))).status).toBe(2);
    expect(argv(log)).toEqual(['anti-slop', 'check', '--', 'src/a.ts']);
  });

  it('runs a package-local install from its package, with package-relative paths (monorepo)', () => {
    const root = mkTmp('anti-slop-preflight-mono-');
    const pkg = join(root, 'packages', 'app');
    mkdirSync(join(pkg, '.devkit', 'anti-slop'), { recursive: true });
    writeFileSync(join(pkg, '.devkit', 'anti-slop', 'manifest.json'), '{}\n');
    const log = join(root, 'stub.log');
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    const bin = join(root, 'node_modules', '.bin', 'devkit');
    writeFileSync(
      bin,
      `#!/bin/sh\npwd -P >> "${log}"\nfor a in "$@"; do printf '%s\\n' "$a" >> "${log}"; done\necho '${FAIL_OUTPUT.stderr}' >&2\nexit 1\n`,
    );
    chmodSync(bin, 0o755);
    const file = write(root, 'packages/app/src/a.ts');
    write(root, 'tools/b.ts');
    const payload = JSON.stringify({
      tool_input: { edits: [{ file_path: file }, { file_path: join(root, 'tools', 'b.ts') }] },
    });
    expect(run(root, payload).status).toBe(2);
    // Only the file under the package's install is checked, from that package's own directory.
    expect(argv(log)).toEqual([realpathSync(pkg), 'anti-slop', 'check', '--', 'src/a.ts']);
  });

  it('works when the project root itself contains spaces and glob characters', () => {
    const parent = mkTmp('anti-slop-preflight-spaced-');
    const root = join(parent, 'Personal and [learning]*');
    mkdirSync(join(root, '.devkit', 'anti-slop'), { recursive: true });
    writeFileSync(join(root, '.devkit', 'anti-slop', 'manifest.json'), '{}\n');
    const log = join(parent, 'stub.log');
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    const bin = join(root, 'node_modules', '.bin', 'devkit');
    writeFileSync(
      bin,
      `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> "${log}"; done\necho '${FAIL_OUTPUT.stderr}' >&2\nexit 1\n`,
    );
    chmodSync(bin, 0o755);
    expect(run(root, claudePayload(write(root, 'src/a.ts'))).status).toBe(2);
    expect(argv(log)).toEqual(['anti-slop', 'check', '--', 'src/a.ts']);
  });

  it('ends option parsing before the paths, so a file named -bad.ts is checked, not parsed', () => {
    const { root, log } = repo('fail');
    expect(run(root, claudePayload(write(root, '-bad.ts'))).status).toBe(2);
    expect(argv(log)).toEqual(['anti-slop', 'check', '--', '-bad.ts']);
  });

  it('passes a path with spaces as ONE argument', () => {
    const { root, log } = repo('fail');
    expect(run(root, claudePayload(write(root, 'src/my module/a b.test.ts'))).status).toBe(2);
    expect(argv(log).at(-1)).toBe('src/my module/a b.test.ts');
  });

  it('decodes JSON escapes in the path (a double quote in a filename)', () => {
    const { root, log } = repo('fail');
    expect(run(root, claudePayload(write(root, 'src/say "hi".ts'))).status).toBe(2);
    expect(argv(log).at(-1)).toBe('src/say "hi".ts');
  });

  it('treats a file reached through the resolved path of a symlinked project dir as inside it', () => {
    // macOS: $TMPDIR is /var/folders/… → /private/var/…; a project opened via a symlink gets
    // file paths in either spelling depending on the tool.
    const { root, log } = repo('fail');
    const link = `${mkTmp('anti-slop-preflight-link-')}/project`;
    symlinkSync(root, link);
    const resolved = write(realpathSync(root), 'src/a.ts');
    expect(run(root, claudePayload(resolved), link).status).toBe(2);
    expect(argv(log).at(-1)).toBe('src/a.ts');
  });

  it('treats a file reached through a symlink as inside a project given by its resolved path', () => {
    const { root, log } = repo('fail');
    const link = `${mkTmp('anti-slop-preflight-link-')}/project`;
    symlinkSync(realpathSync(root), link);
    write(root, 'src/a.ts');
    expect(run(root, claudePayload(`${link}/src/a.ts`), realpathSync(root)).status).toBe(2);
    expect(argv(log).at(-1)).toBe('src/a.ts');
  });

  describe('Bash writes', () => {
    it('checks a source file a Bash heredoc wrote, with the output an Edit of it gets', () => {
      const { root, log } = gitRepo('fail');
      write(root, 'src/a.ts');
      const r = runBash(root, bashPayload(root, 500));
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('ERROR anti-slop/no-module-mocking src/a.test.ts:2:1');
      expect(r.stderr).toContain('anti-slop: FAIL');
      expect(argv(log)).toEqual(['anti-slop', 'check', '--', 'src/a.ts']);
    });

    it('still checks a file the same Bash call staged (status compares with HEAD, not the index)', () => {
      const { root, log } = gitRepo('fail');
      write(root, 'src/a.ts');
      git(root, 'add', 'src/a.ts');
      expect(runBash(root, bashPayload(root, 500)).status).toBe(2);
      expect(argv(log)).toEqual(['anti-slop', 'check', '--', 'src/a.ts']);
    });

    it('checks a tracked file a Bash call rewrote in place', () => {
      const { root, log } = gitRepo('fail');
      backdate(write(root, 'src/a.ts', 'export const a = 1;\n'));
      git(root, 'add', '-A');
      git(root, 'commit', '-qm', 'a');
      write(root, 'src/a.ts');
      expect(runBash(root, bashPayload(root, 500)).status).toBe(2);
      expect(argv(log)).toEqual(['anti-slop', 'check', '--', 'src/a.ts']);
    });

    it('leaves a dirty file written before the call alone, so an Edit-checked file is not re-reported', () => {
      const { root, log } = gitRepo('fail');
      backdate(write(root, 'src/old.ts'));
      write(root, 'src/new.ts');
      expect(runBash(root, bashPayload(root, 500)).status).toBe(2);
      expect(argv(log)).toEqual(['anti-slop', 'check', '--', 'src/new.ts']);
    });

    it('checks nothing when the payload carries no duration_ms (an older harness)', () => {
      const { root, log } = gitRepo('fail');
      write(root, 'src/a.ts');
      const r = runBash(root, bashPayload(root));
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('{}');
      expect(argv(log)).toEqual([]);
    });

    it('never checks non-source, gitignored or deleted paths a Bash call touched', () => {
      const { root, log } = gitRepo('fail');
      backdate(write(root, 'src/gone.ts', 'export const g = 1;\n'));
      git(root, 'add', '-A');
      git(root, 'commit', '-qm', 'gone');
      unlinkSync(join(root, 'src', 'gone.ts'));
      write(root, 'README.md', 'x\n');
      write(root, 'dist/built.ts');
      expect(runBash(root, bashPayload(root, 500)).status).toBe(0);
      expect(argv(log)).toEqual([]);
    });

    it('skips an unmerged file a conflicted merge left, which is not code the agent wrote', () => {
      const { root, log } = gitRepo('fail');
      backdate(write(root, 'src/c.ts', 'export const c = 1;\n'));
      git(root, 'add', '-A');
      git(root, 'commit', '-qm', 'c1');
      git(root, 'checkout', '-qb', 'other');
      write(root, 'src/c.ts', 'export const c = 2;\n');
      git(root, 'commit', '-qam', 'c2');
      git(root, 'checkout', '-q', 'main');
      write(root, 'src/c.ts', 'export const c = 3;\n');
      git(root, 'commit', '-qam', 'c3');
      expect(git(root, 'merge', 'other').status).not.toBe(0);
      expect(runBash(root, bashPayload(root, 500)).status).toBe(0);
      expect(argv(log)).toEqual([]);
    });
  });

  describe('workspace root from the payload cwd', () => {
    /** A main checkout plus a linked worktree outside it, the Frink layout: the session's
     * CLAUDE_PROJECT_DIR is the main checkout while the agent works in the worktree. */
    function linkedWorktree() {
      const { root, log } = gitRepo('fail');
      const worktree = join(mkTmp('anti-slop-preflight-wt-'), 'wt');
      git(root, 'worktree', 'add', '-q', worktree);
      return { root, log, worktree: realpathSync(worktree) };
    }

    it('checks a Bash write in a linked worktree, never the main checkout dirty files', () => {
      const { root, log, worktree } = linkedWorktree();
      write(root, 'src/main-only.ts');
      write(worktree, 'src/a.ts');
      expect(runBash(root, bashPayload(worktree, 500)).status).toBe(2);
      expect(argv(log)).toEqual(['anti-slop', 'check', '--', 'src/a.ts']);
    });

    it('checks an Edit in a linked worktree when CLAUDE_PROJECT_DIR is the main checkout', () => {
      const { root, log, worktree } = linkedWorktree();
      const edit = JSON.stringify({
        tool_name: 'Write',
        tool_input: { file_path: write(worktree, 'src/a.ts') },
        cwd: worktree,
      });
      expect(run(root, edit).status).toBe(2);
      expect(argv(log)).toEqual(['anti-slop', 'check', '--', 'src/a.ts']);
    });

    it('bounds a nested worktree by its own root, so an outer overlay install never checks it', () => {
      const { root, log } = gitRepo('fail');
      const nested = join(root, '.claude', 'worktrees', 'x');
      git(root, 'worktree', 'add', '-q', nested);
      // An overlay manifest is git-excluded, so a fresh worktree has none of its own.
      unlinkSync(join(nested, '.devkit', 'anti-slop', 'manifest.json'));
      const edit = JSON.stringify({
        tool_name: 'Write',
        tool_input: { file_path: write(nested, 'src/a.ts') },
        cwd: nested,
      });
      expect(run(root, edit).status).toBe(0);
      expect(argv(log)).toEqual([]);
    });
  });
});
