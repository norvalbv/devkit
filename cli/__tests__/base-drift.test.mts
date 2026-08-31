/**
 * Real-git coverage for the base-drift core (sc-2297).
 *
 * The pure logic is unit-tested beside the module with a canned GitRun; what needs real git is
 * everything the fake cannot fake: actual shas (so the rearm token can be proven to change), the
 * shared-clone ref mutation across linked worktrees, a genuinely unreachable remote, and git's own
 * rename reporting.
 *
 * Registered in vitest.config.mjs's GIT_INTEGRATION_TESTS — it creates real repos, does real
 * fetches and shares a $TMPDIR marker namespace, so it must not run in the parallel project.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runBaseStatus } from '../lib/ship/base-drift/cli.mts';
import { baseDrift } from '../lib/ship/base-drift/drift.mts';
import { exitCodeFor, renderSessionBrief } from '../lib/ship/base-drift/render.mts';

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const made: string[] = [];

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();

/**
 * A checkout on a branch with NO upstream, cut from a base that lives on origin — the shape a
 * provisioned worktree actually has, and the one sc-2297 happened in.
 *
 * Note `git init` + `remote add` never creates refs/remotes/origin/HEAD, so the origin/HEAD and
 * main/master tiers cannot fire here; every test passes an explicit base, exactly as ship does.
 */
function seed() {
  const bare = tmpDir('bd-bare-');
  git(bare, ['init', '-q', '--bare', '-b', 'trunk', '.']);
  const work = tmpDir('bd-work-');
  git(work, ['init', '-q', '-b', 'trunk', '.']);
  git(work, ['config', 'user.email', 'dev@example.test']);
  git(work, ['config', 'user.name', 'dev']);
  git(work, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(work, 'kept.txt'), 'one\n');
  writeFileSync(join(work, 'shared.txt'), 'base\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'root']);
  git(work, ['remote', 'add', 'origin', bare]);
  git(work, ['push', '-q', 'origin', 'trunk']);
  git(work, ['fetch', '-q', 'origin']);
  // The worktree's own branch, with no upstream.
  git(work, ['checkout', '-q', '-b', 'agent-branch']);
  return { bare, work, markers: tmpDir('bd-markers-') };
}

/** Land a commit on origin's base, the way another agent's merged PR would. */
function landOnBase(bare: string, files: Record<string, string>, message: string): string {
  const clone = tmpDir('bd-lander-');
  git(clone, ['clone', '-q', bare, '.']);
  git(clone, ['config', 'user.email', 'other@example.test']);
  git(clone, ['config', 'user.name', 'other']);
  git(clone, ['config', 'commit.gpgsign', 'false']);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(clone, name), body);
  git(clone, ['add', '-A']);
  git(clone, ['commit', '-q', '-m', message]);
  git(clone, ['push', '-q', 'origin', 'HEAD:trunk']);
  return git(clone, ['rev-parse', 'HEAD']);
}

const run = (repo: { work: string; markers: string }, paths: string[] = []) =>
  baseDrift({ root: repo.work, base: 'trunk', paths, maxAgeMs: 0, tmpDir: repo.markers });

