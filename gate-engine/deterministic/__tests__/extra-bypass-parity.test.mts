/** A self-host `--extra` gate's GUARD_*_OK bypass must reach every site that acts on it: the
 * prefix-cache salt, cache-hit telemetry, `devkit ship --help`, and the test-suite env scrub. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCRUBBED_ENV } from '../../../vitest.setup.mjs';
import { meta } from '../../../cli/commands/ship.mts';
import { SELF_HOST_EXTRAS } from '../../../cli/lib/husky/self-host.mts';
import { EXTRA_BYPASSES, runDeterministic } from '../run.mts';

const REPO = join(import.meta.dirname, '../../..');
const REMEDY =
  'a self-host extra bypass belongs in EXTRA_BYPASSES (gate-engine/deterministic/run.mts), ' +
  'the `devkit ship --help` Env block, and vitest.setup.mjs BYPASS_ENV';

describe('self-host extra bypass parity', () => {
  it('maps every module-declared BYPASS_SUFFIX to its extra', async () => {
    const files = execFileSync('git', ['grep', '-l', 'export const BYPASS_SUFFIX', '--', '*.mts'], {
      cwd: REPO,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((f) => f && !f.includes('__tests__'));
    expect(files.length).toBeGreaterThanOrEqual(2);
    const values: string[] = Object.values(EXTRA_BYPASSES);
    for (const file of files) {
      const { BYPASS_SUFFIX } = await import(pathToFileURL(join(REPO, file)).href);
      expect(values, `${file}: ${REMEDY}`).toContain(BYPASS_SUFFIX);
    }
  });

  it.each(Object.entries(EXTRA_BYPASSES))('%s → GUARD_%s is wired everywhere', (label, suffix) => {
    expect(
      SELF_HOST_EXTRAS.map((x) => x.label),
      `${label}: not a SELF_HOST_EXTRAS label`,
    ).toContain(label);
    expect(meta.help, REMEDY).toContain(`GUARD_${suffix}=1`);
    expect(SCRUBBED_ENV, REMEDY).toContain(`GUARD_${suffix}`);
    expect(SCRUBBED_ENV, REMEDY).toContain(`FRINK_${suffix}`);
  });
});

describe('a prefix-cached retry still records an extra bypass', () => {
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

  it('emits nothing for a bypassed extra that is not part of this invocation', () => {
    const opts = { exec: vi.fn(), extra: [{ label: 'lint', cmd: 'true' }] };
    expect(runDeterministic(dir, opts)).toBe(0);
    expect(runDeterministic(dir, opts)).toBe(0);
    expect(bypasses()).toEqual([]);
  });
});
