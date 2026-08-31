import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  deleteIntent,
  ownsIntentGeneration,
  readIntent,
  relIntentPath,
  writeIntent,
} from './ship-intent.mts';
import {
  filterMembershipStream,
  membershipStreamError,
  pathStreamError,
  sourceMembershipRef,
} from './ship-intent-codec.mts';

const cliPath = fileURLToPath(new URL('./ship-intent.mts', import.meta.url));
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A repo whose .gitignore covers the manifest — the write guard's happy path. */
function seedRepo({ ignored = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ship-intent-'));
  dirs.push(dir);
  execFileSync('git', ['init', '-q', dir], { env: { ...process.env, ...GIT_ENV } });
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'git@github.com:acme/app.git'], {
    env: { ...process.env, ...GIT_ENV },
  });
  if (ignored) writeFileSync(join(dir, '.gitignore'), '.devkit/\n');
  return dir;
}

const base = (opts: Partial<Parameters<typeof writeIntent>[0]> = {}) => ({
  root: seedRepo(),
  branch: 'feat/x',
  mode: 'ship',
  title: 'ship it',
  links: [],
  noQavisPublish: false,
  updatePrBody: false,
  resumed: false,
  mergePaths: false,
  body: Buffer.from('pr body\n'),
  ...opts,
});

