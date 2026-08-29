import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RepositorySource } from '../source.mts';
import { hashPaths, repositorySource } from '../source.mts';

const roots: string[] = [];

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'benchmark-source-'));
  roots.push(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'tracker@example.invalid');
  git(root, 'config', 'user.name', 'Tracker Test');
  writeFileSync(join(root, 'value.txt'), 'base\n');
  git(root, 'add', 'value.txt');
  git(root, 'commit', '-qm', 'base');
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('repository source modes', () => {
  it('reads the staged index independently of unrelated unstaged edits', () => {
    const root = repo();
    writeFileSync(join(root, 'value.txt'), 'staged\n');
    git(root, 'add', 'value.txt');
    writeFileSync(join(root, 'value.txt'), 'unstaged\n');

    expect(repositorySource(root, 'working').read('value.txt')).toBe('unstaged\n');
    expect(repositorySource(root, 'staged').read('value.txt')).toBe('staged\n');
    expect(repositorySource(root, 'tree', 'HEAD').read('value.txt')).toBe('base\n');
  });

  it('observes staged additions and deletions precisely', () => {
    const root = repo();
    writeFileSync(join(root, 'new.txt'), 'new\n');
    git(root, 'add', 'new.txt');
    git(root, 'rm', '-q', 'value.txt');
    const staged = repositorySource(root, 'staged');
    expect(staged.read('new.txt')).toBe('new\n');
    expect(staged.read('value.txt')).toBeNull();
    expect(staged.listFiles()).toContain('new.txt');
    expect(staged.listFiles()).not.toContain('value.txt');
  });

  it('refuses baseline and evidence paths outside the repository', () => {
    const root = repo();
    expect(() => repositorySource(root, 'working').read('../private.json')).toThrow(
      /Path escapes repository/,
    );
    expect(() => repositorySource(root, 'staged').read('../private.json')).toThrow(
      /Path escapes repository/,
    );
  });

  it('matches double-star globs at zero or many directory levels', () => {
    const source = (files: Record<string, string>): RepositorySource => ({
      mode: 'working',
      root: '/fake',
      listFiles: () => Object.keys(files),
      read: (path) => files[path] ?? null,
    });
    const original = {
      'root.json': 'root',
      'src/x.mts': 'direct',
      'src/nested/x.mts': 'nested',
    };
    expect(hashPaths(source(original), ['**/*.json'])).not.toBe(
      hashPaths(source({ ...original, 'root.json': 'changed' }), ['**/*.json']),
    );
    expect(hashPaths(source(original), ['src/**/x.mts'])).not.toBe(
      hashPaths(source({ ...original, 'src/x.mts': 'changed' }), ['src/**/x.mts']),
    );
  });
});