describe('base drift against a base that moved', () => {
  it('reports nothing while the base is where the branch was cut from', () => {
    const repo = seed();
    const report = run(repo);
    expect(report.silent).toBe('no-drift');
    expect(exitCodeFor(report)).toBe(0);
  });

  it('stays quiet when HEAD is merely AHEAD of an unmoved base', () => {
    // The reason the signal is `merge-base --is-ancestor` and not a sha comparison: an unpushed
    // local commit makes origin/<base> != HEAD without anything having moved under us.
    const repo = seed();
    writeFileSync(join(repo.work, 'kept.txt'), 'local edit\n');
    git(repo.work, ['commit', '-qam', 'local work']);
    const report = run(repo);
    expect(report.silent).toBe('no-drift');
    expect(exitCodeFor(report)).toBe(0);
  });

  it('names the file, the commit and the subject once the base moves (the sc-2297 shape)', () => {
    const repo = seed();
    const sha = landOnBase(repo.bare, { 'migration.json': '0091\n' }, 'add migration 0091');
    const report = run(repo, ['migration.json']);
    expect(exitCodeFor(report)).toBe(3);
    expect(report.overlap).toHaveLength(1);
    expect(report.overlap[0]).toMatchObject({ path: 'migration.json', status: 'A' });
    expect(report.overlap[0]?.commit?.sha).toBe(sha);
    expect(report.overlap[0]?.commit?.subject).toBe('add migration 0091');
    expect(renderSessionBrief(report)).toContain('migration.json');
  });

  it('filters to the caller paths, and matches a directory by containment', () => {
    const repo = seed();
    landOnBase(repo.bare, { 'shared.txt': 'moved\n' }, 'touch shared');
    expect(exitCodeFor(run(repo, ['kept.txt']))).toBe(0);
    expect(exitCodeFor(run(repo, ['shared.txt']))).toBe(3);
    // A whole-repo query still sees it.
    expect(run(repo, []).overlap.map((entry) => entry.path)).toContain('shared.txt');
  });
});

describe('a SECOND move re-arms the advisory', () => {
  it('changes the rearm token, so a session that was briefed once is briefed again', () => {
    // sc-2297's origin moved TWICE and the second move produced the 88-file divergence. A dedup key
    // that ignored the base sha would have gone silent for exactly that one.
    const repo = seed();
    landOnBase(repo.bare, { 'shared.txt': 'first\n' }, 'first move');
    const first = run(repo, ['shared.txt']);
    landOnBase(repo.bare, { 'shared.txt': 'second\n' }, 'second move');
    const second = run(repo, ['shared.txt']);
    expect(first.overlap[0]?.rearm).toBeDefined();
    expect(second.overlap[0]?.rearm).not.toBe(first.overlap[0]?.rearm);
  });
});

describe('renames', () => {
  it('reports the OLD name too, so a stale read of it can be corrected', () => {
    // With git's default rename detection only the destination is reported — and the agent who ran
    // `git show HEAD:<old>` and got nothing is precisely who this has to reach.
    const repo = seed();
    const clone = tmpDir('bd-rename-');
    git(clone, ['clone', '-q', repo.bare, '.']);
    git(clone, ['config', 'user.email', 'other@example.test']);
    git(clone, ['config', 'user.name', 'other']);
    git(clone, ['config', 'commit.gpgsign', 'false']);
    renameSync(join(clone, 'shared.txt'), join(clone, 'renamed.txt'));
    git(clone, ['add', '-A']);
    git(clone, ['commit', '-q', '-m', 'rename shared']);
    git(clone, ['push', '-q', 'origin', 'HEAD:trunk']);

    const moved = run(repo, []).moved.map((entry) => entry.path);
    expect(moved).toContain('shared.txt');
    expect(moved).toContain('renamed.txt');
    expect(exitCodeFor(run(repo, ['shared.txt']))).toBe(3);
  });
});

describe('paths git would C-quote', () => {
  it('survives the -z round trip, attribution included', () => {
    const repo = seed();
    const weird = 'we ird\tname.txt';
    landOnBase(repo.bare, { [weird]: 'x\n' }, 'add a hostile path');
    const report = run(repo, [weird]);
    expect(report.overlap.map((entry) => entry.path)).toEqual([weird]);
    expect(report.overlap[0]?.commit?.subject).toBe('add a hostile path');
  });
});

