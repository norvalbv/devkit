import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { meta, POSITIONAL_REJECTED_FLAGS, RESUME_REFUSED_VALUE_FLAGS } from '../commands/ship.mts';
import { SLOT_ENV, SLOT_RELEASE_ENV } from '../lib/ship/queue/enter.mts';

// sc-2485: ship meta and three bash parsers each list the value flags; a flag missing from one
// brings back help-hijacking or misrouting of its value, so the copies are locked together.
const SHIP_DIR = join(import.meta.dirname, '..', 'lib', 'ship');
const read = (name: string) => readFileSync(join(SHIP_DIR, name), 'utf8');

/** Every `--flag)` case arm whose body (up to its `;;`) consumes a value with `shift 2`. */
function shiftTwoFlags(script: string, alsoMatching?: RegExp): string[] {
  const lines = script.split('\n');
  const flags = new Set<string>();
  lines.forEach((line, i) => {
    const arm = /^\s*(--[a-z-]+)\)/.exec(line);
    if (!arm) return;
    const end = lines.findIndex((l, j) => j >= i && l.includes(';;'));
    const body = lines.slice(i, end === -1 ? i + 1 : end + 1).join('\n');
    if (/shift 2/.test(body) && (!alsoMatching || alsoMatching.test(body))) flags.add(arm[1]);
  });
  return [...flags].sort();
}

describe('ship value-flag parity (sc-2485)', () => {
  const declared = [...meta.valueFlags].sort();

  it.each(['ship-branch.sh', 'reship.sh'])('%s consumes exactly meta.valueFlags', (script) => {
    expect(shiftTwoFlags(read(script))).toEqual(declared);
  });

  it.each(['ship-branch.sh', 'reship.sh'])(
    '%s refuses exactly the resume-refused value flags',
    (s) => {
      const refused = shiftTwoFlags(read(s), /RESUME" -eq 0 \] \|\|/);
      expect(refused).toEqual([...RESUME_REFUSED_VALUE_FLAGS].sort());
    },
  );

  it('POSITIONAL_REJECTED_FLAGS is exactly assert-positional-args.sh, and covers every value flag', () => {
    const known = /--base\|[^)]*\)/.exec(read('assert-positional-args.sh'))?.[0] ?? '';
    const listed = known.split(/[|)]/).filter(Boolean).sort();
    expect([...POSITIONAL_REJECTED_FLAGS].sort()).toEqual(listed);
    for (const flag of declared) expect(listed).toContain(flag);
  });
});

// The parser half, run on reship.sh directly so no machine-wide ship slot is taken.
describe("reship.sh keeps a value flag's value opaque", () => {
  const env = { ...process.env, SHIP_RESOLVE_ONLY: '1' };
  delete env[SLOT_ENV];
  delete env[SLOT_RELEASE_ENV];

  it.each([
    ['--body', '--draft'],
    ['--body', '--from-branch'],
    ['--body', '--help'],
    ['--body', '--'],
    ['--body-file', '-h'],
  ])('resolves the branch when %s is given %s', (flag, value) => {
    const args = ['--pr', 'feat/x', 't', flag, value, '--', 'note.txt'];
    const r = spawnSync('/bin/bash', [join(SHIP_DIR, 'reship.sh'), ...args], {
      encoding: 'utf8',
      env,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('BR=feat/x');
  });
});
