import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { commandGate, expandStaged } from '../command-gates.mts';
import { runDeterministic } from '../run.mts';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const RUN = ['vitest', 'related', '--run', '{staged}'];

describe('expandStaged', () => {
  it('leaves a command without the placeholder untouched', () => {
    expect(expandStaged(['knip'], null, '')).toEqual({ argv: ['knip'] });
  });

  it('spreads the sorted staged paths in place of the placeholder', () => {
    const staged = new Set(['b c.ts', 'a.ts']);
    expect(expandStaged([...RUN, '--x'], staged, '')).toEqual({
      argv: ['vitest', 'related', '--run', 'a.ts', 'b c.ts', '--x'],
    });
  });

  // A runner would parse `-x.ts` as an option, so the path would never reach its selection.
  it('keeps a path starting with a dash from reading as an option', () => {
    expect(expandStaged(RUN, new Set(['-x.ts', '--run=0.ts']), '')).toEqual({
      argv: ['vitest', 'related', '--run', './--run=0.ts', './-x.ts'],
    });
  });

  it('makes paths relative to a package dir, keeping a sibling package as ../', () => {
    const staged = new Set(['pkg/src/x.ts', 'shared/y.ts']);
    expect(expandStaged(RUN, staged, 'pkg/')).toEqual({
      argv: ['vitest', 'related', '--run', 'src/x.ts', '../shared/y.ts'],
    });
  });

  it('blocks when git could not list the staged set', () => {
    expect(expandStaged(RUN, null, '')).toEqual({ unrunnable: 'staged set unreadable' });
  });

  it('reports an empty staged set instead of spawning', () => {
    expect(expandStaged(RUN, new Set(), '')).toEqual({ empty: true });
  });

  it('blocks a staged set too large for one command line', () => {
    const staged = new Set(Array.from({ length: 3000 }, (_, i) => `${'d/'.repeat(50)}${i}.ts`));
    expect(expandStaged(RUN, staged, '')).toEqual({
      unrunnable: 'staged set too large for argv (3000 paths)',
    });
  });
});

// One check for every command source: extraGates, and the hook's --extra / --structure flags.
describe('commandGate {staged} validation', () => {
  it.each([
    ['inside an argument', 'vitest related --x={staged}'],
    ['twice', 'vitest related {staged} {staged}'],
  ])('blocks a placeholder %s as unrunnable', (_, cmd) => {
    expect(commandGate('t', tmp(), cmd)).toMatchObject({
      argv: null,
      unrunnable: '{staged} must be one whole argument',
    });
  });
});

function tmp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'staged-placeholder-')));
  dirs.push(d);
  return d;
}

function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

// A repo whose gate dir (`pkg/` or the root) declares a `{staged}` extraGate and selects no guard.
function gateRepo(pkg: string) {
  const root = tmp();
  const cwd = join(root, pkg);
  git(root, 'init', '-q');
  for (const f of ['pkg/src/x.ts', 'shared/y.ts', 'gone.ts']) {
    mkdirSync(join(root, f, '..'), { recursive: true });
    writeFileSync(join(root, f), 'export {};\n');
  }
  git(root, 'add', '.');
  git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  mkdirSync(join(cwd, '.devkit'), { recursive: true });
  writeFileSync(
    join(cwd, '.devkit', 'config.json'),
    JSON.stringify({ components: { guards: [] } }),
  );
  writeFileSync(
    join(cwd, 'guard.config.json'),
    JSON.stringify({ extraGates: { 'related-tests': RUN.join(' ') } }),
  );
  return { root, cwd };
}

const ranArgv = (exec: ReturnType<typeof vi.fn>) =>
  exec.mock.calls.filter(([bin]) => bin === 'vitest').map(([, argv]) => argv);

describe('runDeterministic with a {staged} extraGate', () => {
  it('hands a monorepo package the commit paths relative to its own dir', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { root, cwd } = gateRepo('pkg');
    writeFileSync(join(root, 'pkg/src/x.ts'), 'export const x = 1;\n');
    writeFileSync(join(root, 'shared/y.ts'), 'export const y = 1;\n');
    git(root, 'add', 'pkg/src', 'shared');
    git(root, 'rm', '-q', 'gone.ts');
    const exec = vi.fn();
    expect(runDeterministic(cwd, { exec })).toBe(0);
    expect(ranArgv(exec)).toEqual([['related', '--run', 'src/x.ts', '../shared/y.ts']]);
  });

  it('blocks on the runner failing a related test', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { root } = gateRepo('');
    writeFileSync(join(root, 'shared/y.ts'), 'export const y = 1;\n');
    git(root, 'add', 'shared');
    const exec = vi.fn(() => {
      throw Object.assign(new Error('x'), { status: 1 });
    });
    expect(runDeterministic(root, { exec })).toBe(1);
    expect(err.mock.calls.flat().join('\n')).toContain('deterministic gates failed: related-tests');
  });

  // `commit -a` / `commit -- <path>` stage into an alternate index the hook hands over.
  it('reads the commit index the hook carries, not the default index', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { root } = gateRepo('');
    writeFileSync(join(root, 'shared/y.ts'), 'export const y = 1;\n');
    writeFileSync(join(root, 'gone.ts'), 'export const g = 1;\n');
    git(root, 'add', 'shared/y.ts');
    const alt = join(root, '.git', 'next-index');
    const env = { ...process.env, GIT_INDEX_FILE: alt };
    execFileSync('git', ['read-tree', 'HEAD'], { cwd: root, env });
    execFileSync('git', ['add', 'gone.ts'], { cwd: root, env });
    vi.stubEnv('DEVKIT_COMMIT_INDEX_FILE', alt);
    vi.stubEnv('DEVKIT_COMMIT_GIT_DIR', join(root, '.git'));
    const exec = vi.fn();
    expect(runDeterministic(root, { exec })).toBe(0);
    expect(ranArgv(exec)).toEqual([['related', '--run', 'gone.ts']]);
  });

  // A pasted path list would be stale once the fix is staged, so a {staged} gate prints none.
  it('expands for guard-structure too, keeping its opt-out and printing no stale recheck', () => {
    const { root } = gateRepo('');
    writeFileSync(join(root, 'shared/y.ts'), 'export const y = 1;\n');
    git(root, 'add', 'shared');
    const gate = commandGate('s', root, 'guard-structure --x {staged}');
    expect(gate.argv?.slice(2)).toEqual(['--x', 'shared/y.ts']);
    expect(gate).toMatchObject({ failOpen2: true, recheck: undefined });
  });

  it('passes without spawning when nothing is staged, and says so', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { root } = gateRepo('');
    const exec = vi.fn();
    expect(runDeterministic(root, { exec })).toBe(0);
    expect(exec).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join('\n')).toContain('related-tests: no staged paths, not run');
    // An empty set is a pass, not an opt-out, which would be reported and left out of the cache.
    expect(warn.mock.calls.flat().join('\n')).not.toContain('opted out');
  });

  it('blocks as unrunnable when git cannot list the staged set', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = tmp();
    writeFileSync(
      join(d, 'guard.config.json'),
      JSON.stringify({ extraGates: { 'related-tests': RUN.join(' ') } }),
    );
    mkdirSync(join(d, '.devkit'));
    writeFileSync(
      join(d, '.devkit', 'config.json'),
      JSON.stringify({ components: { guards: [] } }),
    );
    const exec = vi.fn();
    expect(runDeterministic(d, { exec })).toBe(1);
    expect(exec).not.toHaveBeenCalled();
    expect(err.mock.calls.flat().join('\n')).toContain(
      'related-tests(unrunnable: staged set unreadable)',
    );
  });
});
