import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs build script, no declarations
import { copyDistAssets, resolveDistDir } from '../../../scripts/copy-dist-assets.mjs';
import { REPO_ROOT } from '../harness.mts';

// sc-3220: the e2e harness builds into a tmp stage via `--out`, so a test run never rewrites the
// repo's release-only tracked dist/. These pin the retargeting, the refusals that keep a bad `--out`
// from touching source, and that the default (bun run build / devkit release) still targets dist/.

const SCRIPT = join(REPO_ROOT, 'scripts', 'copy-dist-assets.mjs');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'copy-dist-assets-'));
  dirs.push(d);
  return d;
}
/** A stage holding what tsc emits: the three compiled trees the copy step requires. */
function emitted(): string {
  const out = tmp();
  for (const d of ['cli', 'gate-engine', 'anti-slop/src']) mkdirSync(join(out, d), { recursive: true });
  return out;
}
function distStatus(): string {
  return spawnSync('git', ['status', '--porcelain', '--', 'dist'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .stdout;
}

describe('resolveDistDir', () => {
  const root = '/repo';

  it('defaults to <root>/dist, which bun run build and devkit release rely on', () => {
    expect(resolveDistDir([], root)).toBe('/repo/dist');
  });

  it('resolves a relative --out against cwd, not the repo', () => {
    expect(resolveDistDir(['--out', 'stage/dist'], root, '/tmp/x')).toBe('/tmp/x/stage/dist');
  });

  it('accepts --out naming <root>/dist itself', () => {
    expect(resolveDistDir(['--out', '/repo/dist'], root)).toBe('/repo/dist');
  });

  it('refuses --out at the repo root — the mirrors would rm -rf templates/, skills/ …', () => {
    expect(() => resolveDistDir(['--out', '.'], root, '/repo')).toThrow(/overlaps the repo/);
  });

  it('refuses --out inside a source dir (copying templates/ into its own subtree)', () => {
    expect(() => resolveDistDir(['--out', '/repo/templates/x'], root)).toThrow(/overlaps the repo/);
  });

  it('refuses --out under dist/ — only dist/ itself is the in-repo target', () => {
    expect(() => resolveDistDir(['--out', '/repo/dist/nested'], root)).toThrow(/overlaps the repo/);
  });

  it('treats a repo child whose name starts with ".." as inside, not as a parent escape', () => {
    expect(() => resolveDistDir(['--out', '/repo/..stage'], root)).toThrow(/overlaps the repo/);
  });

  it('accepts a sibling of the repo or an unrelated dir', () => {
    expect(resolveDistDir(['--out', '/repo-stage/dist'], root)).toBe('/repo-stage/dist');
    expect(resolveDistDir(['--out', '/tmp/s/dist'], root)).toBe('/tmp/s/dist');
  });

  it('refuses a parent of the repo — a repo dir named like an asset dir would be rm -rf\'d', () => {
    expect(() => resolveDistDir(['--out', '/'], root)).toThrow(/overlaps the repo/);
    expect(() => resolveDistDir(['--out', '..'], '/x/skills', '/x/skills')).toThrow(/overlaps the repo/);
  });

  it('refuses an option-shaped value instead of treating the next flag as the directory', () => {
    expect(() => resolveDistDir(['--out', '--bogus'], root)).toThrow(/needs a directory, got '--bogus'/);
    expect(() => resolveDistDir(['--out', '-x'], root)).toThrow(/needs a directory/);
    expect(() => resolveDistDir(['--out', '--out', '/tmp/s'], root)).toThrow(/needs a directory/);
  });

  it('refuses --out with no value instead of falling back to the repo dist', () => {
    expect(() => resolveDistDir(['--out'], root)).toThrow(/--out needs a directory/);
    expect(() => resolveDistDir(['--out', ''], root)).toThrow(/--out needs a directory/);
  });

  it('refuses an unknown argument such as --out=<dir> rather than silently writing the repo dist', () => {
    expect(() => resolveDistDir(['--out=/tmp/s'], root)).toThrow(/unknown argument '--out=\/tmp\/s'/);
  });
});

describe('resolveDistDir — symlinks are judged by where they lead', () => {
  it('refuses a link that points at the repo, and a not-yet-existing dir beneath one', () => {
    const link = join(tmp(), 'link');
    symlinkSync(REPO_ROOT, link);
    expect(() => resolveDistDir(['--out', link], REPO_ROOT)).toThrow(/overlaps the repo/);
    expect(() => resolveDistDir(['--out', join(link, 'templates', 'new')], REPO_ROOT)).toThrow(
      /overlaps the repo/,
    );
  });

  it('refuses a link into a source dir', () => {
    const link = join(tmp(), 'link');
    symlinkSync(join(REPO_ROOT, 'skills'), link);
    expect(() => resolveDistDir(['--out', link], REPO_ROOT)).toThrow(/overlaps the repo/);
  });

  it('treats a link to the repo dist/ as the default target', () => {
    const link = join(tmp(), 'link');
    symlinkSync(join(REPO_ROOT, 'dist'), link);
    expect(resolveDistDir(['--out', link], REPO_ROOT)).toBe(join(REPO_ROOT, 'dist'));
  });

  it('accepts a dir reached through a link that points outside the repo', () => {
    const target = tmp();
    const link = join(tmp(), 'link');
    symlinkSync(target, link);
    expect(resolveDistDir(['--out', join(link, 'dist')], REPO_ROOT)).toBe(join(link, 'dist'));
  });
});

describe('copyDistAssets', () => {
  it('throws naming the missing tree when tsc emitted nothing, and writes nothing', () => {
    const out = tmp();
    expect(() => copyDistAssets(REPO_ROOT, out)).toThrow(/cli is missing compiled output/);
    expect(readdirSync(out)).toEqual([]);
  });

  it('throws before any write on a partial emit (no anti-slop/src)', () => {
    const out = tmp();
    for (const d of ['cli', 'gate-engine']) mkdirSync(join(out, d));
    expect(() => copyDistAssets(REPO_ROOT, out)).toThrow(/anti-slop\/src is missing compiled output/);
    expect(readdirSync(out).sort()).toEqual(['cli', 'gate-engine']);
  });

  it('mirrors every shipped asset into the given dir and leaves the repo dist/ untouched', () => {
    const before = distStatus();
    const out = emitted();
    copyDistAssets(REPO_ROOT, out);
    expect(readFileSync(join(out, 'package.json'), 'utf8')).toBe(
      readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'),
    );
    for (const rel of ['README.md', 'anti-slop/LICENSE', 'anti-slop/UPSTREAM.md', 'templates', 'skills']) {
      expect(existsSync(join(out, rel)), rel).toBe(true);
    }
    expect(existsSync(join(out, 'cli/lib/ship/ship-branch.sh'))).toBe(true);
    expect(distStatus()).toBe(before);
  });

  it('prunes vendored .ts sources from the compiled anti-slop tree', () => {
    const out = emitted();
    writeFileSync(join(out, 'anti-slop/src/rule.ts'), 'source');
    writeFileSync(join(out, 'anti-slop/src/rule.js'), 'compiled');
    copyDistAssets(REPO_ROOT, out);
    expect(readdirSync(join(out, 'anti-slop/src'))).toEqual(['rule.js']);
  });

  it('re-running over a reused stage drops an asset that no longer exists in source', () => {
    const out = emitted();
    copyDistAssets(REPO_ROOT, out);
    writeFileSync(join(out, 'templates', 'removed-upstream.tmpl'), 'stale');
    copyDistAssets(REPO_ROOT, out);
    expect(existsSync(join(out, 'templates', 'removed-upstream.tmpl'))).toBe(false);
  });
});

describe('copy-dist-assets CLI', () => {
  const run = (args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

  it('exits 1 naming the --out dir when it holds no compiled output', () => {
    const out = tmp();
    const r = run(['--out', out]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(join(out, 'cli'));
    expect(readdirSync(out)).toEqual([]);
  });

  it('exits 1 on an unknown argument without touching the repo dist/', () => {
    const before = distStatus();
    const r = run(['--outdir', tmp()]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/unknown argument '--outdir'/);
    expect(distStatus()).toBe(before);
  });

  it('copies into --out and reports that dir', () => {
    const out = emitted();
    const r = run(['--out', out]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(out);
    expect(existsSync(join(out, 'package.json'))).toBe(true);
  });
});
