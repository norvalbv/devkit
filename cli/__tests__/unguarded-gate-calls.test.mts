/**
 * sc-1366. Every row of the `-e` table below was measured against a real shell before it was
 * encoded, because two earlier drafts of this check had the `if` rule backwards — they treated an
 * enclosing `if` as a guard, when `-e` shields only the CONDITION list. That version would have
 * found 1 of the 8 real hazards in the hook it was designed against.
 *
 * The suite therefore does two things: it pins each shape, and it EXECUTES the shapes it claims
 * abort, so the table cannot quietly drift from the shell it describes.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkFailOpenGuards,
  inspectHookFailOpen,
  renderUnguardedGateCalls,
  unguardedGateCalls,
} from '../lib/doctor/unguarded-gate-calls.mts';
import { rootRegistry } from './_helpers.mts';

const { mkTmp } = rootRegistry();

/** Run a snippet under `sh -e` and report whether the trailing `echo REACHED` ran. */
function reachesUnderErrexit(snippet: string): boolean {
  try {
    const out = execFileSync('sh', ['-e', '-c', `${snippet}\necho REACHED`], { encoding: 'utf8' });
    return out.includes('REACHED');
  } catch {
    return false;
  }
}

const ABORTS: Array<[string, string]> = [
  ['plain command then capture', 'false\nrc=$?'],
  ['inside an if BODY', 'if true; then\nfalse\nrc=$?\nfi'],
  ['inside a case branch', 'case x in\nx)\nfalse\nrc=$?\n;;\nesac'],
  ['inside a subshell', '(\nfalse\nrc=$?\n)'],
  ['joined by a semicolon', 'false; rc=$?'],
  ['right operand of &&', 'true && false\nrc=$?'],
  ['command substitution assignment', 'V=$(false)\nrc=$?'],
];

const SUPPRESSED: Array<[string, string]> = [
  ['|| capture', 'false || rc=$?'],
  ['if CONDITION list', 'if false; then :; fi\nrc=$?'],
  ['! negation', '! false\nrc=$?'],
];

/**
 * Shapes the shell does not abort on, but the checker reports anyway. `false && cmd` is safe ONLY
 * because its left operand is constantly false; the same line with a test on the left
 * (`[ -n "$X" ] && gate`) aborts whenever the test passes. Which one it is cannot be known
 * statically, and staying silent would miss every real instance of the second.
 */
const OVER_REPORTED: Array<[string, string]> = [['left operand of &&', 'false && echo yes\nrc=$?']];

describe('the -e model this check encodes matches the real shell', () => {
  it.each(ABORTS)('%s aborts the script', (_name, snippet) => {
    expect(reachesUnderErrexit(snippet)).toBe(false);
  });

  it.each(SUPPRESSED)('%s does not abort', (_name, snippet) => {
    expect(reachesUnderErrexit(snippet)).toBe(true);
  });

  it.each(OVER_REPORTED)('%s does not abort with THIS left operand', (_name, snippet) => {
    expect(reachesUnderErrexit(snippet)).toBe(true);
  });

  it('…but the same shape with a passing left operand does abort', () => {
    expect(reachesUnderErrexit('true && false\nrc=$?')).toBe(false);
  });
});

