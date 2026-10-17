/** A gate's own GUARD_*_OK bypass must reach every site that acts on it: the prefix-cache salt,
 * cache-hit telemetry, the test-suite env scrub, and `devkit ship --help` for a devkit command gate.
 * devkit's own declared extra gates must all load, and its typecheck must reach e2e/. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCRUBBED_ENV } from '../../../vitest.setup.mjs';
import { meta } from '../../../cli/commands/ship.mts';
import { configExtraGates, GATE_BYPASSES } from '../command-gates.mts';
import { DETERMINISTIC } from '../registry.mts';
import { runDeterministic } from '../run.mts';

const REPO = join(import.meta.dirname, '../../..');
const REMEDY =
  "a gate's own bypass belongs in GATE_BYPASSES (gate-engine/deterministic/command-gates.mts) and " +
  'vitest.setup.mjs BYPASS_ENV; a devkit command gate also documents it in the `devkit ship --help` Env block';

describe('gate bypass parity', () => {
  it('maps every module-declared BYPASS_SUFFIX to its gate', async () => {
    const files = execFileSync('git', ['grep', '-l', 'export const BYPASS_SUFFIX', '--', '*.mts'], {
      cwd: REPO,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((f) => f && !f.includes('__tests__'));
    expect(files.length).toBeGreaterThanOrEqual(3);
    const values: string[] = Object.values(GATE_BYPASSES);
    for (const file of files) {
      const { BYPASS_SUFFIX } = await import(pathToFileURL(join(REPO, file)).href);
      expect(values, `${file}: ${REMEDY}`).toContain(BYPASS_SUFFIX);
    }
  });

  it.each(Object.entries(GATE_BYPASSES))('%s → GUARD_%s is wired everywhere', (gate, suffix) => {
    const extra = configExtraGates(REPO).some((x) => x.label === gate);
    const registered = DETERMINISTIC.some((g) => g.id === gate);
    expect(extra || registered, `${gate}: neither a devkit command gate nor a registry gate`).toBe(
      true,
    );
    if (extra) expect(meta.help, REMEDY).toContain(`GUARD_${suffix}=1`);
    expect(SCRUBBED_ENV, REMEDY).toContain(`GUARD_${suffix}`);
    expect(SCRUBBED_ENV, REMEDY).toContain(`FRINK_${suffix}`);
  });
});

describe('a prefix-cached retry still records a gate bypass', () => {
  let dir = '';
  let sink = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'guard-det-extra-bypass-'));
    mkdirSync(join(dir, '.devkit'));
    writeFileSync(
      join(dir, '.devkit', 'config.json'),
      JSON.stringify({ components: { guards: ['size'] } }),
    );
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['add', '.'], { cwd: dir });
    sink = join(dir, 'events.jsonl');
    vi.stubEnv('DEVKIT_SHIP', '1');
    vi.stubEnv('DEVKIT_GATE_EVENTS', sink);
    vi.stubEnv('GUARD_HOOK_PARITY_OK', '1');
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  const bypasses = () =>
    readFileSync(sink, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((e) => e.type === 'gate_result' && e.bypass);

  it('emits one bypass for an extra the cache hit skipped', () => {
    const opts = { exec: vi.fn(), extra: [{ label: 'hook-parity', cmd: 'true' }] };
    expect(runDeterministic(dir, opts)).toBe(0);
    expect(bypasses()).toEqual([]); // the extra ran, and owns its own emission
    expect(runDeterministic(dir, opts)).toBe(0);
    expect(bypasses()).toEqual([
      expect.objectContaining({ gate: 'hook-parity', bypass: 'GUARD_HOOK_PARITY_OK' }),
    ]);
  });

  it('emits the bypass for a gate guard.config.json declares, the shape devkit itself uses', () => {
    const config = { extraGates: { 'hook-parity': 'true' } };
    writeFileSync(join(dir, 'guard.config.json'), JSON.stringify(config));
    execFileSync('git', ['add', '.'], { cwd: dir });
    const opts = { exec: vi.fn() };
    expect(runDeterministic(dir, opts)).toBe(0);
    expect(runDeterministic(dir, opts)).toBe(0);
    expect(bypasses()).toEqual([
      expect.objectContaining({ gate: 'hook-parity', bypass: 'GUARD_HOOK_PARITY_OK' }),
    ]);
  });

  it('names each bypass canonically, including one exported under the FRINK_ alias', () => {
    vi.stubEnv('FRINK_DECISIONS_INTEGRITY_OK', '1');
    const extra = [
      { label: 'hook-parity', cmd: 'true' },
      { label: 'decisions-integrity', cmd: 'true' },
    ];
    const opts = { exec: vi.fn(), extra };
    expect(runDeterministic(dir, opts)).toBe(0);
    expect(runDeterministic(dir, opts)).toBe(0);
    expect(bypasses().map((e) => `${e.gate}:${e.bypass}`)).toEqual([
      'hook-parity:GUARD_HOOK_PARITY_OK',
      'decisions-integrity:GUARD_DECISIONS_INTEGRITY_OK',
    ]);
  });

  it('records a bypassed registry gate by its id, since decision-checks is no extra', () => {
    writeFileSync(
      join(dir, '.devkit', 'config.json'),
      JSON.stringify({ components: { guards: ['size', 'decisions'] } }),
    );
    execFileSync('git', ['add', '.'], { cwd: dir });
    vi.stubEnv('GUARD_HOOK_PARITY_OK', '');
    vi.stubEnv('GUARD_DECISION_CHECKS_OK', '1');
    const opts = { exec: vi.fn() };
    expect(runDeterministic(dir, opts)).toBe(0);
    expect(runDeterministic(dir, opts)).toBe(0);
    expect(bypasses().map((e) => `${e.gate}:${e.bypass}`)).toEqual([
      'decision-checks:GUARD_DECISION_CHECKS_OK',
    ]);
  });

  it('emits nothing for a bypassed extra that is not part of this invocation', () => {
    const opts = { exec: vi.fn(), extra: [{ label: 'lint', cmd: 'true' }] };
    expect(runDeterministic(dir, opts)).toBe(0);
    expect(runDeterministic(dir, opts)).toBe(0);
    expect(bypasses()).toEqual([]);
  });
});

describe('self-host gate coverage', () => {
  // The config is the only source of devkit's command gates, so this pins each one and its order.
  it('runs every extra gate guard.config.json declares', () => {
    expect(configExtraGates(REPO)).toEqual([
      { label: 'lint', cmd: 'bun run lint' },
      { label: 'hook-parity', cmd: 'node cli/lib/husky/hook-parity.mts --gate' },
      {
        label: 'formatter-identity',
        cmd: 'node cli/lib/husky/format-identity/formatter-identity.mts --gate',
      },
      {
        label: 'decisions-integrity',
        cmd: 'node gate-engine/decisions/cli.mts integrity --staged',
      },
      { label: 'release-only-dist', cmd: 'node cli/lib/ship/dist-integrity.mts --ship-staged' },
      { label: 'benchmarks', cmd: 'bun run benchmarks:check -- --mode staged' },
      { label: 'corpus-lint', cmd: 'bun run benchmarks:corpus' },
      { label: 'git-pathspec', cmd: 'node scripts/git-pathspec-check.mts' },
      { label: 'related-tests', cmd: 'node cli/lib/husky/gate-policy/related-tests.mts' },
      { label: 'typecheck', cmd: 'bun run typecheck' },
    ]);
  });

  it('typechecks the e2e suites, which no test run covers', () => {
    const tsc = join(REPO, 'node_modules', '@typescript', 'native', 'bin', 'tsc');
    const files = execFileSync(process.execPath, [tsc, '-p', 'tsconfig.json', '--listFilesOnly'], {
      cwd: REPO,
      encoding: 'utf8',
    });
    expect(files).toContain(join(REPO, 'e2e', 'no-vacuous-pass.e2e.test.mts'));
  });
});
