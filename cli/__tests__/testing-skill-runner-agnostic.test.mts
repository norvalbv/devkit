import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Source tree, not packageDir(): this must fail on an edit to the checked-in skill, before any sync
// or dist build has had a chance to propagate it.
const SKILL = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'skills',
  'testing',
  'SKILL.md',
);

/** Runner-specific literals — output shapes and tool names that are true for one runner only. */
const RUNNER_SPECIFIC = [
  /Test Files/,
  /=== N passed/,
  /\bvitest\b/i,
  /\bpytest\b/i,
  /\bjest\b/i,
  /\bgo test\b/i,
];

/** The marker that demotes a line from "rule" to "illustration". */
const LABELLED = /labelled example/i;

describe('the testing skill stays runner-agnostic', () => {
  const lines = readFileSync(SKILL, 'utf8').split('\n');

  it('still claims to be stack-agnostic (guards against a vacuous pass)', () => {
    // If this promise is ever dropped, the rule below stops being the right one to enforce — better
    // to fail here and force the decision than to keep policing a contract the file no longer makes.
    expect(readFileSync(SKILL, 'utf8')).toContain('agnostic');
  });

  it('names a runner only inside a labelled example', () => {
    const offenders = lines
      .map((line, i) => ({ line, at: i + 1 }))
      .filter(({ line }) => RUNNER_SPECIFIC.some((re) => re.test(line)) && !LABELLED.test(line));

    expect(
      offenders,
      `skills/testing/SKILL.md is synced verbatim into every consumer repo, so a runner named outside a labelled example becomes a false rule for every other runner. Rephrase in terms of "its runner", and put the concrete string in a "(labelled examples: …)" aside.\n${offenders
        .map(({ at, line }) => `  :${at} ${line.trim()}`)
        .join('\n')}`,
    ).toEqual([]);
  });

  it('teaches that a run without a summary is truncated rather than failed', () => {
    const body = readFileSync(SKILL, 'utf8');
    // The behaviour, not the wording: a reader must be told to re-run, and told that a
    // signal-terminated run is not a failure. Both are what the original incident got wrong.
    expect(body).toMatch(/truncated, not failed/i);
    expect(body).toMatch(/signal/i);
  });
});