describe('ship-intent write/read round trip', () => {
  it('preserves the body byte-exactly: invalid UTF-8, CRLF, unicode, trailing newlines', () => {
    // 0xFF is not valid UTF-8 — a utf8 string hop would substitute U+FFFD and break the
    // landed-commit byte-identity check. The Buffer/base64 path must carry it unchanged.
    const body = Buffer.concat([
      Buffer.from('line1\r\nliné2 — ünïcode\n\n'),
      Buffer.from([0xff, 0xfe]),
      Buffer.from('tail\n\n'),
    ]);
    const opts = base({
      body,
      links: ['idx', 'graph'],
      base: 'main',
      noQavisPublish: true,
      updatePrBody: true,
    });
    expect(writeIntent(opts, ['a.txt', '--dash-leading', 'b dir/c.txt'])).toBe(0);
    const r = readIntent(opts.root, 'feat/x');
    if ('reason' in r) throw new Error(r.reason);
    expect(r.intent.version).toBe(2);
    expect(Buffer.from(r.intent.bodyB64, 'base64').equals(body)).toBe(true);
    expect(r.intent).toMatchObject({
      mode: 'ship',
      sourceMode: 'explicit',
      title: 'ship it',
      base: 'main',
      links: ['idx', 'graph'],
      noQavisPublish: true,
      updatePrBody: true,
      paths: ['a.txt', '--dash-leading', 'b dir/c.txt'],
      repo: 'acme/app',
    });
  });

  it('writes branch-source records as version 3 while explicit records use version 2', () => {
    const branchOpts = base({ sourceMode: 'branch', base: 'work' });
    expect(writeIntent(branchOpts, ['one.txt', 'two.txt'])).toBe(0);
    const stored = JSON.parse(
      readFileSync(join(branchOpts.root, relIntentPath(branchOpts.branch)), 'utf8'),
    );
    expect(stored).toMatchObject({ version: 3, sourceMode: 'branch' });
    expect(stored.sourceAttemptId).toBe(stored.generation);
    const membershipRef = sourceMembershipRef(branchOpts.branch, stored.sourceAttemptId);
    const initialMembership = execFileSync(
      'git',
      ['-C', branchOpts.root, 'rev-parse', membershipRef],
      { encoding: 'utf8' },
    ).trim();
    const branchRead = readIntent(branchOpts.root, branchOpts.branch);
    if ('reason' in branchRead) throw new Error(branchRead.reason);
    expect(branchRead.intent).toMatchObject({ version: 3, sourceMode: 'branch' });

    expect(
      writeIntent(
        {
          ...branchOpts,
          resumed: true,
          expectGeneration: stored.generation,
          sourceAttemptId: stored.sourceAttemptId,
        },
        ['one.txt', 'two.txt'],
      ),
    ).toBe(0);
    const resumed = JSON.parse(
      readFileSync(join(branchOpts.root, relIntentPath(branchOpts.branch)), 'utf8'),
    );
    expect(resumed.sourceAttemptId).toBe(stored.sourceAttemptId);
    expect(resumed.generation).not.toBe(stored.generation);
    expect(
      execFileSync('git', ['-C', branchOpts.root, 'rev-parse', membershipRef], {
        encoding: 'utf8',
      }).trim(),
    ).toBe(initialMembership);
    expect(
      writeIntent(
        {
          ...branchOpts,
          resumed: true,
          expectGeneration: resumed.generation,
          sourceAttemptId: resumed.sourceAttemptId,
        },
        ['changed.txt'],
      ),
    ).toBe(1);
    const unchanged = readIntent(branchOpts.root, branchOpts.branch);
    if ('reason' in unchanged) throw new Error(unchanged.reason);
    expect(unchanged.intent.generation).toBe(resumed.generation);

    const nextAttempt = 'pre-commit-retry-attempt';
    expect(
      writeIntent(
        {
          ...branchOpts,
          resumed: true,
          expectGeneration: resumed.generation,
          sourceAttemptId: nextAttempt,
        },
        ['one.txt', 'two.txt'],
      ),
    ).toBe(0);
    const rotated = readIntent(branchOpts.root, branchOpts.branch);
    if ('reason' in rotated) throw new Error(rotated.reason);
    expect(rotated.intent.sourceAttemptId).toBe(nextAttempt);
    expect(rotated.intent.generation).not.toBe(resumed.generation);
    expect(() =>
      execFileSync('git', ['-C', branchOpts.root, 'rev-parse', '--verify', membershipRef], {
        stdio: 'ignore',
      }),
    ).toThrow();

    const explicitOpts = base();
    expect(writeIntent(explicitOpts, ['p.txt'])).toBe(0);
    const legacy = readIntent(explicitOpts.root, explicitOpts.branch);
    if ('reason' in legacy) throw new Error(legacy.reason);
    expect(legacy.intent).toMatchObject({ version: 2, sourceMode: 'explicit' });
  });

  it('refuses merge/donation semantics for a frozen branch-source record', () => {
    const branchOpts = base({
      sourceMode: 'branch',
      base: 'work',
      mergePaths: true,
      donatePaths: ['later.txt'],
    });
    expect(writeIntent(branchOpts, ['one.txt'])).toBe(1);
    expect(existsSync(join(branchOpts.root, relIntentPath(branchOpts.branch)))).toBe(false);
  });

  it('requires a non-empty base when writing or reading a version-3 branch source', () => {
    const missingBase = base({ sourceMode: 'branch' });
    expect(writeIntent(missingBase, ['one.txt'])).toBe(1);

    const valid = base({ sourceMode: 'branch', base: 'work' });
    expect(writeIntent(valid, ['one.txt'])).toBe(0);
    const file = join(valid.root, relIntentPath(valid.branch));
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    stored.base = null;
    writeFileSync(file, JSON.stringify(stored));
    const read = readIntent(valid.root, valid.branch);
    expect('reason' in read ? read.reason : '').toContain('has no valid base');
  });

  it('requires the stable source-attempt identity when reading a version-3 branch source', () => {
    const valid = base({ sourceMode: 'branch', base: 'work' });
    expect(writeIntent(valid, ['one.txt'])).toBe(0);
    const file = join(valid.root, relIntentPath(valid.branch));
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    delete stored.sourceAttemptId;
    writeFileSync(file, JSON.stringify(stored));
    const read = readIntent(valid.root, valid.branch);
    expect('reason' in read ? read.reason : '').toContain('source attempt id');
  });

  it('refuses to mint a replacement source identity for a malformed branch resume', () => {
    const valid = base({ sourceMode: 'branch', base: 'work' });
    expect(writeIntent(valid, ['one.txt'])).toBe(0);
    const before = readIntent(valid.root, valid.branch);
    if ('reason' in before) throw new Error(before.reason);
    expect(
      writeIntent(
        {
          ...valid,
          resumed: true,
          expectGeneration: before.intent.generation,
          sourceAttemptId: '',
        },
        ['one.txt'],
      ),
    ).toBe(1);
    const after = readIntent(valid.root, valid.branch);
    if ('reason' in after) throw new Error(after.reason);
    expect(after.intent.generation).toBe(before.intent.generation);
  });

  it('rolls back a new membership ref when persisting its replacement intent fails', () => {
    const valid = base({ sourceMode: 'branch', base: 'work' });
    expect(writeIntent(valid, ['one.txt'])).toBe(0);
    const before = readIntent(valid.root, valid.branch);
    if ('reason' in before) throw new Error(before.reason);
    const file = join(valid.root, relIntentPath(valid.branch));
    mkdirSync(`${file}.${process.pid}.tmp`);
    const failedAttempt = 'failed-persist-attempt';
    expect(
      writeIntent(
        {
          ...valid,
          resumed: true,
          expectGeneration: before.intent.generation,
          sourceAttemptId: failedAttempt,
        },
        ['one.txt'],
      ),
    ).toBe(1);
    const after = readIntent(valid.root, valid.branch);
    if ('reason' in after) throw new Error(after.reason);
    expect(after.intent.generation).toBe(before.intent.generation);
    expect(() =>
      execFileSync(
        'git',
        [
          '-C',
          valid.root,
          'rev-parse',
          '--verify',
          sourceMembershipRef(valid.branch, failedAttempt),
        ],
        { stdio: 'ignore' },
      ),
    ).toThrow();
  });

  it('deleting one branch cannot prune a slash-descendant branch membership', () => {
    const first = base({ branch: 'foo', sourceMode: 'branch', base: 'work' });
    const second = { ...first, branch: 'foo/bar' };
    expect(writeIntent(first, ['one.txt'])).toBe(0);
    expect(writeIntent(second, ['two.txt'])).toBe(0);
    const firstRead = readIntent(first.root, first.branch);
    const secondRead = readIntent(second.root, second.branch);
    if ('reason' in firstRead) throw new Error(firstRead.reason);
    if ('reason' in secondRead) throw new Error(secondRead.reason);
    expect(deleteIntent(first.root, first.branch, firstRead.intent.generation)).toBe(0);
    const survivor = readIntent(second.root, second.branch);
    if ('reason' in survivor) throw new Error(survivor.reason);
    expect(survivor.intent.generation).toBe(secondRead.intent.generation);
  });

  it('refuses a branch-source path list that no longer matches its private Git binding', () => {
    const valid = base({ sourceMode: 'branch', base: 'work' });
    expect(writeIntent(valid, ['one.txt'])).toBe(0);
    const file = join(valid.root, relIntentPath(valid.branch));
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    stored.paths.push('widened.txt');
    writeFileSync(file, JSON.stringify(stored));
    const read = readIntent(valid.root, valid.branch);
    expect('reason' in read ? read.reason : '').toContain(
      'frozen membership failed its Git binding',
    );
  });

  it('rejects invalid UTF-8 in a raw Git pathname stream before argv/JSON transport', () => {
    expect(pathStreamError(Buffer.from([0x66, 0x6f, 0x6f, 0]))).toBeNull();
    expect(pathStreamError(Buffer.from([0xff, 0]))).toContain('non-UTF-8');
    expect(pathStreamError(Buffer.from('not NUL terminated'))).toContain('NUL-terminated');
  });

  it('drains a validated NUL path stream larger than Node stdout buffering', () => {
    const raw = Buffer.from(
      Array.from({ length: 20_000 }, (_, i) => `p${String(i).padStart(6, '0')}\0`).join(''),
    );
    const out = execFileSync('node', [cliPath, 'validate-paths'], {
      input: raw,
      maxBuffer: raw.length * 2,
    });
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out.equals(raw)).toBe(true);
  });

  it('refuses Git selections that recurse beyond frozen concrete membership', () => {
    const nul = (...paths: string[]) => Buffer.from(`${paths.join('\0')}\0`);
    expect(membershipStreamError(nul('shape', 'shape/child.txt'), nul('shape'))).toContain(
      'unrecorded path "shape/child.txt"',
    );
    expect(
      membershipStreamError(nul('shape', 'shape/child.txt'), nul('shape', 'shape/child.txt')),
    ).toBeNull();
    const filtered = filterMembershipStream(
      nul('shape', 'shape/child.txt', 'shape/unrelated.txt'),
      nul('shape', 'shape/child.txt'),
    );
    if ('reason' in filtered) throw new Error(filtered.reason);
    expect(filtered.raw.equals(nul('shape', 'shape/child.txt'))).toBe(true);
    const invalidUnrelated = Buffer.concat([Buffer.from('shape\0shape/'), Buffer.from([0xff, 0])]);
    const rawFiltered = filterMembershipStream(invalidUnrelated, nul('shape'));
    if ('reason' in rawFiltered) throw new Error(rawFiltered.reason);
    expect(rawFiltered.raw.equals(nul('shape'))).toBe(true);
  });

  it('a branch with long slash-separated components still gets a writable filename', () => {
    const branch = `${'a'.repeat(200)}/${'b'.repeat(100)}`;
    const rel = relIntentPath(branch);
    expect(rel.split('/').pop()!.length).toBeLessThan(255); // one filesystem component
    const opts = base({ branch });
    expect(writeIntent(opts, ['p.txt'])).toBe(0);
    const r = readIntent(opts.root, branch);
    if ('reason' in r) throw new Error(r.reason);
    expect(r.intent.branch).toBe(branch); // the RAW branch survives truncation via the record
  });

  it('an empty body and an absent base round-trip as empty/null', () => {
    const opts = base({ body: Buffer.alloc(0) });
    expect(writeIntent(opts, ['p.txt'])).toBe(0);
    const r = readIntent(opts.root, 'feat/x');
    if ('reason' in r) throw new Error(r.reason);
    expect(r.intent.bodyB64).toBe('');
    expect(r.intent.base).toBeNull();
    expect(r.intent.updatePrBody).toBe(false);
  });

  it('writes mode 600 and overwrites in place (the newer record wins)', () => {
    const opts = base();
    writeIntent(opts, ['p.txt']);
    const file = join(opts.root, relIntentPath('feat/x'));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    writeIntent({ ...opts, title: 'second attempt' }, ['p.txt', 'q.txt']);
    const r = readIntent(opts.root, 'feat/x');
    if ('reason' in r) throw new Error(r.reason);
    expect(r.intent.title).toBe('second attempt');
    expect(r.intent.paths).toEqual(['p.txt', 'q.txt']);
  });

  it('skips the write (exit 0, nothing on disk) when git does not ignore the manifest path', () => {
    const opts = base({ root: seedRepo({ ignored: false }) });
    expect(writeIntent(opts, ['p.txt'])).toBe(0);
    expect(existsSync(join(opts.root, relIntentPath('feat/x')))).toBe(false);
  });
});

