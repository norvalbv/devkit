import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { preflightStructure } from '../preflight.mts';

const RUN = join(dirname(fileURLToPath(import.meta.url)), '..', 'run.mts');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// The shape of devkit's own gate-engine tree: an entry allowlist plus domain-gated module folders.
const TREE = {
  name: 'lib',
  root: 'src',
  sourceExtensions: ['ts'],
  entryAllowlist: ['index.ts'],
  libDomains: { '@root': ['core'] },
  grammar: {
    files: ['index.ts'],
    domainGate: '@root',
    recurse: 'mod',
    rules: { mod: { folderName: '{kebab_dir}', files: ['{kebab}'], recurse: 'mod' } },
  },
};

function repo(trees: unknown[] = [TREE]) {
  const root = mkdtempSync(join(tmpdir(), 'structure-preflight-'));
  roots.push(root);
  writeFileSync(
    join(root, 'guard.config.json'),
    JSON.stringify({ scanRoots: ['src'], structure: { trees } }),
  );
  return root;
}

function write(root: string, rel: string) {
  mkdirSync(join(root, dirname(rel)), { recursive: true });
  writeFileSync(join(root, rel), 'export {};\n');
}

// In-process so coverage sees it; the CLI wiring keeps one spawned test below.
async function preflight(root: string, ...paths: string[]) {
  const lines: string[] = [];
  const capture = (...args: unknown[]) => void lines.push(args.join(' '));
  const log = vi.spyOn(console, 'log').mockImplementation(capture);
  const error = vi.spyOn(console, 'error').mockImplementation(capture);
  try {
    return { status: await preflightStructure(root, paths), out: lines.join('\n') };
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}

describe('guard-structure preflight', () => {
  it('blocks a new root file the entry allowlist does not admit, naming what it does admit', async () => {
    const root = repo();
    const r = await preflight(root, 'src/helpers.ts');
    expect(r.status).toBe(1);
    expect(r.out).toContain('src/helpers.ts — blocks:');
    expect(r.out).toContain('Allowed names  = index.ts');
    expect(r.out).toContain('structure.trees[].libDomains');
    expect(existsSync(join(root, 'src/helpers.ts'))).toBe(false);
  });

  it('passes a new file inside a registered domain folder', async () => {
    const root = repo();
    const r = await preflight(root, 'src/core/git-paths.ts');
    expect(r.status).toBe(0);
    expect(r.out).toContain('src/core/git-paths.ts — ok');
  });

  it('does not judge a path outside every structure tree', async () => {
    const root = repo();
    const r = await preflight(root, 'README.md', 'docs/x.ts');
    expect(r.status).toBe(0);
    expect(r.out).toContain(
      'not judged (outside every structure tree, or ignored): README.md, docs/x.ts',
    );
  });

  it('blocks every file in one unregistered new folder, not just the first', async () => {
    const root = repo();
    const r = await preflight(root, 'src/newdir/a.ts', 'src/newdir/b.ts');
    expect(r.status).toBe(1);
    expect(r.out).toContain('src/newdir/a.ts — blocks:');
    expect(r.out).toContain('src/newdir/b.ts — blocks:');
  });

  it('judges an existing file the same way the gate would', async () => {
    const root = repo();
    write(root, 'src/Bad.ts');
    write(root, 'src/core/fine.ts');
    const r = await preflight(root, 'src/Bad.ts', 'src/core/fine.ts');
    expect(r.status).toBe(1);
    expect(r.out).toContain('src/Bad.ts — blocks:');
    expect(r.out).toContain('src/core/fine.ts — ok');
  });

  // The baseline grandfathers exact files, so a new sibling in a legacy spot must still block.
  it('passes a grandfathered file but blocks a new sibling beside it', async () => {
    const root = repo();
    write(root, 'src/Legacy.ts');
    mkdirSync(join(root, '.devkit/baselines/structure'), { recursive: true });
    writeFileSync(
      join(root, '.devkit/baselines/structure/lib.mjs'),
      "export const lib = ['Legacy.ts'];\n",
    );
    const r = await preflight(root, 'src/Legacy.ts', 'src/Helpers.ts');
    expect(r.out).toContain('src/Legacy.ts — ok');
    expect(r.out).toContain('src/Helpers.ts — blocks:');
  });

  it('exits 2 when no tree declares a grammar', async () => {
    const root = repo([]);
    const r = await preflight(root, 'src/helpers.ts');
    expect(r.status).toBe(2);
    expect(r.out).toContain('did NOT run');
  });

  it('exits 2 when guard.config.json cannot be read', async () => {
    const root = repo();
    writeFileSync(join(root, 'guard.config.json'), '{ not json');
    expect((await preflight(root, 'src/helpers.ts')).status).toBe(2);
  });

  it('leaves no plugin cache file in the repository', async () => {
    const root = repo();
    await preflight(root, 'src/helpers.ts', 'src/core/a.ts');
    expect(readdirSync(root)).toEqual(['guard.config.json']);
  });

  it('is reachable as `guard-structure preflight -- <paths>`', () => {
    const root = repo();
    const r = spawnSync('node', [RUN, 'preflight', '--', 'src/helpers.ts'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('src/helpers.ts — blocks:');
  });
});