describe('the shared clone', () => {
  it("advances the sibling worktree's view of origin without touching its work", () => {
    const repo = seed();
    const sibling = join(tmpDir('bd-sibling-'), 'wt');
    git(repo.work, ['worktree', 'add', '-q', '-b', 'sibling-branch', sibling]);
    made.push(sibling);
    const siblingHead = git(sibling, ['rev-parse', 'HEAD']);
    landOnBase(repo.bare, { 'shared.txt': 'moved\n' }, 'move it');

    run(repo, []);

    // The fetch writes remote-tracking refs in the COMMON git dir, so the sibling sees the new tip…
    expect(git(sibling, ['rev-parse', 'refs/remotes/origin/trunk'])).toBe(
      git(repo.bare, ['rev-parse', 'trunk']),
    );
    // …and nothing else about the sibling changed.
    expect(git(sibling, ['rev-parse', 'HEAD'])).toBe(siblingHead);
    expect(git(sibling, ['status', '--porcelain'])).toBe('');
    git(repo.work, ['worktree', 'remove', '--force', sibling]);
  });

  it('shares ONE fetch window across sibling worktrees', () => {
    const repo = seed();
    const sibling = join(tmpDir('bd-window-'), 'wt');
    git(repo.work, ['worktree', 'add', '-q', '-b', 'window-branch', sibling]);
    made.push(sibling);
    // Open the window from the first worktree…
    baseDrift({ root: repo.work, base: 'trunk', maxAgeMs: 60_000, tmpDir: repo.markers });
    // …then break the remote. The sibling must ride the window rather than discovering it is gone.
    git(repo.work, ['remote', 'set-url', 'origin', join(tmpdir(), 'bd-absent.git')]);
    const report = baseDrift({
      root: sibling,
      base: 'trunk',
      maxAgeMs: 60_000,
      tmpDir: repo.markers,
    });
    expect(report.freshness).toBe('cached');
    git(repo.work, ['worktree', 'remove', '--force', sibling]);
  });
});

describe('degrading', () => {
  it('reports unknown — not fresh, not silent — when origin is unreachable', () => {
    const repo = seed();
    git(repo.work, ['remote', 'set-url', 'origin', join(tmpdir(), 'bd-definitely-absent.git')]);
    const report = run(repo);
    expect(report.freshness).toBe('unknown');
    expect(exitCodeFor(report)).toBe(4);
    expect(renderSessionBrief(report)).toContain('UNKNOWN');
  });

  it('is LOUD when origin is unreachable and the tracking ref was never fetched', () => {
    const bare = tmpDir('bd-unreach-bare-');
    git(bare, ['init', '-q', '--bare', '-b', 'trunk', '.']);
    const work = tmpDir('bd-unreach-');
    git(work, ['init', '-q', '-b', 'agent', '.']);
    for (const [k, v] of [
      ['user.email', 'd@e.test'],
      ['user.name', 'd'],
      ['commit.gpgsign', 'false'],
    ]) {
      git(work, ['config', k, v]);
    }
    writeFileSync(join(work, 'a.txt'), 'a\n');
    git(work, ['add', '-A']);
    git(work, ['commit', '-q', '-m', 'root']);
    // origin exists as a remote but points nowhere, so refs/remotes/origin/trunk is never created.
    git(work, ['remote', 'add', 'origin', join(tmpdir(), 'bd-unreachable.git')]);

    const report = baseDrift({
      root: work,
      base: 'trunk',
      maxAgeMs: 0,
      tmpDir: tmpDir('bd-unreach-markers-'),
    });
    expect(report.base).toMatchObject({
      kind: 'unresolvable',
      reason: 'fetch-failed',
      base: 'trunk',
    });
    expect(renderSessionBrief(report)).toContain('UNKNOWN');
    expect(exitCodeFor(report)).toBe(4);
  });

  it('is silent, and exits 4, when no base can be resolved', () => {
    const bare = tmpDir('bd-nobase-bare-');
    git(bare, ['init', '-q', '--bare', '.']);
    const work = tmpDir('bd-nobase-');
    git(work, ['init', '-q', '-b', 'solo', '.']);
    git(work, ['config', 'user.email', 'd@e.test']);
    git(work, ['config', 'user.name', 'd']);
    git(work, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(work, 'a.txt'), 'a\n');
    git(work, ['add', '-A']);
    git(work, ['commit', '-q', '-m', 'root']);
    const report = baseDrift({ root: work, maxAgeMs: 0, tmpDir: tmpDir('bd-nobase-markers-') });
    expect(report.base.kind).toBe('unresolvable');
    expect(renderSessionBrief(report)).toBe('');
    expect(exitCodeFor(report)).toBe(4);
  });

  it('does not throw outside a git repository', () => {
    const plain = tmpDir('bd-plain-');
    const report = baseDrift({ root: plain, maxAgeMs: 0, tmpDir: tmpDir('bd-plain-markers-') });
    expect(report.base).toEqual({ kind: 'unresolvable', reason: 'not-a-repo' });
    expect(exitCodeFor(report)).toBe(4);
  });

  it('exits 4 on unrelated histories rather than reporting every file as moved', () => {
    const repo = seed();
    // An orphan root commit shares no ancestor with the base.
    git(repo.work, ['checkout', '-q', '--orphan', 'orphan']);
    writeFileSync(join(repo.work, 'only.txt'), 'x\n');
    git(repo.work, ['add', '-A']);
    git(repo.work, ['commit', '-q', '-m', 'orphan root']);
    expect(exitCodeFor(run(repo))).toBe(4);
  });
});

