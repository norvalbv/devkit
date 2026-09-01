import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DETERMINISTIC } from '../gate-engine/deterministic/run.mts';
import { type Fixture, makeFixture, out } from './lib/harness.mts';

// A gate that could not evaluate its input must not exit 0.
//
// Exit 0 is the one answer indistinguishable from "I checked everything and it was clean", so a
// gate that emits it after checking NOTHING silently removes itself. Devkit has now shipped that
// defect three times: the clone gate reported 0 repo-wide for its own host repo because its
// post-filter kept only .ts/.tsx while the scan roots are .mts (clone-gate-non-import-code); the
// co-occurrence matcher opted out without saying so (gate-opt-out-is-visible-and-detectable); and
// guard-structure's `gate` verb returned 0 in half a second for any consumer without a
// structure.trees[].grammar. Each was found by hand, months apart. This pins the class instead.
//
// Sibling to bin-shim.e2e.test.mts, which pins the neighbouring failure (a bin that never
// dispatches at all). Same harness, same reason for living in e2e: only a real installed bin
// against a real repo can prove what a consumer actually gets.
//
// Deprivation is per-gate, and it is NOT the same as an empty input. A gate handed a repo with
// nothing staged, or a repo whose files are all fine, HAS evaluated its input and 0 is honest —
// the ratchets do exactly that, which is why they are deprived of their config rather than their
// baseline. Each row therefore states what is withheld and why that leaves the gate unable to
// answer at all. Do not "simplify" this into one bare fixture and a single loop: that version
// passes for the wrong reason and stops testing anything.

interface Deprivation {
  /** Registry id from DETERMINISTIC, or 'structure' (wired via --structure, not the registry). */
  id: string;
  bin: string;
  args: string[];
  /** What is withheld, and why it leaves the gate unable to reach a verdict. */
  because: string;
  env?: Record<string, string>;
  /**
   * Whether the fixture writes guard.config.json. The ratchets need it withheld: given a config
   * they evaluate fine, and "no disables, nothing over the cap" is an honest 0. What actually stops
   * them is not knowing which roots to walk.
   */
  config: boolean;
  /**
   * Whether the bin names its own reason. The ratchets opt out SILENTLY and lean on
   * guard-deterministic to narrate the skip, so a consumer running the bin directly sees nothing.
   * Pinned either way, so a gate that newly goes quiet fails here instead of passing unnoticed.
   */
  speaks: boolean;
  /**
   * Fail-open gates answer 2. Coverage is deliberately fail-CLOSED once selected (absent data is a
   * finding, not an opt-out), so it answers 1. Both satisfy the invariant; neither may be 0.
   */
  expected: 1 | 2;
}

const DEPRIVED: Deprivation[] = [
  {
    id: 'size',
    bin: 'guard-size',
    args: ['gate'],
    because: 'no guard.config.json, so the ratchet cannot know which roots to walk',
    config: false,
    speaks: false,
    expected: 2,
  },
  {
    id: 'fanout',
    bin: 'guard-fanout',
    args: ['gate'],
    because: 'no guard.config.json, so the ratchet cannot know which roots to walk',
    config: false,
    speaks: false,
    expected: 2,
  },
  {
    id: 'dup',
    bin: 'guard-dup',
    args: ['scan', '--new', '--changed', '--gate'],
    because: 'no search-code index is configured, so there are no embeddings to compare',
    config: true,
    speaks: true,
    expected: 2,
  },
  {
    id: 'clone',
    bin: 'guard-clone',
    args: ['scan', '--changed', '--gate'],
    // Withhold the ENGINE, not the input. Given a working jscpd this gate legitimately answers 0
    // on a repo with no clones — it looked, and there was nothing there.
    because: 'jscpd cannot be spawned, so no file was ever compared',
    env: { JSCPD_BIN: '/nonexistent/jscpd' },
    config: true,
    speaks: true,
    expected: 2,
  },
  {
    id: 'coverage',
    bin: 'guard-coverage',
    args: ['gate'],
    because: 'coverage/coverage-final.json is absent, so no line was ever observed',
    config: true,
    speaks: true,
    expected: 1,
  },
  {
    id: 'anti-slop',
    bin: 'devkit',
    args: ['anti-slop', 'check', '--staged'],
    because: 'the opted-in managed plugin and explicit shrink-only baseline are both absent',
    config: true,
    speaks: true,
    expected: 2,
  },
  {
    id: 'structure',
    bin: 'guard-structure',
    args: ['gate'],
    because: 'no structure.trees[].grammar is declared, so this engine has no rules to apply',
    config: true,
    speaks: true,
    expected: 2,
  },
];

const created: Fixture[] = [];
afterAll(() => {
  for (const fixture of created) fixture.cleanup();
});

describe('no gate reports clean without evaluating', () => {
  // The registry is the source of truth, so a gate added later lands here as a failure until its
  // deprivation is declared. An unlisted gate is exactly how the previous three shipped.
  it('every deterministic gate in the registry has a declared deprivation', () => {
    const declared = new Set(DEPRIVED.map((row) => row.id));
    const missing = DETERMINISTIC.map((gate) => gate.id).filter((id) => !declared.has(id));
    expect(missing).toEqual([]);
  });

  it.each(DEPRIVED)('$bin: $because → exit $expected, never 0', async (row) => {
    const fixture = await makeFixture('devkit-e2e-vacuous-');
    created.push(fixture);
    // Real source in the repo: the gate has something it WOULD check, so a 0 here could only mean
    // it never looked. Without this the fixture proves nothing.
    mkdirSync(join(fixture.repoDir, 'src'), { recursive: true });
    writeFileSync(join(fixture.repoDir, 'src', 'thing.ts'), 'export const value = 1;\n');
    if (row.config) {
      writeFileSync(
        join(fixture.repoDir, 'guard.config.json'),
        JSON.stringify({ scanRoots: ['src'] }),
      );
    }
    fixture.git('add', '--all');

    const result = fixture.run(row.bin, row.args, { env: row.env });

    expect(result.status, `${row.bin} exited 0 having not evaluated: ${out(result)}`).not.toBe(0);
    expect(result.status).toBe(row.expected);
    // Silence is the other half of the defect: an opt-out nobody can read is not an opt-out.
    expect(out(result).trim() !== '').toBe(row.speaks);
  });
});
