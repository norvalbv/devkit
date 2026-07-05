// Unit tests for the commit-message Sentry-advisory gate's pure core (the LLM judgement itself isn't
// unit-tested — it's validated by the eval/ benchmark against the real model). Tables over repetition:
// every pure rule is exercised via it.each so the assertions read as data, not boilerplate.

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildContext,
  buildPrompt,
  cleanMessage,
  extractEvidence,
  judge,
  majority,
  parseSentryVerdict,
  reportLine,
  run,
  sentryExit,
  shouldJudge,
  skipReason,
  subjectOf,
  watchlistHas,
  watchlistLine,
} from '../check-sentry.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '..', 'check-sentry.mts');

describe('shouldJudge (only behaviour-bearing types reach the LLM)', () => {
  it.each([
    ['fix(executor): disarm task-signal on dead chats', true],
    ['feat: add a thing', true],
    ['perf(db): batch updates', true],
    ['refactor!: drop legacy path', true], // breaking-! tolerated
    ['docs(x): document y', false],
    ['chore(biome): organize imports', false],
    ['style: sort imports', false],
    ['bump packages', false], // non-conventional one-liner
    ['fixes', false],
    ['', false],
  ])('judges %j → %j', (msg, judged) => {
    expect(shouldJudge(msg)).toBe(judged);
  });

  it('reads the subject past leading comment / blank lines', () => {
    expect(subjectOf('# a comment\n\nfix(api): map FK violations')).toBe(
      'fix(api): map FK violations',
    );
    expect(shouldJudge('# scissor\n\nfeat: real subject')).toBe(true);
  });
});

describe('parseSentryVerdict (first-line, confident single hit; null = no block)', () => {
  it.each([
    ['MONITOR', 'MONITOR'],
    [' skip\n', 'SKIP'], // case/whitespace-insensitive
    ['MONITOR — executor / dead-chat path', 'MONITOR'], // inline why kept
    ['SKIP\nthis is not something to MONITOR', 'SKIP'], // only the first line is read
    ['MONITOR or SKIP', null], // two tokens on line 1 → ambiguous
    ['', null],
    ['maybe', null],
    ['MONITORING the queue depth', null], // word-boundary: MONITORING is NOT MONITOR
    ['SKIPPED the lint step', null], // word-boundary: SKIPPED is NOT SKIP
  ])('parse(%j) → %j', (raw, expected) => {
    expect(parseSentryVerdict(raw)).toBe(expected);
  });
});

describe('extractEvidence (survives inline OR two-line why)', () => {
  it.each([
    ['MONITOR — executor / dead-chat signal path', 'executor / dead-chat signal path'], // inline
    ['MONITOR\nflow run stranded — never auto-captured', 'flow run stranded — never auto-captured'], // 2nd line, newline collapsed
    ['MONITOR: db constraint path', 'db constraint path'], // colon separator
    ['**MONITOR** — fs reclaim', 'fs reclaim'], // markdown bold + dash
    ['MONITOR\nwhy line one\nwhy line two', 'why line one why line two'], // multi-line why collapsed
    ['SKIP', ''], // verdict-only
    ['MONITOR.', ''],
  ])('extract(%j) → %j', (raw, expected) => {
    expect(extractEvidence(raw)).toBe(expected);
  });
});

describe('majority (self-consistency vote; tie → null preserves the no-block discipline)', () => {
  it.each([
    [['MONITOR', 'MONITOR', 'SKIP'], 'MONITOR'], // strict plurality
    [['SKIP', null, 'SKIP'], 'SKIP'], // nulls ignored
    [[null, null], null],
    [['MONITOR', 'SKIP'], null], // 1-1 split must not coin-flip a verdict
    [['SKIP', 'MONITOR'], null],
    [[], null], // zero samples (boundary) → no verdict
    [['SKIP', 'SKIP', 'MONITOR'], 'SKIP'], // clear plurality the other way
  ])('vote(%j) → %j', (votes, expected) => {
    expect(majority(votes)).toBe(expected);
  });
});