describe('caller scope', () => {
  it('reports NOTHING when every supplied path lies outside the checkout', () => {
    // "The caller named nothing" and "the caller named things, none of which are here" are
    // different questions with different answers. Collapsing them makes `base-status -- /etc/passwd`
    // answer with every file that moved in the repo, which is a confidently wrong verdict.
    const repo = seed();
    landOnBase(repo.bare, { 'shared.txt': 'moved\n' }, 'move it');
    const report = run(repo, ['/etc/passwd', '../elsewhere']);
    expect(report.overlap).toEqual([]);
    expect(exitCodeFor(report)).toBe(0);
  });

  it('treats "." as the whole repo, even alongside a narrower path', () => {
    const repo = seed();
    landOnBase(repo.bare, { 'shared.txt': 'moved\n' }, 'move it');
    expect(run(repo, ['.']).overlap.map((entry) => entry.path)).toContain('shared.txt');
    expect(run(repo, ['kept.txt', '.']).overlap.map((entry) => entry.path)).toContain('shared.txt');
  });

  it('an empty path list still means the whole repo', () => {
    const repo = seed();
    landOnBase(repo.bare, { 'shared.txt': 'moved\n' }, 'move it');
    expect(run(repo, []).overlap.map((entry) => entry.path)).toContain('shared.txt');
  });
});

describe('concurrency against a shared clone', () => {
  it('does not clobber FETCH_HEAD, so a concurrent ship keeps its pinned base', () => {
    // THE hazard --no-write-fetch-head exists for. ship-branch.sh:298-303 runs `git fetch` and then
    // reads `git rev-parse FETCH_HEAD` to pin the commit its ephemeral worktree is cut from. A hook
    // fetch landing between those two lines would silently repoint the ship at a different base.
    const repo = seed();
    // Stand in for ship's own fetch, then capture what it would pin.
    git(repo.work, ['fetch', '-q', 'origin', 'refs/heads/trunk']);
    const shipWouldPin = git(repo.work, ['rev-parse', 'FETCH_HEAD']);

    // Another agent's PR lands, and a base-drift fetch fires in the SAME worktree.
    landOnBase(repo.bare, { 'shared.txt': 'landed mid-ship\n' }, 'lands mid-ship');
    const report = run(repo, ['shared.txt']);
    expect(report.freshness).toBe('fresh'); // it really did fetch

    expect(git(repo.work, ['rev-parse', 'FETCH_HEAD'])).toBe(shipWouldPin);
  });

  it('never reports fresh when two worktrees fetch the same ref at once', () => {
    // Ref-lock contention is a legitimate outcome of N parallel agents on one clone. Whatever the
    // loser observes, it must not be a claim that the refs are current.
    const repo = seed();
    const sibling = join(tmpDir('bd-race-'), 'wt');
    git(repo.work, ['worktree', 'add', '-q', '-b', 'race-branch', sibling]);
    made.push(sibling);
    landOnBase(repo.bare, { 'shared.txt': 'raced\n' }, 'race');

    const both = [repo.work, sibling].map((root) =>
      baseDrift({ root, base: 'trunk', maxAgeMs: 0, tmpDir: repo.markers }),
    );
    for (const report of both) {
      expect(['fresh', 'cached', 'unknown']).toContain(report.freshness);
      // A crash, or a fabricated merge-base, would show up here.
      expect(report.base.kind).toBe('resolved');
    }
    git(repo.work, ['worktree', 'remove', '--force', sibling]);
  });
});

