import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fingerprint, loadOverrides, reconcile } from '../overrides.mts';
import {
  WAIVE_KIND_PLACEHOLDER,
  WAIVE_RATIONALE_PLACEHOLDER,
  WAIVER_KINDS,
} from '../valve/shell-word.mts';
import { parseWaiveTarget, resolveWaiveAuthor, runWaive } from '../valve/waive.mts';

const dirs: string[] = [];
const repo = () => {
  const d = mkdtempSync(join(tmpdir(), 'waive-'));
  dirs.push(d);
  return d;
};
let savedSink: string | undefined;
let sink: string;
beforeEach(() => {
  savedSink = process.env.DEVKIT_GATE_EVENTS;
  sink = join(repo(), 'events.jsonl');
  process.env.DEVKIT_GATE_EVENTS = sink;
});
afterEach(() => {
  if (savedSink === undefined) delete process.env.DEVKIT_GATE_EVENTS;
  else process.env.DEVKIT_GATE_EVENTS = savedSink;
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const waiverEvents = () =>
  existsSync(sink)
    ? readFileSync(sink, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
        .filter((e) => e.type === 'waiver_created')
    : [];

const AUTHOR = 'Ada Lovelace';
// runWaive's real author resolver shells out to `git config`; every test injects a fixed identity
// instead, so assertions never depend on the executing machine's real git config.
const fixedAuthor = () => AUTHOR;
const RATIONALE = 'writer holds the shard lock the fixture omits — not a real race';
// Every waive needs a kind; the kind-specific tests below call runWaive directly.
const waive = (args: string[], cwd: string, author?: (cwd: string) => string) =>
  runWaive([...args, '--kind', 'false-positive'], cwd, author);

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
    expect(waive(['correctness-reviewer:concurrency-races', fp, RATIONALE], cwd, fixedAuthor)).toBe(
      0,
    );
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
    waive(['correctness-reviewer:concurrency-races', fp, RATIONALE], cwd, fixedAuthor);
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
    waive(['correctness-reviewer:shared-lens', fpCorrectness, RATIONALE], cwd, fixedAuthor);
    // conventions-reviewer's fingerprint for the identical lens+diff text is a DIFFERENT fp (the
    // reviewer name feeds the hash) — reconciling it must see no suppression at all.
    const rConventions = reconcile(cwd, 'conventions-reviewer', ['shared-lens'], 'DIFF', 'NOW');
    expect(rConventions.suppressed).toEqual([]);
    expect(rConventions.blocking).toEqual([{ lens: 'shared-lens', fp: expect.any(String) }]);
  });

  it('refuses (exit 2) when target/itemId/rationale are missing', () => {
    const cwd = repo();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(waive(['correctness-reviewer:x'], cwd)).toBe(2);
    expect(waive([], cwd)).toBe(2);
    expect(err.mock.calls.flat().join('\n')).toContain('Usage:');
  });

  it('refuses an unknown reviewer name', () => {
    const cwd = repo();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(waive(['not-a-real-reviewer', 'a1b2c3d4e5f6', RATIONALE], cwd)).toBe(2);
    expect(err.mock.calls.flat().join('\n')).toContain('unknown reviewer');
  });

  it('refuses a cascade reviewer (no model pin — opus-confirmed, not eligible for override)', () => {
    const cwd = repo();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(waive(['api-security-reviewer', 'a1b2c3d4e5f6', RATIONALE], cwd)).toBe(2);
    const out = err.mock.calls.flat().join('\n');
    expect(out).toContain('cascade reviewer');
    expect(out).toContain('Fix the confirmed finding');
    expect(out).toContain("user's explicit OK");
    expect(out).toContain('env GUARD_REVIEW_SKIP=api-security-reviewer <retry command>');
    expect(out).not.toContain('export GUARD_REVIEW_SKIP');
    expect(out).toContain('skips only api-security-reviewer; every other reviewer still runs');
    expect(out).toContain('GUARD_NO_REVIEW=1 skips the entire review gate');
    expect(loadOverrides(cwd)).toEqual({});
  });

  it('refuses an itemId that is not a 12-hex fingerprint', () => {
    const cwd = repo();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(waive(['correctness-reviewer', 'not-a-fingerprint', RATIONALE], cwd)).toBe(2);
    expect(err.mock.calls.flat().join('\n')).toContain('12-hex fingerprint');
  });

  it('refuses a too-short rationale', () => {
    const cwd = repo();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(waive(['correctness-reviewer', 'a1b2c3d4e5f6', 'nope'], cwd)).toBe(2);
    expect(err.mock.calls.flat().join('\n')).toContain('specific reason');
  });

  it('refuses a literal-placeholder rationale even when it is long enough', () => {
    const cwd = repo();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      waive(
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
    waive(
      ['correctness-reviewer:a', fpA, 'first waiver, holds a lock the fixture omits'],
      cwd,
      fixedAuthor,
    );
    waive(
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
      waive(['correctness-reviewer:concurrency-races', fp, RATIONALE], cwd, fixedAuthor);
      expect(runWaive(['--list'], cwd)).toBe(0);
      const out = log.mock.calls.flat().join('\n');
      expect(out).toContain(fp);
      expect(out).toContain('correctness-reviewer:concurrency-races');
      expect(out).toContain(RATIONALE);
    });
  });
});

