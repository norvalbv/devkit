import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

// The whole point of the integrity checks is that a record the CLI itself wrote passes them, and a
// record something else wrote does not. Asserting that end-to-end through the real bin — rather than
// calling scanCorpus() on a hand-built fixture, which integrity-checks.test.mts already covers — is
// what proves the two halves actually agree about the format.
describe('guard-decisions integrity (via cli.mts, the real bin)', () => {
  it('passes a record written by the CLI itself', () => {
    expect(run(['add', 'my-axis', '--target', '--new', ...reqFlags('my-axis')]).status).toBe(0);
    const r = run(['integrity']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('every record has the shape the CLI would have written');
  });

  it('exits 1 and names the check when a record is edited outside the CLI', () => {
    expect(run(['add', 'my-axis', '--target', '--new', ...reqFlags('my-axis')]).status).toBe(0);
    // A hand-edit of exactly the kind the CLI can never produce: the body H1 renamed while the
    // filename (and so the axis's identity everywhere else) stays put.
    const file = join(dir, 'my-axis.md');
    writeFileSync(file, readFileSync(file, 'utf8').replace(/^# my-axis$/m, '# renamed-by-hand'));

    const r = run(['integrity']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('h1-slug-mismatch');
    expect(r.stderr).toContain('my-axis');
  });

  it('reports a clean pass rather than an error when no decisions exist yet', () => {
    const r = run(['integrity']);
    expect(r.status, r.stderr).toBe(0);
  });

  // The check reads a whitespace-only Evidence-change as missing (it trims). If the WRITE guard did
  // not trim too, the CLI could write a re-target that its own integrity check then flags — the one
  // thing these checks promise can never happen. Guarded at the write end, not by loosening the check.
  it('refuses a whitespace-only --evidence-change rather than writing a record it would then flag', () => {
    expect(run(['add', 'my-axis', '--target', '--new', ...reqFlags('my-axis')]).status).toBe(0);

    const retarget = run([
      'add',
      'my-axis',
      '--target',
      ...reqFlags('my-axis'),
      '--evidence-change',
      '   ',
    ]);
    expect(retarget.status).not.toBe(0);
    expect(retarget.stderr).toContain('evidence-change');

    // …and the log it refused to write is still clean.
    expect(run(['integrity']).status).toBe(0);
  });
});

// One verb for "this replaces that": --supersedes on a --target writes **Supersedes:**, on a --note
// it writes **Amends:** — the note-level marker retrieval has keyed on since sc-1236. The flag was
// already parsed and silently ignored on the note path.
describe('guard-decisions add --note --supersedes (via cli.mts, the real bin)', () => {
  const seed = () =>
    expect(run(['add', 'my-axis', '--target', '--new', ...reqFlags('my-axis')]).status).toBe(0);

  it('writes an Amends-tagged note naming the note it replaces', () => {
    seed();
    expect(run(['add', 'my-axis', '--note', 'carry-on made real']).status).toBe(0);
    const r = run([
      'add',
      'my-axis',
      '--note',
      'deleted, it was a lie',
      '--supersedes',
      'note:2026-07-26',
    ]);
    expect(r.status, r.stderr).toBe(0);

    const file = readFileSync(join(dir, 'my-axis.md'), 'utf8');
    expect(file).toContain('**Amends:** note:2026-07-26 — deleted, it was a lie');
    expect(run(['integrity']).status).toBe(0);
  });

  // The sc-1282 lesson applied at a new write site: a CLI must never write a record its own check
  // then rejects. Both failures below are caught BEFORE anything reaches disk.
  it('refuses a pointer that names no note on the axis', () => {
    seed();
    const r = run(['add', 'my-axis', '--note', 'nope', '--supersedes', 'note:2020-01-01']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('names no note on this axis');
    expect(run(['integrity']).status).toBe(0);
  });

  it('refuses a Target id — a note amends a NOTE, not a ruling', () => {
    seed();
    const r = run(['add', 'my-axis', '--note', 'nope', '--supersedes', 'target:2026-07-26']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('is not a note id');
  });

  it('leaves an ordinary note untouched when no relation is declared', () => {
    seed();
    expect(run(['add', 'my-axis', '--note', 'plain convergence']).status).toBe(0);
    expect(readFileSync(join(dir, 'my-axis.md'), 'utf8')).not.toContain('**Amends:**');
  });
});