describe('ship-intent read refusals — each names its cause', () => {
  const reasonOf = (root: string, branch: string, nowMs?: number) => {
    const r = readIntent(root, branch, nowMs);
    return 'reason' in r ? r.reason : '';
  };

  it('absent record', () => {
    expect(reasonOf(seedRepo(), 'feat/none')).toContain('no recorded ship invocation');
  });

  it('unknown version', () => {
    const opts = base();
    writeIntent(opts, ['p.txt']);
    const file = join(opts.root, relIntentPath('feat/x'));
    const j = JSON.parse(readFileSync(file, 'utf8'));
    j.version = 99;
    writeFileSync(file, JSON.stringify(j));
    expect(reasonOf(opts.root, 'feat/x')).toContain('unknown version 99');
  });

  it('sanitized-name twins get distinct files, and a copied record still refuses on the raw branch', () => {
    const opts = base({ branch: 'a/b' });
    writeIntent(opts, ['p.txt']);
    // The hash suffix keeps a/b and a-b apart on disk — neither can overwrite the other.
    expect(relIntentPath('a/b')).not.toBe(relIntentPath('a-b'));
    expect(reasonOf(opts.root, 'a-b')).toContain('no recorded ship invocation');
    // Defense in depth: a record COPIED onto the other twin's filename refuses on the raw branch.
    writeFileSync(
      join(opts.root, relIntentPath('a-b')),
      readFileSync(join(opts.root, relIntentPath('a/b'))),
    );
    expect(reasonOf(opts.root, 'a-b')).toContain("for branch 'a/b', not 'a-b'");
  });

  it('corrupt base64 body refuses instead of silently replaying a wrong body', () => {
    const opts = base();
    writeIntent(opts, ['p.txt']);
    const file = join(opts.root, relIntentPath('feat/x'));
    const j = JSON.parse(readFileSync(file, 'utf8'));
    j.bodyB64 = '*'; // Buffer.from tolerates it and decodes to EMPTY — the wrong body, silently
    writeFileSync(file, JSON.stringify(j));
    expect(reasonOf(opts.root, 'feat/x')).toContain('body is corrupt');
  });

  it('a rollover calendar date refuses: Date.parse would silently normalize it', () => {
    const opts = base();
    writeIntent(opts, ['p.txt']);
    const file = join(opts.root, relIntentPath('feat/x'));
    const j = JSON.parse(readFileSync(file, 'utf8'));
    j.createdAt = '2026-02-30T00:00:00.000Z'; // parses as March 2 — an impossible stamp must refuse
    writeFileSync(file, JSON.stringify(j));
    expect(reasonOf(opts.root, 'feat/x')).toContain('stale or misdated');
  });

  it('a record without a valid generation refuses — no ownership token means no cleanup', () => {
    const opts = base();
    writeIntent(opts, ['p.txt']);
    const file = join(opts.root, relIntentPath('feat/x'));
    const j = JSON.parse(readFileSync(file, 'utf8'));
    delete j.generation;
    writeFileSync(file, JSON.stringify(j));
    expect(reasonOf(opts.root, 'feat/x')).toContain('generation');
  });

  it('a non-boolean noQavisPublish refuses instead of coercing a publish preference to false', () => {
    const opts = base({ noQavisPublish: true });
    writeIntent(opts, ['p.txt']);
    const file = join(opts.root, relIntentPath('feat/x'));
    const j = JSON.parse(readFileSync(file, 'utf8'));
    j.noQavisPublish = 'true'; // the coercion trap: `=== true` would read this as FALSE and publish
    writeFileSync(file, JSON.stringify(j));
    expect(reasonOf(opts.root, 'feat/x')).toContain('noQavisPublish');
  });

  it('a delete that cannot take the lock keeps the record AND reports failure', () => {
    const opts = base();
    writeIntent(opts, ['p.txt']);
    const file = join(opts.root, relIntentPath('feat/x'));
    const generation = JSON.parse(readFileSync(file, 'utf8')).generation;
    // A fresh lock dir is a live holder to the reaper (mtime-gated) — the delete must time out.
    mkdirSync(`${file}.lock`);
    try {
      expect(deleteIntent(opts.root, 'feat/x', generation)).toBe(1);
      expect(existsSync(file)).toBe(true);
    } finally {
      rmSync(`${file}.lock`, { recursive: true, force: true });
    }
  }, 20_000);

  it("compare-and-delete: a mismatched generation keeps a concurrent attempt's newer record", () => {
    const opts = base();
    writeIntent(opts, ['p.txt']);
    const file = join(opts.root, relIntentPath('feat/x'));
    const generation = JSON.parse(readFileSync(file, 'utf8')).generation;
    deleteIntent(opts.root, 'feat/x', 'someone-elses-token'); // a foreign claim must not delete
    expect(existsSync(file)).toBe(true);
    deleteIntent(opts.root, 'feat/x', generation); // the owning generation does
    expect(existsSync(file)).toBe(false);
  });

  it('a success keeps the record when it carries a donated path the push did not ship', () => {
    const opts = base();
    writeIntent(opts, ['p.txt']);
    const file = join(opts.root, relIntentPath('feat/x'));
    const generation = JSON.parse(readFileSync(file, 'utf8')).generation;
    // A losing resume donated remedy.txt into this record; the owner's push shipped only p.txt —
    // deleting would destroy the only resumable copy of the unshipped remedy.
    writeIntent(
      { ...opts, mergePaths: true, expectGeneration: 'lost-the-race', donatePaths: ['remedy.txt'] },
      ['p.txt', 'remedy.txt'],
    );
    expect(deleteIntent(opts.root, 'feat/x', generation, ['p.txt'])).toBe(2); // kept, not released
    expect(existsSync(file)).toBe(true);
    // With the full shipped set, the same delete releases it.
    expect(deleteIntent(opts.root, 'feat/x', generation, ['p.txt', 'remedy.txt'])).toBe(0);
    expect(existsSync(file)).toBe(false);
  });

  it('two same-instant attempts still get distinct ownership tokens', () => {
    const opts = base();
    writeIntent(opts, ['p.txt']);
    const file = join(opts.root, relIntentPath('feat/x'));
    const first = JSON.parse(readFileSync(file, 'utf8')).generation;
    writeIntent(opts, ['p.txt']);
    const second = JSON.parse(readFileSync(file, 'utf8')).generation;
    expect(first).not.toBe(second); // random, never the (millisecond-shared) timestamp
  });

  it('mergePaths unions with the on-disk record instead of last-write-wins', () => {
    const opts = base();
    writeIntent(opts, ['note.txt', 'a.txt']); // a concurrent resume already added a.txt
    writeIntent({ ...opts, mergePaths: true }, ['note.txt', 'b.txt']);
    const r = readIntent(opts.root, 'feat/x');
    if ('reason' in r) throw new Error(r.reason);
    expect(r.intent.paths.sort()).toEqual(['a.txt', 'b.txt', 'note.txt']);
  });

  it('a losing resume donates ONLY its explicitly briefed paths, never its stale recorded list', () => {
    const opts = base();
    writeIntent(opts, ['note.txt']);
    const file = join(opts.root, relIntentPath('feat/x'));
    const owner = JSON.parse(readFileSync(file, 'utf8'));
    // The loser's read predates the owner's re-record: its full list carries stale.txt, which the
    // newer invocation deliberately dropped — only the briefed remedy may reach the owner's scope.
    writeIntent(
      {
        ...opts,
        mergePaths: true,
        expectGeneration: 'a-generation-that-lost',
        donatePaths: ['remedy.txt'],
      },
      ['note.txt', 'stale.txt', 'remedy.txt'],
    );
    const after = JSON.parse(readFileSync(file, 'utf8'));
    expect(after.generation).toBe(owner.generation); // ownership unchanged
    expect(after.title).toBe(owner.title);
    expect(after.paths).toEqual(['note.txt', 'remedy.txt']); // remedy survived; stale.txt did not
  });

  it('expectGeneration against a DELETED record recreates nothing — spent stays spent', () => {
    const opts = base();
    writeIntent(opts, ['p.txt']);
    const file = join(opts.root, relIntentPath('feat/x'));
    const generation = JSON.parse(readFileSync(file, 'utf8')).generation;
    deleteIntent(opts.root, 'feat/x', generation);
    writeIntent({ ...opts, mergePaths: true, expectGeneration: generation }, ['p.txt']);
    expect(existsSync(file)).toBe(false);
  });

  it('expectGeneration CAS: a resume based on a superseded read cannot regress newer metadata', () => {
    const opts = base({ title: 'old title' });
    writeIntent(opts, ['p.txt']);
    const file = join(opts.root, relIntentPath('feat/x'));
    const readGeneration = JSON.parse(readFileSync(file, 'utf8')).generation; // what the resume read
    writeIntent({ ...opts, title: 'newer full invocation' }, ['p.txt', 'q.txt']); // concurrent B
    writeIntent(
      { ...opts, title: 'old title', mergePaths: true, expectGeneration: readGeneration },
      ['p.txt'],
    );
    const r = readIntent(opts.root, 'feat/x');
    if ('reason' in r) throw new Error(r.reason);
    expect(r.intent.title).toBe('newer full invocation'); // B's record survived the stale resume
    expect(r.intent.paths).toEqual(['p.txt', 'q.txt']);
  });

  it('repo mismatch (a manifest copied across checkouts)', () => {
    const opts = base();
    writeIntent(opts, ['p.txt']);
    execFileSync(
      'git',
      ['-C', opts.root, 'remote', 'set-url', 'origin', 'git@github.com:other/repo.git'],
      { env: { ...process.env, ...GIT_ENV } },
    );
    expect(reasonOf(opts.root, 'feat/x')).toContain("for repo 'acme/app'");
  });

  it('stale record (older than the abandonment bound)', () => {
    const opts = base();
    writeIntent(opts, ['p.txt']);
    const sevenHours = 7 * 60 * 60 * 1000;
    expect(reasonOf(opts.root, 'feat/x', Date.now() + sevenHours)).toContain('stale');
  });

  it('a FUTURE createdAt cannot buy immortality past the staleness bound', () => {
    const opts = base();
    writeIntent(opts, ['p.txt']);
    const file = join(opts.root, relIntentPath('feat/x'));
    const j = JSON.parse(readFileSync(file, 'utf8'));
    j.createdAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(file, JSON.stringify(j));
    expect(reasonOf(opts.root, 'feat/x')).toContain('stale or misdated');
  });

  it('a NUL anywhere refuses — the read protocol splits fields on NUL', () => {
    const opts = base();
    writeIntent(opts, ['p.txt']);
    const file = join(opts.root, relIntentPath('feat/x'));
    const j = JSON.parse(readFileSync(file, 'utf8'));
    j.bodyB64 = Buffer.from('body\0/etc/injected').toString('base64');
    writeFileSync(file, JSON.stringify(j));
    expect(reasonOf(opts.root, 'feat/x')).toContain('body is corrupt');
    j.bodyB64 = Buffer.from('clean').toString('base64');
    j.paths = ['ok.txt', 'evil\0.txt'];
    writeFileSync(file, JSON.stringify(j));
    expect(reasonOf(opts.root, 'feat/x')).toContain('incomplete');
  });

  it('a present-but-invalid base refuses instead of silently replaying the default target', () => {
    const opts = base();
    writeIntent(opts, ['p.txt']);
    const file = join(opts.root, relIntentPath('feat/x'));
    const j = JSON.parse(readFileSync(file, 'utf8'));
    j.base = 42;
    writeFileSync(file, JSON.stringify(j));
    expect(reasonOf(opts.root, 'feat/x')).toContain('malformed (base)');
  });

  it('present-but-invalid links refuse instead of silently dropping gate dependencies', () => {
    const opts = base();
    writeIntent(opts, ['p.txt']);
    const file = join(opts.root, relIntentPath('feat/x'));
    const j = JSON.parse(readFileSync(file, 'utf8'));
    j.links = 42;
    writeFileSync(file, JSON.stringify(j));
    expect(reasonOf(opts.root, 'feat/x')).toContain('malformed (links)');
  });

  it('reads legacy v1 as preserve-only and requires a valid updatePrBody in v2', () => {
    const opts = base({ updatePrBody: true });
    writeIntent(opts, ['p.txt']);
    const file = join(opts.root, relIntentPath('feat/x'));
    const j = JSON.parse(readFileSync(file, 'utf8'));
    j.version = 1;
    delete j.updatePrBody;
    writeFileSync(file, JSON.stringify(j));
    const legacy = readIntent(opts.root, 'feat/x');
    if ('reason' in legacy) throw new Error(legacy.reason);
    expect(legacy.intent.updatePrBody).toBe(false);

    j.version = 2;
    writeFileSync(file, JSON.stringify(j));
    expect(reasonOf(opts.root, 'feat/x')).toContain('malformed (updatePrBody)');

    j.updatePrBody = 'true';
    writeFileSync(file, JSON.stringify(j));
    expect(reasonOf(opts.root, 'feat/x')).toContain('malformed (updatePrBody)');
  });

  it('proves only the generation that still owns the on-disk intent', () => {
    const opts = base();
    writeIntent(opts, ['p.txt']);
    const r = readIntent(opts.root, 'feat/x');
    if ('reason' in r) throw new Error(r.reason);
    expect(ownsIntentGeneration(opts.root, 'feat/x', r.intent.generation)).toBe(true);
    expect(ownsIntentGeneration(opts.root, 'feat/x', 'superseded')).toBe(false);
    deleteIntent(opts.root, 'feat/x', r.intent.generation);
    expect(ownsIntentGeneration(opts.root, 'feat/x', r.intent.generation)).toBe(false);
  });

  it('torn/unparseable record', () => {
    const opts = base();
    writeIntent(opts, ['p.txt']);
    writeFileSync(join(opts.root, relIntentPath('feat/x')), '{"version":1,');
    expect(reasonOf(opts.root, 'feat/x')).toContain('unreadable');
  });
});

