// sc-2341: with fallow selected the devkit block must carry the staged gate, and a merge-base
// `fallow audit --base` pasted OUTSIDE it is an advisory devkit cannot remove.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectResults } from '../commands/doctor.mts';
import { check } from '../lib/doctor/check-result.mts';
import { checkFallowHook, mergeBaseFallowLines } from '../lib/doctor/fallow/fallow-hook-check.mts';
import { buildGuardBlock } from '../lib/husky/husky-block.mts';
import { markEnd, markStart } from '../lib/husky/husky.mts';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// fallow's own printed fallback, verbatim shape (sc-2341 story).
const PASTED = `command -v fallow >/dev/null 2>&1 || exit 0
UPSTREAM="$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)"
BASE="main"
fallow audit --base "$BASE" --quiet --gate-marker pre-commit`;

function repoWithHook(hook: string, pkgName = 'consumer-app'): string {
  const root = mkdtempSync(join(tmpdir(), 'dk-fallow-doctor-'));
  roots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: pkgName }));
  mkdirSync(join(root, '.husky'));
  writeFileSync(join(root, '.husky', 'pre-commit'), hook);
  return root;
}

const block = (fallow: boolean) => buildGuardBlock({ guards: ['review'], fallow });
// doctor --fix re-runs init only for fixable rows NAMED like this (HOOK_CHECKS in doctor.mts).
const NAME = '.husky/pre-commit';
const GATE_DETAIL = 'no staged fallow gate';

