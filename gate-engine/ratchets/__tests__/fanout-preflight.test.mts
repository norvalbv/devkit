import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const FANOUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'folder-fanout.mts');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root: string, ...args: string[]) {
  execFileSync('git', args, { cwd: root });
}

function write(root: string, rel: string, content = 'export {};\n') {
  mkdirSync(join(root, dirname(rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

// The guard.config.json fields a fixture overrides on top of its defaults.
interface FixtureConfig {
  fanoutExempt?: string[];
}

// A committed repo whose `src/<dir>` folders hold the given number of impl files.
function makeRepo(dirs: Record<string, number>, config: FixtureConfig | null = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fanout-preflight-'));
  roots.push(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 't@t.t');
  git(root, 'config', 'user.name', 't');
  if (config) {
    const cfg = { scanRoots: ['src'], sourceExtensions: ['ts'], fanoutCap: 12, ...config };
    write(root, 'guard.config.json', JSON.stringify(cfg));
  }
  for (const [dir, n] of Object.entries(dirs)) {
    for (let i = 0; i < n; i++) write(root, `src/${dir}/file-${i}.ts`);
  }
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
  return root;
}

function fanout(root: string, ...args: string[]) {
  const r = spawnSync('node', [FANOUT, ...args], { cwd: root, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('guard-fanout preflight', () => {
  it('blocks a new file in a folder already at the cap', () => {
    const root = makeRepo({ pile: 12 });
    const r = fanout(root, 'preflight', '--', 'src/pile/new.ts');
    expect(r.status).toBe(1);
    expect(r.out).toContain('src/pile: 12→13/12 impl files — blocks: split into a subfolder');
  });

  it('reports headroom for a folder under the cap', () => {
    const r = fanout(makeRepo({ pile: 5 }), 'preflight', '--', 'src/pile/new.ts');
    expect(r.status).toBe(0);
    expect(r.out).toContain('src/pile: 5→6/12 impl files — ok (headroom 6)');
  });

  it('honours a grandfathered baseline ceiling', () => {
    const root = makeRepo({ pile: 14 });
    write(
      root,
      '.devkit/baselines/fanout.json',
      JSON.stringify({ cap: 12, dirs: { 'src/pile': 15 } }),
    );
    const r = fanout(root, 'preflight', '--', 'src/pile/new.ts');
    expect(r.status).toBe(0);
    expect(r.out).toContain('src/pile: 14→15/15 impl files — ok (headroom 0)');
  });

  it('does not count an already-tracked path or a repeated argument twice', () => {
    const r = fanout(
      makeRepo({ pile: 12 }),
      'preflight',
      '--',
      'src/pile/file-0.ts',
      'src/pile/file-0.ts',
    );
    expect(r.status).toBe(0);
    expect(r.out).toContain('src/pile: 12→12/12');
  });

  it('adds up several new files in one folder', () => {
    const r = fanout(makeRepo({ pile: 11 }), 'preflight', '--', 'src/pile/a.ts', 'src/pile/b.ts');
    expect(r.status).toBe(1);
    expect(r.out).toContain('src/pile: 11→13/12');
  });

  it('treats a not-yet-created folder as empty', () => {
    const r = fanout(makeRepo({ pile: 12 }), 'preflight', '--', 'src/pile/fresh/new.ts');
    expect(r.status).toBe(0);
    expect(r.out).toContain('src/pile/fresh: 0→1/12 impl files — ok (headroom 11)');
  });

  it('lists tests, barrels, exempt and out-of-scope paths as not judged', () => {
    const root = makeRepo({ pile: 12, skip: 12 }, { fanoutExempt: ['src/skip'] });
    const paths = ['src/pile/new.test.ts', 'src/pile/index.ts', 'src/skip/new.ts', 'docs/new.ts'];
    const r = fanout(root, 'preflight', '--', ...paths);
    expect(r.status).toBe(0);
    expect(r.out).toContain(
      `not judged (test, barrel, exempt or outside scanRoots): ${paths.join(', ')}`,
    );
    expect(r.out).not.toContain('src/pile:');
  });

  it('ignores untracked files on disk, matching the commit-time gate', () => {
    const root = makeRepo({ pile: 11 });
    write(root, 'src/pile/untracked.ts');
    const r = fanout(root, 'preflight', '--', 'src/pile/new.ts');
    expect(r.status).toBe(0);
    expect(r.out).toContain('src/pile: 11→12/12');
  });

  it('agrees with the gate when a staged deletion makes room', () => {
    const root = makeRepo({ pile: 12 });
    git(root, 'rm', '-q', 'src/pile/file-0.ts');
    const preflight = fanout(root, 'preflight', '--', 'src/pile/new.ts');
    write(root, 'src/pile/new.ts');
    git(root, 'add', 'src/pile/new.ts');
    expect(preflight.status).toBe(0);
    expect(fanout(root, 'gate').status).toBe(0);
  });

  it('agrees with the gate when the addition grows a full folder', () => {
    const root = makeRepo({ pile: 12 });
    const preflight = fanout(root, 'preflight', '--', 'src/pile/new.ts');
    write(root, 'src/pile/new.ts');
    git(root, 'add', 'src/pile/new.ts');
    expect(preflight.status).toBe(1);
    expect(fanout(root, 'gate').status).toBe(1);
  });

  it('exits 2 in an ungoverned repo with no baseline', () => {
    const r = fanout(makeRepo({ pile: 12 }, null), 'preflight', '--', 'src/pile/new.ts');
    expect(r.status).toBe(2);
    expect(r.out).toContain('opted out');
  });

  it('prints usage without `--` and paths', () => {
    const r = fanout(makeRepo({ pile: 1 }), 'preflight', 'src/pile/new.ts');
    expect(r.status).toBe(2);
    expect(r.out).toContain('usage: guard-fanout <freeze|gate|preflight -- path...>');
  });
});