describe('attribution cap', () => {
  it('names commits up to the cap and leaves the rest null, flagging truncation', () => {
    const repo = seed();
    const files = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`f${i}.txt`, `${i}\n`]));
    landOnBase(repo.bare, files, 'five files');
    const report = baseDrift({
      root: repo.work,
      base: 'trunk',
      paths: Object.keys(files),
      maxAgeMs: 0,
      maxAttributions: 2,
      tmpDir: repo.markers,
    });
    expect(report.overlap).toHaveLength(5);
    expect(report.overlap.slice(0, 2).every((entry) => entry.commit !== null)).toBe(true);
    expect(report.overlap.slice(2).every((entry) => entry.commit === null)).toBe(true);
    expect(report.truncated).toBe(true);
    // Every entry still carries a rearm token — dedup must not depend on the attribution budget.
    expect(report.overlap.every((entry) => /^[0-9a-f]{16}$/.test(entry.rearm))).toBe(true);
  });

  it('does not claim truncation when the overlap lands exactly on the cap', () => {
    const repo = seed();
    landOnBase(repo.bare, { 'a.txt': 'a\n', 'b.txt': 'b\n' }, 'two files');
    const report = baseDrift({
      root: repo.work,
      base: 'trunk',
      paths: ['a.txt', 'b.txt'],
      maxAgeMs: 0,
      maxAttributions: 2,
      tmpDir: repo.markers,
    });
    expect(report.overlap).toHaveLength(2);
    expect(report.truncated).toBe(false);
    expect(report.overlap.every((entry) => entry.commit !== null)).toBe(true);
  });
});

describe('real-world ref shapes', () => {
  it('handles a slashed branch name end to end, refspec included', () => {
    // `release/1.0` is ordinary, and it is interpolated into a refspec, a rev-parse and a log range.
    const bare = tmpDir('bd-slash-bare-');
    git(bare, ['init', '-q', '--bare', '-b', 'release/1.0', '.']);
    const work = tmpDir('bd-slash-work-');
    git(work, ['init', '-q', '-b', 'release/1.0', '.']);
    for (const [k, v] of [
      ['user.email', 'd@e.test'],
      ['user.name', 'd'],
      ['commit.gpgsign', 'false'],
    ]) {
      git(work, ['config', k, v]);
    }
    writeFileSync(join(work, 'x.txt'), 'one\n');
    git(work, ['add', '-A']);
    git(work, ['commit', '-q', '-m', 'root']);
    git(work, ['remote', 'add', 'origin', bare]);
    git(work, ['push', '-q', 'origin', 'release/1.0']);
    git(work, ['fetch', '-q', 'origin']);
    git(work, ['checkout', '-q', '-b', 'feature']);

    const clone = tmpDir('bd-slash-land-');
    git(clone, ['clone', '-q', bare, '.']);
    for (const [k, v] of [
      ['user.email', 'o@e.test'],
      ['user.name', 'o'],
      ['commit.gpgsign', 'false'],
    ]) {
      git(clone, ['config', k, v]);
    }
    writeFileSync(join(clone, 'x.txt'), 'moved\n');
    git(clone, ['add', '-A']);
    git(clone, ['commit', '-q', '-m', 'move on a slashed base']);
    git(clone, ['push', '-q', 'origin', 'HEAD:release/1.0']);

    const report = baseDrift({
      root: work,
      base: 'release/1.0',
      paths: ['x.txt'],
      maxAgeMs: 0,
      tmpDir: tmpDir('bd-slash-markers-'),
    });
    expect(report.freshness).toBe('fresh');
    expect(exitCodeFor(report)).toBe(3);
    expect(report.overlap[0]?.commit?.subject).toBe('move on a slashed base');
  });

  it('accepts an explicit base spelled with the origin/ prefix', () => {
    const repo = seed();
    landOnBase(repo.bare, { 'shared.txt': 'moved\n' }, 'move it');
    const prefixed = baseDrift({
      root: repo.work,
      base: 'origin/trunk',
      paths: ['shared.txt'],
      maxAgeMs: 0,
      tmpDir: repo.markers,
    });
    expect(exitCodeFor(prefixed)).toBe(3);
  });
});

