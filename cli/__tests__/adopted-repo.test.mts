import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DETERMINISTIC, gateModulePath } from '../../gate-engine/deterministic/registry.mts';
import { runGate, testExecFileSync, tmpRepos } from './_helpers.mts';

const { adoptedRepo, cleanup } = tmpRepos('adopted-repo-');
afterEach(cleanup);

const SIZE = DETERMINISTIC.find((gate) => gate.id === 'size');
const OVER_CAP = Array.from({ length: 501 }, (_, i) => `export const v${i} = ${i};\n`).join('');

function stageBigFile(root: string): void {
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'index.ts'), 'export const index = 1;\n');
  testExecFileSync('git', ['add', '-A'], { cwd: root });
  testExecFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
  writeFileSync(join(root, 'src', 'big.ts'), OVER_CAP);
  testExecFileSync('git', ['add', '-A'], { cwd: root });
}

describe('adoptedRepo', () => {
  it('runs the size gate with the line caps init enables', () => {
    const root = adoptedRepo();
    stageBigFile(root);
    const run = runGate(root, SIZE);
    expect(run.status, run.stderr).toBe(1);
    expect(run.stderr).toContain('src/big.ts');
  });

  it('merges overrides over the config init writes', () => {
    const root = adoptedRepo({ maxLines: 0, maxTestLines: 0 });
    stageBigFile(root);
    const run = runGate(root, SIZE);
    expect(run.status, run.stderr).toBe(0);
  });
});

describe('gateModulePath', () => {
  it.each(DETERMINISTIC.map((gate) => [gate.id, gate] as const))(
    'resolves %s to a module that exists',
    (_, gate) => {
      expect(existsSync(gateModulePath(gate)), gateModulePath(gate)).toBe(true);
    },
  );
});
