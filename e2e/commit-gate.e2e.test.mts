import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { type Fixture, headCount, makeFixture, MARKERS, out } from './lib/harness.mts';

// Flow (b): a real `git commit` fires the INSTALLED pre-commit hook (sh → bunx → guard-deterministic).
// A clean change passes (exit 0, HEAD advances); a structure violation BLOCKS it (exit 1, HEAD frozen,
// change left staged). This is the harness's strongest signal — it proves the shipped gate actually
// decides, end-to-end, the way it does on a consumer's machine.

const created: Fixture[] = [];
afterAll(() => {
  for (const f of created) f.cleanup();
});
async function fixture(): Promise<Fixture> {
  const f = await makeFixture();
  created.push(f);
  return f;
}

function write(fx: Fixture, rel: string, content: string): void {
  mkdirSync(join(fx.repoDir, rel, '..'), { recursive: true });
  writeFileSync(join(fx.repoDir, rel), content);
}

describe('e2e: commit gate', () => {
  it('clean change passes the real hook (exit 0, HEAD advances)', async () => {
    const fx = await fixture();
    write(fx, 'README.md', '# fixture\n');
    fx.git('add', 'README.md');
    fx.git('commit', '-q', '-m', 'base');
    const before = headCount(fx);

    expect(fx.run('devkit', ['init', '--stack', 'generic', '--guards', 'size,fanout', '--yes']).status).toBe(0);
    fx.git('config', 'core.hooksPath', '.husky');

    write(fx, 'src/util.ts', 'export const util = 1;\n');
    fx.git('add', 'src/util.ts');
    const commit = fx.git('commit', '-m', 'clean change');

    // Primary: the commit succeeded and HEAD moved by exactly one.
    expect(commit.status).toBe(0);
    expect(headCount(fx)).toBe(before + 1);
    // Corroboration: the hook fired and nothing was blocked.
    expect(out(commit)).toContain(MARKERS.detGates);
    expect(out(commit)).not.toContain(MARKERS.structViolation);
  });

  it('deterministic gate violation blocks the commit (exit 1, HEAD frozen, change still staged)', async () => {
    const fx = await fixture();
    write(fx, 'src/index.ts', 'export {};\n');
    fx.git('add', 'src/index.ts');
    fx.git('commit', '-q', '-m', 'base');
    const before = headCount(fx);

    expect(fx.run('devkit', ['init', '--stack', 'generic', '--guards', 'size,fanout', '--yes']).status).toBe(0);
    // Confirm the deterministic gate is wired into the hook before relying on it to trip.
    expect(readFileSync(join(fx.repoDir, '.husky/pre-commit'), 'utf8')).toContain('bunx guard-deterministic');
    fx.git('config', 'core.hooksPath', '.husky');

    // Introduce a fan-out violation AFTER init (generic cap is 12, no exemption) so the baseline
    // freeze can't grandfather it — a folder created post-init trips deterministically.
    for (let i = 0; i < 15; i++) write(fx, `src/pkg/file${i}.ts`, 'export const x = 1;\n');
    fx.git('add', 'src/pkg');
    const commit = fx.git('commit', '-m', 'trip fan-out gate');

    // Primary: blocked (exit 1, not the fail-open 2), HEAD unchanged, change still staged.
    expect(commit.status).toBe(1);
    expect(headCount(fx)).toBe(before);
    expect(fx.git('diff', '--cached', '--name-only').stdout).toContain('src/pkg/file0.ts');
    // Corroboration.
    expect(out(commit)).toContain(MARKERS.fanoutExceeded);
  });
});