describe('a repository with no commits yet', () => {
  it('stays silent instead of throwing on an unborn HEAD', () => {
    const bare = tmpDir('bd-unborn-bare-');
    git(bare, ['init', '-q', '--bare', '-b', 'main', '.']);
    const work = tmpDir('bd-unborn-');
    git(work, ['init', '-q', '-b', 'main', '.']);
    git(work, ['remote', 'add', 'origin', bare]);
    const report = baseDrift({
      root: work,
      base: 'main',
      maxAgeMs: 0,
      tmpDir: tmpDir('bd-unborn-markers-'),
    });
    expect(renderSessionBrief(report)).toBe('');
    expect(exitCodeFor(report)).toBe(4);
  });
});

describe('a user gitconfig cannot change what is reported', () => {
  it('reports both sides of a rename even when diff.renames is enabled in config', () => {
    // Real users set diff.renames (and its `copies` variant) globally. If config could win over the
    // command line, the diff would emit three-field records, the -z pair parser would DESYNC, and
    // every path after the first rename would be garbage. This pins that --no-renames wins.
    const repo = seed();
    git(repo.work, ['config', 'diff.renames', 'copies']);
    const clone = tmpDir('bd-cfgrename-');
    git(clone, ['clone', '-q', repo.bare, '.']);
    for (const [k, v] of [
      ['user.email', 'o@e.test'],
      ['user.name', 'o'],
      ['commit.gpgsign', 'false'],
    ]) {
      git(clone, ['config', k, v]);
    }
    renameSync(join(clone, 'shared.txt'), join(clone, 'moved-away.txt'));
    git(clone, ['add', '-A']);
    git(clone, ['commit', '-q', '-m', 'rename with renames configured']);
    git(clone, ['push', '-q', 'origin', 'HEAD:trunk']);

    const moved = run(repo, []).moved;
    expect(moved.map((entry) => entry.path).sort()).toEqual(['moved-away.txt', 'shared.txt']);
    // Every record parsed cleanly: a desync would leave a status field sitting in a path slot.
    expect(
      moved.every((entry) => /^[A-Z]/.test(entry.status) && !entry.path.startsWith('\t')),
    ).toBe(true);
  });
});

describe('runBaseStatus — the wiring every surface shares', () => {
  const drifted = () => {
    const repo = seed();
    landOnBase(repo.bare, { 'shared.txt': 'moved\n' }, 'their merged change');
    return repo;
  };

  it('--json carries the rendered text the synced hooks depend on', () => {
    // The hooks cannot import render.mts, so this block IS their renderer. If it stopped being
    // emitted the hooks would go silently inert with every other test still green.
    const repo = drifted();
    const { text } = runBaseStatus(
      ['--root', repo.work, '--base', 'trunk', '--json', '--', 'shared.txt'],
      repo.work,
    );
    const payload = JSON.parse(text);
    expect(payload.schema).toBe(1);
    expect(payload.rendered.session).toContain('shared.txt');
    expect(payload.rendered.edit).toContain('shared.txt');
    expect(payload.rendered.ship).toContain('shared.txt');
    expect(payload.rendered.status).toContain('origin/trunk');
    expect(payload.overlap[0].rearm).toMatch(/^[0-9a-f]{16}$/);
  });

  it('--ship renders the ship wording and reports itself as the ship caller', () => {
    // `ship` is returned rather than re-derived from argv, so the stdout/stderr routing cannot
    // disagree with the text that was actually rendered.
    const repo = drifted();
    const result = runBaseStatus(
      ['--root', repo.work, '--base', 'trunk', '--ship', '--', 'shared.txt'],
      repo.work,
    );
    expect(result.ship).toBe(true);
    expect(result.text).toContain('devkit ship:');
    expect(result.code).toBe(3);
  });

  it('a path literally named --ship is a PATH, not the flag', () => {
    const repo = drifted();
    const result = runBaseStatus(
      ['--root', repo.work, '--base', 'trunk', '--', '--ship'],
      repo.work,
    );
    expect(result.ship).toBe(false);
    expect(result.text).toContain('origin/trunk'); // the operator status block, not the ship notice
  });

  it('--exit-zero keeps a drift verdict from failing its caller', () => {
    const repo = drifted();
    const guarded = runBaseStatus(
      ['--root', repo.work, '--base', 'trunk', '--exit-zero', '--', 'shared.txt'],
      repo.work,
    );
    expect(guarded.report.overlap).toHaveLength(1); // drift really was found
    expect(guarded.code).toBe(0);
  });

  it('answers from live refs by default — a query must not read a cached window', () => {
    const repo = seed();
    // Open a window, then move the base. A TTL-respecting caller would still say "no drift".
    runBaseStatus(['--root', repo.work, '--base', 'trunk'], repo.work);
    landOnBase(repo.bare, { 'shared.txt': 'moved after the window opened\n' }, 'late move');
    const after = runBaseStatus(
      ['--root', repo.work, '--base', 'trunk', '--', 'shared.txt'],
      repo.work,
    );
    expect(after.code).toBe(3);
  });
});

