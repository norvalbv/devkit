import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fingerprint, loadOverrides, reconcile } from '../overrides.mts';
import { parseWaiveTarget, resolveWaiveAuthor, runWaive } from '../valve/waive.mts';

const dirs: string[] = [];
const repo = () => {
  const d = mkdtempSync(join(tmpdir(), 'waive-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const AUTHOR = 'Ada Lovelace';
// runWaive's real author resolver shells out to `git config`; every test injects a fixed identity
// instead, so assertions never depend on the executing machine's real git config.
const fixedAuthor = () => AUTHOR;
const RATIONALE = 'writer holds the shard lock the fixture omits — not a real race';

describe('parseWaiveTarget', () => {
  it('splits reviewer:lens on the FIRST colon (a conventions lens is itself path:line)', () => {
    expect(parseWaiveTarget('conventions-reviewer:src/app.ts:42')).toEqual({
      reviewer: 'conventions-reviewer',
      lens: 'src/app.ts:42',
    });
  });
  it('defaults lens to "(finding)" when omitted — matches reconcile’s own fallback', () => {
    expect(parseWaiveTarget('correctness-reviewer')).toEqual({
      reviewer: 'correctness-reviewer',
      lens: '(finding)',
    });
  });
});

describe('resolveWaiveAuthor', () => {
  it('prefers git user.name', () => {
    const run = vi.fn().mockReturnValue('Ada Lovelace');
    expect(resolveWaiveAuthor('/repo', {}, run)).toBe('Ada Lovelace');
    expect(run).toHaveBeenCalledWith(['config', 'user.name']);
  });
  it('falls back to user.email when user.name is unset', () => {
    const run = vi.fn().mockImplementation((args: string[]) => {
      if (args[1] === 'user.name') throw new Error('not set');
      return 'ada@example.com';
    });
    expect(resolveWaiveAuthor('/repo', {}, run)).toBe('ada@example.com');
  });
  it('falls back to $USER when git has no identity at all', () => {
    const run = vi.fn().mockImplementation(() => {
      throw new Error('no identity');
    });
    expect(resolveWaiveAuthor('/repo', { USER: 'ada' }, run)).toBe('ada');
  });
  it('falls back to "unknown" when nothing resolves', () => {
    const run = vi.fn().mockImplementation(() => {
      throw new Error('no identity');
    });
    expect(resolveWaiveAuthor('/repo', {}, run)).toBe('unknown');
  });
});

describe('runWaive', () => {
  it('writes a full entry {reviewer, lens, itemId, rationale, author, at, by} via the shared store', () => {
    const cwd = repo();
    const fp = fingerprint('correctness-reviewer', 'concurrency-races', 'D');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      runWaive(['correctness-reviewer:concurrency-races', fp, RATIONALE], cwd, fixedAuthor),
    ).toBe(0);
    const stored = loadOverrides(cwd)[fp];
    expect(stored).toMatchObject({
      rationale: RATIONALE,
      reviewer: 'correctness-reviewer',
      lens: 'concurrency-races',
      itemId: fp,
      author: AUTHOR,
      by: 'cli',
    });
    expect(typeof stored.at).toBe('string');
  });

  it('a written waive is consumed by reconcile() on the next gate run exactly like an env override', () => {
    const cwd = repo();
    const fp = fingerprint('correctness-reviewer', 'concurrency-races', 'D');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    runWaive(['correctness-reviewer:concurrency-races', fp, RATIONALE], cwd, fixedAuthor);
    const r = reconcile(cwd, 'correctness-reviewer', ['concurrency-races'], 'D', '2026-01-01');
    expect(r.blocking).toEqual([]);
    expect(r.suppressed[0]).toMatchObject({
      lens: 'concurrency-races',
      fingerprint: fp,
      rationale: RATIONALE,
      recorded_by: 'cli',
    });
  });

  it('a waive for reviewer X never fires for reviewer Y, even on the SAME lens name and diff', () => {
    const cwd = repo();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fpCorrectness = fingerprint('correctness-reviewer', 'shared-lens', 'DIFF');
    runWaive(['correctness-reviewer:shared-lens', fpCorrectness, RATIONALE], cwd, fixedAuthor);
    // conventions-reviewer's fingerprint for the identical lens+diff text is a DIFFERENT fp (the
    // reviewer name feeds the hash) — reconciling it must see no suppression at all.
    const rConventions = reconcile(cwd, 'conventions-reviewer', ['shared-lens'], 'DIFF', 'NOW');
    expect(rConventions.suppressed).toEqual([]);
    expect(rConventions.blocking).toEqual([{ lens: 'shared-lens', fp: expect.any(String) }]);
  });

  it('refuses (exit 2) when target/itemId/rationale are missing', () => {
    const cwd = repo();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(runWaive(['correctness-reviewer:x'], cwd)).toBe(2);
    expect(runWaive([], cwd)).toBe(2);
    expect(err.mock.calls.flat().join('\n')).toContain('Usage:');
  });

  it('refuses an unknown reviewer name', () => {
    const cwd = repo();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(runWaive(['not-a-real-reviewer', 'a1b2c3d4e5f6', RATIONALE], cwd)).toBe(2);
    expect(err.mock.calls.flat().join('\n')).toContain('unknown reviewer');
  });

  it('refuses a cascade reviewer (no model pin — opus-confirmed, not eligible for override)', () => {
    const cwd = repo();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(runWaive(['api-security-reviewer', 'a1b2c3d4e5f6', RATIONALE], cwd)).toBe(2);
    expect(err.mock.calls.flat().join('\n')).toContain('cascade reviewer');
  });

  it('refuses an itemId that is not a 12-hex fingerprint', () => {
    const cwd = repo();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(runWaive(['correctness-reviewer', 'not-a-fingerprint', RATIONALE], cwd)).toBe(2);
    expect(err.mock.calls.flat().join('\n')).toContain('12-hex fingerprint');
  });

  it('refuses a too-short rationale', () => {
    const cwd = repo();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(runWaive(['correctness-reviewer', 'a1b2c3d4e5f6', 'nope'], cwd)).toBe(2);
    expect(err.mock.calls.flat().join('\n')).toContain('specific reason');
  });

  it('refuses a literal-placeholder rationale even when it is long enough', () => {
    const cwd = repo();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      runWaive(
        ['correctness-reviewer', 'a1b2c3d4e5f6', 'why', 'this', 'is', 'not', 'a', 'real', 'defect'],
        cwd,
      ),
    ).toBe(2);
    expect(err.mock.calls.flat().join('\n')).toContain('specific reason');
  });

  it('never clobbers an already-recorded waive for a different reviewer/lens on write', () => {
    const cwd = repo();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fpA = fingerprint('correctness-reviewer', 'a', 'D');
    const fpB = fingerprint('conventions-reviewer', 'app.ts:1', 'D');
    runWaive(
      ['correctness-reviewer:a', fpA, 'first waiver, holds a lock the fixture omits'],
      cwd,
      fixedAuthor,
    );
    runWaive(
      ['conventions-reviewer:app.ts:1', fpB, 'second waiver, a different reviewer entirely'],
      cwd,
      fixedAuthor,
    );
    const store = loadOverrides(cwd);
    expect(store[fpA]?.rationale).toBe('first waiver, holds a lock the fixture omits');
    expect(store[fpB]?.rationale).toBe('second waiver, a different reviewer entirely');
  });

  describe('--list', () => {
    it('reports no active waives on an empty store', () => {
      const cwd = repo();
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      expect(runWaive(['--list'], cwd)).toBe(0);
      expect(log.mock.calls.flat().join('\n')).toContain('no active waives');
    });

    it('lists a written waive with its reviewer:lens, fp, author and rationale', () => {
      const cwd = repo();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const fp = fingerprint('correctness-reviewer', 'concurrency-races', 'D');
      runWaive(['correctness-reviewer:concurrency-races', fp, RATIONALE], cwd, fixedAuthor);
      expect(runWaive(['--list'], cwd)).toBe(0);
      const out = log.mock.calls.flat().join('\n');
      expect(out).toContain(fp);
      expect(out).toContain('correctness-reviewer:concurrency-races');
      expect(out).toContain(RATIONALE);
    });
  });
});
