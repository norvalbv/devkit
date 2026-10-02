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
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { hasAnyCommand, rootRegistry, seedSessionLedger, testSpawnSync } from './_helpers.mts';

const AGENTS_HOOKS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'agents-hooks');
const KNIP_HOOK = join(AGENTS_HOOKS, 'knip-check.sh');
const LINT_HOOK = join(AGENTS_HOOKS, 'lint-check.sh');

const HAS_BUN = hasAnyCommand('bun');

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
const run = (
  dir,
  { stopHookActive = false, edits = ['KNIP_RAN.ts'], path = undefined, hook = KNIP_HOOK } = {},
) => {
  const tmp = seedSessionLedger(dir, 'test-sid', edits);
  const env = { ...process.env, CLAUDE_PROJECT_DIR: dir, TMPDIR: tmp };
  if (path !== undefined) env.PATH = path;
  return testSpawnSync('bash', [hook], {
    input: JSON.stringify({ stop_hook_active: stopHookActive, session_id: 'test-sid' }),
    env,
    encoding: 'utf8',
  });
};

describe.skipIf(!HAS_BUN)('knip-check.sh gate behaviour', () => {
  // Forms the ORIGINAL hook missed (it checked only knip.json/.jsonc/.ts/.config.ts). Parametrised
  // so dropping any arm of the detection loop regresses a test — the bug was an INCOMPLETE list.
  it.each(['.knip.json', '.knip.jsonc', 'knip.js', 'knip.config.js'])(
    'Defect C: runs knip for a %s config (a newly-supported form)',
    (configFile) => {
      const r = run(fixture({ [configFile]: '{}', 'package.json': withKnipScript() }));
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('KNIP_RAN');
    },
  );

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

// Defect D: a bun-only toolchain has no node, so only the lib's js_eval may shell `node -e`, and
// only after bun (sc-1054). Matches the invocation form, so prose mentioning "node" never trips it.
const LIB = join(AGENTS_HOOKS, 'session-edits-lib.sh');
describe('Defect D static guard: hooks never shell node outside js_eval', () => {
  it.each([
    ['knip-check.sh', KNIP_HOOK],
    ['lint-check.sh', LINT_HOOK],
  ])('%s contains no `node -<flag>` probe', (_name, path) => {
    expect(readFileSync(path, 'utf8')).not.toMatch(/\bnode\s+-/);
  });

  it('session-edits-lib.sh reaches `node -e` only inside js_eval, behind a bun-first branch', () => {
    const lib = readFileSync(LIB, 'utf8');
    expect(lib.match(/\bnode\s+-/g)).toHaveLength(1);
    const body = lib.match(/^js_eval\(\) \{\n([\s\S]*?)\n\}/m)?.[1] ?? '';
    expect(body).toMatch(/\bnode\s+-e/);
    expect(body.indexOf('bun -e')).toBeGreaterThan(-1);
    expect(body.indexOf('bun -e')).toBeLessThan(body.indexOf('node -e'));
  });
});

// sc-1054: each test below REPLACES PATH with shims + the system dirs, so the runtimes and package
// managers that "exist" are exactly the ones the test put there.
const SYSTEM_PATH = '/usr/bin:/bin';
const realNode = (() => {
  const r = spawnSync('bash', ['-c', 'command -v node'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
})();
const systemHas = (bin) => SYSTEM_PATH.split(':').some((d) => existsSync(join(d, bin)));
// Probe the whole mechanism end to end: a sandbox that cannot exec a temp-dir shim through a
// replaced PATH skips these tests (like HAS_BUN) instead of failing every hook as exit 0.
const shimsRun = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pm-shim-probe-'));
  try {
    symlinkSync(realNode, join(dir, 'node'));
    writeFileSync(join(dir, 'probe'), `#!/bin/sh\nnode -e 'process.stdout.write("ok")'\n`);
    chmodSync(join(dir, 'probe'), 0o755);
    const r = spawnSync('bash', ['-c', 'probe'], {
      env: { ...process.env, PATH: `${dir}:${SYSTEM_PATH}` },
      encoding: 'utf8',
      timeout: 30_000,
    });
    return r.stdout === 'ok';
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const CAN_SHIM = realNode !== null && !systemHas('bun') && shimsRun();

// The marker rides ON the finding line: the hook filters its report to ledger paths, so a bare
// `PM=` line would be dropped before it reached stderr.
const fakePm = (name, finding = 'KNIP_RAN.ts') =>
  `#!/bin/sh\necho "${finding}: PM=${name} $*"\nexit 1\n`;
// A fake bun must still answer js_eval's `bun -e` probes, so it delegates those to the real node.
const fakeBun = (finding = 'KNIP_RAN.ts') =>
  `#!/bin/sh\nif [ "$1" = "-e" ]; then exec "${realNode}" "$@"; fi\necho "${finding}: PM=bun $*"\nexit 1\n`;

const shimPath = ({ node = true, pms = {} } = {}) => {
  const dir = mkTmp('pm-shims-');
  if (node) symlinkSync(realNode, join(dir, 'node'));
  for (const [name, body] of Object.entries(pms)) {
    writeFileSync(join(dir, name), body);
    chmodSync(join(dir, name), 0o755);
  }
  return `${dir}:${SYSTEM_PATH}`;
};

const knipRepo = (extraPkg = {}, files = {}) =>
  fixture({ '.knip.json': '{}', 'package.json': withKnipScript(extraPkg), ...files });

describe.skipIf(!CAN_SHIM)('knip-check.sh — package-manager resolution (sc-1054)', () => {
  it('runs knip through npm when bun is absent (the reported defect)', () => {
    const r = run(knipRepo({}, { 'package-lock.json': '{}' }), {
      path: shimPath({ pms: { npm: fakePm('npm') } }),
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('PM=npm run knip');
    expect(r.stderr).toContain("'npm run knip' shows the repo-wide view");
    expect(r.stderr).not.toContain('bun run knip');
  });

  it('a package-lock.json selects npm even when bun is installed', () => {
    const r = run(knipRepo({}, { 'package-lock.json': '{}' }), {
      path: shimPath({ pms: { npm: fakePm('npm'), bun: fakeBun() } }),
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('PM=npm run knip');
  });

  it.each([
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['npm-shrinkwrap.json', 'npm'],
  ])('lockfile %s selects %s', (lockfile, pm) => {
    const r = run(knipRepo({}, { [lockfile]: '' }), {
      path: shimPath({ pms: { [pm]: fakePm(pm) } }),
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(`PM=${pm} run knip`);
  });

  it('bun.lock wins over a stale package-lock.json (same ladder as dependency-preflight)', () => {
    const r = run(knipRepo({}, { 'bun.lock': '', 'package-lock.json': '{}' }), {
      path: shimPath({ pms: { npm: fakePm('npm'), bun: fakeBun() } }),
    });
    expect(r.stderr).toContain('PM=bun run knip');
  });

  it('the packageManager field outranks a disagreeing lockfile, with its @version stripped', () => {
    const r = run(knipRepo({ packageManager: 'pnpm@9.12.0+sha512.abc' }, { 'yarn.lock': '' }), {
      path: shimPath({ pms: { pnpm: fakePm('pnpm'), yarn: fakePm('yarn') } }),
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('PM=pnpm run knip');
  });

  it('an unrecognised packageManager value falls through to the lockfile ladder', () => {
    const r = run(knipRepo({ packageManager: 'deno@2.0.0' }, { 'package-lock.json': '{}' }), {
      path: shimPath({ pms: { npm: fakePm('npm') } }),
    });
    expect(r.stderr).toContain('PM=npm run knip');
  });

  it('no lockfile and no field falls back to npm when bun is absent', () => {
    const r = run(knipRepo(), { path: shimPath({ pms: { npm: fakePm('npm') } }) });
    expect(r.stderr).toContain('PM=npm run knip');
  });

  it('fails open when the resolved manager is not installed — never substitutes another one', () => {
    const r = run(knipRepo({}, { 'pnpm-lock.yaml': '' }), {
      path: shimPath({ pms: { npm: fakePm('npm') } }),
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });

  it.skipIf(systemHas('node'))('fails open when neither bun nor node exists', () => {
    const r = run(knipRepo({}, { 'package-lock.json': '{}' }), {
      path: shimPath({ node: false, pms: { npm: fakePm('npm') } }),
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });

  it('a malformed package.json fails open instead of crashing the Stop hook', () => {
    const dir = fixture({
      '.knip.json': '{}',
      'package.json': '{ not json',
      'package-lock.json': '{}',
    });
    const r = run(dir, { path: shimPath({ pms: { npm: fakePm('npm') } }) });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });

  it("npm's run banner and error trailer never reach the report when findings are in another session's files", () => {
    const dir = knipRepo({}, { 'package-lock.json': '{}' });
    writeFileSync(join(dir, 'theirs.ts'), 'export {};\n');
    const banner = `#!/bin/sh\necho "> fx@0.0.0 knip"\necho "> knip"\necho "theirs.ts: unused export"\necho "npm error Lifecycle script \\\`knip\\\` failed with error:" >&2\nexit 1\n`;
    const r = run(dir, { edits: ['KNIP_RAN.ts'], path: shimPath({ pms: { npm: banner } }) });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });

  it('runs the script with the corepack download prompt disabled', () => {
    const probe = `#!/bin/sh\necho "KNIP_RAN.ts: prompt=$COREPACK_ENABLE_DOWNLOAD_PROMPT"\nexit 1\n`;
    const r = run(knipRepo({}, { 'pnpm-lock.yaml': '' }), {
      path: shimPath({ pms: { pnpm: probe } }),
    });
    expect(r.stderr).toContain('prompt=0');
  });
});

describe.skipIf(!CAN_SHIM)(
  'partial sync: a stale session-edits-lib.sh without the runner helpers',
  () => {
    // `sync-hooks --only knip-check.sh` refreshes the hook but NOT the lib (install-hooks.mts), so the
    // new hook must keep today's bun behaviour against the old lib rather than skip or crash.
    const staleHookDir = (hookFile) => {
      const dir = mkTmp('stale-lib-');
      const lib = readFileSync(LIB, 'utf8');
      const marker = lib.indexOf('# ---- Package-manager runner');
      expect(marker).toBeGreaterThan(-1);
      writeFileSync(join(dir, 'session-edits-lib.sh'), lib.slice(0, marker));
      writeFileSync(join(dir, hookFile), readFileSync(join(AGENTS_HOOKS, hookFile), 'utf8'));
      return join(dir, hookFile);
    };

    it('knip-check.sh still runs knip through bun', () => {
      const r = run(knipRepo({}, { 'package-lock.json': '{}' }), {
        hook: staleHookDir('knip-check.sh'),
        path: shimPath({ pms: { bun: fakeBun(), npm: fakePm('npm') } }),
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('PM=bun run knip');
    });

    it.each(['knip-check.sh', 'lint-check.sh'])(
      '%s: PATH executables named like the helpers never stand in for the missing functions',
      (hookFile) => {
        const impostor = '#!/bin/sh\necho "KNIP_RAN.ts: IMPOSTOR"\nexit 0\n';
        const pms = { bun: fakeBun(), js_eval: impostor, resolve_pm: impostor, pm_run: impostor };
        const r = run(knipRepo({ scripts: { knip: 'x', 'ts:check': 'x' } }), {
          hook: staleHookDir(hookFile),
          path: shimPath({ pms }),
        });
        expect(r.status).toBe(2);
        expect(r.stderr).toContain('PM=bun run');
        expect(r.stderr).not.toContain('IMPOSTOR');
      },
    );

    it('a PATH executable named session_edits_file never stands in for a missing lib', () => {
      const dir = mkTmp('no-lib-');
      writeFileSync(join(dir, 'knip-check.sh'), readFileSync(KNIP_HOOK, 'utf8'));
      const impostor = '#!/bin/sh\necho /dev/null\n';
      const r = run(knipRepo({}, { 'bun.lock': '' }), {
        hook: join(dir, 'knip-check.sh'),
        path: shimPath({ pms: { bun: fakeBun(), session_edits_file: impostor } }),
      });
      expect(r.status).toBe(0);
      expect(r.stderr).toBe('');
    });

    it('knip-check.sh skips (as before) when bun is absent', () => {
      const r = run(knipRepo({}, { 'package-lock.json': '{}' }), {
        hook: staleHookDir('knip-check.sh'),
        path: shimPath({ pms: { npm: fakePm('npm') } }),
      });
      expect(r.status).toBe(0);
      expect(r.stderr).toBe('');
    });
  },
);

describe.skipIf(!CAN_SHIM)('lint-check.sh — package-manager resolution (sc-1054)', () => {
  const lintRepo = (scripts, files = {}) =>
    fixture({
      'package.json': pkg({ scripts }),
      'package-lock.json': '{}',
      ...files,
    });

  it('runs ts:check through npm when bun is absent, and the hint names npm', () => {
    const r = run(lintRepo({ 'ts:check': 'tsc' }), {
      hook: LINT_HOOK,
      path: shimPath({ pms: { npm: fakePm('npm') } }),
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('PM=npm run ts:check');
    expect(r.stderr).toContain("'npm run ts:check' shows the repo-wide view");
  });

  it('runs lint:structure through the resolved manager', () => {
    const r = run(lintRepo({ 'lint:structure': 'eslint .' }, { 'pnpm-lock.yaml': '' }), {
      hook: LINT_HOOK,
      path: shimPath({ pms: { pnpm: fakePm('pnpm') } }),
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('PM=pnpm run lint:structure');
    expect(r.stderr).toContain("'pnpm run lint:structure' shows the repo-wide view");
  });

  it('biome configured but bun absent: the bun-rendered biome step is skipped, not a bogus failure', () => {
    // The biome lines are rendered verbatim by the formatter-identity descriptor and still invoke
    // `bun run`; without bun that is exit 127, which must not be reported as lint errors.
    const dir = lintRepo({}, { 'biome.json': '{}' });
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', '.bin', 'biome'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(dir, 'node_modules', '.bin', 'biome'), 0o755);
    const r = run(dir, { hook: LINT_HOOK, path: shimPath({ pms: { npm: fakePm('npm') } }) });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });
});