describe('mergeBaseFallowLines', () => {
  it('flags the pasted merge-base audit with its 1-based line', () => {
    const hook = `#!/bin/sh\n${PASTED}\n${block(true)}\n`;
    expect(mergeBaseFallowLines(hook)).toEqual([5]);
  });

  it('ignores the same text INSIDE any devkit block, including a monorepo package block', () => {
    const inner = `${markStart('pkg/a')}\nfallow audit --base "$BASE"\n${markEnd('pkg/a')}`;
    expect(mergeBaseFallowLines(`#!/bin/sh\n${inner}\n`)).toEqual([]);
  });

  // Continuations are one command: env-prefix, flag or the whole tail may sit on a later line.
  it.each([
    ['fallow audit \\\n  --base "$BASE" --quiet', [2]],
    ['FALLOW_AUDIT=1 \\\n  fallow audit --base main', [2]],
    ['fallow audit --quiet \\\n  --gate-marker pre-commit \\\n  --base "$B"', [2]],
    ['fallow audit \\\n  --diff-stdin', []],
  ])('joins backslash continuations: %j', (body, want) => {
    expect(mergeBaseFallowLines(`#!/bin/sh\n${body}\n`)).toEqual(want);
  });

  // A heredoc body is data, whatever it says; the lines after its terminator are code again.
  it.each([
    ['cat <<EOF\nfallow audit --base main\nEOF', []],
    ["cat <<'EOF'\nfallow audit --base main\nEOF\nfallow audit --base x", [4]],
    ['cat <<-EOF\n\tfallow audit --base main\n\tEOF\nfallow audit --base y', [4]],
    ['echo "<<EOF"\nfallow audit --base main', [2]],
    ['fallow audit --base m <<EOF\ninput\nEOF', [1]],
    // An UNQUOTED heredoc expands `$(…)`, so that body line really runs.
    ['cat <<EOF\n$(fallow audit --base main)\nEOF', [2]],
    ["cat <<'EOF'\n$(fallow audit --base main)\nEOF", []],
  ])('heredoc bodies are data: %j', (hook, want) => {
    expect(mergeBaseFallowLines(hook)).toEqual(want);
  });

  // Marker TEXT inside a heredoc body is data: it opens no block and hides nothing after it.
  it.each([
    [`cat <<EOF\n${markStart()} documentation\nEOF\nfallow audit --base main`, [4]],
    [`cat <<-EOF\n\t${markStart()}\n\tEOF\nfallow audit --base main`, [4]],
    [`cat <<EOF\n${markEnd()}\nEOF\n${markStart()}\nfallow audit --base x\n${markEnd()}`, []],
    [`${markStart()}\ncat <<EOF\n${markEnd()}\nEOF\nfallow audit --base y\n${markEnd()}`, []],
  ])('a marker inside a heredoc is data: %j', (hook, want) => {
    expect(mergeBaseFallowLines(hook)).toEqual(want);
  });

  // Only the EXACT marker lines open a block; a comment that merely starts the same way does not.
  it('a look-alike comment opens no block and hides nothing', () => {
    const hook = [
      '# >>> devkit-guards are discussed below',
      'fallow audit --base main',
      '# <<< devkit-guards are discussed below',
    ].join('\n');
    expect(mergeBaseFallowLines(hook)).toEqual([2]);
  });

  // Comment lines stay comments inside compound commands; only heredoc / multi-line string text is data.
  it.each([
    [`if true; then\n${markStart()}\nfallow audit --base x\n${markEnd()}\nfi`, []],
    [`if true; then\n  fallow audit --base y\nfi`, [2]],
    [
      `{\n${markStart('pkg/a')}\n( fallow audit --base x )\n${markEnd('pkg/a')}\n}\nfallow audit --base z`,
      [6],
    ],
    [`echo "\n${markStart()}\n"\nfallow audit --base z\n${markEnd()}`, [4]],
  ])('nested blocks and multi-line strings: %j', (hook, want) => {
    expect(mergeBaseFallowLines(hook)).toEqual(want);
  });

  it('a stray second end marker does not re-close the block over a later audit', () => {
    const hook = [markStart(), 'true', markEnd(), 'fallow audit --base main', markEnd()].join('\n');
    expect(mergeBaseFallowLines(hook)).toEqual([4]);
  });

  // A function body runs only where the function is CALLED — that call site is the finding.
  it.each([
    ['legacy() { fallow audit --base main; }', []],
    ['legacy() { fallow audit --base main; }\nlegacy', [2]],
    ['legacy() {\n  fallow audit --base main\n}\nif true; then\n  legacy\nfi', [5]],
    ['outer() { inner; }\ninner() { fallow audit --base m; }\nouter', [3]],
    ['loop() { loop; }\nloop', []],
    ["eval 'legacy() { fallow audit --base m; }; legacy'", [1]],
    ['echo legacy\nlegacy() { fallow audit --base m; }', []],
    // Not yet defined at the call: the shell runs `command not found`, not the later body.
    ['run_audit\nrun_audit() { fallow audit --base main; }', []],
    ['run_audit() { fallow audit --base main; }\nrun_audit', [2]],
    ["sh -c 'f() { fallow audit --base m; }'\nf", []],
    // Branches are not evaluated: only an UNCONDITIONAL definition counts (under-report, by design).
    ['if false; then legacy() { fallow audit --base main; }; fi\nlegacy', []],
    ['true && legacy() { fallow audit --base main; }\nlegacy', []],
    ['( legacy() { fallow audit --base main; } )\nlegacy', []],
    ['{ legacy() { fallow audit --base main; }; }\nlegacy', [2]],
  ])('function bodies are judged at their call sites: %j', (hook, want) => {
    expect(mergeBaseFallowLines(hook)).toEqual(want);
  });

  it('flags a paste sitting BETWEEN two package blocks', () => {
    const hook = [
      markStart('pkg/a'),
      markEnd('pkg/a'),
      'fallow audit --base origin/main',
      markStart('pkg/b'),
      markEnd('pkg/b'),
    ].join('\n');
    expect(mergeBaseFallowLines(hook)).toEqual([3]);
  });

  // A mention is not an invocation: quoted data, comments, and arguments to another command.
  it.each([
    '# fallow audit --base "$BASE"',
    '  # fallow audit --base main',
    'echo "fallow audit --base was removed"',
    'echo fallow audit --base x',
    "printf '%s' 'fallow audit --base x'",
    'HELP="run fallow audit --base main"',
    'git diff --cached | fallow audit --diff-stdin',
    'fallow audit --diff-stdin # was --base',
    'fallow audit --baseline-file x.json',
    'myfallow audit --base x',
    ': fallow audit --base x',
    'echo "x; y" fallow audit --base main',
    // `--base` belongs to a DIFFERENT command than the audit.
    'fallow audit --diff-stdin; echo --base main',
    'fallow audit --diff-stdin && git log --base',
    'fallow audit --diff-stdin | tee --base',
    '(fallow audit --diff-stdin) --base',
    "echo '$(fallow audit --base m)'",
    'echo "$(echo fallow audit --base m)"',
    "sh -c 'echo fallow audit --base main'",
    "sh -c 'fallow audit --diff-stdin' --base",
    // After the first operand, `-c` belongs to the SCRIPT being run, not to the shell.
    "sh ./hook-helper -c 'fallow audit --base main'",
    "bash -- -c 'fallow audit --base main'",
    // A wrapper in front of a mention command is still a mention.
    'command echo fallow audit --base main',
    'sudo echo fallow audit --base main',
    'env FOO=1 printf fallow audit --base main',
    'command -v fallow audit --base main',
    './scripts/notify.sh fallow audit --base main',
    "echo env -S 'fallow audit --base main'",
    "env -S 'echo fallow audit --base main'",
    'env --help fallow audit --base main',
    'sudo --version fallow audit --base main',
  ])('a mention is not flagged: %s', (line) => {
    expect(mergeBaseFallowLines(line)).toEqual([]);
  });

  it.each([
    'FALLOW_X=1 fallow audit --base main',
    'npx fallow audit --base main',
    'fallow audit "--base" main',
    'fallow audit --base=main',
    'git diff | true && fallow audit --quiet --base "$B"',
    // Any wrapper still runs it — the classifier denies mentions rather than allowing runners.
    'sudo fallow audit --base main',
    'doas -u ci fallow audit --base main',
    'timeout 60 fallow audit --base main',
    'MSG="a;b" fallow audit --base main',
    '! fallow audit --base main',
    'fallow audit --msg "a;b" --base main',
    // Command substitution runs its command even inside double quotes.
    'OUT="$(fallow audit --base "$BASE")"',
    'OUT=`fallow audit --base main`',
    'OUT="`fallow audit --base main`"',
    'echo "$(fallow audit --base main)"',
    // Quoting the command name or pathing it changes nothing about what runs.
    '"fallow" audit --base main',
    "'fallow' 'audit' '--base' main",
    '/usr/local/bin/fallow audit --base main',
    // A string run AS SHELL is code too, behind any wrapper.
    "sh -c 'fallow audit --base main'",
    'bash -lc "fallow audit --quiet --base main"',
    "sudo /bin/sh -c 'cd x && fallow audit --base main'",
    "eval 'fallow audit --base main'",
    "bash -e -o pipefail -c 'fallow audit --base main'",
    "sh -c -- 'fallow audit --base main'",
    'command fallow audit --base main',
    'env -u HOME FOO=1 fallow audit --base main',
    'sudo -u ci nice -n 5 fallow audit --base main',
    'timeout -s KILL 60 fallow audit --base main',
    'pnpm exec fallow audit --base main',
    "sudo sh -c 'fallow audit --base main'",
    // `env -S` splits ONE string into the command line it runs.
    `env -S 'sh -c "fallow audit --base main"'`,
    "env -S 'fallow audit' --base main",
    "env --split-string='fallow audit --base main'",
  ])('a real invocation is flagged: %s', (line) => {
    expect(mergeBaseFallowLines(line)).toEqual([1]);
  });

  it('catches an indented, mid-line merge-base audit', () => {
    expect(mergeBaseFallowLines('  if true; then fallow audit --quiet --base "$B"; fi')).toEqual([
      1,
    ]);
  });
});

