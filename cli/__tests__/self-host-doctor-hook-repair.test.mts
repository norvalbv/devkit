/** Self-host `doctor --fix` repairs the hook in every state and touches no managed state (sc-2700).
 * The capability is injected: its real sync is the collateral under test (devkit-self-dogfood). */

import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { check } from '../lib/doctor/check-result.mts';
import { runSelfHostDoctor, type SelfHostCapability } from '../lib/doctor/self-host-doctor.mts';
import { HOOK_REL, selfHostHookParity } from '../lib/husky/hook-parity.mts';
import { extractGuardBlock } from '../lib/husky/husky-block.mts';
import {
  buildSelfHostHook,
  SELF_HOST_EXTRAS,
  SELF_HOST_STRUCTURE_CMD,
  selfHostSelection,
} from '../lib/husky/self-host.mts';
import { rootRegistry } from './_helpers.mts';

function row(name: string) {
  return capability.drifted
    ? check(
        name,
        'DRIFT',
        'managed plugin/config/probe bytes changed',
        'run `devkit doctor --fix`',
        true,
      )
    : check(name, 'OK', 'ok');
}

/** A faithful stand-in for the managed lifecycle: reports OK or DRIFT, and records every sync. */
const capability = {
  drifted: false,
  sync: vi.fn((_cwd: string) => {}),
  check: (_cwd: string) => [row('Oxc runtime'), row('anti-slop plugin')],
} satisfies SelfHostCapability;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK_SEL = {
  ...selfHostSelection(),
  structureCmd: SELF_HOST_STRUCTURE_CMD,
  extras: SELF_HOST_EXTRAS,
};
const CFG = { components: {} };
/** Everything a hook repair must leave byte-identical. */
const MANAGED = ['.devkit/anti-slop', '.devkit/oxc', 'oxlint.json', 'package.json'];

const { mkTmp, cleanup } = rootRegistry();
let lines: string[];

