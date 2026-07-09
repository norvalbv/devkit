import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { type Fixture, makeFixture } from './lib/harness.mts';

// Flow (a): the INSTALLED `devkit init` writes its artifact set into a fresh consumer repo and
// patches the devkit pin — without shelling out to a network install. Runs the real dist bin, so a
// missing dist asset or a broken bin field reddens here where the source suite stays green.

const created: Fixture[] = [];
afterAll(() => {
  for (const f of created) f.cleanup();
});
async function fixture(): Promise<Fixture> {
  const f = await makeFixture();
  created.push(f);
  return f;
}

describe('e2e: devkit init', () => {
  it('writes the artifact set + pin and runs no network install', async () => {
    const fx = await fixture();
    const r = fx.run('devkit', ['init', '--stack', 'generic', '--yes']);

    expect(r.status).toBe(0);

    // On-disk artifacts (primary signal).
    for (const rel of [
      'guard.config.json',
      'biome.jsonc',
      'tsconfig.json',
      '.husky/pre-commit',
      '.devkit/config.json',
    ]) {
      expect(existsSync(join(fx.repoDir, rel)), `expected ${rel} to exist`).toBe(true);
    }

    // package.json patched with the devkit pin + husky prepare. The URL half varies with DEVKIT_REPO
    // (deleted from the fixture env), so assert only the `#v<version>` tag half.
    const pkg = JSON.parse(readFileSync(join(fx.repoDir, 'package.json'), 'utf8'));
    expect(pkg.devDependencies?.['@norvalbv/devkit']).toMatch(/#v\d/);
    expect(pkg.scripts?.prepare).toBe('husky');

    // The assembled hook invokes the deterministic gate; config records the stack.
    expect(readFileSync(join(fx.repoDir, '.husky/pre-commit'), 'utf8')).toContain(
      'bunx guard-deterministic',
    );
    expect(JSON.parse(readFileSync(join(fx.repoDir, '.devkit/config.json'), 'utf8')).stack).toBe(
      'generic',
    );

    // node_modules is still the harness symlink — proves init did not run its own `bun install`.
    expect(lstatSync(join(fx.repoDir, 'node_modules')).isSymbolicLink()).toBe(true);
  });

  it('a dev-set DEVKIT_REPO does not leak into the written pin', async () => {
    // The user toggles DEVKIT_REPO (git+ssh / local path) during dev; makeFixture must delete it from
    // the fixture env so init still writes the canonical git+https #v<version> pin (S2 regression).
    const saved = process.env.DEVKIT_REPO;
    process.env.DEVKIT_REPO = 'git+ssh://git@github.com/norvalbv/devkit.git';
    try {
      const fx = await fixture();
      expect(fx.run('devkit', ['init', '--stack', 'generic', '--yes']).status).toBe(0);
      const pin = JSON.parse(readFileSync(join(fx.repoDir, 'package.json'), 'utf8')).devDependencies?.[
        '@norvalbv/devkit'
      ];
      expect(pin).toMatch(/#v\d/);
      expect(pin).not.toContain('ssh');
    } finally {
      if (saved === undefined) delete process.env.DEVKIT_REPO;
      else process.env.DEVKIT_REPO = saved;
    }
  });
});
