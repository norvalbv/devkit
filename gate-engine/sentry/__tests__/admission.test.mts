// The sentry judge's admission: which commits reach the LLM, decided from the staged diff. The table
// pins the pure rule; the spawned runs pin the gate wiring against a real index, merge and sink.

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { sentrySkipCause, skipLine, subjectOf } from '../admission.mts';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'check-sentry.mts');

/** One file's staged diff segment with a single hunk of the given body lines. */
const seg = (path: string, ...body: string[]) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,3 +1,4 @@ function f() {\n${body.join('\n')}\n`;

const SRC_ADDS_CATCH = seg('src/flow.ts', ' run();', '+} catch (e) {', '+  return false;', ' }');
const SRC_NO_TOKEN = seg(
  'src/flow.ts',
  ' const run = get(id);',
  '+if (!run) return;',
  ' advance(run);',
);
const SRC_CONTEXT_CATCH = seg('src/flow.ts', '-const a = 1;', '+const a = 2;', ' } catch (e) {');
const SRC_ADDS_CAPTURE = seg('src/flow.ts', ' x();', '+captureContained(err);');
const README = seg('README.md', '+Retry, or catch the error and throw it again.');
const TEST_ONLY = seg('src/__tests__/flow.test.ts', '+try { run(); } catch (e) { fail(e); }');
// A capture look-alike on another receiver is local error plumbing, not instrumentation.
const SRC_STACK_TRACE = seg('src/err.ts', ' super(msg);', '+Error.captureStackTrace(this);');
const SRC_REMOVES_CATCH = seg('src/flow.ts', ' run();', '-} catch (e) {', '-  report(e);', ' }');

describe('sentrySkipCause', () => {
  it.each([
    // Deleting error handling is a change to it: only `+` lines would let a removed capture slip by.
    [
      'a source line removing a catch → judged',
      'Simplify the runner',
      SRC_REMOVES_CATCH,
      false,
      null,
    ],
    // The token scan runs on source files only, so a doc's prose cannot admit a plain source edit.
    [
      'a docs catch beside a token-free source edit → skipped',
      'Tidy the runner',
      README + SRC_NO_TOKEN,
      false,
      'no_source_error_hunk',
    ],
    [
      'plain-English subject + a source line adding catch → judged (AC1)',
      'Recover torn flow runs',
      SRC_ADDS_CATCH,
      false,
      null,
    ],
    [
      'Error.captureStackTrace is not a capture → skipped',
      'Keep error stacks',
      SRC_STACK_TRACE,
      false,
      'no_source_error_hunk',
    ],
    [
      'plain-English subject + an added capture → judged',
      'Report reconnect failures',
      SRC_ADDS_CAPTURE,
      false,
      null,
    ],
    ['docs-only diff → skipped (AC2)', 'Explain retries', README, false, 'no_staged_source'],
    // Every common docs extension is docs, not source, so its prose never admits on content.
    ...['README.markdown', 'guide.adoc', '.cursor/rules/x.mdc'].map((path) => [
      `${path} only → skipped`,
      'Explain retries',
      seg(path, '+Please try again, or catch it.'),
      false,
      'no_staged_source',
    ]),
    [
      'test-only diff → skipped (AC2)',
      'Cover the retry path',
      TEST_ONLY,
      false,
      'no_staged_source',
    ],
    [
      'typed subject on a docs-only diff → still skipped',
      'fix(docs): retry section',
      README,
      false,
      'no_staged_source',
    ],
    [
      'typed subject, source change with no error token → judged',
      'fix(flows): skip vanished runs',
      SRC_NO_TOKEN,
      false,
      null,
    ],
    [
      'untyped subject, source change with no error token → skipped',
      'Skip vanished runs',
      SRC_NO_TOKEN,
      false,
      'no_source_error_hunk',
    ],
    [
      'a catch only on a context line admits nothing',
      'Bump a constant',
      SRC_CONTEXT_CATCH,
      false,
      'no_source_error_hunk',
    ],
    [
      'git could not read the diff → judged (fail toward judging)',
      'Recover torn flow runs',
      null,
      false,
      null,
    ],
    ['nothing staged, typed subject → judged (message only)', 'fix: reword', '', false, null],
    ['nothing staged, untyped subject → skipped', 'Reword', '', false, 'untyped_no_diff'],
    [
      'a merge → skipped, whatever it inherits',
      'Merge main into feature',
      SRC_ADDS_CATCH,
      true,
      'merge_commit',
    ],
    ['empty message → skipped', '# only a comment\n', SRC_ADDS_CATCH, false, 'empty_message'],
  ])('%s', (_name, message, diff, merging, cause) => {
    expect(sentrySkipCause(message, diff, merging)).toBe(cause);
  });

  it('reads the subject past leading comment and blank lines', () => {
    expect(subjectOf('# a comment\n\nfix(api): map FK violations')).toBe(
      'fix(api): map FK violations',
    );
  });

  it('names the cause on every skip line, under the sentry-judge prefix (AC3)', () => {
    expect(skipLine('no_staged_source')).toBe(
      'sentry-judge: SKIP (only test or docs files are staged — not judged)',
    );
  });
});

describe('check-sentry --gate admission against a real index', () => {
  const dirs: string[] = [];
  const tmp = (prefix: string) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const git = (cwd: string, ...args: string[]) =>
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      cwd,
      encoding: 'utf8',
    });

  /** A repo with one committed source file, so the next staged edit is a real hunk. */
  const repo = () => {
    const cwd = tmp('sentry-admit-');
    git(cwd, 'init', '-q', '-b', 'main');
    mkdirSync(join(cwd, 'src'));
    writeFileSync(join(cwd, 'src/flow.ts'), 'export function f() {\n  run();\n}\n');
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-qm', 'init');
    return cwd;
  };

  /** A fake `claude` that records its stdin and answers SKIP, plus a private store and sink. */
  const judgeEnv = () => {
    const bin = tmp('sentry-stub-');
    const seen = join(bin, 'stdin.txt');
    const fake = join(bin, 'claude');
    writeFileSync(fake, `#!/bin/sh\ncat >>'${seen}'\necho SKIP\n`);
    chmodSync(fake, 0o755);
    const sink = join(bin, 'events.jsonl');
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GUARD_REVIEW_MODEL: 'haiku',
      DEVKIT_RUN_MODE: 'review',
      DEVKIT_REVIEW_DATA_ROOT: tmp('sentry-store-'),
      DEVKIT_GATE_EVENTS: sink,
    };
    const read = (f: string) => {
      try {
        return readFileSync(f, 'utf8');
      } catch {
        return '';
      }
    };
    return { env, stdin: () => read(seen), events: () => read(sink) };
  };

  const gate = (cwd: string, env: NodeJS.ProcessEnv, msg: string) =>
    spawnSync('node', [SCRIPT, '--gate', msg], { cwd, env, encoding: 'utf8' });

  it('a plain-English subject staging a new catch reaches the judge (AC1)', () => {
    const cwd = repo();
    writeFileSync(
      join(cwd, 'src/flow.ts'),
      'export function f() {\n  try { run(); } catch (e) { return false; }\n}\n',
    );
    git(cwd, 'add', '.');
    const j = judgeEnv();
    const r = gate(cwd, j.env, 'Recover torn flow runs without a restart');
    expect(r.status).toBe(0);
    expect(j.stdin()).toContain('catch (e)');
    expect(r.stderr).toContain('sentry-judge: PASS');
  });

  it('the message tier still reads the staged diff to admit a plain-English subject', () => {
    const cwd = repo();
    writeFileSync(
      join(cwd, 'src/flow.ts'),
      'export function f() {\n  try { run(); } catch {}\n}\n',
    );
    git(cwd, 'add', '.');
    const j = judgeEnv();
    const r = gate(cwd, { ...j.env, GUARD_SENTRY_CONTEXT: 'message' }, 'Recover torn flow runs');
    expect(r.status).toBe(0);
    expect(j.stdin()).toContain('Recover torn flow runs');
    expect(r.stderr).not.toContain('sentry-judge: SKIP');
  });

  it('an unreadable staged diff still reaches the judge (fail toward judging)', () => {
    const j = judgeEnv();
    const r = gate(tmp('sentry-nogit-'), j.env, 'Recover torn flow runs without a restart');
    expect(r.status).toBe(0);
    expect(j.stdin()).toContain('Recover torn flow runs');
    expect(r.stderr).not.toContain('sentry-judge: SKIP');
  });

  it('a test-only diff skips without calling the judge, names why, and emits judge_skipped', () => {
    const cwd = repo();
    mkdirSync(join(cwd, 'src/__tests__'));
    writeFileSync(join(cwd, 'src/__tests__/flow.test.ts'), 'try { f(); } catch (e) { throw e; }\n');
    git(cwd, 'add', '.');
    const j = judgeEnv();
    const r = gate(cwd, j.env, 'Cover the flow retry path');
    expect(r.status).toBe(0);
    expect(j.stdin()).toBe('');
    expect(r.stderr).toContain(skipLine('no_staged_source'));
    const rows = j
      .events()
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(rows).toContainEqual(
      expect.objectContaining({
        type: 'judge_skipped',
        judge: 'sentry-advisory',
        reason: 'no_staged_source',
      }),
    );
  });

  it('a merge skips, even when the branch it brings in adds a catch', () => {
    const cwd = repo();
    git(cwd, 'switch', '-qc', 'feature');
    writeFileSync(join(cwd, 'src/other.ts'), 'export const g = 1;\n');
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-qm', 'feature work');
    git(cwd, 'switch', '-q', 'main');
    writeFileSync(
      join(cwd, 'src/flow.ts'),
      'export function f() {\n  try { run(); } catch (e) { return false; }\n}\n',
    );
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-qm', 'main swallows');
    git(cwd, 'switch', '-q', 'feature');
    expect(git(cwd, 'merge', '--no-commit', '--no-ff', 'main').status).toBe(0);
    const j = judgeEnv();
    const r = gate(cwd, j.env, "Merge branch 'main' into feature");
    expect(r.status).toBe(0);
    expect(j.stdin()).toBe('');
    expect(r.stderr).toContain(skipLine('merge_commit'));
  });
});
