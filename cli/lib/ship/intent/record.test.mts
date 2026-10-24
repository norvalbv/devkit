import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { base, GIT_ENV, seedRepo } from '../../../__tests__/_ship-intent-fixture.mts';
import { writeIntent } from '../ship-intent.mts';
import { readIntent, relIntentPath } from './record.mts';

describe('readIntent refusals — each names its cause', () => {
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

  it('a record carrying a field this version no longer writes still reads', () => {
    const opts = base();
    writeIntent(opts, ['p.txt']);
    const file = join(opts.root, relIntentPath('feat/x'));
    const j = JSON.parse(readFileSync(file, 'utf8'));
    j.retiredFlag = true;
    writeFileSync(file, JSON.stringify(j));
    expect('intent' in readIntent(opts.root, 'feat/x')).toBe(true);
  });

  // `draft` and `noStack` post-date all three schema versions, so older records lack the keys. Absent
  // reads as false, NOT malformed: refusing would strand a blocked ship's --resume.
  it.each([['draft'], ['noStack']] as const)(
    'a record predating the %s key still reads it as false',
    (key) => {
      const opts = base();
      writeIntent(opts, ['p.txt']);
      const file = join(opts.root, relIntentPath('feat/x'));
      const j = JSON.parse(readFileSync(file, 'utf8'));
      writeFileSync(
        file,
        JSON.stringify(j, (k, v) => (k === key ? undefined : v)),
      );
      const result = readIntent(opts.root, 'feat/x');
      expect(
        'intent' in result,
        `legacy record must still resume, got: ${reasonOf(opts.root, 'feat/x')}`,
      ).toBe(true);
      expect(result.intent[key]).toBe(false);
    },
  );

  // A PRESENT value is still strict-checked: `=== true` would silently read 'true' as false.
  it.each([['true'], [null], [0], [1]])(
    'a non-boolean draft (%p) refuses instead of coercing to false',
    (tampered) => {
      const opts = base({ draft: true });
      writeIntent(opts, ['p.txt']);
      const file = join(opts.root, relIntentPath('feat/x'));
      const j = JSON.parse(readFileSync(file, 'utf8'));
      j.draft = tampered;
      writeFileSync(file, JSON.stringify(j));
      expect(reasonOf(opts.root, 'feat/x')).toContain('draft');
    },
  );

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

  it('torn/unparseable record', () => {
    const opts = base();
    writeIntent(opts, ['p.txt']);
    writeFileSync(join(opts.root, relIntentPath('feat/x')), '{"version":1,');
    expect(reasonOf(opts.root, 'feat/x')).toContain('unreadable');
  });
});
