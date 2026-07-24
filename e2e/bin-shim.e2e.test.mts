import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { type Fixture, makeFixture, out, REPO_ROOT } from './lib/harness.mts';

// Flow (c): every published bin, invoked THROUGH ITS SHIM.
//
// `Fixture.run` resolves a bin to `<prefix>/node_modules/.bin/<name>` — a symlink, exactly what a
// consumer's PATH hands to node. So `process.argv[1]` here is the shim path, never the real
// `dist/**.mjs`, and a run-as-main guard that compares the two without realpath'ing declines to
// dispatch: args parsed, nothing run, **exit 0 with no output**. Indistinguishable from "the gate
// ran and passed" — which is how `guard-clone scan --gate` and `guard-dup-allowlist <verb>` shipped
// dead for several releases (sc-1178), found only by comparing shim invocation against a direct
// `node <real path>` run. Every unit test drives the real path, so none of them can catch this.
//
// The assertion is the dead-dispatch signature itself — exit 0 AND completely empty stdout+stderr —
// so it generalises to all 15 bins without pinning each one's semantics. Each row supplies args (and
// stdin where the bin reads it) chosen so a LIVE bin provably speaks: a usage line, a fail-open
// notice, or a real result. `expect`, where present, additionally pins that the bin did its own
// work rather than merely printing something.
//
// cli/__tests__/bin-run-as-main.test.mts is the fast static counterpart (source grep, no build).

interface Case {
  bin: string;
  args: string[];
  /** stdin payload, for bins that read one. */
  input?: string;
  /** Substring that proves this specific bin dispatched (not just that bytes were emitted). */
  expect?: string;
}

// A fallow audit payload whose introduced dead_code finding references no attributable path, so the
// filter's fail-closed branch fires: exit 1 with the blocker on stdout. A dead shim exits 0, silent.
const FALLOW_PAYLOAD =
  '{"dead_code":{"unused_files":[{"introduced":true,"reason":"no attributable ref"}]}}';

const PKG = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));

const CASES: Case[] = [
  { bin: 'devkit', args: ['--version'], expect: PKG.version },
  // The two bins the report was filed against — given REAL work, not a usage path.
  { bin: 'guard-clone', args: ['scan', '--gate'], expect: 'jscpd' },
  { bin: 'guard-dup-allowlist', args: ['list'], expect: 'pair(s)' },
  { bin: 'guard-coverage', args: [], expect: 'Coverage gate' },
  { bin: 'guard-decisions', args: [], expect: 'Commands:' },
  // No usage path — this runs the real deterministic chain and narrates it.
  { bin: 'guard-deterministic', args: [], expect: 'matcher' },
  { bin: 'guard-dup', args: [], expect: 'co-occurrence matcher' },
  { bin: 'guard-fallow-staged', args: [], input: FALLOW_PAYLOAD, expect: 'fail-closed' },
  { bin: 'guard-fanout', args: [], expect: 'usage: guard-fanout' },
  { bin: 'guard-prefix', args: [], expect: 'Usage: guard-prefix' },
  { bin: 'guard-qavis-advisory', args: [], expect: 'Usage: guard-qavis-advisory' },
  { bin: 'guard-review', args: [], expect: 'Usage: guard-review' },
  { bin: 'guard-sentry', args: [], expect: 'sentry-judge' },
  { bin: 'guard-size', args: [], expect: 'usage: guard-size' },
  // Bare `guard-structure` defaults to `gate`, which is legitimately silent on a clean tree — an
  // unknown verb is the invocation that must speak.
  { bin: 'guard-structure', args: ['bogus-verb'], expect: 'usage: guard-structure' },
];

const created: Fixture[] = [];
afterAll(() => {
  for (const f of created) f.cleanup();
});

describe('e2e: every published bin dispatches through its bin shim', () => {
  it('covers every bin in package.json (a new bin must be added here)', () => {
    expect(CASES.map((c) => c.bin).sort()).toEqual(Object.keys(PKG.bin).sort());
  });

  it.each(CASES)('$bin $args', async ({ bin, args, input, expect: marker }) => {
    const fx = await makeFixture('devkit-e2e-shim-');
    created.push(fx);

    const r = fx.run(bin, args, { input });
    const output = out(r);

    // The dead-dispatch signature: parsed its args, ran nothing, exited clean.
    expect(
      r.status === 0 && output.trim() === '',
      `${bin} exited 0 with NO output when invoked through its bin shim — its run-as-main guard is ` +
        'not realpath-symmetric, so it never dispatched (a silently dead gate).',
    ).toBe(false);

    if (marker) expect(output).toContain(marker);
  });
});
