/**
 * collectCorpusUrls fails CLOSED. makeHardDrop treats the returned set as the authoritative record
 * of what has already been promoted ('a landed source.url must never be re-queued'), and a set that
 * is silently short is indistinguishable from a complete one — the re-offered candidate looks like
 * a genuine new find. So every way of not-knowing must throw; only a corpus that does not exist yet
 * is a legitimate empty.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectCorpusUrls } from '../mine-common.mts';

const roots: string[] = [];
const mkTmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'devkit-corpus-'));
  roots.push(d);
  return d;
};

const row = (url: string) => `${JSON.stringify({ id: 'x', source: { url } })}\n`;

afterEach(() => {
  for (const d of roots.splice(0)) {
    try {
      chmodSync(d, 0o755);
    } catch {
      /* already readable */
    }
    rmSync(d, { recursive: true, force: true });
  }
});

/** chmod is a no-op for root; skip the permission cases rather than assert a false pass. */
const canDenyReads = () => {
  const probe = mkTmp();
  const f = join(probe, 'cases-probe.jsonl');
  writeFileSync(f, row('u'));
  chmodSync(f, 0o000);
  try {
    collectCorpusUrls(probe);
    return false; // still readable → running privileged
  } catch {
    return true;
  }
};

describe('collectCorpusUrls', () => {
  it('collects source.url from every cases-*.jsonl and ignores other files', () => {
    const dir = mkTmp();
    writeFileSync(join(dir, 'cases-api-security.jsonl'), row('https://a/1') + row('https://a/2'));
    writeFileSync(join(dir, 'cases-correctness.jsonl'), row('https://c/1'));
    writeFileSync(join(dir, 'candidates.jsonl'), row('https://not-promoted/1'));
    writeFileSync(join(dir, 'notes.md'), 'not a corpus file');

    expect([...collectCorpusUrls(dir)].sort()).toEqual([
      'https://a/1',
      'https://a/2',
      'https://c/1',
    ]);
  });

  it('returns an empty set when the corpus dir does not exist (ENOENT is a real empty)', () => {
    expect(collectCorpusUrls(join(mkTmp(), 'nope')).size).toBe(0);
  });

  it('tolerates blank lines and rows carrying no source.url', () => {
    const dir = mkTmp();
    writeFileSync(
      join(dir, 'cases-x.jsonl'),
      `${row('https://a/1')}\n${JSON.stringify({ id: 'no-source' })}\n`,
    );
    expect([...collectCorpusUrls(dir)]).toEqual(['https://a/1']);
  });

  it('THROWS on a malformed corpus row rather than under-counting it', () => {
    const dir = mkTmp();
    writeFileSync(join(dir, 'cases-x.jsonl'), `${row('https://a/1')}{not json\n`);
    expect(() => collectCorpusUrls(dir)).toThrow(/malformed JSON in promoted corpus .*line 2/);
  });

  it.skipIf(!canDenyReads())(
    'THROWS when a corpus file cannot be read (EACCES, not ENOENT)',
    () => {
      const dir = mkTmp();
      const f = join(dir, 'cases-x.jsonl');
      writeFileSync(f, row('https://a/1'));
      chmodSync(f, 0o000);
      expect(() => collectCorpusUrls(dir)).toThrow(/cannot read promoted corpus/);
    },
  );

  it.skipIf(!canDenyReads())(
    'THROWS when the corpus dir cannot be listed (EACCES, not ENOENT)',
    () => {
      const parent = mkTmp();
      const dir = join(parent, 'reviewers');
      mkdirSync(dir);
      writeFileSync(join(dir, 'cases-x.jsonl'), row('https://a/1'));
      chmodSync(dir, 0o000);
      try {
        expect(() => collectCorpusUrls(dir)).toThrow(/cannot list corpus dir/);
      } finally {
        chmodSync(dir, 0o755); // an unreadable nested dir would defeat the afterEach rmSync
      }
    },
  );
});
