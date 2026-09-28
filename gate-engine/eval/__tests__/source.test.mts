import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RepositorySource } from '../source.mts';
import { assertBlobMatches, gitObjectId } from '../snapshot/integrity.mts';
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

// sc-3215: a staged listing that lacks a tracked path used to fail with one sentence that fit a real
// staged deletion, a short index and a wrong root equally. The diagnostic has to tell them apart.
describe('absence diagnostics name why a path is missing from a snapshot', () => {
  function explain(source: RepositorySource, path: string): string {
    if (!source.explainAbsence) throw new Error(`${source.mode} source has no explainAbsence`);
    return source.explainAbsence(path);
  }

  it('reports a real staged deletion as persistent, tracked in HEAD and D against HEAD', () => {
    const root = repo();
    git(root, 'rm', '-q', '--cached', 'value.txt');
    const staged = repositorySource(root, 'staged');
    expect(staged.read('value.txt')).toBeNull();
    const report = explain(staged, 'value.txt');
    expect(report).toMatch(/listing: 0 entries/);
    expect(report).toMatch(/re-probe: absent/);
    expect(report).toMatch(/HEAD: tracked/);
    expect(report).toMatch(/staged vs HEAD: D$/m);
  });

  it('reports a path staged after the memoised listing as a transient miss', () => {
    const root = repo();
    const staged = repositorySource(root, 'staged');
    staged.listFiles();
    writeFileSync(join(root, 'late.txt'), 'late\n');
    git(root, 'add', 'late.txt');
    expect(staged.read('late.txt')).toBeNull();
    const report = explain(staged, 'late.txt');
    expect(report).toMatch(/listing: 1 entries/);
    expect(report).toMatch(/re-probe: present/);
    expect(report).toMatch(/HEAD: untracked/);
    expect(report).toMatch(/staged vs HEAD: A$/m);
  });

  it('treats glob characters in the asked-for path literally', () => {
    const root = repo();
    writeFileSync(join(root, 'ab.txt'), 'sibling\n');
    git(root, 'add', 'ab.txt');
    const report = explain(repositorySource(root, 'staged'), 'a*.txt');
    expect(report).toMatch(/re-probe: absent/);
    expect(report).toMatch(/staged vs HEAD: none$/m);
  });

  it('looks up tracked names that are pathspec syntax literally, in HEAD and the index', () => {
    const root = repo();
    const names = [':(exclude)foo', ':!bar', 'a*.txt'];
    for (const name of names) writeFileSync(join(root, name), `${name}\n`);
    git(root, 'add', '--', ...names.map((name) => `:(literal)${name}`));
    git(root, 'commit', '-qm', 'magic names');
    git(root, 'rm', '-q', '--cached', '--', ...names.map((name) => `:(literal)${name}`));
    const staged = repositorySource(root, 'staged');
    for (const name of names) {
      const report = explain(staged, name);
      expect(report).toMatch(/HEAD: tracked/);
      expect(report).toMatch(/staged vs HEAD: D$/m);
    }
  });

  it('reports an unborn HEAD instead of an unavailable probe', () => {
    const root = mkdtempSync(join(tmpdir(), 'benchmark-source-unborn-'));
    roots.push(root);
    git(root, 'init', '-q');
    writeFileSync(join(root, 'first.txt'), 'first\n');
    git(root, 'add', 'first.txt');
    const report = explain(repositorySource(root, 'staged'), 'missing.txt');
    expect(report).toMatch(/HEAD: unborn/);
    expect(report).toMatch(/staged vs HEAD: HEAD unborn/);
    expect(report).toMatch(/listing: 1 entries/);
  });

  it('says whether an index.lock is held, the signal of a concurrent index writer', () => {
    const root = repo();
    const staged = repositorySource(root, 'staged');
    expect(explain(staged, 'missing.txt')).toMatch(/index\.lock absent/);
    writeFileSync(join(root, '.git', 'index.lock'), '');
    const report = explain(staged, 'missing.txt');
    expect(report).toMatch(/index\.lock present/);
    expect(report).toMatch(/size=\d+ bytes/);
  });

  it('resolves a linked worktree index and agrees with its toplevel, as in a ship worktree', () => {
    const root = repo();
    const parent = mkdtempSync(join(tmpdir(), 'benchmark-source-linked-'));
    roots.push(parent);
    const linked = join(parent, 'wt');
    git(root, 'worktree', 'add', '-q', '--detach', linked, 'HEAD');
    const report = explain(repositorySource(linked, 'staged'), 'missing.txt');
    expect(report).toMatch(/index: \S*[\\/]worktrees[\\/]wt[\\/]index/);
    expect(report).not.toMatch(/<unavailable/);
    expect(report).toMatch(/toplevel: matches root/);
  });

  it('never throws when git becomes unusable after the source was built', () => {
    const root = repo();
    const staged = repositorySource(root, 'staged');
    staged.listFiles();
    rmSync(join(root, '.git'), { recursive: true, force: true });
    const report = explain(staged, 'value.txt');
    expect(report).toMatch(/listing: 1 entries/);
    expect(report).toMatch(/re-probe: <unavailable/);
  });

  function dropObject(root: string, rev: string) {
    const oid = git(root, 'rev-parse', rev).trim();
    rmSync(join(root, '.git', 'objects', oid.slice(0, 2), oid.slice(2)));
  }

  it('reports HEAD unavailable, not untracked, when the HEAD tree object is missing', () => {
    const root = repo();
    dropObject(root, 'HEAD^{tree}');
    const report = explain(repositorySource(root, 'staged'), 'value.txt');
    expect(report).toMatch(/HEAD: <unavailable/);
    expect(report).not.toMatch(/HEAD: untracked/);
  });

  it('reports HEAD unavailable, not unborn, when the HEAD commit object is missing', () => {
    const root = repo();
    dropObject(root, 'HEAD');
    const report = explain(repositorySource(root, 'staged'), 'value.txt');
    expect(report).toMatch(/HEAD: <unavailable/);
    expect(report).not.toMatch(/unborn/);
  });

  it('names the ref for a tree snapshot', () => {
    const root = repo();
    const report = explain(repositorySource(root, 'tree', 'HEAD'), 'missing.txt');
    expect(report).toMatch(/listing: 1 entries at HEAD/);
  });
});

