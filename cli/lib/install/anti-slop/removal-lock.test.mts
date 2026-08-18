import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANTI_SLOP_LOCK_REL } from './constants.mts';

const spies = vi.hoisted(() => ({ syncOxcCapability: vi.fn() }));
vi.mock('../oxc/lifecycle.mts', () => ({
  assertOxcCapabilityReady: vi.fn(),
  oxcBaseCapabilityIssue: vi.fn(() => null),
  syncOxcCapability: spies.syncOxcCapability,
}));

import { removeAntiSlopCapability } from './lifecycle.mts';

const roots: string[] = [];
afterEach(() => {
  spies.syncOxcCapability.mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('anti-slop removal locking', () => {
  it('holds the capability lock through the paired Oxc base rewrite', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'anti-slop-remove-lock-'));
    roots.push(cwd);
    mkdirSync(join(cwd, '.devkit/anti-slop'), { recursive: true });
    mkdirSync(join(cwd, '.devkit/oxc'), { recursive: true });
    writeFileSync(join(cwd, '.devkit/oxc/manifest.json'), '{}\n');
    spies.syncOxcCapability.mockImplementation(() => {
      expect(existsSync(join(cwd, ANTI_SLOP_LOCK_REL))).toBe(true);
    });

    removeAntiSlopCapability(cwd);

    expect(spies.syncOxcCapability).toHaveBeenCalledWith(cwd, { antiSlop: false });
    expect(existsSync(join(cwd, '.devkit/anti-slop'))).toBe(false);
    expect(existsSync(join(cwd, ANTI_SLOP_LOCK_REL))).toBe(false);
  });

  it('keeps managed plugin bytes when the Oxc base cannot be unwired', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'anti-slop-remove-failure-'));
    roots.push(cwd);
    mkdirSync(join(cwd, '.devkit/anti-slop'), { recursive: true });
    mkdirSync(join(cwd, '.devkit/oxc'), { recursive: true });
    spies.syncOxcCapability.mockImplementation(() => {
      throw new Error('runtime unavailable');
    });

    expect(() => removeAntiSlopCapability(cwd)).toThrow('runtime unavailable');

    expect(existsSync(join(cwd, '.devkit/anti-slop'))).toBe(true);
    expect(existsSync(join(cwd, ANTI_SLOP_LOCK_REL))).toBe(false);
  });
});
