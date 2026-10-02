// doctor's prior-art advisory: gate on + no research.referenceCheckouts = a local leg that reads
// nothing. Advisory only — the exit code never moves on it.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runSelfHostDoctor } from '../lib/doctor/self-host-doctor.mts';
import { printPriorArtAdvisoryHealth } from '../lib/doctor/qavis-health.mts';
import { rootRegistry, tmpRepos } from './_helpers.mts';

const { mkTmp, cleanup } = rootRegistry();
const repos = tmpRepos('doctor-prior-art-');
afterEach(() => {
  cleanup();
  repos.cleanup();
  vi.restoreAllMocks();
});

const ADVISORY = 'research.referenceCheckouts';

/** A tmp dir whose guard.config.json is `contents` verbatim, or absent when `contents` is null. */
function repoWith(contents: string | null): string {
  const root = mkTmp('prior-art-health-');
  if (contents !== null) writeFileSync(join(root, 'guard.config.json'), contents);
  return root;
}

/** Everything printPriorArtAdvisoryHealth logged for this repo and selection. */
function advisoryFor(root: string, sel: { priorArtGate?: boolean }): string {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    lines.push(a.join(' '));
  });
  printPriorArtAdvisoryHealth(root, sel);
  vi.restoreAllMocks();
  return lines.join('\n');
}

describe('printPriorArtAdvisoryHealth', () => {
  it('stays silent when the prior-art gate is off, even with nothing declared', () => {
    expect(advisoryFor(repoWith(null), { priorArtGate: false })).toBe('');
    expect(advisoryFor(repoWith(null), {})).toBe('');
  });

  it.each([
    ['no guard.config.json at all', null],
    ['a config without the research key', '{"scanRoots":["src"]}'],
    ['research without referenceCheckouts', '{"research":{}}'],
    ['an explicit empty list', '{"research":{"referenceCheckouts":[]}}'],
    // A bare string is the likeliest hand-written mistake. The engine drops a non-array to [], so
    // the agent reads nothing — the advisory must say so rather than treat the key as present.
    ['a string instead of a list', '{"research":{"referenceCheckouts":"../sibling"}}'],
    // Entries that cannot name a directory are not a declaration, however many there are.
    [
      'only blank or non-string entries',
      '{"research":{"referenceCheckouts":["", "  ", 42, null]}}',
    ],
  ])('advises once when the gate is on and %s', (_label, contents) => {
    const out = advisoryFor(repoWith(contents), { priorArtGate: true });
    expect(out).toContain(ADVISORY);
    expect(out.split('\n')).toHaveLength(1);
  });

  it('stays silent once any pattern is declared, resolved or not', () => {
    // Doctor deliberately does not resolve the globs: a fresh clone without the siblings is a
    // valid state, and a second resolver here could disagree with the agent's.
    const root = repoWith('{"research":{"referenceCheckouts":["", "../does-not-exist"]}}');
    expect(advisoryFor(root, { priorArtGate: true })).toBe('');
  });

  it('does not throw on a corrupt guard.config.json, and leaves that finding to its owner', () => {
    // The config-validity check reports a corrupt file; an advisory that threw here would take the
    // whole self-host doctor down instead.
    const root = repoWith('{ not json');
    expect(() => advisoryFor(root, { priorArtGate: true })).not.toThrow();
    expect(advisoryFor(root, { priorArtGate: true })).toBe('');
  });
});

describe('the advisory is wired into every doctor mode that can reach it', () => {
  it('self-host doctor prints it — devkit dogfoods the gate on that path', async () => {
    const root = repoWith(null);
    execFileSync('git', ['init', '-q'], { cwd: root });
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      lines.push(a.join(' '));
    });
    await runSelfHostDoctor(
      root,
      { components: { skills: false, agents: false, priorArtGate: true } },
      false,
    );
    vi.restoreAllMocks();
    expect(lines.join('\n')).toContain(ADVISORY);
  });

  it.each([
    ['package', []],
    ['overlay', ['--overlay']],
  ])(
    '%s-mode doctor prints it, and declaring the key changes the output but not the exit code',
    (_mode, flags) => {
      const root = repos.tmpRepo();
      execFileSync('git', ['init', '-q'], { cwd: root });
      const init = repos.devkit(
        root,
        'init',
        '--stack',
        'generic',
        '--yes',
        '--prior-art-gate',
        ...flags,
      );
      expect(init.status).toBe(0);

      const before = repos.devkit(root, 'doctor');
      expect(before.stdout).toContain(ADVISORY);

      // An overlay may leave guard.config.json unwritten; the key is declared either way.
      const cfgPath = join(root, 'guard.config.json');
      const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : {};
      writeFileSync(
        cfgPath,
        JSON.stringify({ ...cfg, research: { referenceCheckouts: ['../x'] } }),
      );
      const after = repos.devkit(root, 'doctor');
      expect(after.stdout).not.toContain(ADVISORY);
      expect(after.status).toBe(before.status);
    },
  );
});