describe('unguardedGateCalls', () => {
  it.each(ABORTS)('reports: %s', (_name, snippet) => {
    expect(unguardedGateCalls(snippet).length).toBeGreaterThan(0);
  });

  it.each(SUPPRESSED)('stays silent on: %s', (_name, snippet) => {
    expect(unguardedGateCalls(snippet)).toEqual([]);
  });

  it.each(OVER_REPORTED)('reports (knowingly, runtime-dependent): %s', (_name, snippet) => {
    expect(unguardedGateCalls(snippet).length).toBeGreaterThan(0);
  });

  it('joins a \\-continued command and reports the line it STARTS on', () => {
    const hook = ['CHANGED="x" \\', '    node scripts/gate.mjs --gate', 'rc=$?'].join('\n');
    const found = unguardedGateCalls(hook);
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(1); // not 2 — the tail is not the command
    expect(found[0]?.command).toContain('node scripts/gate.mjs --gate');
  });

  it('ignores a mention inside a string or a comment', () => {
    expect(unguardedGateCalls('echo "run: guard-review --gate"\n# rc=$?')).toEqual([]);
  });

  it('ignores statements inside a set +e region, and resumes after set -e', () => {
    const hook = ['set +e', 'false', 'rc=$?', 'set -e', 'node gate.mjs', 'src=$?'].join('\n');
    const found = unguardedGateCalls(hook);
    expect(found).toHaveLength(1);
    expect(found[0]?.command).toBe('node gate.mjs');
  });

  it('does not flag a capture after an inert command', () => {
    expect(unguardedGateCalls('true\nrc=$?')).toEqual([]);
  });
});

/**
 * The acceptance bar, taken from the consumer hook this check was written against (frink's
 * .husky/pre-commit, which carries 8 hazards and 6 correctly-guarded calls). Verified against the
 * real file: 8 reported, 0 false positives. Reproduced here as a fixture so the suite does not
 * depend on another repository — each block below is one of that file's real shapes.
 */
const CONSUMER_HOOK = `#!/bin/bash
# --- guarded: every call devkit generates ---
ddrc=0
__dk_no_git_env bunx guard-decisions detect --gate || ddrc=$?
rrc=0
__dk_no_git_env bunx guard-review --gate || rrc=$?
qarc=0
__dk_no_git_env bunx guard-qavis-advisory --gate || qarc=$?
cat x | bash .claude/hooks/fallow-gate.sh && fgrc=0 || fgrc=$?
guard-decisions detect --gate || ddrc=$?
guard-review --gate || rrc=$?

# --- hazard 1: plain command in an if body ---
if [ -n "$HAS_IDENTITY" ]; then
    node scripts/positioning/check-invariant.mjs --gate
    prc=$?
fi

# --- hazard 2: command substitution over a pipeline, in an if body ---
if [ -n "$STAGED_LINT" ]; then
    ESLINT_OUT=$(echo "$STAGED_LINT" | xargs ./node_modules/.bin/eslint 2>&1)
    esrc=$?
fi

# --- hazard 3: a \\-continued command whose tail is on the next line ---
MATCHER_CHANGED_FILES="$(echo "$CHANGED" | paste -sd, -)" \\
    node scripts/co-occurrence/matcher.mjs scan --new --changed --gate
rc=$?

# --- hazard 4: top level ---
guard-decisions check-alignment --gate
arc=$?
`;

describe('acceptance: the consumer hook this was written against', () => {
  const found = unguardedGateCalls(CONSUMER_HOOK);

  it('reports every hazard and nothing else', () => {
    expect(found).toHaveLength(4);
  });

  it('never flags a correctly guarded `|| rc=$?` call', () => {
    expect(found.some((f) => f.command.includes('||'))).toBe(false);
    expect(found.some((f) => f.command.includes('guard-review --gate'))).toBe(false);
  });

  it('cites the line a \\-continued command STARTS on, not its tail', () => {
    const cont = found.find((f) => f.command.includes('matcher.mjs'));
    expect(cont?.command).toContain('MATCHER_CHANGED_FILES=');
  });

  it('catches the command-substitution-over-a-pipeline shape', () => {
    expect(found.some((f) => f.command.startsWith('ESLINT_OUT=$('))).toBe(true);
  });
});

/**
 * Reviewer findings from the first ship of this branch — all four were real, none waived.
 */