describe('ship-intent CLI protocol', () => {
  it('read emits NUL-delimited fields in the documented order; delete is idempotent', () => {
    const root = seedRepo();
    execFileSync(
      'node',
      [
        cliPath,
        'write',
        '--root',
        root,
        '--branch',
        'feat/x',
        '--mode',
        'ship',
        '--title',
        't',
        '--base',
        'main',
        '--link',
        'idx',
        '--update-pr-body',
        '--',
        'p.txt',
        'q dir/r.txt',
      ],
      {
        input: 'body line\n',
        env: { ...process.env, DEVKIT_NO_TELEMETRY: '1' },
      },
    );
    const out = execFileSync('node', [cliPath, 'read', '--root', root, '--branch', 'feat/x']);
    const fields = out.toString('utf8').split('\0');
    expect(fields.pop()).toBe(''); // every field NUL-terminated, so the split leaves one empty tail
    // mode, sourceMode, title, base, noQavisPublish, updatePrBody, createdAt, generation,
    // sourceAttemptId, nlinks, <links>, body, <paths...>
    expect(fields[0]).toBe('ship');
    expect(fields[1]).toBe('explicit');
    expect(fields[2]).toBe('t');
    expect(fields[3]).toBe('main');
    expect(fields[4]).toBe('0');
    expect(fields[5]).toBe('1');
    expect(Number.isFinite(Date.parse(fields[6]))).toBe(true);
    expect(fields[7]).toMatch(/^[0-9a-f-]{36}$/);
    expect(fields[8]).toBe('');
    expect(fields[9]).toBe('1');
    expect(fields[10]).toBe('idx');
    expect(fields[11]).toBe('body line\n');
    expect(fields.slice(12)).toEqual(['p.txt', 'q dir/r.txt']);

    execFileSync('node', [cliPath, 'delete', '--root', root, '--branch', 'feat/x']);
    expect(existsSync(join(root, relIntentPath('feat/x')))).toBe(false);
    execFileSync('node', [cliPath, 'delete', '--root', root, '--branch', 'feat/x']); // idempotent
  });

  it('write emits a ship_intent event carrying command, pr_body and the resumed flag', () => {
    const root = seedRepo();
    const sink = join(root, 'events.jsonl');
    execFileSync(
      'node',
      [
        cliPath,
        'write',
        '--root',
        root,
        '--branch',
        'feat/x',
        '--mode',
        'ship',
        '--title',
        'ship "it"',
        '--resumed',
        '--',
        'p.txt',
      ],
      {
        input: 'the body\n',
        env: {
          ...process.env,
          DEVKIT_GATE_EVENTS: sink,
          DEVKIT_SHIP_ID: 'test-ship-1',
          DEVKIT_SHIP_REPO: 'app',
          DEVKIT_SHIP_BRANCH: 'feat/x',
        },
      },
    );
    const ev = JSON.parse(readFileSync(sink, 'utf8').trim());
    expect(ev).toMatchObject({
      type: 'ship_intent',
      mode: 'ship',
      source_mode: 'explicit',
      ship_id: 'test-ship-1',
      resumed: true,
      body_bytes: 9,
      path_count: 1,
      pr_body: 'the body\n',
    });
    expect(ev.command).toBe('devkit ship feat/x \'ship "it"\' -- p.txt'); // shell-quoted, replayable
    expect(ev.devkit_version).toBeTruthy(); // enveloped — the first source-stamped event of a ship
  });

  it('renders branch-source telemetry without reinterpreting derived paths as explicit input', () => {
    const root = seedRepo();
    const sink = join(root, 'events.jsonl');
    const run = (resumed: boolean, sourceAttemptId?: string) =>
      execFileSync(
        'node',
        [
          cliPath,
          'write',
          '--root',
          root,
          '--branch',
          'feat/x',
          '--mode',
          'ship',
          '--source-mode',
          'branch',
          '--title',
          'ship it',
          '--base',
          'work',
          ...(resumed ? ['--resumed', '--source-attempt-id', sourceAttemptId!] : []),
          '--',
          'derived.txt',
        ],
        { input: '', env: { ...process.env, DEVKIT_GATE_EVENTS: sink } },
      );
    const sourceAttemptId = run(false).toString().trim();
    run(true, sourceAttemptId);
    const events = readFileSync(sink, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events[0]).toMatchObject({ source_mode: 'branch', path_count: 1, resumed: false });
    expect(events[0].command).toBe("devkit ship feat/x 'ship it' --base work --from-branch");
    expect(events[0].command).not.toContain('derived.txt');
    expect(events[1].command).toBe('devkit ship --resume feat/x');
  });

  it('the event redacts credential shapes from pr_body/command; body_bytes stays the raw length', () => {
    const root = seedRepo();
    const sink = join(root, 'events.jsonl');
    const body = `deploy notes\ntoken = ghp_${'a'.repeat(36)}\ndone\n`;
    execFileSync(
      'node',
      [
        cliPath,
        'write',
        '--root',
        root,
        '--branch',
        'feat/x',
        '--mode',
        'ship',
        '--title',
        't',
        '--',
        'p.txt',
      ],
      {
        input: body,
        env: { ...process.env, DEVKIT_GATE_EVENTS: sink, DEVKIT_SHIP_ID: 'test-ship-2' },
      },
    );
    const ev = JSON.parse(readFileSync(sink, 'utf8').trim());
    expect(ev.pr_body).not.toContain('ghp_');
    expect(ev.pr_body).toContain('[REDACTED]');
    expect(ev.body_bytes).toBe(body.length); // RAW length — redaction never changes the measure
  });

  it('redacts underscore-qualified assignments and STS key IDs, not just the bare words', () => {
    const root = seedRepo();
    const sink = join(root, 'events.jsonl');
    // \b(secret)\b never fires inside AWS_SECRET_ACCESS_KEY (underscores are word chars), and
    // temporary STS credentials carry the ASIA prefix, not AKIA — both must still redact.
    const body = `AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG\nkey ASIAIOSFODNN7EXAMPLE here\npay sk_live_a1B2c3D4e5F6g7H8 now\npublish npm_${'t'.repeat(36)} ok\nPASSWORD="correct horse battery staple"\nclone https://user:hunter2@example.com/r.git\n`;
    execFileSync(
      'node',
      [
        cliPath,
        'write',
        '--root',
        root,
        '--branch',
        'feat/x',
        '--mode',
        'ship',
        '--title',
        't',
        '--',
        'p.txt',
      ],
      {
        input: body,
        env: { ...process.env, DEVKIT_GATE_EVENTS: sink, DEVKIT_SHIP_ID: 'test-ship-3' },
      },
    );
    const ev = JSON.parse(readFileSync(sink, 'utf8').trim());
    expect(ev.pr_body).not.toContain('wJalrXUtnFEMI');
    expect(ev.pr_body).not.toContain('ASIAIOSFODNN7EXAMPLE');
    expect(ev.pr_body).not.toContain('sk_live_');
    expect(ev.pr_body).not.toContain('npm_');
    expect(ev.pr_body).not.toContain('battery'); // quoted multi-word value redacts wholesale
    expect(ev.pr_body).not.toContain('hunter2'); // URL userinfo credentials
    expect(ev.pr_body).toContain('https://[REDACTED]@example.com/r.git');
    expect(ev.pr_body).toContain('AWS_SECRET_ACCESS_KEY=[REDACTED]');
  });
});