describe('sentryExit (block bounded to hard-mode + confident MONITOR)', () => {
  it.each([
    ['MONITOR', true, 1], // the ONLY blocking case
    ['MONITOR', false, 0], // warn-default: MONITOR alone never blocks
    ['SKIP', true, 0],
    [null, true, 0], // ambiguous / unavailable → no block
  ])('exit(verdict=%j, hard=%j) → %j', (verdict, hard, code) => {
    expect(sentryExit(verdict, hard)).toBe(code);
  });
});

describe('buildContext (names tier appends changed files, never hunks)', () => {
  it('message tier is message-only', () => {
    expect(buildContext('fix: x', 'M\tsrc/a.ts', 'message')).toBe('COMMIT MESSAGE:\nfix: x');
  });

  it('names tier appends the changed-file list when present', () => {
    const out = buildContext('fix: x', 'M\tsrc/a.ts\nA\tsrc/b.ts', 'names');
    expect(out).toContain('CHANGED FILES');
    expect(out).toContain('M\tsrc/a.ts');
  });

  it('names tier with no file list degrades to message-only', () => {
    expect(buildContext('fix: x', '', 'names')).toBe('COMMIT MESSAGE:\nfix: x');
  });

  it('caps a huge changed-file list at 30 lines (a big refactor commit)', () => {
    const nameStatus = Array.from({ length: 50 }, (_, i) => `M\tsrc/f${i}.ts`).join('\n');
    const fileLines = buildContext('fix: x', nameStatus, 'names')
      .split('CHANGED FILES (status\\tpath):\n')[1]
      .split('\n')
      .filter(Boolean);
    expect(fileLines.length).toBe(30);
  });

  it('caps an oversized commit message at 2000 chars', () => {
    const msg = `fix: ${'a'.repeat(5000)}`;
    expect(buildContext(msg, '', 'message').length).toBeLessThanOrEqual(
      'COMMIT MESSAGE:\n'.length + 2000,
    );
  });
});

describe('reportLine + buildPrompt (report formatting; few-shot toggle)', () => {
  it('formats a verdict + evidence, and the no-verdict fallback', () => {
    expect(reportLine({ verdict: 'MONITOR', evidence: 'executor path' })).toBe(
      'sentry-judge: MONITOR — executor path',
    );
    expect(reportLine({ verdict: 'SKIP', evidence: '' })).toBe('sentry-judge: SKIP'); // no evidence
    expect(reportLine(null)).toContain('no verdict');
  });

  it('few-shot exemplars present at 4 shots, absent at 0', () => {
    expect(buildPrompt(4)).toContain('Examples:');
    expect(buildPrompt(0)).not.toContain('Examples:');
  });
});

describe('cleanMessage (drop git template comments, trim, cap; CRLF-tolerant)', () => {
  it('recovers the subject past a comment-prefixed git editor template on CRLF', () => {
    // git's default editor template prefixes the body with '#' comment lines; on Windows the message
    // file is CRLF. The gate must still recover the conventional subject and reach the judge.
    const raw =
      'fix(api): map FK violations\r\n\r\n# Please enter the commit message.\r\n# Lines starting with # are ignored.\r\n';
    const cleaned = cleanMessage(raw);
    expect(cleaned.startsWith('fix(api): map FK violations')).toBe(true);
    expect(cleaned).not.toContain('Please enter'); // comment lines stripped
    expect(shouldJudge(cleaned)).toBe(true);
  });

  it('caps a runaway message at 4000 chars', () => {
    expect(cleanMessage(`feat: ${'x'.repeat(9000)}`).length).toBe(4000);
  });
});

