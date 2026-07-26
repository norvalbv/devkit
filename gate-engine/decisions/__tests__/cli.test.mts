import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// cli.mts (not decisions.mts) is the real `guard-decisions` bin — `categories` is dispatched there
// (see cli.mts's `run`), so this exercises the ACTUAL entrypoint a user invokes, not an internal fn.
const SCRIPT = fileURLToPath(new URL('../cli.mts', import.meta.url));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'guard-decisions-cli-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(args: string[]) {
  return spawnSync('node', [SCRIPT, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GUARD_DECISIONS_DIR: dir,
      DECISIONS_TODAY: '2026-07-26',
      DECISIONS_NO_EMBED: '1',
      DECISIONS_INDEX: join(dir, 'vec-index.json'),
    },
  });
}

const reqFlags = (slug: string) => [
  '--context',
  `${slug} broke`,
  '--ruling',
  `${slug}-ruling`,
  '--consequences',
  `${slug} value`,
  '--tradeoff',
  `${slug} cost`,
  '--vision-fit',
  'n/a',
];

describe('guard-decisions categories (via cli.mts, the real bin)', () => {
  it('exits 0 and prints something sane for an empty log', () => {
    const r = run(['categories']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('No decisions recorded.');
  });

  it('groups a recorded axis under its Category and still exits 0', () => {
    const add = run([
      'add',
      'my-axis',
      '--target',
      '--new',
      ...reqFlags('my-axis'),
      '--category',
      'ship-pipeline',
    ]);
    expect(add.status, add.stderr).toBe(0);

    const r = run(['categories']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('# ship-pipeline (1)');
    expect(r.stdout).toContain('- my-axis · my-axis-ruling');
  });

  it('still dispatches ordinary commands (unaffected by the new branch)', () => {
    expect(run(['list']).stdout).toContain('No decisions recorded.');
  });
});
