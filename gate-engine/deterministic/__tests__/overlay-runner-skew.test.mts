import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmpSemver, devkitVersion, LEGACY_DEVKIT_VERSION } from '../../devkit-version.mts';
import { reportOlderOverlayRunner } from '../../overlay-mode.mts';
import { runDeterministic } from '../run.mts';

/** The `.devkit/config.json` fields these fixtures vary. */
interface FixtureConfig {
  overlay?: boolean;
  devkitRef?: string;
}

const RUNNING = devkitVersion();
const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() ?? '', { recursive: true, force: true });
  delete process.env.DEVKIT_SHIP;
  vi.restoreAllMocks();
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'overlay-skew-'));
  dirs.push(d);
  return d;
}

function writeConfig(dir: string, cfg: FixtureConfig): void {
  mkdirSync(join(dir, '.devkit'), { recursive: true });
  const body = { components: { guards: ['size'] }, ...cfg };
  writeFileSync(join(dir, '.devkit', 'config.json'), JSON.stringify(body));
}

function overlayRepo(devkitRef: string, cfg: FixtureConfig = { overlay: true }): string {
  const d = tmp();
  writeConfig(d, { ...cfg, devkitRef });
  return d;
}

/** A gate runner that records each spawn and passes. */
const passingExec = () => vi.fn(() => Buffer.from(''));

const stderr = () => {
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  return () => err.mock.calls.flat().join('\n');
};

describe('overlay gates refuse an OLDER global devkit', () => {
  it('blocks before any gate runs and names both versions and the reinstall', () => {
    const printed = stderr();
    const exec = passingExec();
    expect(runDeterministic(overlayRepo('v999.0.0'), { exec })).toBe(1);
    expect(exec).not.toHaveBeenCalled();
    const out = printed();
    expect(out).toContain(`global devkit ${RUNNING} is running these gates`);
    expect(out).toContain('this overlay pins v999.0.0');
    expect(out).toContain('Run: bun add -g @norvalbv/devkit#v999.0.0, then devkit doctor --fix');
    expect(out).not.toContain('bunx');
  });

  it('reads the config through a linked .devkit, as in a ship or borrowing worktree', () => {
    stderr();
    const home = overlayRepo('v999.0.0');
    const wt = tmp();
    symlinkSync(join(home, '.devkit'), join(wt, '.devkit'));
    const exec = passingExec();
    expect(runDeterministic(wt, { exec })).toBe(1);
    expect(exec).not.toHaveBeenCalled();
  });

  it('a cached all-green staged tree does not skip the check', () => {
    stderr();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const d = overlayRepo(`v${RUNNING}`);
    execFileSync('git', ['init', '-q'], { cwd: d });
    // A real overlay git-excludes its config, so raising the pin leaves the staged tree's key intact.
    writeFileSync(join(d, '.git', 'info', 'exclude'), '.devkit/config.json\n');
    writeFileSync(join(d, 'a.txt'), 'a\n');
    execFileSync('git', ['add', '.'], { cwd: d });
    process.env.DEVKIT_SHIP = '1';
    const exec = passingExec();
    expect(runDeterministic(d, { exec })).toBe(0);
    expect(exec).toHaveBeenCalledTimes(1);

    writeConfig(d, { overlay: true, devkitRef: 'v999.0.0' });
    expect(runDeterministic(d, { exec })).toBe(1);
    expect(exec).toHaveBeenCalledTimes(1); // the second run spawned nothing
  });
});

describe('overlay gates proceed when the global is not older', () => {
  it.each([
    ['a newer global', 'v0.0.1'],
    ['the pinned version', `v${RUNNING}`],
    ['a branch pin', 'main'],
    ['a SHA pin', '5dd3f2b83'],
    ['an unanchored tag', 'v999.0.0-feature'],
  ])('%s runs the gates silently', (_label, ref) => {
    const printed = stderr();
    const exec = passingExec();
    expect(runDeterministic(overlayRepo(ref), { exec })).toBe(0);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(printed()).not.toContain('devkit doctor --fix');
  });

  // cmpSemver returns NaN for a non-release runner, and NaN >= 0 is false, so without the release
  // guard a newer prerelease global or an unresolved manifest would read as older and block.
  it.each([
    ['a newer prerelease global', '999.0.1-rc.1'],
    ['an unresolved manifest', LEGACY_DEVKIT_VERSION],
  ])('%s proceeds rather than false-blocking', (_label, running) => {
    const printed = stderr();
    expect(reportOlderOverlayRunner(overlayRepo('v999.0.0'), running)).toBe(false);
    expect(printed()).toBe('');
  });

  it('package mode with a higher devkitRef is not this check', () => {
    stderr();
    const exec = passingExec();
    expect(runDeterministic(overlayRepo('v999.0.0', {}), { exec })).toBe(0);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('an unparseable config proceeds to the default selection', () => {
    stderr();
    const d = tmp();
    mkdirSync(join(d, '.devkit'));
    writeFileSync(join(d, '.devkit', 'config.json'), '{ not json');
    const exec = passingExec();
    runDeterministic(d, { exec });
    expect(exec).toHaveBeenCalled();
  });
});

describe('cmpSemver', () => {
  it('orders numerically, not lexically', () => {
    expect(cmpSemver('0.9.0', '0.10.0')).toBeLessThan(0); // 9 < 10 despite lex order
    expect(cmpSemver('1.0.0', '0.9.9')).toBeGreaterThan(0);
    expect(cmpSemver('0.99.99', '1.0.0')).toBeLessThan(0);
    expect(cmpSemver('0.9.1', '0.9.1')).toBe(0);
  });

  // Number rounds both of these to 9007199254740992, so a float compare calls two distinct versions
  // equal — the permissive answer, which would let an older runner publish managed state.
  it('orders components beyond Number.MAX_SAFE_INTEGER exactly', () => {
    expect(cmpSemver('1.9007199254740992.0', '1.9007199254740993.0')).toBeLessThan(0);
    expect(cmpSemver('9007199254740993.0.0', '9007199254740992.0.0')).toBeGreaterThan(0);
  });

  // Unordered must stay NaN, not 0: `update` tests `cmpSemver(latest, current) <= 0` to mean
  // "already up to date", so a 0 here would silently skip a real update instead of proceeding.
  it('treats an unparseable component as unordered rather than throwing', () => {
    expect(cmpSemver('main', '1.0.0')).toBeNaN();
    expect(cmpSemver('1.0.0', 'main')).toBeNaN();
  });
});