describe('watchlist dedup (subject-keyed; amend/retry must not dup, distinct subjects must not collide)', () => {
  it('formats the backlog line with and without evidence', () => {
    expect(watchlistLine('fix: foo', 'executor path')).toBe('- [ ] fix: foo — executor path');
    expect(watchlistLine('fix: foo', '')).toBe('- [ ] fix: foo');
  });

  it('matches an existing entry for the same subject (the amend/retry guard)', () => {
    expect(watchlistHas('- [ ] fix: foo — bar\n', 'fix: foo')).toBe(true);
  });

  it('dedupes the same subject even when the evidence text differs', () => {
    // The LLM evidence is non-deterministic: the same commit re-judged yields different evidence.
    // Keying dedup on the subject alone is what stops a re-run from duplicating the entry.
    expect(watchlistHas('- [ ] fix: foo — executor path null-check\n', 'fix: foo')).toBe(true);
  });

  it('matches a subject logged WITHOUT evidence', () => {
    expect(watchlistHas('- [ ] fix: foo\n', 'fix: foo')).toBe(true);
  });

  it('does NOT match a distinct subject that is a SUBSTRING of an existing one', () => {
    // "fix: foo" is a substring of "fix: foobar" — anchoring on the full line prefix keeps them
    // distinct so a real commit is never silently dropped from the backlog.
    expect(watchlistHas('- [ ] fix: foobar — baz\n', 'fix: foo')).toBe(false);
  });

  it('an empty watchlist matches nothing', () => {
    expect(watchlistHas('', 'fix: foo')).toBe(false);
  });
});

describe('skipReason (pre-claude bypass: env override or trivial commit type)', () => {
  it('returns the env-skip reason when GUARD_NO_SENTRY_JUDGE is set', () => {
    vi.stubEnv('GUARD_NO_SENTRY_JUDGE', '1');
    expect(skipReason('fix(x): y')).toContain('NO_SENTRY_JUDGE');
    vi.unstubAllEnvs();
  });

  it('respects the FRINK_* back-compat alias', () => {
    vi.stubEnv('FRINK_NO_SENTRY_JUDGE', '1');
    expect(skipReason('fix(x): y')).toContain('NO_SENTRY_JUDGE');
    vi.unstubAllEnvs();
  });

  it('returns the trivial-type reason for a non-judged commit type', () => {
    expect(skipReason('chore(x): y')).toContain('SKIP');
  });

  it('returns null for a behaviour-bearing type → proceed to judge', () => {
    expect(skipReason('fix(x): y')).toBeNull();
  });
});

describe('judge (fail-open guards, no claude call)', () => {
  it('returns null for empty / whitespace input without invoking the model', () => {
    expect(judge('')).toBeNull();
    expect(judge('   \n  ')).toBeNull();
  });

  it('returns null when GUARD_SENTRY_NO_LLM disables the judge', () => {
    vi.stubEnv('GUARD_SENTRY_NO_LLM', '1');
    expect(judge('COMMIT MESSAGE:\nfix(x): y')).toBeNull();
    vi.unstubAllEnvs();
  });
});