beforeEach(() => {
  capability.drifted = false;
  capability.sync.mockReset();
  lines = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.join(' '));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

/** A self-host-shaped git repo with managed capability state, and a hook only when asked. */
function seedRepo(hook?: string): string {
  const root = mkTmp('devkit-self-host-hook-repair-');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  copyFileSync(join(ROOT, 'package.json'), join(root, 'package.json'));
  mkdirSync(join(root, '.devkit', 'anti-slop', 'plugin'), { recursive: true });
  mkdirSync(join(root, '.devkit', 'oxc'), { recursive: true });
  writeFileSync(join(root, '.devkit', 'config.json'), JSON.stringify(CFG));
  writeFileSync(join(root, '.devkit', 'anti-slop', 'plugin', 'index.js'), 'export default {};\n');
  writeFileSync(join(root, '.devkit', 'anti-slop', 'manifest.json'), '{"ruleIds":[]}\n');
  writeFileSync(join(root, '.devkit', 'oxc', 'oxlint.base.json'), '{}\n');
  writeFileSync(join(root, 'oxlint.json'), '{"extends":[]}\n');
  if (hook !== undefined) {
    mkdirSync(join(root, '.husky'), { recursive: true });
    writeFileSync(join(root, HOOK_REL), hook, { mode: 0o755 });
  }
  return root;
}

/** `[relPath, base64 bytes]` for every managed file, in walk order. */
function snapshot(root: string) {
  const out: Array<[string, string]> = [];
  const walk = (abs: string) => {
    if (!existsSync(abs)) return;
    if (statSync(abs).isDirectory()) {
      for (const entry of readdirSync(abs).sort()) walk(join(abs, entry));
      return;
    }
    out.push([relative(root, abs), readFileSync(abs).toString('base64')]);
  };
  for (const rel of MANAGED) walk(join(root, rel));
  return out;
}

const freshHook = (root: string) => buildSelfHostHook(HOOK_SEL, '', root);
const BLOCK_START = '# >>> devkit-guards >>>';
// The preamble comment mentions `# devkit-guards` too, so anchor on the real start marker.
const staleHook = (root: string) =>
  freshHook(root).replace(BLOCK_START, `${BLOCK_START}\necho hand-edited-inside-block`);
const hook = (root: string) => readFileSync(join(root, HOOK_REL), 'utf8');
const output = () => lines.join('\n');

describe('self-host doctor --fix repairs the hook without touching managed state', () => {
  it('recreates a missing hook (and its .husky dir) instead of pointing at init', async () => {
    const root = seedRepo();
    const before = snapshot(root);

    await runSelfHostDoctor(root, CFG, true, capability);

    expect(selfHostHookParity(root).status).toBe('ok');
    expect(snapshot(root)).toEqual(before);
    expect(capability.sync).not.toHaveBeenCalled();
    expect(output()).not.toMatch(/pre-commit.*devkit init/);
  });

  it.skipIf(process.platform === 'win32')(
    'leaves a recreated hook executable — git silently skips a non-executable hook',
    async () => {
      const root = seedRepo();
      await runSelfHostDoctor(root, CFG, true, capability);
      expect(statSync(join(root, HOOK_REL)).mode & 0o111).not.toBe(0);
    },
  );

  it('refreshes a stale block and changes nothing but the hook', async () => {
    const root = seedRepo();
    mkdirSync(join(root, '.husky'), { recursive: true });
    writeFileSync(join(root, HOOK_REL), staleHook(root), { mode: 0o755 });
    expect(selfHostHookParity(root).status).toBe('stale');
    const before = snapshot(root);

    await runSelfHostDoctor(root, CFG, true, capability);

    expect(selfHostHookParity(root).status).toBe('ok');
    expect(snapshot(root)).toEqual(before);
    expect(capability.sync).not.toHaveBeenCalled();
  });

  it('keeps hand-written lines outside the managed block when refreshing it', async () => {
    const root = seedRepo();
    const handLine = 'echo "hand-written after the block"';
    mkdirSync(join(root, '.husky'), { recursive: true });
    writeFileSync(join(root, HOOK_REL), `${staleHook(root)}\n${handLine}\n`, { mode: 0o755 });

    await runSelfHostDoctor(root, CFG, true, capability);

    expect(selfHostHookParity(root).status).toBe('ok');
    expect(hook(root)).toContain(handLine);
  });

  it('replaces a marker-less hand hook whole, so the gates never run twice', async () => {
    const root = seedRepo('#!/bin/sh\nnode gate-engine/review/cli.mts\n');
    expect(selfHostHookParity(root).status).toBe('unmarked');

    await runSelfHostDoctor(root, CFG, true, capability);

    expect(selfHostHookParity(root).status).toBe('ok');
    expect(hook(root).split(BLOCK_START)).toHaveLength(2);
    expect(hook(root)).not.toMatch(/^node gate-engine\/review\/cli\.mts$/m);
    expect(extractGuardBlock(hook(root))).not.toBeNull();
  });
});

describe('self-host doctor --fix when capability sync fails', () => {
  it('still refreshes a stale hook, names the sync failure, and exits non-zero', async () => {
    capability.drifted = true;
    capability.sync.mockImplementation(() => {
      throw new Error('oxlint runtime unavailable');
    });
    const root = seedRepo();
    mkdirSync(join(root, '.husky'), { recursive: true });
    writeFileSync(join(root, HOOK_REL), staleHook(root), { mode: 0o755 });

    const code = await runSelfHostDoctor(root, CFG, true, capability);

    expect(selfHostHookParity(root).status).toBe('ok');
    expect(output()).toContain('anti-slop sync failed');
    expect(output()).toContain('oxlint runtime unavailable');
    expect(code).toBe(1);
  });

  it('still recreates a missing hook', async () => {
    capability.drifted = true;
    capability.sync.mockImplementation(() => {
      throw new Error('lock held');
    });
    const root = seedRepo();

    await runSelfHostDoctor(root, CFG, true, capability);

    expect(selfHostHookParity(root).status).toBe('ok');
  });

  it('runs a succeeding sync exactly once, for this repo', async () => {
    capability.drifted = true;
    const root = seedRepo();
    mkdirSync(join(root, '.husky'), { recursive: true });
    writeFileSync(join(root, HOOK_REL), freshHook(root), { mode: 0o755 });

    await runSelfHostDoctor(root, CFG, true, capability);

    expect(capability.sync).toHaveBeenCalledTimes(1);
    expect(capability.sync).toHaveBeenCalledWith(root);
  });
});

describe('self-host doctor hook repair — refusals', () => {
  it('without --fix, names doctor --fix for a missing hook and writes nothing', async () => {
    const root = seedRepo();

    const code = await runSelfHostDoctor(root, CFG, false, capability);

    expect(output()).toContain('devkit doctor --fix');
    expect(output()).not.toMatch(/pre-commit.*devkit init/);
    expect(existsSync(join(root, HOOK_REL))).toBe(false);
    expect(code).toBe(1);
  });

  it('reports a generator failure instead of throwing out of doctor', async () => {
    const root = seedRepo();
    // No `bin` map: sourceBinFor throws inside the generator.
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@norvalbv/devkit' }));

    const code = await runSelfHostDoctor(root, CFG, true, capability);

    expect(code).toBe(1);
    expect(output()).toMatch(/\.husky\/pre-commit.*could not be regenerated/);
    expect(existsSync(join(root, HOOK_REL))).toBe(false);
  });
});
