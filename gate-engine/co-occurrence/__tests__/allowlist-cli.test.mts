import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// guard-dup-allowlist is the tool the dup/clone gates print as their approval remedy — its
// exit codes (0 approve/removed, 1 usage/not-covered, 2 corrupt-refuse) and its refusal to
// wipe a corrupt allowlist are what a human/agent depends on when a commit is blocked.

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, '..', 'allowlist-cli.mts');

let tmp: string;
let n = 0;
const freshPath = () => join(tmp, `al-${n++}.json`);

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}
// Run the CLI with the allowlist pinned to `al` via the CO_OCCURRENCE_ALLOWLIST seam.
function run(al: string, args: string[]): Run {
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      env: { ...process.env, CO_OCCURRENCE_ALLOWLIST: al },
      encoding: 'utf8',
    });
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status: number; stdout?: string; stderr?: string };
    return { status: err.status, stdout: `${err.stdout ?? ''}`, stderr: `${err.stderr ?? ''}` };
  }
}
const read = (al: string) => JSON.parse(readFileSync(al, 'utf8'));

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'allowlist-cli-'));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('guard-dup-allowlist pair lifecycle', () => {
  it('add → check(0) → remove → check(1), single non-duplicated entry', () => {
    const al = freshPath();
    expect(
      run(al, [
        'add',
        'symA',
        'a.ts',
        'symB',
        'b.ts',
        '--similarity',
        '.95',
        '--description',
        'intentional',
      ]).status,
    ).toBe(0);
    const file = read(al);
    expect(file.pairs).toHaveLength(1);
    expect(file.pairs[0]).toMatchObject({
      symbolA: 'symA',
      fileA: 'a.ts',
      similarity: 0.95,
      description: 'intentional',
    });
    expect(file.pairs[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    expect(run(al, ['check', 'symA', 'a.ts', 'symB', 'b.ts']).status).toBe(0); // live → covered
    expect(run(al, ['remove', 'symA', 'a.ts', 'symB', 'b.ts']).status).toBe(0);
    expect(read(al).pairs).toHaveLength(0);
    expect(run(al, ['check', 'symA', 'a.ts', 'symB', 'b.ts']).status).toBe(1); // gone → not covered
  });

  it('re-add is idempotent (upsert on symFileKey, never a duplicate)', () => {
    const al = freshPath();
    run(al, ['add', 'symA', 'a.ts', 'symB', 'b.ts', '--description', 'one']);
    run(al, ['add', 'symA', 'a.ts', 'symB', 'b.ts', '--description', 'two']);
    const file = read(al);
    expect(file.pairs).toHaveLength(1);
    expect(file.pairs[0].description).toBe('two');
  });

  it('remove matches order-insensitively (A/B reversed still hits)', () => {
    const al = freshPath();
    run(al, ['add', 'symA', 'a.ts', 'symB', 'b.ts', '--description', 'x']);
    // Remove with the two sides swapped — symFileKey sorts, so it must still match.
    expect(run(al, ['remove', 'symB', 'b.ts', 'symA', 'a.ts']).status).toBe(0);
    expect(read(al).pairs).toHaveLength(0);
  });

  it('backslash paths are normalised to / (OS-agnostic key)', () => {
    const al = freshPath();
    run(al, ['add', 'symA', 'src\\a.ts', 'symB', 'src\\b.ts', '--description', 'x']);
    expect(read(al).pairs[0].fileA).toBe('src/a.ts');
    // A forward-slash check must match the stored (normalised) entry.
    expect(run(al, ['check', 'symA', 'src/a.ts', 'symB', 'src/b.ts']).status).toBe(0);
  });
});

describe('guard-dup-allowlist clone lifecycle', () => {
  it('add-clone persists findability metadata → remove-clone', () => {
    const al = freshPath();
    expect(
      run(al, [
        'add-clone',
        'deadbeef',
        'a.ts',
        'b.ts',
        '--lines',
        '12',
        '--range-a',
        '1-12',
        '--description',
        'gen mirror',
      ]).status,
    ).toBe(0);
    const file = read(al);
    expect(file.clones).toHaveLength(1);
    expect(file.clones[0]).toMatchObject({
      fragmentHash: 'deadbeef',
      fileA: 'a.ts',
      lines: 12,
      rangeA: '1-12',
    });

    expect(run(al, ['remove-clone', 'deadbeef']).status).toBe(0);
    expect(read(al).clones).toHaveLength(0);
  });

  it('add-clone preserves existing pairs (union write, no wipe)', () => {
    const al = freshPath();
    run(al, ['add', 'symA', 'a.ts', 'symB', 'b.ts', '--description', 'pair']);
    run(al, ['add-clone', 'cafe', 'c.ts', 'd.ts', '--description', 'clone']);
    const file = read(al);
    expect(file.pairs).toHaveLength(1);
    expect(file.clones).toHaveLength(1);
  });
});

describe('guard-dup-allowlist guardrails', () => {
  it('add refuses a missing or <why>-placeholder description (exit 1)', () => {
    const al = freshPath();
    expect(run(al, ['add', 'symA', 'a.ts', 'symB', 'b.ts']).status).toBe(1);
    expect(run(al, ['add', 'symA', 'a.ts', 'symB', 'b.ts', '--description', '<why>']).status).toBe(
      1,
    );
  });

  it('add refuses wrong positional count (exit 1)', () => {
    const al = freshPath();
    expect(run(al, ['add', 'symA', 'a.ts', '--description', 'x']).status).toBe(1);
  });

  it('unknown mode exits 1 and lists the valid modes', () => {
    const al = freshPath();
    const r = run(al, ['frobnicate']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('add');
  });

  it('every write verb refuses a corrupt-but-present allowlist (exit 2, file untouched)', () => {
    const corrupt = '{ "pairs": [ {"symbolA": <<<<<<< merge conflict garbage';
    for (const args of [
      ['add', 'symA', 'a.ts', 'symB', 'b.ts', '--description', 'x'],
      ['remove', 'symA', 'a.ts', 'symB', 'b.ts'],
      ['add-clone', 'deadbeef', 'a.ts', 'b.ts', '--description', 'x'],
      ['prune'],
      ['list'],
    ]) {
      const al = freshPath();
      writeFileSync(al, corrupt);
      expect(run(al, args).status).toBe(2);
      expect(readFileSync(al, 'utf8')).toBe(corrupt); // never overwritten
    }
  });
});

describe('guard-dup-allowlist prune + baseline guard', () => {
  it('prune drops expired entries and keeps live ones', () => {
    const al = freshPath();
    writeFileSync(
      al,
      JSON.stringify({
        pairs: [
          {
            symbolA: 'old',
            fileA: 'a.ts',
            symbolB: 'old2',
            fileB: 'b.ts',
            date: '2000-01-01',
            decayDays: 7,
          },
          {
            symbolA: 'new',
            fileA: 'c.ts',
            symbolB: 'new2',
            fileB: 'd.ts',
            date: '2999-01-01',
            decayDays: 7,
          },
        ],
        clones: [{ fragmentHash: 'stale', date: '2000-01-01', decayDays: 7 }],
      }),
    );
    expect(run(al, ['prune']).status).toBe(0);
    const file = read(al);
    expect(file.pairs).toHaveLength(1);
    expect(file.pairs[0].symbolA).toBe('new');
    expect(file.clones).toHaveLength(0);
  });

  it('re-adding over a baseline entry leaves it ENTIRELY untouched (freeze + metadata)', () => {
    const al = freshPath();
    const baseline = {
      symbolA: 'symA',
      fileA: 'a.ts',
      symbolB: 'symB',
      fileB: 'b.ts',
      rangeA: '10-40',
      rangeB: '88-120',
      similarity: 0.98,
      description: 'baseline 2020-01-01 — exact duplicate, frozen by co-occurrence matcher',
      date: '2020-01-01',
      decayDays: 3650,
    };
    writeFileSync(al, JSON.stringify({ pairs: [baseline], clones: [] }));
    // A user pastes a bare `add` (default decay, no ranges) over an already-baselined pair.
    expect(
      run(al, ['add', 'symA', 'a.ts', 'symB', 'b.ts', '--description', 'looks intentional']).status,
    ).toBe(0);
    // Nothing downgraded, nothing rewritten, no findability metadata dropped.
    expect(read(al).pairs).toEqual([baseline]);
  });

  it('add / add-clone reject a decay of < 1 day (would be instantly expired) — exit 1, no write', () => {
    for (const args of [
      ['add', 'symA', 'a.ts', 'symB', 'b.ts', '--description', 'x', '--decay-days', '0'],
      ['add', 'symA', 'a.ts', 'symB', 'b.ts', '--description', 'x', '--decay-days', '-1'],
      ['add-clone', 'deadbeef', 'a.ts', 'b.ts', '--description', 'x', '--decay-days', '0'],
    ]) {
      const al = freshPath();
      expect(run(al, args).status).toBe(1);
      // Rejected before any write — no allowlist file is created.
      expect(existsSync(al)).toBe(false);
    }
  });

  it('similarity 0 and lines 0 are preserved, not dropped as falsy', () => {
    const al = freshPath();
    run(al, ['add', 'symA', 'a.ts', 'symB', 'b.ts', '--similarity', '0', '--description', 'x']);
    expect(read(al).pairs[0].similarity).toBe(0);
    run(al, ['add-clone', 'hash0', 'c.ts', 'd.ts', '--lines', '0', '--description', 'x']);
    expect(read(al).clones[0].lines).toBe(0);
  });
});

// Real-world input shape: repo paths with spaces (the user's own repo lives under
// "Personal and learning/"). Args arrive as an argv array — already shell-split — so a spaced
// path is one positional and must round-trip through the symFileKey add→check→remove loop.
describe('guard-dup-allowlist — paths with spaces', () => {
  it('adds, coverage-checks, and removes a pair whose files contain spaces', () => {
    const al = freshPath();
    const fa = 'my app/src/a.ts';
    const fb = 'my app/src/b.ts';
    expect(run(al, ['add', 'symA', fa, 'symB', fb, '--description', 'intentional']).status).toBe(0);
    expect(read(al).pairs[0].fileA).toBe(fa);
    expect(run(al, ['check', 'symA', fa, 'symB', fb]).status).toBe(0); // covered
    expect(run(al, ['remove', 'symA', fa, 'symB', fb]).status).toBe(0);
    expect(read(al).pairs).toHaveLength(0);
  });
});