describe('run dispatch (in-process; covers readMessage + skipReason + applyGateResult wiring)', () => {
  // run() ends in process.exit; capture the FIRST exit code (run's own catch re-exits 2 on the
  // mock's throw, so ignore subsequent calls). Silence the gate's stdout/stderr to keep output clean.
  const callRun = (gate, message, env = {}) => {
    const origArgv = process.argv;
    process.argv = ['node', 'check-sentry.mts', ...(gate ? ['--gate'] : []), message];
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    let code;
    const exit = vi.spyOn(process, 'exit').mockImplementation((c) => {
      if (code === undefined) code = c ?? 0;
      throw new Error('__exit__');
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      run(gate);
    } catch (e) {
      if (e.message !== '__exit__') throw e;
    } finally {
      exit.mockRestore();
      log.mockRestore();
      err.mockRestore();
      process.argv = origArgv;
      vi.unstubAllEnvs();
    }
    return code;
  };

  it('report mode: a judged commit with the LLM disabled prints + exits 0', () => {
    expect(callRun(false, 'fix(executor): disarm signal', { GUARD_SENTRY_NO_LLM: '1' })).toBe(0);
  });

  it('report mode: GUARD_NO_SENTRY_JUDGE bypass exits 0', () => {
    expect(callRun(false, 'fix(x): y', { GUARD_NO_SENTRY_JUDGE: '1' })).toBe(0);
  });

  it('report mode: a trivial commit type free-skips, exits 0', () => {
    expect(callRun(false, 'chore(x): y')).toBe(0);
  });

  it('gate mode: judged commit, LLM disabled → no verdict → exits 0 even in hard mode', () => {
    expect(callRun(true, 'fix(x): y', { GUARD_SENTRY_NO_LLM: '1', GUARD_SENTRY_HARD: '1' })).toBe(
      0,
    );
  });
});

describe('check-sentry gate — fail-open / bypass / free-skip (provider-absent degrades silently)', () => {
  const gate = (env, msg) =>
    spawnSync('node', [SCRIPT, '--gate', msg], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
    });
  // Stub `claude` on PATH so the real judge path runs (runJudgeOnce + the sample loop). Stubs return
  // SKIP / exit — never MONITOR — so the gate never appends to a real watchlist.
  const stubs = [];
  const stubPath = (script) => {
    const dir = mkdtempSync(join(tmpdir(), 'sentry-stub-'));
    stubs.push(dir);
    const fake = join(dir, 'claude');
    writeFileSync(fake, `#!/bin/sh\ncat >/dev/null\n${script}`);
    chmodSync(fake, 0o755);
    return `${dir}:${process.env.PATH}`;
  };
  afterEach(() => {
    while (stubs.length) rmSync(stubs.pop(), { recursive: true, force: true });
  });

  it('GUARD_NO_SENTRY_JUDGE=1 skips entirely → exit 0', () => {
    expect(gate({ GUARD_NO_SENTRY_JUDGE: '1' }, 'fix(x): y').status).toBe(0);
  });

  it('a trivial commit type free-skips (no claude) → exit 0', () => {
    expect(gate({}, 'chore(x): y').status).toBe(0);
  });

  it('GUARD_SENTRY_NO_LLM=1 → no judgement → exit 0 even in hard mode, never blocks', () => {
    expect(gate({ GUARD_SENTRY_NO_LLM: '1', GUARD_SENTRY_HARD: '1' }, 'fix(x): y').status).toBe(0);
  });

  it('report mode (no --gate) prints a verdict line and exits 0', () => {
    const r = spawnSync('node', [SCRIPT, 'chore(x): y'], {
      env: { ...process.env, GUARD_SENTRY_NO_LLM: '1' },
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('sentry-judge:');
  });

  it('judged commit + healthy SKIP verdict → exit 0: the judge ran and was parsed (no warning)', () => {
    const r = gate({ PATH: stubPath('echo SKIP\n') }, 'fix(x): y');
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('claude judge unavailable');
  });

  it('judged commit + claude dark → exit 0 (warn-only unchanged) AND warns visibly', () => {
    const r = gate({ PATH: stubPath('exit 3\n') }, 'fix(x): y');
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('sentry-advisory: claude judge unavailable');
  });
});

// The gate describe above spawns a SUBPROCESS, which v8 cannot instrument. Calling the exported
// judge() directly runs the changed orchestration (runJudgeOnce + the sample loop) inside the test
// process, so it is measured — and lets us pin the bail-once behaviour precisely.
describe('check-sentry judge() in-process — runJudgeOnce + sample loop', () => {
  const stubs = [];
  const stubOnPath = (script) => {
    const dir = mkdtempSync(join(tmpdir(), 'sentry-inproc-'));
    stubs.push(dir);
    const fake = join(dir, 'claude');
    writeFileSync(fake, `#!/bin/sh\ncat >/dev/null\n${script}`);
    chmodSync(fake, 0o755);
    vi.stubEnv('PATH', `${dir}:${process.env.PATH}`);
  };
  afterEach(() => {
    vi.unstubAllEnvs();
    while (stubs.length) rmSync(stubs.pop(), { recursive: true, force: true });
  });

  it('healthy SKIP across 2 samples → a verdict object (the loop ran without bailing)', () => {
    stubOnPath('echo SKIP\n');
    expect(judge('COMMIT:\nfix(x): y', { model: 'haiku', samples: 2 })?.verdict).toBe('SKIP');
  });

  it('dark judge with samples=3 → bails on the first sample: null + exactly ONE warning', () => {
    stubOnPath('exit 3\n');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(judge('COMMIT:\nfix(x): y', { model: 'haiku', samples: 3 })).toBeNull();
    const warns = err.mock.calls.filter((c) => String(c[0]).includes('claude judge unavailable'));
    expect(warns).toHaveLength(1); // bail-once: not three warnings
  });
});
