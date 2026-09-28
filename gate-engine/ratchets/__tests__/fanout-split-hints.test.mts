import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Grammar } from '../../structure/compile.mts';
import { fanoutSplitHints } from '../folder-fanout.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SIZE = join(HERE, '..', 'size-disable.mts');
const FANOUT = join(HERE, '..', 'folder-fanout.mts');
const TRIP = 'a sibling split will trip guard-fanout';
const roots: string[] = [];

// The guard.config.json fields these fixtures set.
interface FixtureConfig {
  scanRoots: string[];
  sourceExtensions: string[];
  fanoutCap?: number;
  fanoutExempt?: string[];
  maxLines?: number;
  structure?: { trees: unknown[]; walls: unknown[] };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(config: FixtureConfig | null = { scanRoots: ['src'], sourceExtensions: ['ts'] }) {
  const root = mkdtempSync(join(tmpdir(), 'fanout-hints-'));
  roots.push(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 't@t.t');
  git(root, 'config', 'user.name', 't');
  if (config) write(root, 'guard.config.json', JSON.stringify(config));
  return root;
}

function git(root: string, ...args: string[]) {
  execFileSync('git', args, { cwd: root });
}

function write(root: string, rel: string, content = 'export {};\n') {
  mkdirSync(join(root, dirname(rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

// `n` impl files named file-0.ts … in `dir`.
function fill(root: string, dir: string, n: number, prefix = 'file') {
  for (let i = 0; i < n; i++) write(root, `${dir}/${prefix}-${i}.ts`);
}

function freezeFanout(root: string, dirs: Record<string, number>, cap = 12) {
  write(root, '.devkit/baselines/fanout.json', JSON.stringify({ cap, dirs }));
}

function big(lines: number) {
  return `${Array(lines).fill('const x = 1;').join('\n')}\n`;
}

function run(script: string, root: string, ...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });
}

describe('fanoutSplitHints — headroom boundaries', () => {
  it('flags a folder at exactly the cap: headroom 0 means any sibling split trips', () => {
    const root = makeRoot();
    fill(root, 'src/a', 12);
    const hints = fanoutSplitHints(root, ['src/a/file-0.ts']);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain('src/a is at 12/12 impl files');
    expect(hints[0]).toContain(TRIP);
    expect(hints[0]).toContain('split into a subfolder instead');
  });

  it('reports remaining room one below the cap, without subfolder advice', () => {
    const root = makeRoot();
    fill(root, 'src/a', 11);
    const [hint] = fanoutSplitHints(root, ['src/a/file-0.ts']);
    expect(hint).toContain('src/a: 11/12 impl files');
    expect(hint).toContain('room for 1 more sibling file(s)');
    expect(hint).not.toContain(TRIP);
  });

  it('honours a consumer fanoutCap instead of the default 12', () => {
    const root = makeRoot({ scanRoots: ['src'], sourceExtensions: ['ts'], fanoutCap: 3 });
    fill(root, 'src/a', 3);
    expect(fanoutSplitHints(root, ['src/a/file-0.ts'])[0]).toContain('3/3 impl files');
  });

  it('honours a JS consumer whose sourceExtensions are mjs', () => {
    const root = makeRoot({ scanRoots: ['lib'], sourceExtensions: ['mjs'] });
    for (let i = 0; i < 12; i++) write(root, `lib/m-${i}.mjs`);
    expect(fanoutSplitHints(root, ['lib/m-0.mjs'])[0]).toContain('lib is at 12/12');
  });
});

describe('fanoutSplitHints — allowance comes from the baseline, as the gate judges it', () => {
  it('uses a grandfathered allowance: 15 of an allowed 15 is at its limit', () => {
    const root = makeRoot();
    fill(root, 'src/pile', 15);
    freezeFanout(root, { 'src/pile': 15 });
    const [hint] = fanoutSplitHints(root, ['src/pile/file-0.ts']);
    expect(hint).toContain('src/pile is at 15/15');
    expect(hint).toContain(TRIP);
  });

  it('does not claim a trip for a grandfathered folder that shrank below its allowance', () => {
    const root = makeRoot();
    fill(root, 'src/pile', 14); // over the raw cap of 12, but under its frozen 15
    freezeFanout(root, { 'src/pile': 15 });
    const [hint] = fanoutSplitHints(root, ['src/pile/file-0.ts']);
    expect(hint).toContain('14/15');
    expect(hint).not.toContain(TRIP);
  });

  it('uses a raised config cap over a stale frozen cap, as the gate does', () => {
    const root = makeRoot({ scanRoots: ['src'], sourceExtensions: ['ts'], fanoutCap: 15 });
    fill(root, 'src/a', 13);
    freezeFanout(root, {}, 12); // frozen before the cap was raised
    const [hint] = fanoutSplitHints(root, ['src/a/file-0.ts']);
    expect(hint).toContain('13/15');
    expect(hint).not.toContain(TRIP);
    write(root, 'src/a/sibling.ts');
    expect(run(FANOUT, root, 'gate').status).toBe(0);
  });

  it('flags a drifted folder already above its allowance (negative headroom)', () => {
    const root = makeRoot();
    fill(root, 'src/pile', 16);
    freezeFanout(root, { 'src/pile': 15 });
    expect(fanoutSplitHints(root, ['src/pile/file-0.ts'])[0]).toContain('16/15');
  });
});

describe('fanoutSplitHints — folders fan-out does not judge get no hint', () => {
  it('skips test files and barrels, which never count toward fan-out', () => {
    const root = makeRoot();
    fill(root, 'src/a', 12);
    write(root, 'src/a/big.test.ts');
    write(root, 'src/a/index.ts');
    expect(fanoutSplitHints(root, ['src/a/big.test.ts', 'src/a/index.ts'])).toEqual([]);
  });

  it('skips a folder listed in fanoutExempt', () => {
    const root = makeRoot({
      scanRoots: ['src'],
      sourceExtensions: ['ts'],
      fanoutExempt: ['src/a'],
    });
    fill(root, 'src/a', 20);
    expect(fanoutSplitHints(root, ['src/a/file-0.ts'])).toEqual([]);
  });

  it('skips a folder outside scanRoots', () => {
    const root = makeRoot();
    fill(root, 'scripts', 12);
    expect(fanoutSplitHints(root, ['scripts/file-0.ts'])).toEqual([]);
  });

  it('skips a file under a __tests__ directory', () => {
    const root = makeRoot();
    fill(root, 'src/a/__tests__', 12, 'helper');
    expect(fanoutSplitHints(root, ['src/a/__tests__/helper-0.ts'])).toEqual([]);
  });

  it('prints nothing when guard-fanout fails open (no config, no baseline)', () => {
    const root = makeRoot(null);
    fill(root, 'src/a', 12);
    expect(fanoutSplitHints(root, ['src/a/file-0.ts'])).toEqual([]);
  });

  it('still hints when a baseline governs a repo that has no guard.config.json', () => {
    const root = makeRoot(null);
    fill(root, 'src/a', 12);
    freezeFanout(root, {});
    expect(fanoutSplitHints(root, ['src/a/file-0.ts'])[0]).toContain(TRIP);
  });

  it('returns no hint rather than throwing on a corrupt fan-out baseline', () => {
    const root = makeRoot();
    fill(root, 'src/a', 12);
    write(root, '.devkit/baselines/fanout.json', '{not json');
    expect(fanoutSplitHints(root, ['src/a/file-0.ts'])).toEqual([]);
  });
});

describe('fanoutSplitHints — output shape', () => {
  it('prints one line per folder however many of its files are over cap, sorted by folder', () => {
    const root = makeRoot();
    fill(root, 'src/b', 12);
    fill(root, 'src/a', 12);
    const hints = fanoutSplitHints(root, ['src/b/file-1.ts', 'src/a/file-0.ts', 'src/b/file-0.ts']);
    expect(hints).toHaveLength(2);
    expect(hints[0]).toContain('src/a is at');
    expect(hints[1]).toContain('src/b is at');
  });

  it('adds the registration step when the folder is a domain-gated tree root', () => {
    const root = makeRoot({
      scanRoots: ['src'],
      sourceExtensions: ['ts'],
      structure: {
        trees: [{ name: 'src', root: 'src', grammar: { domainGate: '@root' } }],
        walls: [],
      },
    });
    fill(root, 'src', 12);
    expect(fanoutSplitHints(root, ['src/file-0.ts'])[0]).toContain('register it');
  });

  it('adds the registration step for a domain-gated named folder like cli/lib', () => {
    const root = makeRoot({
      scanRoots: ['cli'],
      sourceExtensions: ['ts'],
      structure: {
        trees: [{ name: 'cli', root: 'cli', grammar: { folders: { lib: { domainGate: 'lib' } } } }],
        walls: [],
      },
    });
    fill(root, 'cli/lib', 12);
    fill(root, 'cli/lib/ship', 12);
    const hints = fanoutSplitHints(root, ['cli/lib/file-0.ts', 'cli/lib/ship/file-0.ts']);
    expect(hints[0]).toContain('register it');
    // A folder nested below the gated one takes kebab subfolders freely.
    expect(hints[1]).not.toContain('register it');
  });
});

describe('fanoutSplitHints — domain gates nested in a consumer grammar', () => {
  const gated = (grammar: Grammar) =>
    makeRoot({
      scanRoots: ['src'],
      sourceExtensions: ['ts'],
      structure: { trees: [{ name: 'src', root: 'src', grammar }], walls: [] },
    });

  it('finds a domain gate on a nested named folder (src/features/lib)', () => {
    const root = gated({ folders: { features: { folders: { lib: { domainGate: 'lib' } } } } });
    fill(root, 'src/features/lib', 12);
    expect(fanoutSplitHints(root, ['src/features/lib/file-0.ts'])[0]).toContain('register it');
  });

  it('finds a domain gate reached through a recurse rule', () => {
    const root = gated({
      recurse: 'pkg',
      rules: { pkg: { folderName: '{kebab_dir}', folders: { lib: { domainGate: 'lib' } } } },
    });
    fill(root, 'src/billing/lib', 12);
    expect(fanoutSplitHints(root, ['src/billing/lib/file-0.ts'])[0]).toContain('register it');
  });

  it.each([
    ['ignoredDirs', { ignoredDirs: ['legacy'] }],
    ['frozenDirs', { frozenDirs: ['legacy'] }],
  ])('omits the step below a folder in %s, which the structure walker never judges', (_, skip) => {
    const root = makeRoot({
      scanRoots: ['src'],
      sourceExtensions: ['ts'],
      structure: {
        trees: [
          {
            name: 'src',
            root: 'src',
            ...skip,
            grammar: { recurse: 'mod', rules: { mod: { domainGate: 'lib', recurse: 'mod' } } },
          },
        ],
        walls: [],
      },
    });
    fill(root, 'src/legacy', 12);
    fill(root, 'src/billing', 12);
    const hints = fanoutSplitHints(root, ['src/billing/file-0.ts', 'src/legacy/file-0.ts']);
    expect(hints[0]).toContain('register it'); // src/billing: the same rule, not skipped
    expect(hints[1]).not.toContain('register it');
  });

  it('omits the step for a folder the grammar resolves to an ungated rule', () => {
    const root = gated({ domainGate: '@root', recurse: 'mod', rules: { mod: { recurse: 'mod' } } });
    fill(root, 'src/review', 12);
    expect(fanoutSplitHints(root, ['src/review/file-0.ts'])[0]).not.toContain('register it');
  });
});

describe('fanoutSplitHints — counts the same snapshot the gate would judge', () => {
  it('counts the index during a commit, ignoring untracked files in the same folder', () => {
    const root = makeRoot();
    fill(root, 'src/a', 11);
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'base');
    write(root, 'src/a/new.ts');
    git(root, 'add', 'src/a/new.ts'); // index: 12
    fill(root, 'src/a', 3, 'untracked'); // another agent's unstaged work
    expect(fanoutSplitHints(root, ['src/a/new.ts'])[0]).toContain('12/12');
  });

  it('counts the working tree when nothing is staged, as the gate does in CI or an audit', () => {
    const root = makeRoot();
    fill(root, 'src/a', 11);
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'base');
    write(root, 'src/a/untracked.ts');
    expect(fanoutSplitHints(root, ['src/a/file-0.ts'])[0]).toContain('12/12');
  });
});

describe('guard-size failure output carries the fan-out hint (integration)', () => {
  const config = { scanRoots: ['src'], sourceExtensions: ['ts'], maxLines: 50 };

  // 11 committed impl files + a staged over-cap 12th: the folder is at the cap.
  function atCapWithOversized(root: string) {
    fill(root, 'src/a', 11);
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'base');
    write(root, 'src/a/runtime.ts', big(60));
    git(root, 'add', 'src/a/runtime.ts');
  }

  it('the line gate prints the hint and still exits 1', () => {
    const root = makeRoot(config);
    atCapWithOversized(root);
    const result = run(SIZE, root, 'gate');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('src/a/runtime.ts: 60 lines');
    expect(result.stderr).toContain(`src/a is at 12/12 impl files: ${TRIP}`);
  });

  it('the preflight prints the hint and still exits 1; a passing preflight prints none', () => {
    const root = makeRoot(config);
    atCapWithOversized(root);
    const failing = run(SIZE, root, 'preflight', '--base', 'HEAD');
    expect(failing.status).toBe(1);
    expect(failing.stderr).toContain(TRIP);

    write(root, 'src/a/runtime.ts', big(40));
    git(root, 'add', 'src/a/runtime.ts');
    const passing = run(SIZE, root, 'preflight', '--base', 'HEAD');
    expect(passing.status).toBe(0);
    expect(`${passing.stdout}${passing.stderr}`).not.toContain(TRIP);
  });

  it('the disable gate prints the hint beside its split remedy', () => {
    const root = makeRoot({ scanRoots: ['src'], sourceExtensions: ['ts'] });
    fill(root, 'src/a', 12);
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'base');
    write(root, 'src/a/file-0.ts', '/* eslint-disable max-lines */\nexport {};\n');
    git(root, 'add', 'src/a/file-0.ts');
    const result = run(SIZE, root, 'gate');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Split the file below the cap');
    expect(result.stderr).toContain(TRIP);
  });

  it('acceptance: the sibling split the hint warns about trips guard-fanout; the subfolder split passes both gates', () => {
    const root = makeRoot(config);
    atCapWithOversized(root);
    expect(run(SIZE, root, 'gate').stderr).toContain(TRIP);

    // Sibling split: runtime.ts shrinks, a 13th impl file lands beside it.
    write(root, 'src/a/runtime.ts', big(30));
    write(root, 'src/a/runtime-part.ts', big(30));
    git(root, 'add', '-A');
    expect(run(SIZE, root, 'gate').status).toBe(0);
    expect(run(FANOUT, root, 'gate').status).toBe(1);

    // Subfolder split: the extracted part moves below the capped folder.
    git(root, 'rm', '-q', '--cached', 'src/a/runtime-part.ts');
    rmSync(join(root, 'src/a/runtime-part.ts'));
    write(root, 'src/a/runtime/part.ts', big(30));
    git(root, 'add', '-A');
    expect(run(SIZE, root, 'gate').status).toBe(0);
    expect(run(FANOUT, root, 'gate').status).toBe(0);
  });
});
