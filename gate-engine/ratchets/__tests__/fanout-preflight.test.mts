import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { preflightFanout } from '../folder-fanout.mts';

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
  structure?: { trees: unknown[]; walls: unknown[] };
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

// In-process so coverage sees it; the CLI wiring keeps one spawned test below.
function preflight(root: string, ...paths: string[]) {
  const lines: string[] = [];
  const capture = (...args: unknown[]) => void lines.push(args.join(' '));
  const log = vi.spyOn(console, 'log').mockImplementation(capture);
  const error = vi.spyOn(console, 'error').mockImplementation(capture);
  try {
    return { status: preflightFanout(root, paths), out: lines.join('\n') };
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}

describe('guard-fanout preflight', () => {
  it('blocks a new file in a folder already at the cap', () => {
    const root = makeRepo({ pile: 12 });
    const r = preflight(root, 'src/pile/new.ts');
    expect(r.status).toBe(1);
    expect(r.out).toContain('src/pile: 12→13/12 impl files — blocks: split into a subfolder');
  });

  // Catches a remedy that omits registration: a subfolder of a domain-gated folder fails structure lint unregistered.
  it('adds the libDomains registration step when the full folder is domain-gated', () => {
    const grammar = { folders: { pile: { domainGate: 'pile' } } };
    const structure = { trees: [{ name: 'src', root: 'src', grammar }], walls: [] };
    const r = preflight(makeRepo({ pile: 12 }, { structure }), 'src/pile/new.ts');
    expect(r.status).toBe(1);
    expect(r.out).toContain('blocks: split into a subfolder and register it');
  });

  it('reports headroom for a folder under the cap', () => {
    const r = preflight(makeRepo({ pile: 5 }), 'src/pile/new.ts');
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
    const r = preflight(root, 'src/pile/new.ts');
    expect(r.status).toBe(0);
    expect(r.out).toContain('src/pile: 14→15/15 impl files — ok (headroom 0)');
  });

  it('does not count an already-tracked path or a repeated argument twice (via the CLI)', () => {
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
    const r = preflight(makeRepo({ pile: 11 }), 'src/pile/a.ts', 'src/pile/b.ts');
    expect(r.status).toBe(1);
    expect(r.out).toContain('src/pile: 11→13/12');
  });

  // Catches a false "ok": a ./-prefixed or absolute path missed the repo-relative tally and read as not judged.
  it('judges ./-prefixed and absolute paths like repo-relative ones', () => {
    const root = makeRepo({ pile: 12 });
    for (const path of ['./src/pile/new.ts', join(root, 'src/pile/new.ts')]) {
      const r = preflight(root, path);
      expect(r.status).toBe(1);
      expect(r.out).toContain('src/pile: 12→13/12');
    }
  });

  // Catches a false "ok": an absolute path through a symlinked root (macOS /var → /private/var) into a new folder.
  it('blocks a pile of new files in a new folder named through a symlinked absolute root', () => {
    const root = makeRepo({ pile: 1 });
    const paths = Array.from({ length: 13 }, (_, i) => join(root, `src/pile/fresh/f-${i}.ts`));
    const r = preflight(root, ...paths);
    expect(r.status).toBe(1);
    expect(r.out).toContain('src/pile/fresh: 0→13/12');
  });

  // Catches a false "ok": a new symlink file was judged in its target's folder, but git tracks the link itself.
  it('judges a symlinked file in its own folder, not its target’s', () => {
    const root = makeRepo({ pile: 12, other: 1 });
    symlinkSync('../other/file-0.ts', join(root, 'src/pile/link.ts'));
    const r = preflight(root, 'src/pile/link.ts');
    expect(r.status).toBe(1);
    expect(r.out).toContain('src/pile: 12→13/12');
  });

  it('treats a not-yet-created folder as empty', () => {
    const r = preflight(makeRepo({ pile: 12 }), 'src/pile/fresh/new.ts');
    expect(r.status).toBe(0);
    expect(r.out).toContain('src/pile/fresh: 0→1/12 impl files — ok (headroom 11)');
  });

  it('lists tests, barrels, exempt and out-of-scope paths as not judged', () => {
    const root = makeRepo({ pile: 12, skip: 12 }, { fanoutExempt: ['src/skip'] });
    const paths = ['src/pile/new.test.ts', 'src/pile/index.ts', 'src/skip/new.ts', 'docs/new.ts'];
    const r = preflight(root, ...paths);
    expect(r.status).toBe(0);
    expect(r.out).toContain(
      `not judged (test, barrel, exempt or outside scanRoots): ${paths.join(', ')}`,
    );
    expect(r.out).not.toContain('src/pile:');
  });

  it('ignores untracked files on disk, matching the commit-time gate', () => {
    const root = makeRepo({ pile: 11 });
    write(root, 'src/pile/untracked.ts');
    const r = preflight(root, 'src/pile/new.ts');
    expect(r.status).toBe(0);
    expect(r.out).toContain('src/pile: 11→12/12');
  });

  it('agrees with the gate when a staged deletion makes room', () => {
    const root = makeRepo({ pile: 12 });
    git(root, 'rm', '-q', 'src/pile/file-0.ts');
    const before = preflight(root, 'src/pile/new.ts');
    write(root, 'src/pile/new.ts');
    git(root, 'add', 'src/pile/new.ts');
    expect(before.status).toBe(0);
    expect(fanout(root, 'gate').status).toBe(0);
  });

  it('agrees with the gate when the addition grows a full folder', () => {
    const root = makeRepo({ pile: 12 });
    const before = preflight(root, 'src/pile/new.ts');
    write(root, 'src/pile/new.ts');
    git(root, 'add', 'src/pile/new.ts');
    expect(before.status).toBe(1);
    expect(fanout(root, 'gate').status).toBe(1);
  });

  it('exits 2 in an ungoverned repo with no baseline', () => {
    const r = preflight(makeRepo({ pile: 12 }, null), 'src/pile/new.ts');
    expect(r.status).toBe(2);
    expect(r.out).toContain('opted out');
  });

  it('prints usage without `--` and paths', () => {
    const r = fanout(makeRepo({ pile: 1 }), 'preflight', 'src/pile/new.ts');
    expect(r.status).toBe(2);
    expect(r.out).toContain('usage: guard-fanout <freeze|gate|preflight -- path...>');
  });
});
