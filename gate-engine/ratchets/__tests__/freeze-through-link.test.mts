import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SIZE_BIN = join(HERE, '..', 'size-disable.mts');
const FANOUT_BIN = join(HERE, '..', 'folder-fanout.mts');
const LINES = '.devkit/baselines/size-lines.json';
const SIZE = '.devkit/baselines/size.json';
const FANOUT = '.devkit/baselines/fanout.json';

let roots: string[] = [];
const makeRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'freeze-link-'));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

const write = (root: string, rel: string, content: string) => {
  mkdirSync(join(root, dirname(rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd });
const bytes = (root: string, rel: string) => readFileSync(join(root, rel), 'utf8');
const big = (n: number) => Array(n).fill('const x = 1;').join('\n');
const pile = (root: string, n: number) => {
  rmSync(join(root, 'src/pile'), { recursive: true, force: true });
  for (let i = 0; i < n; i++) write(root, `src/pile/f-${i}.ts`, 'export {};\n');
};

const run = (bin: string, cwd: string, cmd: string, env: Record<string, string> = {}) => {
  const { DEVKIT_OVERLAY: _inherited, ...clean } = process.env;
  return spawnSync(process.execPath, [bin, cmd], {
    cwd,
    encoding: 'utf8',
    env: { ...clean, ...env },
  });
};

// Both ratchets carry debt, so a freeze from the worktree would change every baseline's bytes.
function seedRepo({ overlay = true } = {}) {
  const root = makeRoot();
  git(root, 'init', '-q', '--initial-branch=main');
  git(root, 'config', 'user.email', 't@t.t');
  git(root, 'config', 'user.name', 't');
  if (overlay) {
    write(root, '.git/info/exclude', '/.devkit\n');
    write(root, '.devkit/config.json', '{"overlay":true}\n');
  }
  write(root, 'guard.config.json', JSON.stringify({ scanRoots: ['src'], maxLines: 50 }));
  write(root, 'src/legacy.ts', big(80));
  write(root, 'src/off.ts', '/* eslint-disable max-lines */\nexport {};\n');
  pile(root, 20);
  for (const bin of [SIZE_BIN, FANOUT_BIN]) expect(run(bin, root, 'freeze').status).toBe(0);
  git(root, 'add', 'guard.config.json', 'src');
  git(root, 'commit', '-qm', 'seed');
  return root;
}

function linkedWorktree(primary: string) {
  const worktree = join(makeRoot(), 'linked');
  git(primary, 'worktree', 'add', '-q', '--detach', worktree);
  return worktree;
}

function link(primary: string, worktree: string, rel: string) {
  mkdirSync(dirname(join(worktree, rel)), { recursive: true });
  symlinkSync(join(primary, rel), join(worktree, rel));
}

const BASELINES = [LINES, SIZE, FANOUT];
const snapshot = (root: string) => BASELINES.map((rel) => bytes(root, rel));

describe('overlay freeze through a link into another checkout', () => {
  it.each([
    ['guard-size', '.devkit', SIZE_BIN],
    ['guard-size', '.devkit/baselines', SIZE_BIN],
    ['guard-size', LINES, SIZE_BIN],
    ['guard-fanout', '.devkit', FANOUT_BIN],
    ['guard-fanout', '.devkit/baselines', FANOUT_BIN],
    ['guard-fanout', FANOUT, FANOUT_BIN],
  ])('%s freeze refuses when %s is linked, leaving the primary intact', (name, linked, bin) => {
    const primary = seedRepo();
    const before = snapshot(primary);
    const worktree = linkedWorktree(primary);
    link(primary, worktree, linked);
    write(worktree, 'src/legacy.ts', big(90));
    pile(worktree, 25);
    const r = run(bin, worktree, 'freeze');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(`${name} freeze: ${linked} links into another checkout`);
    expect(r.stderr).toContain(`rm '${linked}'`);
    expect(r.stderr).toContain('devkit doctor --fix');
    expect(snapshot(primary)).toEqual(before);
  });

  it('guard-size checks every baseline before writing the first, so none is half-frozen', () => {
    const primary = seedRepo();
    const worktree = linkedWorktree(primary);
    link(primary, worktree, LINES);
    expect(run(SIZE_BIN, worktree, 'freeze').status).toBe(2);
    expect(existsSync(join(worktree, SIZE))).toBe(false);
  });

  it.each([
    ['guard-size', SIZE_BIN],
    ['guard-fanout', FANOUT_BIN],
  ])('%s freeze with no debt left keeps the primary baseline it would delete', (_name, bin) => {
    const primary = seedRepo();
    const before = snapshot(primary);
    const worktree = linkedWorktree(primary);
    link(primary, worktree, '.devkit');
    rmSync(join(worktree, 'src'), { recursive: true });
    write(worktree, 'src/small.ts', 'export {};\n');
    expect(run(bin, worktree, 'freeze').status).toBe(2);
    expect(snapshot(primary)).toEqual(before);
  });

  // The leaf is missing, so the target resolves through the linked ancestor, not the file.
  it.each([
    ['guard-size', SIZE_BIN, LINES],
    ['guard-fanout', FANOUT_BIN, FANOUT],
  ])('%s freeze refuses to create a baseline the primary lacks', (_name, bin, rel) => {
    const primary = seedRepo();
    rmSync(join(primary, rel));
    const worktree = linkedWorktree(primary);
    link(primary, worktree, '.devkit');
    write(worktree, 'src/legacy.ts', big(90));
    pile(worktree, 25);
    expect(run(bin, worktree, 'freeze').status).toBe(2);
    expect(existsSync(join(primary, rel))).toBe(false);
  });

  it("freezes a projected worktree's own copy and leaves the primary alone", () => {
    const primary = seedRepo();
    const before = snapshot(primary);
    const worktree = linkedWorktree(primary);
    cpSync(join(primary, '.devkit/baselines'), join(worktree, '.devkit/baselines'), {
      recursive: true,
    });
    write(worktree, 'src/legacy.ts', big(90));
    pile(worktree, 25);
    for (const bin of [SIZE_BIN, FANOUT_BIN]) expect(run(bin, worktree, 'freeze').status).toBe(0);
    expect(JSON.parse(bytes(worktree, LINES)).files['src/legacy.ts']).toBe(90);
    expect(JSON.parse(bytes(worktree, FANOUT)).dirs['src/pile']).toBe(25);
    expect(snapshot(primary)).toEqual(before);
  });

  // `..x` is a directory name, not a step up, so the target stays inside this checkout.
  it('freezes through a link whose target is a `..`-named directory inside the checkout', () => {
    const root = seedRepo();
    mkdirSync(join(root, '..store'));
    cpSync(join(root, '.devkit/baselines'), join(root, '..store/baselines'), { recursive: true });
    rmSync(join(root, '.devkit/baselines'), { recursive: true });
    symlinkSync(join(root, '..store/baselines'), join(root, '.devkit/baselines'));
    write(root, 'src/legacy.ts', big(90));
    expect(run(SIZE_BIN, root, 'freeze').status).toBe(0);
    const lines = JSON.parse(readFileSync(join(root, '..store/baselines/size-lines.json'), 'utf8'));
    expect(lines.files['src/legacy.ts']).toBe(90);
  });

  it('freezes in the primary checkout as before', () => {
    const primary = seedRepo();
    write(primary, 'src/legacy.ts', big(90));
    expect(run(SIZE_BIN, primary, 'freeze').status).toBe(0);
    expect(JSON.parse(bytes(primary, LINES)).files['src/legacy.ts']).toBe(90);
  });

  it('a tracked install still writes through its linked baselines directory', () => {
    const root = seedRepo({ overlay: false });
    const elsewhere = join(makeRoot(), 'baselines');
    cpSync(join(root, '.devkit/baselines'), elsewhere, { recursive: true });
    rmSync(join(root, '.devkit/baselines'), { recursive: true });
    symlinkSync(elsewhere, join(root, '.devkit/baselines'));
    write(root, 'src/legacy.ts', big(90));
    expect(run(SIZE_BIN, root, 'freeze').status).toBe(0);
    expect(JSON.parse(readFileSync(join(elsewhere, 'size-lines.json'), 'utf8')).files).toEqual({
      'src/legacy.ts': 90,
    });
  });

  it('DEVKIT_OVERLAY=1 freezes a root that has no .devkit yet, as init does', () => {
    const root = makeRoot();
    git(root, 'init', '-q');
    write(root, 'guard.config.json', JSON.stringify({ scanRoots: ['src'], maxLines: 50 }));
    write(root, 'src/legacy.ts', big(80));
    pile(root, 20);
    for (const bin of [SIZE_BIN, FANOUT_BIN])
      expect(run(bin, root, 'freeze', { DEVKIT_OVERLAY: '1' }).status).toBe(0);
    expect(existsSync(join(root, LINES))).toBe(true);
    expect(existsSync(join(root, FANOUT))).toBe(true);
  });

  // A tracked install still nudges, so the overlay check cannot have silenced it everywhere.
  it.each([
    ['an overlay', false, true],
    ['a tracked', true, false],
  ])(
    '%s fan-out gate prints the freeze nudge when a folder shrank: %s',
    (_label, nudged, overlay) => {
      const primary = seedRepo({ overlay });
      pile(primary, 15);
      git(primary, 'add', 'src/pile');
      const r = run(FANOUT_BIN, primary, 'gate');
      expect(r.status).toBe(0);
      expect(r.stdout.includes('run `guard-fanout freeze` to lock it in')).toBe(nudged);
    },
  );
});