describe('regressions found by the reviewer gate', () => {
  it('the RIGHT operand of || is not exempt — only the left is', () => {
    // `some_check || node gate.mjs --gate` then `rc=$?`: the gate is the list's LAST element, so
    // its failure aborts and the capture never runs. Treating any `||` as a guard was a false
    // all-clear from a checker whose entire charter is never to produce one.
    expect(reachesUnderErrexit('false || sh -c "exit 3"\nrc=$?')).toBe(false);
    const found = unguardedGateCalls('some_check || node scripts/gate.mjs --gate\nrc=$?');
    expect(found).toHaveLength(1);
    expect(found[0]?.command).toContain('node scripts/gate.mjs --gate');
    // The safe form — the capture IS the tail — stays silent, including when chained.
    expect(unguardedGateCalls('cmd || rc=$?')).toEqual([]);
    expect(unguardedGateCalls('cmd || other || rc=$?')).toEqual([]);
    expect(reachesUnderErrexit('false || false || rc=$?')).toBe(true);
  });

  it('a quoted || is not a real OR-guard (it would still abort under -e)', () => {
    // `grep -E 'a||b' file` has no shell OR-list. Reading one there drops a statement that DOES
    // abort — a false clean, the one direction this check must never fail in.
    expect(reachesUnderErrexit("grep -E 'a||b' /nonexistent-xyz\nrc=$?")).toBe(false);
    expect(unguardedGateCalls("grep -E 'a||b' file\nrc=$?")).toHaveLength(1);
    // The unquoted form is still correctly treated as guarded.
    expect(unguardedGateCalls('cmd || rc=$?')).toEqual([]);
  });

  it('a `\\` ending a COMMENT continues nothing — the next command is still reported', () => {
    // The continuation test used to run on the raw line, so a comment ending in `\` swallowed the
    // following command into the same logical line; stripComment then deleted it and the hazard
    // vanished. Verified against the shell: the gate really does run here.
    const hook = [
      '# a trailing backslash in prose \\',
      'node scripts/gate.mjs --gate',
      'rc=$?',
    ].join('\n');
    expect(reachesUnderErrexit('# note \\\nfalse\nrc=$?')).toBe(false);
    const found = unguardedGateCalls(hook);
    expect(found).toHaveLength(1);
    expect(found[0]?.command).toBe('node scripts/gate.mjs --gate');
  });

  it('a line ending in an ESCAPED backslash does not continue (odd count does, even does not)', () => {
    // `echo foo\\` ends in one literal backslash — the line is complete, so the gate on the next
    // line is its own command and must be reported. Built with String.raw so the fixture is
    // exactly the two characters the shell sees, not an escaping artefact of the test source.
    const even = 'echo foo\\\\\nnode scripts/gate.mjs --gate\nrc=$?';
    // Prove the fixture, not the escaping: line 1 must really end in TWO backslashes.
    expect(even.split('\n')[0]).toBe('echo foo\\\\');
    const found = unguardedGateCalls(even);
    expect(found).toHaveLength(1);
    expect(found[0]?.command).toBe('node scripts/gate.mjs --gate');

    // Odd count (a single `\`) genuinely continues: the two lines are ONE command, so the capture
    // that follows belongs to it and the finding is reported at the line the command STARTS on.
    const odd = 'VAR=x \\\n  node scripts/gate.mjs --gate\nrc=$?';
    expect(odd.split('\n')[0]).toBe('VAR=x \\');
    expect(unguardedGateCalls(odd)[0]?.line).toBe(1);
  });

  it('recognises the long form `set -o errexit` / `set +o errexit`', () => {
    // A hook that enables errexit the long way, with no `sh -e` runner, still aborts.
    expect(unguardedGateCalls('set -o errexit\nnode gate.mjs\nrc=$?')).toHaveLength(1);
    // …and the long-form OFF really opens a suppression region.
    expect(unguardedGateCalls('set +o errexit\nnode gate.mjs\nrc=$?')).toEqual([]);
  });

  it('catches the one-line `if …; then cmd; rc=$?; fi` shape', () => {
    // splitStatements yields `then node …` for this; skipping every statement starting with a
    // block keyword dropped the body along with the structure.
    const one = 'if [ -f package.json ]; then node scripts/check-vision.mjs --gate; vrc=$?; fi';
    expect(reachesUnderErrexit(one)).toBe(false);
    const found = unguardedGateCalls(one);
    expect(found).toHaveLength(1);
    expect(found[0]?.command).toBe('node scripts/check-vision.mjs --gate');
    // Bare structure is still skipped.
    expect(unguardedGateCalls('if true; then\ntrue\nfi\nrc=$?')).toEqual([]);
  });

  it('resolves the git root, so a monorepo subdir does not report a hook it never read', () => {
    const root = mkTmp('unguarded-mono-');
    mkdirSync(join(root, '.husky', '_'), { recursive: true });
    writeFileSync(join(root, '.husky', 'pre-commit'), 'node gate.mjs --gate\nrc=$?\n');
    writeFileSync(join(root, '.husky', '_', 'h'), '#!/usr/bin/env sh\nsh -e "$s" "$@"\n');
    execFileSync('git', ['init', '-q'], { cwd: root });
    const pkg = join(root, 'packages', 'web');
    mkdirSync(pkg, { recursive: true });

    // Called from the package subdir: must still find the hook at the git root.
    const r = checkFailOpenGuards(pkg);
    expect(r.status).not.toBe('OK');
    expect(r.detail).toMatch(/cannot fail open/);
  });

  it('a hook that was never read is MISSING, never a clean OK', () => {
    const root = mkTmp('unguarded-nohook-');
    execFileSync('git', ['init', '-q'], { cwd: root });
    const r = checkFailOpenGuards(root);
    expect(r.status).toBe('MISSING');
    expect(r.detail).toMatch(/not found/);
  });
});

