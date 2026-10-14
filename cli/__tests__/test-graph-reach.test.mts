import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { localModuleClosureFiles } from '../../gate-engine/review/eval/module-closure-hash.mts';

// `vitest related` selects through the import graph, and spawning `node <module>.mts` adds no edge,
// so a spawning test declares one with a never-run `void (() => import('<module>'))` line.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const TEST_RE = /^(anti-slop|gate-engine|cli)\/.*\.test\.mts$|^e2e\/lib\/.*\.unit\.test\.mts$/;
const SOURCE_RE = /^(cli|gate-engine)\/.*\.mts$/;
const NOT_SOURCE_RE = /\.test\.mts$|\/__tests__\/|\/fixtures?\/|\/eval\//;

/** Modules exempt from the reach check, each with the reason no test edge belongs to it. */
const EXEMPT = {
  // The dispatcher reaches every command: an edge to it would select every spawning test.
  'cli/index.mts': 'dispatcher',
} satisfies Record<string, string>;

/** Repo-relative files git lists that still exist on disk (an unstaged `rm` stays in the index). */
function listedFiles(root: string, ...lsArgs: string[]): string[] {
  return execFileSync('git', ['ls-files', ...lsArgs], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f && existsSync(join(root, f)));
}

/** Indexed source modules no test reaches; an untracked stray is not the commit's to answer for. */
function unreachedModules(root: string) {
  const tests = listedFiles(root, '--cached', '--others', '--exclude-standard')
    .filter((f) => TEST_RE.test(f))
    .map((f) => join(root, f));
  const reached = new Set(localModuleClosureFiles(tests).map((f) => relative(root, f)));
  const unreached = listedFiles(root, '--cached').filter(
    (f) => SOURCE_RE.test(f) && !NOT_SOURCE_RE.test(f) && !reached.has(f) && !(f in EXEMPT),
  );
  return { unreached, reached };
}

describe('every source module is reachable from some test in vitest’s import graph', () => {
  const { unreached, reached } = unreachedModules(REPO_ROOT);

  it('names each module a staged change to which would select no test', () => {
    expect(
      unreached,
      "add `void (() => import('<module>'));` to the test that spawns it, or exempt it with a reason",
    ).toEqual([]);
  });

  it('drops an exemption once a test reaches the module', () => {
    expect(Object.keys(EXEMPT).filter((f) => reached.has(f))).toEqual([]);
  });
});

describe('unreachedModules', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function repo(files: Record<string, string>): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'graph-reach-')));
    dirs.push(root);
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), body);
    }
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    return root;
  }

  it('counts a never-run edge line as reach and names the module nothing reaches', () => {
    const root = repo({
      'cli/spawned.mts': 'export {};\n',
      'cli/orphan.mts': 'export {};\n',
      'cli/__tests__/spawned.test.mts': "void (() => import('../spawned.mts'));\n",
    });
    expect(unreachedModules(root).unreached).toEqual(['cli/orphan.mts']);
  });

  it('neither crashes on nor counts an indexed test deleted from disk, and skips untracked sources', () => {
    const root = repo({
      'cli/gone.test.mts': "import './kept.mts';\n",
      'cli/kept.mts': 'export {};\n',
    });
    rmSync(join(root, 'cli/gone.test.mts'));
    writeFileSync(join(root, 'cli/untracked.mts'), 'export {};\n');
    expect(unreachedModules(root).unreached).toEqual(['cli/kept.mts']);
  });
});
