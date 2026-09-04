import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INHERITED_RUN_ENV, SCRUBBED_ENV, SHIP_EXPORTED_ENV } from '../../vitest.setup.mjs';

const REPO = path.resolve(import.meta.dirname, '../..');
const SETUP = path.join(REPO, 'vitest.setup.mjs');
const SHIP_SCRIPTS = ['cli/lib/ship/ship-branch.sh', 'cli/lib/ship/run-gates-with-capture.sh'];

const read = (rel: string) => readFileSync(path.join(REPO, rel), 'utf8');

/** Every DEVKIT_/GUARD_ name a shell script `export`s, read off the assignment left-hand sides. */
function exportedNames(source: string): string[] {
  const names: string[] = [];
  for (const [, tail] of source.matchAll(/^\s*export\s+(.+)$/gm)) {
    const code = tail?.replace(/\s+#.*$/, '') ?? '';
    const bare = code.match(/^([A-Z][A-Z0-9_]*)\s*$/)?.[1];
    if (bare) names.push(bare);
    for (const [, name] of code.matchAll(/\b([A-Z][A-Z0-9_]*)=/g)) if (name) names.push(name);
  }
  return [...new Set(names)].filter((n) => n.startsWith('DEVKIT_') || n.startsWith('GUARD_'));
}

/** A full outer-ship environment, valued as ship-branch.sh would actually value it. */
const SHIP_ENV = {
  DEVKIT_RUN_MODE: 'ship',
  DEVKIT_REVIEW_GUARDS: 'comments',
  DEVKIT_REVIEW_PROGRESS: '/tmp/outer/progress.json',
  DEVKIT_SHIP: '1',
  DEVKIT_SHIP_BASE_SHA: 'a'.repeat(40),
  DEVKIT_SHIP_BRANCH: 'outer/ship-branch',
  DEVKIT_SHIP_DRY_GATES: '1',
  DEVKIT_SHIP_FROM_BRANCH: '1',
  DEVKIT_SHIP_ID: 'outer-ship-id',
  DEVKIT_SHIP_INTENT_RECORDED: '1',
  DEVKIT_SHIP_MODE: 'ship',
  DEVKIT_SHIP_PATHS: 'src/a.ts\nsrc/b.ts',
  DEVKIT_SHIP_REPO: 'benordlabs/devkit',
  DEVKIT_SHIP_RESUMED: '0',
  DEVKIT_SHIP_ROOT: '/outer/ship/worktree',
  DEVKIT_SHIP_SOURCE_HEAD: 'b'.repeat(40),
  FRINK_AI_STRICT: '1',
  GUARD_AI_STRICT: '1',
  GUARD_DECISIONS_DIR: '/elsewhere/docs/decisions',
};

/** Loads vitest.setup.mjs in a clean node process and reports the env it leaves behind. */
function envAfterSetup(extra: Record<string, string>): Record<string, string | undefined> {
  const stdout = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `await import(${JSON.stringify(pathToFileURL(SETUP).href)});
       process.stdout.write(JSON.stringify(process.env));`,
    ],
    { cwd: REPO, encoding: 'utf8', env: { ...process.env, ...extra } },
  );
  return JSON.parse(stdout);
}

describe('vitest.setup.mjs scrubs inherited gate policy', () => {
  it('matches the authority list cli/lib/ship/review-target.sh unsets', () => {
    // Two scrubs of the same vocabulary, one in shell and one here. A name in only one list is a
    // hole in whichever path uses the shorter one.
    const sh = read('cli/lib/ship/review-target.sh');
    const body = sh.match(/^for name in \\\n([\s\S]*?)\ndo$/m)?.[1];
    expect(body).toBeDefined();
    const names = body?.match(/\b[A-Z][A-Z0-9_]+\b/g) ?? [];
    expect([...new Set(names)].sort()).toEqual([...INHERITED_RUN_ENV].sort());
  });

  it('covers every policy name the ship scripts actually export', () => {
    // review-target.sh guards a review ENTRYPOINT, so its list is not a superset of what a ship
    // exports downstream — the delta is the half that reaches the suite unscrubbed.
    const exported = [...new Set(SHIP_SCRIPTS.flatMap((f) => exportedNames(read(f))))];
    expect(exported.length).toBeGreaterThan(10);
    for (const name of exported) expect(SCRUBBED_ENV, name).toContain(name);
  });

  it('leaves no scrubbed name in a process launched from a ship environment', () => {
    const env = envAfterSetup(SHIP_ENV);
    for (const name of SCRUBBED_ENV) {
      // DEVKIT_GATE_EVENTS is scrubbed and then reassigned; the point is that it is no longer the
      // inherited value, which is what would let a test ship write to the developer's real sink.
      if (name === 'DEVKIT_GATE_EVENTS') continue;
      expect(env[name], name).toBeUndefined();
    }
  });

  it('scrubs the ship state qavis-advisory and completeness read at runtime', () => {
    // shipMode() branches on DEVKIT_SHIP_ROOT and then runs git against it; verdictBranch() scopes
    // a sticky verdict to DEVKIT_SHIP_BRANCH. Inherited, both answer for the OUTER ship.
    const env = envAfterSetup(SHIP_ENV);
    for (const name of [
      'DEVKIT_SHIP_ROOT',
      'DEVKIT_SHIP_BRANCH',
      'DEVKIT_SHIP_FROM_BRANCH',
      'DEVKIT_SHIP_PATHS',
      'DEVKIT_SHIP_REPO',
    ]) {
      expect(env[name], name).toBeUndefined();
    }
  });

  it('declares each name once, in exactly one provenance list', () => {
    expect(SCRUBBED_ENV).toEqual([...new Set(SCRUBBED_ENV)]);
    const overlap = SHIP_EXPORTED_ENV.filter((n: string) => INHERITED_RUN_ENV.includes(n));
    expect(overlap).toEqual([]);
  });

  it('applies to the e2e suite through the same setup file', () => {
    // vitest.e2e.config.mjs is a separate config; if it ever stops sharing this file the e2e
    // workers silently regain the leak, and no other test would notice.
    expect(read('vitest.config.mjs')).toContain("setupFiles: ['./vitest.setup.mjs']");
    expect(read('vitest.e2e.config.mjs')).toContain("setupFiles: ['./vitest.setup.mjs']");
  });

  it('redirects the inherited gate-events sink instead of honouring it', () => {
    const env = envAfterSetup({ ...SHIP_ENV, DEVKIT_GATE_EVENTS: '/real/telemetry.jsonl' });
    expect(env.DEVKIT_GATE_EVENTS).not.toBe('/real/telemetry.jsonl');
    expect(env.DEVKIT_GATE_EVENTS).toMatch(/devkit-test-gate-events-\d+\.jsonl$/);
    expect(env.DEVKIT_NO_TELEMETRY).toBe('1');
  });

  it('preserves the deliberate invocation knobs the scrub must not reach', () => {
    // SHIP_COMMIT_TIMEOUT and DEVKIT_PREFLIGHT_TIMEOUT are inputs a caller chose, not inherited
    // policy — a scrub that widened into a GUARD_*/DEVKIT_* prefix rule would silently eat them.
    const env = envAfterSetup({
      ...SHIP_ENV,
      SHIP_COMMIT_TIMEOUT: '42',
      DEVKIT_PREFLIGHT_TIMEOUT: '7',
    });
    expect(env.SHIP_COMMIT_TIMEOUT).toBe('42');
    expect(env.DEVKIT_PREFLIGHT_TIMEOUT).toBe('7');
  });
});