describe('errexit state is tri-state and never silently clean', () => {
  const hookWithHazard = 'node scripts/gate.mjs --gate\nvrc=$?\n';

  const repo = (runner: string | null) => {
    const dir = mkTmp('unguarded-');
    mkdirSync(join(dir, '.husky', '_'), { recursive: true });
    writeFileSync(join(dir, '.husky', 'pre-commit'), hookWithHazard);
    if (runner !== null) writeFileSync(join(dir, '.husky', '_', 'h'), runner);
    return dir;
  };

  it('in-force when husky runs the hook via sh -e', () => {
    const r = inspectHookFailOpen(
      repo('#!/usr/bin/env sh\nsh -e "$s" "$@"\n'),
      '.husky/pre-commit',
    );
    expect(r.errexit).toBe('in-force');
    expect(r.calls).toHaveLength(1);
    expect(renderUnguardedGateCalls(r, '.husky/pre-commit')[0]).toContain('cannot fail open');
  });

  it('not-in-force when the runner does not use -e — nothing to report', () => {
    const r = inspectHookFailOpen(repo('#!/usr/bin/env sh\nsh "$s" "$@"\n'), '.husky/pre-commit');
    expect(r.errexit).toBe('not-in-force');
    expect(renderUnguardedGateCalls(r, '.husky/pre-commit')).toEqual([]);
  });

  it('UNVERIFIABLE — not clean — when the runner is absent (husky gitignores it)', () => {
    const r = inspectHookFailOpen(repo(null), '.husky/pre-commit');
    expect(r.errexit).toBe('unverifiable');
    expect(r.calls).toHaveLength(1);
    // The candidates must still be listed, with the caveat. A silent pass here converts
    // "nobody has looked" into "devkit says this is fine".
    expect(renderUnguardedGateCalls(r, '.husky/pre-commit').join('\n')).toContain(
      'MAY not fail open',
    );
  });

  it('names the function-body blind spot in its own output', () => {
    const r = inspectHookFailOpen(
      repo('#!/usr/bin/env sh\nsh -e "$s" "$@"\n'),
      '.husky/pre-commit',
    );
    expect(renderUnguardedGateCalls(r, '.husky/pre-commit').join('\n')).toContain(
      'Not checked: commands inside a function body',
    );
  });
});
