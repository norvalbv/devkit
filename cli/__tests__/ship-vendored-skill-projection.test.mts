import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { materializeShipAssetRuntime } from '../lib/ship/review/asset-runtime.mts';
import { VENDORED_SKILLS } from '../lib/install/vendored-skills.mts';

const sourcePackageRoot = fileURLToPath(new URL('../../', import.meta.url));
const parents: string[] = [];

afterEach(() => {
  for (const parent of parents.splice(0)) rmSync(parent, { recursive: true, force: true });
});

describe('ship reviewer asset runtime', () => {
  it('leaves vendored skills out of the .claude/skills projection', () => {
    const parent = mkdtempSync(join(tmpdir(), 'ship-vendored-'));
    parents.push(parent);
    const runtime = join(parent, 'runtime');
    materializeShipAssetRuntime(sourcePackageRoot, runtime);

    expect(existsSync(join(runtime, 'skills', 'using-devkit', 'SKILL.md'))).toBe(true);
    for (const { name } of VENDORED_SKILLS) {
      expect(existsSync(join(sourcePackageRoot, 'skills', name, 'SKILL.md'))).toBe(true);
      expect(existsSync(join(runtime, 'skills', name))).toBe(false);
    }
  });
});
