/**
 * Runtime tests for the knip-check.sh Stop hook (sc-1043). Guards two silent-skip regressions:
 *   - Defect C: config detection must cover ALL of knip's config forms (.knip.json, knip.js,
 *     package.json#knip, …) — not just the four the hook originally checked.
 *   - Defect D: the package.json probe must run under bun (the hook's only required runtime, line 17),
 *     not node — a node probe silently skips in a bun-only toolchain.
 * The distribution suites (install-hooks.test.mjs) treat these scripts as opaque blobs, so this is the
 * only coverage of what the hook actually DOES. Lives under cli/ because vitest's include glob is
 * ['gate-engine/**\/*.test.mjs','cli/**\/*.test.mjs'] — a test outside those dirs would never run.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { rootRegistry, seedSessionLedger } from './_helpers.mts';

const AGENTS_HOOKS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'agents-hooks');
const KNIP_HOOK = join(AGENTS_HOOKS, 'knip-check.sh');
const LINT_HOOK = join(AGENTS_HOOKS, 'lint-check.sh');

const HAS_BUN = spawnSync('bash', ['-c', 'command -v bun'], { encoding: 'utf8' }).status === 0;

// A `knip` script that announces itself then fails: exit 2 + this marker in the hook's stderr proves
// the degrade-skip gates OPENED and knip actually ran; the marker's ABSENCE proves the hook skipped.
// Cleanly separable even though "ran-and-passed" and "skipped" would both exit 0. The marker is a
// PATH (and the fixture creates that file + seeds it into the session-edits ledger) because the hook
// now filters knip output to files the session edited — a non-path marker would be filtered out.
const KNIP_SCRIPT = 'echo KNIP_RAN.ts; exit 1';
const pkg = (extra = {}) => JSON.stringify({ name: 'fx', version: '0.0.0', ...extra });
const withKnipScript = (extra = {}) => pkg({ scripts: { knip: KNIP_SCRIPT }, ...extra });

const { mkTmp, cleanup } = rootRegistry();
afterEach(cleanup);

const fixture = (files) => {
  const dir = mkTmp('knip-hook-');
  writeFileSync(join(dir, 'KNIP_RAN.ts'), 'export {};\n');
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
};

// By default the payload session "edited" the marker file, so the session-scoping gate is open
// and the legacy degrade-skip behaviours stay observable. `edits: null` = a session with no edits.
const run = (dir, { stopHookActive = false, edits = ['KNIP_RAN.ts'] } = {}) => {
  const tmp = seedSessionLedger(dir, 'test-sid', edits);
  return spawnSync('bash', [KNIP_HOOK], {
    input: JSON.stringify({ stop_hook_active: stopHookActive, session_id: 'test-sid' }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, TMPDIR: tmp },
    encoding: 'utf8',
  });
};

describe.skipIf(!HAS_BUN)('knip-check.sh gate behaviour', () => {
  // Forms the ORIGINAL hook missed (it checked only knip.json/.jsonc/.ts/.config.ts). Parametrised
  // so dropping any arm of the detection loop regresses a test — the bug was an INCOMPLETE list.
  it.each([
    '.knip.json',
    '.knip.jsonc',
    'knip.js',
    'knip.config.js',
  ])('Defect C: runs knip for a %s config (a newly-supported form)', (configFile) => {
    const r = run(fixture({ [configFile]: '{}', 'package.json': withKnipScript() }));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('KNIP_RAN');
  });

  it('Defect C: runs knip for a package.json#knip config key (no separate config file)', () => {
    const r = run(fixture({ 'package.json': withKnipScript({ knip: {} }) }));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('KNIP_RAN');
  });

  it('degrade-skips when no knip config is present', () => {
    const r = run(fixture({ 'package.json': withKnipScript() }));
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('KNIP_RAN');
  });

  it('degrade-skips when configured but no `knip` script (exercises the bun -e probe — Defect D path)', () => {
    const r = run(
      fixture({ '.knip.json': '{}', 'package.json': pkg({ scripts: { other: 'true' } }) }),
    );
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('KNIP_RAN');
  });

  it('honours the stop_hook_active loop guard (never re-blocks its own re-invocation)', () => {
    const r = run(fixture({ '.knip.json': '{}', 'package.json': withKnipScript() }), {
      stopHookActive: true,
    });
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('KNIP_RAN');
  });

  it('session scoping: a session with NO recorded edits is never blocked (fail-open)', () => {
    const r = run(fixture({ '.knip.json': '{}', 'package.json': withKnipScript() }), {
      edits: null,
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });

  it("session scoping: findings only in ANOTHER session's files are filtered out", () => {
    const dir = fixture({ '.knip.json': '{}', 'package.json': withKnipScript() });
    writeFileSync(join(dir, 'theirs.ts'), 'export {};\n');
    const r = run(dir, { edits: ['theirs.ts'] }); // knip flags KNIP_RAN.ts, which this session never touched
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('KNIP_RAN');
  });
});

// Static guard — no bun/node needed. Locks Defect D permanently: neither bun-only hook may probe
// package.json via `node -<flag>` again. Matches the invocation form only, so comment prose that
// mentions "node" without a following flag never trips it.
describe('Defect D static guard: bun-only hooks never shell node', () => {
  it.each([
    ['knip-check.sh', KNIP_HOOK],
    ['lint-check.sh', LINT_HOOK],
    ['session-edits-lib.sh', join(AGENTS_HOOKS, 'session-edits-lib.sh')],
  ])('%s contains no `node -<flag>` probe', (_name, path) => {
    expect(readFileSync(path, 'utf8')).not.toMatch(/\bnode\s+-/);
  });
});
