import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ensureInstalledPrefix, type Fixture, headCount, makeFixture, MARKERS, out } from './lib/harness.mts';

// Harness-level edges: fixture isolation from the shared prefix, the empty-repo boundary, and a repo
// path containing spaces (devkit's historically fragile case — hook $0/path handling).

const created: Fixture[] = [];
afterAll(() => {
  for (const f of created) f.cleanup();
});
async function fixture(prefix?: string): Promise<Fixture> {
  const f = await makeFixture(prefix);
  created.push(f);
  return f;
}
function write(fx: Fixture, rel: string, body = 'export const x = 1;\n'): void {
  mkdirSync(join(fx.repoDir, rel, '..'), { recursive: true });
  writeFileSync(join(fx.repoDir, rel), body);
}

describe('e2e: harness isolation + robustness', () => {
  it('cleanup() removes only the fixture, never the shared prefix', async () => {
    const prefix = await ensureInstalledPrefix();
    const devkitBin = join(prefix, 'node_modules', '.bin', 'devkit');

    const a = await makeFixture(); // NOT tracked — we clean it here
    expect(existsSync(devkitBin)).toBe(true);
    a.cleanup();

    // The prefix (shared across all fixtures) must survive a fixture teardown…
    expect(existsSync(devkitBin)).toBe(true);
    // …and a subsequent fixture must still resolve the installed bin.
    const b = await fixture();
    expect(b.run('devkit', ['--version']).status).toBe(0);
  });

  it('headCount is 0 on a fresh repo and advances after a commit (boundary)', async () => {
    const fx = await fixture();
    expect(headCount(fx)).toBe(0);
    write(fx, 'README.md', '# x\n');
    fx.git('add', 'README.md');
    fx.git('commit', '-q', '-m', 'base');
    expect(headCount(fx)).toBe(1);
  });

  it('the installed hook still blocks a bad commit when the repo path contains spaces', async () => {
    const fx = await fixture('devkit e2e spaced '); // mkdtemp under a path WITH spaces
    expect(fx.repoDir).toContain(' ');
    write(fx, 'src/index.ts', 'export {};\n');
    fx.git('add', 'src/index.ts');
    fx.git('commit', '-q', '-m', 'base');
    const before = headCount(fx);

    expect(fx.run('devkit', ['init', '--stack', 'generic', '--guards', 'size,fanout', '--yes']).status).toBe(0);
    fx.git('config', 'core.hooksPath', '.husky');

    for (let i = 0; i < 15; i++) write(fx, `src/pkg/file${i}.ts`);
    fx.git('add', 'src/pkg');
    const commit = fx.git('commit', '-m', 'trip under spaced path');

    expect(commit.status).toBe(1);
    expect(headCount(fx)).toBe(before);
    expect(out(commit)).toContain(MARKERS.fanoutExceeded);
  });
});