describe('the drift snapshot cache', () => {
  it('is written once and reused for a different path scope', () => {
    // The pre-edit hook runs on every Edit. The path-independent half of the answer cannot change
    // while HEAD and the base tip are unchanged, so it must not cost a diff each time.
    const repo = seed();
    landOnBase(repo.bare, { 'shared.txt': 'moved\n', 'kept.txt': 'also\n' }, 'two files');

    const first = run(repo, ['shared.txt']);
    expect(first.overlap.map((entry) => entry.path)).toEqual(['shared.txt']);
    const markerDir = join(repo.markers, 'devkit-base-drift');
    expect(readdirSync(markerDir).filter((n) => n.endsWith('.snapshot.json'))).toHaveLength(1);

    // A different scope over the same shas reuses that snapshot and still filters correctly.
    const second = run(repo, ['kept.txt']);
    expect(second.overlap.map((entry) => entry.path)).toEqual(['kept.txt']);
    expect(second.moved.map((entry) => entry.path).sort()).toEqual(
      first.moved.map((e) => e.path).sort(),
    );
    expect(readdirSync(markerDir).filter((n) => n.endsWith('.snapshot.json'))).toHaveLength(1);
  });

  it('discards a malformed cache file instead of reporting from it', () => {
    const repo = seed();
    landOnBase(repo.bare, { 'shared.txt': 'moved\n' }, 'move it');
    expect(run(repo, []).moved.map((entry) => entry.path)).toEqual(['shared.txt']);

    const markerDir = join(repo.markers, 'devkit-base-drift');
    const [snapshot] = readdirSync(markerDir).filter((name) => name.endsWith('.snapshot.json'));
    expect(snapshot).toBeDefined();
    for (const name of readdirSync(markerDir).filter((n) => n.endsWith('.snapshot.json'))) {
      writeFileSync(join(markerDir, name), JSON.stringify({ behind: 0, moved: [{}] }));
    }

    const report = run(repo, []);
    expect(report.base.kind).toBe('resolved');
    expect(report.moved.map((entry) => entry.path)).toEqual(['shared.txt']);
  });

  it('does not serve a stale answer once the base moves again', () => {
    const repo = seed();
    landOnBase(repo.bare, { 'shared.txt': 'first\n' }, 'first move');
    expect(run(repo, []).moved.map((e) => e.path)).toEqual(['shared.txt']);
    landOnBase(repo.bare, { 'other.txt': 'second\n' }, 'second move');
    // A new base tip is a new cache key, so the second file appears rather than being cached away.
    expect(
      run(repo, [])
        .moved.map((e) => e.path)
        .sort(),
    ).toEqual(['other.txt', 'shared.txt']);
  });
});
