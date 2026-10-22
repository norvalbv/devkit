import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import vitestConfig from '../../vitest.config.mjs';
import { readFailingTestFiles } from '../lib/husky/pre-push/failing-test-files.mts';
import { testSpawnSync } from './_helpers.mts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { cacheDir } = vitestConfig;
const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'devkit-failing-files-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('readFailingTestFiles', () => {
  it('treats a cache written in the same instant as the reference as fresh', () => {
    const root = makeRoot();
    const cache = join(root, 'results.json');
    writeFileSync(join(root, 'a.test.mts'), '');
    writeFileSync(
      cache,
      JSON.stringify({ results: [['parallel:a.test.mts', { duration: 1, failed: true }]] }),
    );
    utimesSync(cache, 1_700_000_000, 1_700_000_000);
    const { mtimeMs } = statSync(cache);

    expect(readFailingTestFiles(cache, mtimeMs, root)).toEqual(['a.test.mts']);
    expect(readFailingTestFiles(cache, mtimeMs + 1, root)).toEqual([]);
  });

  // The cache format is undocumented, so this runs the installed vitest and reads what it wrote: a
  // vitest upgrade that moves or reshapes the file fails here rather than silencing the hook.
  it('reads the cache the installed vitest writes for a failing file, where the hook looks', () => {
    const root = makeRoot();
    symlinkSync(join(REPO_ROOT, 'node_modules'), join(root, 'node_modules'));
    // devkit's own cacheDir, under a node_modules shared like a linked worktree's.
    writeFileSync(
      join(root, 'vitest.config.mjs'),
      `export default { cacheDir: ${JSON.stringify(cacheDir)}, test: { name: 'pinned', include: ['*.test.mjs'] } };\n`,
    );
    writeFileSync(
      join(root, 'boom.test.mjs'),
      `import { expect, it } from 'vitest';\nit('fails', () => { expect(1).toBe(2); });\n`,
    );
    writeFileSync(
      join(root, 'ok.test.mjs'),
      `import { expect, it } from 'vitest';\nit('passes', () => { expect(1).toBe(1); });\n`,
    );

    const startedMs = Date.now();
    const run = testSpawnSync(
      process.execPath,
      [join(REPO_ROOT, 'node_modules/vitest/vitest.mjs'), 'run'],
      { cwd: root, encoding: 'utf8' },
    );
    expect(run.status, run.stderr).toBe(1);

    const [hash = ''] = readdirSync(join(root, cacheDir, 'vitest'));
    expect(
      readFailingTestFiles(join(root, cacheDir, 'vitest', hash, 'results.json'), 0, root),
    ).toEqual(['boom.test.mjs']);
    // Nothing landed in the shared install, where another checkout's run would also write.
    const shared = join(root, 'node_modules/.vite/vitest', hash, 'results.json');
    expect(existsSync(shared) && statSync(shared).mtimeMs >= startedMs).toBe(false);
    expect(readFileSync(join(REPO_ROOT, 'cli/lib/husky/pre-push-validation.sh'), 'utf8')).toContain(
      `"$ROOT"/${cacheDir}/vitest/*/results.json`,
    );
  });
});