describe('waiver_created telemetry', () => {
  it('a recorded CLI waive emits exactly one event carrying reviewer/lens/fingerprint/rationale/by', () => {
    const cwd = repo();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fp = fingerprint('correctness-reviewer', 'concurrency-races', 'D');
    waive(['correctness-reviewer:concurrency-races', fp, RATIONALE], cwd, fixedAuthor);
    const events = waiverEvents();
    expect(events).toMatchObject([
      {
        reviewer: 'correctness-reviewer',
        lens: 'concurrency-races',
        fingerprint: fp,
        rationale: RATIONALE,
        by: 'cli',
      },
    ]);
    // recorded_at is the STORE entry's timestamp — the authoritative decision time, since events
    // are appended after the lock releases and concurrent appends carry no order guarantee.
    expect(events[0].recorded_at).toBe(loadOverrides(cwd)[fp].at);
  });

  it('re-running the identical waive emits nothing; a CHANGED rationale emits again', () => {
    const cwd = repo();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fp = fingerprint('correctness-reviewer', 'concurrency-races', 'D');
    const args = ['correctness-reviewer:concurrency-races', fp, RATIONALE];
    waive(args, cwd, fixedAuthor);
    waive(args, cwd, fixedAuthor);
    expect(waiverEvents()).toHaveLength(1);
    waive(
      [args[0], fp, 'sharper second rationale: the lock is held by the caller'],
      cwd,
      fixedAuthor,
    );
    expect(waiverEvents()).toHaveLength(2);
  });

  it('the event carries a bounded rationale copy; the store keeps the full text', async () => {
    const cwd = repo();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fp = fingerprint('correctness-reviewer', 'concurrency-races', 'D');
    const long = `the lock is held by the caller ${'x'.repeat(2000)}`;
    waive(['correctness-reviewer:concurrency-races', fp, long], cwd, fixedAuthor);
    const { WAIVER_RATIONALE_EVENT_CAP } = await import('../overrides.mts');
    expect(waiverEvents()[0].rationale).toBe(long.slice(0, WAIVER_RATIONALE_EVENT_CAP));
    expect(loadOverrides(cwd)[fp].rationale).toBe(long);
  });

  // commit-gates tells authors to waive a non-reproducing finding with the command and its output as
  // the rationale, so pasted terminal output (newlines, quotes, tabs, colour escapes) must round-trip.
  it('a pasted reproduction (multi-line output, colour escapes) is stored as text and suppresses', () => {
    const cwd = repo();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fp = fingerprint('correctness-reviewer', 'error-and-edge-classification', 'D');
    const output =
      '$ node -e "console.log(captureSymbols(\'`${`${a}`}`\'))"\n' +
      "[ 'a' ]\n\t\x1b[32m✓\x1b[0m nested interpolation captured\r\n";
    expect(
      waive(['correctness-reviewer:error-and-edge-classification', fp, output], cwd, fixedAuthor),
    ).toBe(0);
    const raw = readFileSync(join(cwd, '.devkit', 'correctness-overrides.json'), 'utf8');
    expect([...raw].filter((c) => c < ' ' && c !== '\n')).toEqual([]);
    expect(loadOverrides(cwd)[fp].rationale).toBe(output.trim());
    const r = reconcile(
      cwd,
      'correctness-reviewer',
      ['error-and-edge-classification'],
      'D',
      '2026-01-01',
    );
    expect(r.blocking).toEqual([]);
    expect(r.suppressed[0].rationale).toBe(output.trim());
    // Stored verbatim, but never re-emitted raw: a pasted escape sequence must not drive the terminal.
    expect(runWaive(['--list'], cwd)).toBe(0);
    const printed = [...err.mock.calls, ...log.mock.calls].flat().join('\n');
    expect(printed).toContain('nested interpolation captured');
    expect(printed).not.toContain('\x1b');
  });

  it('a refused waive (cascade reviewer) emits nothing', () => {
    const cwd = repo();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(waive(['api-security-reviewer', 'a1b2c3d4e5f6', RATIONALE], cwd, fixedAuthor)).toBe(2);
    expect(waiverEvents()).toHaveLength(0);
  });

  it('the env write-through channel emits by:"env" on the first persist and never on a re-read', () => {
    const cwd = repo();
    const fp = fingerprint('correctness-reviewer', 'stale-read', 'ENVDIFF');
    const env = { [`OVERRIDE_${fp}_RATIONALE`]: 'reader re-validates the row before use' };
    reconcile(cwd, 'correctness-reviewer', ['stale-read'], 'ENVDIFF', '2026-01-01', env);
    reconcile(cwd, 'correctness-reviewer', ['stale-read'], 'ENVDIFF', '2026-01-02', env);
    expect(waiverEvents()).toMatchObject([
      {
        reviewer: 'correctness-reviewer',
        lens: 'stale-read',
        fingerprint: fp,
        rationale: 'reader re-validates the row before use',
        by: 'env',
        kind: null,
      },
    ]);
  });
});

