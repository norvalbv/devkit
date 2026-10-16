/** Executable labels for backend-performance source rows, kept outside judge-visible trees. The
 * cost invariant must hold in the base and break in the buggy postimage. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

interface HookRun {
  reported: string[];
  starts: number;
}
interface Row {
  id: string;
  reasonPattern: string;
  repo: { base: Record<string, string>; staged: Record<string, string> };
}

const GOLD = 'beperf-cli-per-staged-file-git-show';
const rows: Row[] = readFileSync(
  new URL('../cases-backend-performance.jsonl', import.meta.url),
  'utf8',
)
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));
const gold = rows.find((row) => row.id === GOLD);
if (!gold) throw new Error(`${GOLD} is missing from cases-backend-performance.jsonl`);
const VARIANTS = { base: gold.repo.base, bug: { ...gold.repo.base, ...gold.repo.staged } };
type Variant = keyof typeof VARIANTS;
const SMALL = 10;
const BIG = 50;
const ADDED = 'zq7 distinctive note no committed file contains';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function write(root: string, files: Record<string, string>): void {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
}

/** The variant's hook and `committed` live in HEAD, so only `stage` can add comment text. */
function hookRepo(
  variant: Variant,
  committed: Record<string, string>,
  stage: (root: string) => void,
): string {
  const root = tmp('beperf-control-');
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'control@example.test']);
  git(root, ['config', 'user.name', 'Control Test']);
  write(root, { ...VARIANTS[variant], ...committed });
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'base']);
  stage(root);
  return root;
}

/** The hook's reported comments and how many git processes it started. */
function runHook(root: string): HookRun {
  const trace = join(tmp('beperf-control-trace-'), 'trace2.json');
  const code =
    "const hook = await import('./api/hooks/comment-gate.mjs'); console.log(JSON.stringify(hook.checkComments()));";
  const stdout = execFileSync(process.execPath, ['--input-type=module', '--eval', code], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GIT_TRACE2_EVENT: trace },
    timeout: 30000,
  });
  const starts = (existsSync(trace) ? readFileSync(trace, 'utf8') : '')
    .split('\n')
    .filter((line) => line.includes('"event":"start"')).length;
  expect(starts, 'no git process recorded, so the count proves nothing').toBeGreaterThan(0);
  return { reported: JSON.parse(stdout), starts };
}

function generated(n: number): Record<string, string> {
  return Object.fromEntries(
    Array.from({ length: n }, (_, i) => [
      `dist/f${i}.mjs`,
      `// generated helper ${i}\nexport const g${i} = 0;\n`,
    ]),
  );
}

/** Git processes per deleted generated file, optionally with one new comment staged alongside. */
function slope(variant: Variant, addComment: boolean): number {
  const [small, big] = [SMALL, BIG].map((n) =>
    runHook(
      hookRepo(variant, generated(n), (root) => {
        git(root, ['rm', '-rq', 'dist']);
        if (!addComment) return;
        write(root, { 'src/note.mjs': `// ${ADDED}\nexport {};\n` });
        git(root, ['add', 'src/note.mjs']);
      }),
    ),
  );
  expect(big.reported).toEqual(addComment ? [ADDED] : []);
  return (big.starts - small.starts) / (BIG - SMALL);
}

describe(`${GOLD} control`, () => {
  for (const addComment of [false, true]) {
    it(`only the bug starts git per deleted file (${addComment ? 'one comment added' : 'none added'})`, () => {
      expect(slope('base', addComment)).toBe(0);
      expect(slope('bug', addComment)).toBeGreaterThanOrEqual(1);
    });
  }

  it('the bug excuses a comment moved out of a deleted file once', () => {
    const moved = '// keep the retry budget\n';
    const reported = (variant: Variant) =>
      runHook(
        hookRepo(
          variant,
          { 'src/old.mjs': `${moved}export const alpha = 1;\nexport const beta = 2;\n` },
          (root) => {
            git(root, ['rm', '-q', 'src/old.mjs']);
            write(root, {
              'src/retry.mjs': `${moved}export function retry() {}\n`,
              'src/backoff.mjs': `${moved}export function backoff() {}\n`,
            });
            git(root, ['add', 'src']);
          },
        ),
      ).reported;
    expect(reported('base')).toEqual(['keep the retry budget', 'keep the retry budget']);
    expect(reported('bug')).toEqual(['keep the retry budget']);
  });

  // A wrong-item FAIL earns pattern-only credit from this regex, matched the way scoreRow does.
  it('reasonPattern credits the per-file scaling finding, not the event-loop framing', () => {
    const credits = (text: string) => new RegExp(gold.reasonPattern, 'i').test(text);
    // The current wording's observed findings on this row.
    expect(
      credits(
        'moved-comments.mjs spawns `git diff` + `git show` per staged file (about 2N processes) where one batched diff plus `git cat-file --batch` would serve (sync-io)',
      ),
    ).toBe(true);
    expect(
      credits(
        'api/hooks/moved-comments.mjs:21-22 — removedCommentPool loops the staged M/R/D set and removedText spawns git diff (removedLines) + git show per file: ~2N execFileSync per commit.',
      ),
    ).toBe(true);
    expect(
      credits('execFileSync in moved-comments.mjs blocks the event loop; use the async execFile'),
    ).toBe(false);
    expect(
      credits(
        'no backend performance findings in the staged hook changes; the sync git calls run only in the pre-commit CLI path.',
      ),
    ).toBe(false);
  });
});
