import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { type Fixture, makeFixture, MARKERS, out } from './lib/harness.mts';

// Flow (c): the INSTALLED `devkit doctor` reports the right verdict + exit code for a clean repo,
// a drifted repo, and an uninitialized one. Exit code is the primary signal; the glyph line is
// corroboration.

const created: Fixture[] = [];
afterAll(() => {
  for (const f of created) f.cleanup();
});
async function fixture(): Promise<Fixture> {
  const f = await makeFixture();
  created.push(f);
  return f;
}

// Narrow surface: deterministic-only guards + no skills/agents keeps doctor's clean baseline stable
// and never shells an AI gate.
const INIT_ARGS = [
  'init',
  '--stack',
  'generic',
  '--guards',
  'size,fanout',
  '--yes',
  '--no-skills',
  '--no-agents',
];

describe('e2e: devkit doctor', () => {
  it('reports clean → exit 0', async () => {
    const fx = await fixture();
    expect(fx.run('devkit', INIT_ARGS).status).toBe(0);

    const d = fx.run('devkit', ['doctor']);
    expect(d.status).toBe(0);
    expect(out(d)).toContain(MARKERS.doctorClean);
  });

  it('detects a missing hook → exit 1', async () => {
    const fx = await fixture();
    expect(fx.run('devkit', INIT_ARGS).status).toBe(0);

    rmSync(join(fx.repoDir, '.husky/pre-commit'));

    const d = fx.run('devkit', ['doctor']);
    expect(d.status).toBe(1);
    expect(out(d)).toContain(MARKERS.doctorHuskyMissing);
  });

  it('reports uninitialized → exit 2', async () => {
    const fx = await fixture(); // no init
    const d = fx.run('devkit', ['doctor']);
    expect(d.status).toBe(2);
    expect(out(d)).toContain(MARKERS.doctorUninitialized);
  });
});