describe('waive base provenance (sc-2480)', () => {
  const FP = 'a1b2c3d4e5f6';
  const BASE = '31884c2b7f0e4a19c5d6b8f2a3e7c9d1b4f6a802';

  it('records the base it was HANDED, never one derived from its own worktree', () => {
    const cwd = repo();
    expect(
      waive(['correctness-reviewer:races', FP, '--base', BASE, RATIONALE], cwd, fixedAuthor),
    ).toBe(0);
    expect(loadOverrides(cwd)[FP].baseSha).toBe(BASE);
    expect(waiverEvents()[0].base_sha).toBe(BASE);
  });

  it('records NO base when none was supplied — an unprovable base is worse than none', () => {
    const cwd = repo();
    expect(waive(['correctness-reviewer:races', FP, RATIONALE], cwd, fixedAuthor)).toBe(0);
    expect(loadOverrides(cwd)[FP].baseSha).toBeUndefined();
    expect(waiverEvents()[0].base_sha).toBeNull();
  });

  it('refuses a --base that is not a sha rather than recording a guess', () => {
    const cwd = repo();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      waive(['correctness-reviewer:races', FP, '--base', 'main', RATIONALE], cwd, fixedAuthor),
    ).toBe(2);
    expect(loadOverrides(cwd)[FP]).toBeUndefined();
  });

  it('keeps the rationale intact when --base precedes it', () => {
    const cwd = repo();
    waive(['correctness-reviewer:races', FP, '--base', BASE, RATIONALE], cwd, fixedAuthor);
    expect(loadOverrides(cwd)[FP].rationale).toBe(RATIONALE);
  });
});

describe('waive --base parsing shapes (sc-2480)', () => {
  const FP = 'a1b2c3d4e5f6';
  const BASE = '31884c2b7f0e4a19c5d6b8f2a3e7c9d1b4f6a802';

  it('accepts --base before the positional arguments', () => {
    const cwd = repo();
    expect(
      waive(['--base', BASE, 'correctness-reviewer:races', FP, RATIONALE], cwd, fixedAuthor),
    ).toBe(0);
    expect(loadOverrides(cwd)[FP].baseSha).toBe(BASE);
    expect(loadOverrides(cwd)[FP].rationale).toBe(RATIONALE);
  });

  // blockingNote prints an abbreviated sha; the CLI must take exactly what it printed.
  it('accepts the 12-hex short sha the block note actually prints', () => {
    const cwd = repo();
    expect(
      waive(
        ['correctness-reviewer:races', FP, '--base', BASE.slice(0, 12), RATIONALE],
        cwd,
        fixedAuthor,
      ),
    ).toBe(0);
    expect(loadOverrides(cwd)[FP].baseSha).toBe(BASE.slice(0, 12));
  });

  // A rationale is one quoted argv element, so its text can never be mistaken for the flag.
  it('leaves a rationale that merely mentions --base untouched', () => {
    const cwd = repo();
    const mentions = 'the --base flag is irrelevant; the shard lock makes this safe';
    expect(waive(['correctness-reviewer:races', FP, mentions], cwd, fixedAuthor)).toBe(0);
    expect(loadOverrides(cwd)[FP].rationale).toBe(mentions);
    expect(loadOverrides(cwd)[FP].baseSha).toBeUndefined();
  });

  it('refuses a trailing --base with no value rather than swallowing the rationale', () => {
    const cwd = repo();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(waive(['correctness-reviewer:races', FP, RATIONALE, '--base'], cwd, fixedAuthor)).toBe(
      2,
    );
    expect(loadOverrides(cwd)[FP]).toBeUndefined();
  });
});