// sc-3215 root cause: bun's spawnSync returned truncated git stdout with exit 0 (32,768 of 94,846
// bytes, reproduced). A short read must be a fault, never a content verdict.
describe('subprocess output is verified against the object id the listing named', () => {
  const blob = Buffer.from('{"catalog":true}\n');
  const oid = gitObjectId(blob, 40);

  it('accepts bytes that hash to the listed blob id, SHA-1 and SHA-256 alike', () => {
    expect(() => assertBlobMatches(':x', blob, oid)).not.toThrow();
    expect(() => assertBlobMatches(':x', blob, gitObjectId(blob, 64))).not.toThrow();
  });

  it('refuses truncated or empty output as a fault naming the read', () => {
    expect(() =>
      assertBlobMatches(':docs/benchmarks/catalog.json', blob.subarray(0, 5), oid),
    ).toThrow(
      /git show :docs\/benchmarks\/catalog\.json returned 5 bytes that do not hash to .*truncated/,
    );
    expect(() => assertBlobMatches(':x', Buffer.alloc(0), oid)).toThrow(/returned 0 bytes/);
  });

  it('matches real reads byte-for-byte, including non-UTF-8 content, in staged and tree modes', () => {
    const root = repo();
    writeFileSync(join(root, 'latin1.bin'), Buffer.from([0xe9, 0x00, 0xff, 0x0a]));
    git(root, 'add', 'latin1.bin');
    git(root, 'commit', '-qm', 'binary');
    expect(() => repositorySource(root, 'staged').read('latin1.bin')).not.toThrow();
    expect(() => repositorySource(root, 'tree', 'HEAD').read('latin1.bin')).not.toThrow();
    expect(repositorySource(root, 'staged').read('value.txt')).toBe('base\n');
  });

  // The reproduced fault itself: a git whose stdout arrives cut short while it still exits 0.
  function withTruncatingGit<T>(subcommand: string, bytes: number, action: () => T): T {
    const bin = mkdtempSync(join(tmpdir(), 'benchmark-source-truncating-'));
    roots.push(bin);
    const log = join(bin, 'calls.log');
    const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    writeFileSync(
      join(bin, 'git'),
      `#!/bin/sh\nif [ "$1" = '${subcommand}' ]; then echo "$*" >> '${log}'; '${real}' "$@" | head -c ${bytes}; exit 0; fi\nexec '${real}' "$@"\n`,
    );
    chmodSync(join(bin, 'git'), 0o755);
    const original = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${original ?? ''}`;
    try {
      return action();
    } finally {
      process.env.PATH = original;
      expect(existsSync(log)).toBe(true);
    }
  }

  it('throws on a truncated blob read instead of returning short content', () => {
    const root = repo();
    const staged = repositorySource(root, 'staged');
    staged.listFiles();
    withTruncatingGit('show', 2, () => {
      expect(() => staged.read('value.txt')).toThrow(/returned 2 bytes .*truncated/);
    });
  });

  it('captures git stdout through a file, never the pipe the truncation was reproduced on', () => {
    const root = repo();
    const bin = mkdtempSync(join(tmpdir(), 'benchmark-source-nopipe-'));
    roots.push(bin);
    const log = join(bin, 'calls.log');
    const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    writeFileSync(
      join(bin, 'git'),
      `#!/bin/sh\necho "$1" >> '${log}'\nif [ ! -f /dev/stdout ]; then echo 'stdout is not a file' >&2; exit 3; fi\nexec '${real}' "$@"\n`,
    );
    chmodSync(join(bin, 'git'), 0o755);
    const original = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${original ?? ''}`;
    try {
      const staged = repositorySource(root, 'staged');
      expect(staged.listFiles()).toEqual(['value.txt']);
      expect(staged.read('value.txt')).toBe('base\n');
      expect(repositorySource(root, 'tree', 'HEAD').read('value.txt')).toBe('base\n');
    } finally {
      process.env.PATH = original;
    }
    expect(readFileSync(log, 'utf8')).toMatch(/ls-files[\s\S]*show/);
  });

  it('verifies reads in a SHA-256 repository', () => {
    const root = mkdtempSync(join(tmpdir(), 'benchmark-source-sha256-'));
    roots.push(root);
    git(root, 'init', '-q', '--object-format=sha256');
    writeFileSync(join(root, 'value.txt'), 'sha256\n');
    git(root, 'add', 'value.txt');
    expect(repositorySource(root, 'staged').read('value.txt')).toBe('sha256\n');
  });
});