describe('checkFallowHook', () => {
  it('fallow unselected → no staged-gate demand, but a pasted merge-base audit still runs → advisory', () => {
    const clean = repoWithHook(`#!/bin/sh\n${block(false)}\n`);
    expect(checkFallowHook(clean, false)).toEqual([]);
    expect(checkFallowHook(clean, undefined)).toEqual([]);
    const pasted = checkFallowHook(repoWithHook(`#!/bin/sh\n${PASTED}\n${block(false)}\n`), false);
    expect(pasted).toHaveLength(1);
    expect(pasted[0]).toMatchObject({ advisory: true, fixable: false });
    expect(pasted[0]?.remediation).toContain('re-enable fallow');
  });

  it('no hook → no rows (checkHusky owns the MISSING report)', () => {
    const root = mkdtempSync(join(tmpdir(), 'dk-fallow-doctor-'));
    roots.push(root);
    execFileSync('git', ['init', '-q'], { cwd: root });
    expect(checkFallowHook(root, true)).toEqual([]);
  });

  it('an unreadable hook (a directory where the file should be) → no rows, never a throw', () => {
    const root = mkdtempSync(join(tmpdir(), 'dk-fallow-doctor-'));
    roots.push(root);
    execFileSync('git', ['init', '-q'], { cwd: root });
    mkdirSync(join(root, '.husky', 'pre-commit'), { recursive: true });
    expect(checkFallowHook(root, true)).toEqual([]);
  });

  it('a pre-sc-2341 block without the staged gate is fixable DRIFT', () => {
    const root = repoWithHook(`#!/bin/sh\n${block(false)}\n`);
    const [row] = checkFallowHook(root, true);
    expect(row).toMatchObject({ name: NAME, status: 'DRIFT', fixable: true });
    expect(row.advisory).toBe(false);
  });

  it('a current block is clean', () => {
    expect(checkFallowHook(repoWithHook(`#!/bin/sh\n${block(true)}\n`), true)).toEqual([]);
  });

  const advisoryOnly = () =>
    block(false).replace(
      markEnd(),
      `# devkit:fallow-advisory\ntrue\n# /devkit:fallow-advisory\n${markEnd()}`,
    );

  it("devkit's own repo: hook-parity owns the exact block, so no staged-gate row", () => {
    for (const hook of [advisoryOnly(), block(false)]) {
      expect(
        checkFallowHook(repoWithHook(`#!/bin/sh\n${hook}\n`, '@norvalbv/devkit'), true),
      ).toEqual([]);
    }
  });

  it('the marker alone, without the executable audit, is still fixable DRIFT', () => {
    const markerOnly = block(false).replace(
      markEnd(),
      `# devkit:fallow\ntrue\n# /devkit:fallow\n${markEnd()}`,
    );
    const [row] = checkFallowHook(repoWithHook(`#!/bin/sh\n${markerOnly}\n`), true);
    expect(row).toMatchObject({ status: 'DRIFT', fixable: true });
  });

  it('a consumer carrying only the advisory marker is still ungated → fixable DRIFT', () => {
    const [row] = checkFallowHook(repoWithHook(`#!/bin/sh\n${advisoryOnly()}\n`), true);
    expect(row).toMatchObject({ status: 'DRIFT', fixable: true });
  });

  it('a pasted merge-base audit is an ADVISORY, not fixable, naming the line', () => {
    const root = repoWithHook(`#!/bin/sh\n${PASTED}\n${block(true)}\n`);
    const rows = checkFallowHook(root, true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'DRIFT', fixable: false, advisory: true });
    expect(rows[0].detail).toContain('line 5');
  });

  it('both findings at once: stale block AND a paste → two rows', () => {
    const root = repoWithHook(`#!/bin/sh\n${PASTED}\n${block(false)}\n`);
    expect(checkFallowHook(root, true).map((r) => r.fixable)).toEqual([true, false]);
  });

  it('no devkit block at all → only the paste is reported (checkHusky owns the missing block)', () => {
    const rows = checkFallowHook(repoWithHook(`#!/bin/sh\n${PASTED}\n`), true);
    expect(rows.map((r) => r.advisory)).toEqual([true]);
  });
});

// Wiring: each unit above can pass while doctor never calls it.
describe('devkit doctor reaches the fallow check', () => {
  const CONFIG_OK = check('config.json', 'OK', '');
  const cfg = (fallow: boolean) => ({
    components: { husky: true, biome: false, tsconfig: false, guards: ['review'], fallow },
  });

  it('reports the stale block through collectResults when fallow is recorded on', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const root = repoWithHook(`#!/bin/sh\n${block(false)}\n`);
    const { results } = await collectResults(root, cfg(true), CONFIG_OK);
    expect(results.find((r) => r.detail.includes(GATE_DETAIL))).toMatchObject({
      name: NAME,
      status: 'DRIFT',
      fixable: true,
    });
  });

  it('fallow recorded off: no staged-gate row, but a pasted merge-base audit is still reported', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const root = repoWithHook(`#!/bin/sh\n${PASTED}\n${block(false)}\n`);
    const { results } = await collectResults(root, cfg(false), CONFIG_OK);
    expect(results.find((r) => r.detail.includes(GATE_DETAIL))).toBeUndefined();
    expect(
      results.find((r) => r.detail.includes('merge-base fallow audit reachable')),
    ).toMatchObject({
      advisory: true,
    });
  });
});
