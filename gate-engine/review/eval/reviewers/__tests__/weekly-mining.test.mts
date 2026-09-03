/** weekly-mining.sh (sc-2492): a failed miner fails the sweep visibly (exit 1, stage named, first error
 * logged, full output kept), a clean sweep exits 0; miners are stubbed via the script's own PATH. */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'propose', 'weekly-mining.sh');
const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

/** A fake HOME whose $HOME/.bun/bin/bun fails for the scripts in `failing` with a bun-style error above
 * a 7-line hint block (so a tail alone would cut it), else exits 0; osascript is stubbed too. */
function fakeHome(failing: string[]) {
  const home = mkdtempSync(join(tmpdir(), 'weekly-mining-'));
  homes.push(home);
  const bin = join(home, '.bun', 'bin');
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(home, '.claude-usage'), { recursive: true });
  const cases = failing
    .map(
      (f) =>
        `  ${f}) echo "mining $1"; echo "error: bun ran out of file descriptors (ProcessFdQuotaExceeded)" >&2; for i in 1 2 3 4 5 6 7; do echo "hint line $i"; done; exit 1;;`,
    )
    .join('\n');
  writeFileSync(
    join(bin, 'bun'),
    `#!/bin/sh\ncase "$1" in\n${cases}\n  *) echo "ok $1"; exit 0;;\nesac\n`,
  );
  chmodSync(join(bin, 'bun'), 0o755);
  writeFileSync(join(bin, 'osascript'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'osascript'), 0o755);
  return home;
}

const run = (home: string) =>
  spawnSync('sh', [SCRIPT], { env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
const logOf = (home: string) =>
  readFileSync(join(home, '.claude-usage', 'weekly-mining.log'), 'utf8');

describe('weekly-mining.sh', () => {
  it('a failing miner fails the sweep: exit 1, stage named, error line in the log, full output kept', () => {
    const home = fakeHome(['mine-telemetry.mts']);
    const r = run(home);
    expect(r.status).toBe(1);
    const log = logOf(home);
    expect(log).toMatch(/^=== weekly mining sweep .* \(fd soft=\d+ hard=(\d+|unlimited)\) ===$/m);
    // The failure tail is 20 lines, so the error line above the 7-line hint block reaches the log.
    expect(log).toMatch(/^error: bun ran out of file descriptors/m);
    expect(log).toContain('hint line 7');
    expect(log).toMatch(
      /^!!! mine-telemetry FAILED \(exit 1\) — full output: .*mine-telemetry\.log$/m,
    );
    expect(log).toContain('--- propose-telemetry skipped (mine-telemetry failed) ---');
    expect(log).not.toMatch(/mine-bots FAILED|mine-ghsa FAILED|propose-bots FAILED/);
    const sweeps = readdirSync(join(home, '.claude-usage', 'weekly-mining'));
    expect(sweeps).toHaveLength(1);
    expect(sweeps[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z\.[A-Za-z0-9]{6}$/); // unique per invocation
    const full = readFileSync(
      join(home, '.claude-usage', 'weekly-mining', sweeps[0], 'mine-telemetry.log'),
      'utf8',
    );
    expect(full).toContain('mining mine-telemetry.mts');
    expect(full).toContain('hint line 7');
    expect(
      existsSync(join(home, '.claude-usage', 'weekly-mining', sweeps[0], 'mine-bots.log')),
    ).toBe(true);
  });
  it('every stage failing still runs every independent stage and names them all', () => {
    const home = fakeHome([
      'mine-bots.mts',
      'mine-telemetry.mts',
      'mine-ghsa.mts',
      'propose/propose.mts',
    ]);
    expect(run(home).status).toBe(1);
    const log = logOf(home);
    for (const s of ['mine-bots', 'mine-telemetry', 'mine-ghsa', 'propose-bots'])
      expect(log).toMatch(new RegExp(`^!!! ${s} FAILED \\(exit 1\\)`, 'm'));
  });
  it('two sweeps in the same minute keep separate full-output directories', () => {
    const home = fakeHome([]);
    expect(run(home).status).toBe(0);
    expect(run(home).status).toBe(0);
    expect(readdirSync(join(home, '.claude-usage', 'weekly-mining'))).toHaveLength(2);
  });
  it('a clean sweep exits 0 with no FAILED line and runs propose-telemetry', () => {
    const home = fakeHome([]);
    const r = run(home);
    expect(r.status).toBe(0);
    const log = logOf(home);
    expect(log).not.toContain('FAILED');
    expect(log).toContain('--- propose-telemetry ---');
    expect(log).toContain('ok propose/propose-telemetry.mts');
  });
});
