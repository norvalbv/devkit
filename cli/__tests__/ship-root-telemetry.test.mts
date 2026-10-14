import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { testSpawnSync as spawnSync } from './_helpers.mts';

const TELEMETRY_SH = resolve(import.meta.dirname, '../lib/ship/telemetry.sh');

/** The fragment the helper prints for `root`, spliced the way the ship rows splice it. */
function rowFor(root: string, locale: string): string {
  const r = spawnSync(
    '/bin/bash',
    [
      '-c',
      `. "${TELEMETRY_SH}"; printf '{"type":"ship_attempt"%s}' "$(devkit_ship_root_json "$1")"`,
      '_',
      root,
    ],
    { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: locale }, encoding: 'utf8' },
  );
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}

describe.each(['C', 'en_US.UTF-8'])('devkit_ship_root_json under LC_ALL=%s', (locale) => {
  it.each([
    '/Users/dev/.frink/worktrees/app/striped-hollow',
    '/tmp/with space/and "quote"',
    '/tmp/back\\slash',
    '/tmp/ünïcode — À',
    '/tmp/50%s done/%d/*[x]', // printf directives and glob characters stay data, never format
    `/${'é'.repeat(199)}`, // 399 bytes: just inside the cap
    `/${'a'.repeat(399)}`, // exactly 400 bytes: the cap is inclusive
    '"'.repeat(200), // exactly 400 bytes once escaped
  ])('round-trips %j', (root) => {
    expect(JSON.parse(rowFor(root, locale))).toEqual({ type: 'ship_attempt', root });
  });

  // Each of these would either tear the JSONL row or push it past the single-write append size.
  it.each([
    ['empty', ''],
    ['tab', '/tmp/a\tb'],
    ['newline', '/tmp/a\nb'],
    ['trailing newline', '/tmp/a\n'],
    ['over the byte cap', `/${'a'.repeat(400)}`],
    ['over the byte cap in multi-byte characters', `/${'é'.repeat(200)}`],
    ['over the cap only once escaped', '"'.repeat(201)],
  ])('omits the key for a root that is %s', (_label, root) => {
    expect(JSON.parse(rowFor(root, locale))).toEqual({ type: 'ship_attempt' });
  });
});