describe('git failures are attributed, never reported as an absent file', () => {
  interface GitShim {
    bin: string;
    /** Every git invocation the shim actually intercepted, argv joined by spaces. */
    calls: () => string[];
  }

  /**
   * A git that answers every subcommand normally except `failOn`, and LOGS every invocation.
   *
   * The log is what makes these tests honest. Interception happens through `process.env.PATH`, and a
   * runner or pool that resolved `git` before the mutation would send the source at the real binary
   * — leaving a test that still passes while exercising nothing. Every case below asserts the log is
   * non-empty, so a shim that never took effect fails loudly instead of silently proving nothing.
   */
  function shimGit(failOn: string, message: string): GitShim {
    const bin = mkdtempSync(join(tmpdir(), 'benchmark-source-bin-'));
    roots.push(bin);
    const log = join(bin, 'calls.log');
    const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    writeFileSync(
      join(bin, 'git'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nfor arg in "$@"; do\n  if [ "$arg" = '${failOn}' ]; then\n    echo '${message}' >&2\n    exit 128\n  fi\ndone\nexec '${real}' "$@"\n`,
    );
    chmodSync(join(bin, 'git'), 0o755);
    return {
      bin,
      calls: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []),
    };
  }

  const shimGitFailingOnShow = () => shimGit('show', 'fatal: unable to read object store');

  const shimGitFailingOnCatFile = () => shimGit('cat-file', 'fatal: not a git repository');

  function withShim<T>(bin: string, action: () => T): T {
    const original = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${original ?? ''}`;
    try {
      return action();
    } finally {
      process.env.PATH = original;
    }
  }

  it('throws with the resolved root, mode and git stderr instead of returning null', () => {
    const root = repo();
    const shim = shimGitFailingOnShow();
    withShim(shim.bin, () => {
      const staged = repositorySource(root, 'staged');
      expect(staged.listFiles()).toContain('value.txt');
      expect(() => staged.read('value.txt')).toThrow(/unable to read object store/);
      expect(() => staged.read('value.txt')).toThrow(/mode=staged/);
      expect(() => staged.read('value.txt')).toThrow(new RegExp(root.replace(/\W/g, '.')));
    });
    expect(shim.calls()).not.toHaveLength(0);
  });

  it('reads a tracked path without consulting an exit-status existence probe', () => {
    const root = repo();
    const shim = shimGitFailingOnCatFile();
    withShim(shim.bin, () => {
      const staged = repositorySource(root, 'staged');
      expect(staged.read('value.txt')).toBe('base\n');
      expect(repositorySource(root, 'tree', 'HEAD').read('value.txt')).toBe('base\n');
    });
    // The shim ran (so PATH interception reached the source) and `cat-file` was never among the
    // subcommands — the reads succeeded because nothing consulted an exit-status probe at all.
    expect(shim.calls()).not.toHaveLength(0);
    expect(shim.calls().filter((call) => call.startsWith('cat-file'))).toEqual([]);
  });

  it('propagates that failure through hashPaths rather than hashing a short set', () => {
    const root = repo();
    const shim = shimGitFailingOnShow();
    withShim(shim.bin, () => {
      expect(() => hashPaths(repositorySource(root, 'staged'), ['**/*.txt'])).toThrow(
        /unable to read object store/,
      );
    });
    expect(shim.calls()).not.toHaveLength(0);
  });

  it('still reports a genuinely absent path as null, in every snapshot mode', () => {
    const root = repo();
    expect(repositorySource(root, 'staged').read('nope.txt')).toBeNull();
    expect(repositorySource(root, 'tree', 'HEAD').read('nope.txt')).toBeNull();
    expect(repositorySource(root, 'working').read('nope.txt')).toBeNull();
  });

  // git QUOTES non-ASCII paths in its default listing output (`"docs/\303\251.md"`), so a
  // newline-split file list could name a path that no later read would ever match.
  it('lists and reads a tracked path that git would otherwise quote', () => {
    const root = repo();
    writeFileSync(join(root, 'café.txt'), 'accented\n');
    git(root, 'add', 'café.txt');
    const staged = repositorySource(root, 'staged');
    expect(staged.listFiles()).toContain('café.txt');
    expect(staged.read('café.txt')).toBe('accented\n');
  });
});

describe('real repository shapes the tracker must survive', () => {
  it('reads a blob larger than the default subprocess buffer', () => {
    const root = repo();
    const big = `${'x'.repeat(1_500_000)}\n`;
    writeFileSync(join(root, 'big.txt'), big);
    git(root, 'add', 'big.txt');
    expect(repositorySource(root, 'staged').read('big.txt')).toBe(big);
    git(root, 'commit', '-qm', 'big');
    expect(repositorySource(root, 'tree', 'HEAD').read('big.txt')).toBe(big);
  });

  it('ignores a submodule gitlink rather than failing on an unreadable object', () => {
    const root = repo();
    // A gitlink is staged directly: `git submodule add` needs a reachable source repo and
    // protocol.file.allow, and the index entry is the only part under test.
    const oid = git(root, 'rev-parse', 'HEAD').trim();
    git(root, 'update-index', '--add', `--cacheinfo`, `160000,${oid},vendor`);
    const staged = repositorySource(root, 'staged');
    // `git show :vendor` is `fatal: bad object` — a gitlink is not a blob and never was one. It must
    // not enter a listing whose whole contract is "these are readable paths".
    expect(staged.listFiles()).not.toContain('vendor');
    expect(() => hashPaths(staged, ['**'])).not.toThrow();
    expect(staged.read('vendor')).toBeNull();
  });

  it('lists a conflicted path once, and refuses to skip it silently', () => {
    const root = repo();
    // Never hardcode `master`/`main`: the branch a bare `git init` produces is whatever the running
    // machine's init.defaultBranch says, so a fixed name passes on one developer's box and not another's.
    const base = git(root, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
    git(root, 'checkout', '-q', '-b', 'other');
    writeFileSync(join(root, 'conflict.txt'), 'theirs\n');
    git(root, 'add', 'conflict.txt');
    git(root, 'commit', '-qm', 'theirs');
    git(root, 'checkout', '-q', base);
    writeFileSync(join(root, 'conflict.txt'), 'ours\n');
    git(root, 'add', 'conflict.txt');
    git(root, 'commit', '-qm', 'ours');
    try {
      git(root, 'merge', '-q', 'other');
    } catch {
      /* the conflict IS the fixture */
    }

    const staged = repositorySource(root, 'staged');
    // `git ls-files --cached` emits one row PER STAGE, so an unmerged path arrives twice and would
    // otherwise be hashed twice.
    expect(staged.listFiles().filter((path) => path === 'conflict.txt')).toHaveLength(1);
    // Stage 0 does not exist mid-conflict. Reporting that as "absent" would let the checker hash a
    // short set and PASS on an index nobody could commit; git's own reason is the right answer.
    expect(() => staged.read('conflict.txt')).toThrow(/stage 0/);
  });

  it('lists and reads a path containing a newline', () => {
    const root = repo();
    // Newline-splitting the listing turned this single path into two entries that matched nothing.
    writeFileSync(join(root, 'two\nlines.txt'), 'awkward\n');
    git(root, 'add', '--', 'two\nlines.txt');
    const staged = repositorySource(root, 'staged');
    expect(staged.listFiles()).toContain('two\nlines.txt');
    expect(staged.read('two\nlines.txt')).toBe('awkward\n');
  });

  it('names an unreachable tree ref instead of reporting every path as absent', () => {
    const root = repo();
    // A shallow clone or an unfetched --base sha lands here. Answering null per path would render a
    // whole missing snapshot as "every file was deleted" and produce confident nonsense.
    const source = repositorySource(root, 'tree', '0000000000000000000000000000000000000001');
    expect(() => source.read('value.txt')).toThrow(/mode=tree/);
    // git's own wording varies by version; what must survive is that it reaches the reader at all.
    expect(() => source.read('value.txt')).toThrow(/stderr: fatal:/);
  });

  it('answers from the snapshot it listed, not from a later index mutation', () => {
    const root = repo();
    const staged = repositorySource(root, 'staged');
    expect(staged.read('value.txt')).toBe('base\n');
    writeFileSync(join(root, 'late.txt'), 'staged after the first read\n');
    git(root, 'add', 'late.txt');
    // Deliberate: a checker judges ONE snapshot. Mixing a memoised listing with live reads is how a
    // report ends up describing two different indexes at once.
    expect(staged.read('late.txt')).toBeNull();
    expect(staged.listFiles()).not.toContain('late.txt');
    expect(repositorySource(root, 'staged').read('late.txt')).toBe('staged after the first read\n');
  });
});
