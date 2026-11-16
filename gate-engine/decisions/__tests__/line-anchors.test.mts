import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../decisions.mts', import.meta.url));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'decisions-anchors-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(args: string[]) {
  return spawnSync('node', [SCRIPT, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GUARD_DECISIONS_DIR: dir,
      DECISIONS_TODAY: '2026-10-16',
      DECISIONS_NO_EMBED: '1',
      DECISIONS_INDEX: join(dir, 'vec-index.json'),
    },
  });
}

const target = (slug: string, extra: string[] = []) => [
  'add',
  slug,
  '--target',
  '--context',
  'the forcing failure',
  '--ruling',
  'the mechanism chosen',
  '--consequences',
  'the value protected',
  '--tradeoff',
  'the cost paid',
  '--vision-fit',
  'n/a — internal tooling',
  '--new',
  ...extra,
];

describe('guard-decisions refuses line anchors at write time', () => {
  it('refuses a note citing file:line and leaves the record byte-identical', () => {
    expect(run(target('axis')).status).toBe(0);
    const file = join(dir, 'axis.md');
    const before = readFileSync(file, 'utf8');

    const refused = run(['add', 'axis', '--note', 'the preflight lives at reship.sh:435']);

    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('reship.sh:435');
    expect(refused.stderr).toContain('Cite the function, test or variable name');
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('refuses an anchor in any Target field without creating the axis', () => {
    const refused = run(target('axis', ['--researched', 'read gate-engine/config.mts:179-182']));

    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('gate-engine/config.mts:179-182');
    expect(existsSync(join(dir, 'axis.md'))).toBe(false);
  });

  it('refuses an anchor introduced by amend --note-replace', () => {
    run(target('axis'));
    expect(run(['add', 'axis', '--note', 'draft names foo']).status).toBe(0);
    const file = join(dir, 'axis.md');
    const before = readFileSync(file, 'utf8');

    const refused = run(['amend', 'axis', '--note-replace', 'foo', 'a.mts:3-9']);

    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('a.mts:3-9');
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('refuses a --note-replace that completes an anchor from the surrounding note text', () => {
    run(target('axis'));
    expect(run(['add', 'axis', '--note', 'preflight at reship.sh:LINE']).status).toBe(0);
    const file = join(dir, 'axis.md');
    const before = readFileSync(file, 'utf8');

    const refused = run(['amend', 'axis', '--note-replace', 'LINE', '435']);

    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('reship.sh:435');
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it.each([
    ['--note', ['--note', 'moved to reship.sh:490']],
    [
      '--target',
      ['--target', ...target('axis').slice(3, -1), '--rejected', 'see ship-branch.sh:210'],
    ],
  ])('refuses an anchor in amend %s and keeps the draft', (flag, args) => {
    run(target('axis'));
    if (flag === '--note') run(['add', 'axis', '--note', 'draft note']);
    const file = join(dir, 'axis.md');
    const before = readFileSync(file, 'utf8');

    const refused = run(['amend', 'axis', ...args]);

    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/reship\.sh:490|ship-branch\.sh:210/);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('writes a note that cites the symbol instead', () => {
    run(target('axis'));
    const added = run(['add', 'axis', '--note', 'the preflight is orphanPreflight in reship.sh']);

    expect(added.status, added.stderr).toBe(0);
    expect(readFileSync(join(dir, 'axis.md'), 'utf8')).toContain('orphanPreflight in reship.sh');
  });
});