describe('waive re-records changed provenance (reviewer finding)', () => {
  const FP = 'a1b2c3d4e5f6';
  const A = '31884c2b7f0e4a19c5d6b8f2a3e7c9d1b4f6a802';
  const B = '0e7d8722ec23c3e2fafbbb5f14da102d8b7c120b';

  it('emits an event when the SAME rationale is re-waived against a different base', () => {
    const cwd = repo();
    waive(['correctness-reviewer:races', FP, '--base', A, RATIONALE], cwd, fixedAuthor);
    expect(
      waive(['correctness-reviewer:races', FP, '--base', B, RATIONALE], cwd, fixedAuthor),
    ).toBe(0);
    expect(loadOverrides(cwd)[FP].baseSha).toBe(B);
    const events = waiverEvents();
    expect(events).toHaveLength(2);
    expect(events[1].base_sha).toBe(B);
  });

  it('stays idempotent when nothing at all changed', () => {
    const cwd = repo();
    waive(['correctness-reviewer:races', FP, '--base', A, RATIONALE], cwd, fixedAuthor);
    waive(['correctness-reviewer:races', FP, '--base', A, RATIONALE], cwd, fixedAuthor);
    expect(waiverEvents()).toHaveLength(1);
  });
});

describe('waive --kind', () => {
  const FP = 'a1b2c3d4e5f6';
  const TARGET = 'correctness-reviewer:races';
  const errors = () => vi.spyOn(console, 'error').mockImplementation(() => {});

  it('refuses a waive with no --kind and lists the four kinds with their meanings', () => {
    const cwd = repo();
    const err = errors();
    expect(runWaive([TARGET, FP, RATIONALE], cwd, fixedAuthor)).toBe(2);
    const out = err.mock.calls.flat().join('\n');
    for (const [kind, meaning] of Object.entries(WAIVER_KINDS))
      expect(out).toContain(`--kind ${kind}: ${meaning}`);
    expect(loadOverrides(cwd)[FP]).toBeUndefined();
    expect(waiverEvents()).toHaveLength(0);
  });

  it.each(['bogus', WAIVE_KIND_PLACEHOLDER, 'constructor'])('refuses the kind %s', (kind) => {
    const cwd = repo();
    const err = errors();
    expect(runWaive([TARGET, FP, '--kind', kind, RATIONALE], cwd, fixedAuthor)).toBe(2);
    expect(err.mock.calls.flat().join('\n')).toContain(`(got "${kind}")`);
    expect(loadOverrides(cwd)[FP]).toBeUndefined();
  });

  // An edited placeholder plus an appended `--kind` must not let one silently win.
  it('refuses two --kind flags rather than recording one and storing the other in the rationale', () => {
    const cwd = repo();
    errors();
    const args = [TARGET, FP, '--kind', 'deferred', RATIONALE, '--kind', 'accepted'];
    expect(runWaive(args, cwd, fixedAuthor)).toBe(2);
    expect(loadOverrides(cwd)[FP]).toBeUndefined();
  });

  it('names both edits at once when the rationale and kind are both unedited', () => {
    const err = errors();
    const args = [TARGET, FP, '--kind', WAIVE_KIND_PLACEHOLDER, WAIVE_RATIONALE_PLACEHOLDER];
    expect(runWaive(args, repo(), fixedAuthor)).toBe(2);
    const out = err.mock.calls.flat().join('\n');
    expect(out).toContain('specific reason');
    expect(out).toContain('--kind must be one of');
  });

  it.each(Object.keys(WAIVER_KINDS))('records %s on the store entry and one event', (kind) => {
    const cwd = repo();
    errors();
    expect(runWaive(['--kind', kind, TARGET, FP, RATIONALE], cwd, fixedAuthor)).toBe(0);
    expect(loadOverrides(cwd)[FP].kind).toBe(kind);
    expect(waiverEvents()).toMatchObject([{ fingerprint: FP, kind }]);
  });

  it('a kind-only change is a new decision; an identical rerun is not', () => {
    const cwd = repo();
    errors();
    runWaive([TARGET, FP, '--kind', 'false-positive', RATIONALE], cwd, fixedAuthor);
    runWaive([TARGET, FP, '--kind', 'deferred', RATIONALE], cwd, fixedAuthor);
    runWaive([TARGET, FP, '--kind', 'deferred', RATIONALE], cwd, fixedAuthor);
    expect(loadOverrides(cwd)[FP].kind).toBe('deferred');
    expect(waiverEvents().map((e) => e.kind)).toEqual(['false-positive', 'deferred']);
  });

  it('--list prints the kind, and "unclassified" for an entry written before the field', () => {
    const cwd = repo();
    errors();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    runWaive([TARGET, FP, '--kind', 'pre-existing', RATIONALE], cwd, fixedAuthor);
    const older = 'b1b2c3d4e5f6';
    const store = { ...loadOverrides(cwd), [older]: { rationale: RATIONALE, by: 'file' } };
    writeFileSync(join(cwd, '.devkit', 'correctness-overrides.json'), JSON.stringify(store));
    expect(runWaive(['--list'], cwd)).toBe(0);
    const out = log.mock.calls.flat().join('\n');
    expect(out).toMatch(new RegExp(`\\[${FP}\\].* · kind pre-existing`));
    expect(out).toMatch(new RegExp(`\\[${older}\\].* · unclassified`));
  });
});
