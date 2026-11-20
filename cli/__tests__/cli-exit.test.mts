import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CLI, testSpawnSync } from './_helpers.mts';

// Never called: declares the spawned modules to vitest's graph, so `vitest related` selects this file.
void (() => import('../../gate-engine/deterministic/reason.mts'));
void (() => import('../commands/baseline/prove-regression.mts'));

const dir = mkdtempSync(join(tmpdir(), 'cli-exit-'));
const spy = join(dir, 'exit-spy.mjs');
writeFileSync(
  spy,
  "const exit = process.exit; process.exit = (code) => { process.stderr.write('process.exit called\\n'); return exit(code); };\n",
);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const run = (args: string[], env: NodeJS.ProcessEnv = process.env) =>
  testSpawnSync(process.execPath, ['--import', spy, CLI, ...args], { encoding: 'utf8', env });

// Node 24's process.exit can deadlock in platform shutdown (nodejs/node#64274), so a returning
// command must end by draining its event loop instead.
describe('devkit exit', () => {
  it('ends a returning command with its code without calling process.exit', () => {
    const result = run(['prove-regression']);

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('prove-regression usage');
    expect(result.stderr).not.toContain('process.exit called');
  });

  it('ends a command that throws with 1 without calling process.exit', () => {
    // An empty PATH leaves git unresolvable, so the dispatcher's git check throws out of main.
    const result = run(['prove-regression'], { ...process.env, PATH: '/var/empty' });

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toMatch(/git is not installed or not on PATH/);
    expect(result.stderr).not.toContain('process.exit called');
  });
});
