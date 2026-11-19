/** sc-3225 provenance survives ship's fallow rekey (sc-1292): the gate reads the linked artifact
 * byte-exact, so a fresh run passes with its run id and an unseen production edit still blocks. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rebaseWorktreeCoverage } from '../../../cli/lib/ship/coverage/coverage-rebase.mts';
import { coverageMapSchema } from '../fallow-copy.mts';
import {
  cleanupRepos,
  entry,
  gate,
  git,
  measure,
  repo,
  stage,
  trackRoot,
  write,
} from './_provenance-fixtures.mts';

const helper = fileURLToPath(
  new URL('../../../cli/lib/ship/coverage/coverage-rebase.mts', import.meta.url),
);

beforeEach(() => {
  vi.stubEnv('GUARD_COVERAGE_OK', '');
  vi.stubEnv('GUARD_NO_COVERAGE', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  cleanupRepos();
});

/** coverage-run in `root`, keyed by its absolute paths (as istanbul writes them), then a ship-style
 * worktree whose coverage/ links back to it with fallow's rekeyed copy written aside. */
function shipWorktree() {
  const { root } = repo();
  const key = `${root}/src/a.mts`;
  const cov = JSON.stringify({
    [key]: {
      path: key,
      statementMap: { '0': { start: { line: 1 } } },
      s: { '0': 1 },
      f: {},
      b: { '0': [1, -1] },
    },
  });
  measure(root, undefined, cov);
  const wt = join(trackRoot(mkdtempSync(join(tmpdir(), 'coverage-ship-rekey-'))), 'ship wt');
  git(root, 'worktree', 'add', '-q', '--detach', wt, 'HEAD');
  symlinkSync(join(root, 'coverage'), join(wt, 'coverage'));
  const out = join(wt, '..', 'fallow-coverage.json');
  expect(rebaseWorktreeCoverage(wt, join(root, 'coverage'), out)).toEqual({ root });
  return { root, wt, out };
}

describe('ship: coverage provenance after the fallow rekey', () => {
  it('a fresh artifact passes and names its run — provenance is not blinded to unknown', () => {
    const { wt } = shipWorktree();
    stage(wt);
    const { code, out } = gate(wt);
    expect(code).toBe(0);
    expect(out).toMatch(/✓ Coverage gate passed \(.*\) — artifact run run-\d+/);
    expect(out).not.toContain('provenance unknown');
  });

  it('a production edit the run never saw blocks the ship', () => {
    const { wt } = shipWorktree();
    write(wt, 'src/a.mts', 'export const a = 2;\n');
    stage(wt);
    const { code, out } = gate(wt);
    expect(code).toBe(1);
    expect(out).toContain('coverage artifact predates 1 briefed file(s):');
  });

  it("fallow's copy carries the worktree's keys; the gate's artifact keeps the producer's", () => {
    const { root, wt, out } = shipWorktree();
    const keysOf = (file: string) =>
      Object.keys(coverageMapSchema.parse(JSON.parse(readFileSync(file, 'utf8'))));
    expect(keysOf(join(wt, 'coverage/coverage-final.json'))).toEqual([`${root}/src/a.mts`]);
    expect(keysOf(out)[0]).toMatch(/\/ship wt\/src\/a\.mts$/);
    // The gate judges the artifact as produced; only fallow's copy clamps a negative count to 0.
    expect(readFileSync(join(wt, 'coverage/coverage-final.json'), 'utf8')).toContain(
      '"b":{"0":[1,-1]}',
    );
    expect(readFileSync(out, 'utf8')).toContain('"b":{"0":[1,0]}');
  });
});

describe('ship: a full run the staged edits postdate', () => {
  it("drops the stale file's key before the rekey and names the file", () => {
    const { root } = repo();
    write(root, 'src/b.mts', 'export const b = 1;\n');
    stage(root);
    git(root, 'commit', '-q', '-m', 'b');
    const [a, b] = [`${root}/src/a.mts`, `${root}/src/b.mts`];
    measure(root, undefined, JSON.stringify({ [a]: entry(a), [b]: entry(b) }));
    const wt = join(trackRoot(mkdtempSync(join(tmpdir(), 'coverage-ship-stale-'))), 'wt');
    git(root, 'worktree', 'add', '-q', '--detach', wt, 'HEAD');
    write(wt, 'src/a.mts', '// header\nexport const a = 1;\n');
    stage(wt);
    const out = join(wt, '..', 'fallow-coverage.json');

    const result = rebaseWorktreeCoverage(wt, join(root, 'coverage'), out);

    expect(result).toEqual({ root, stale: { files: ['src/a.mts'], keys: [a], tests: [] } });
    const keys = Object.keys(coverageMapSchema.parse(JSON.parse(readFileSync(out, 'utf8'))));
    expect(keys).toEqual([`${realpathSync(wt)}/src/b.mts`]);
  });

  it('prints `pruned` when the keys already sit at the worktree and only stale keys were dropped', () => {
    const { root } = repo();
    const top = git(root, 'rev-parse', '--show-toplevel');
    const a = `${top}/src/a.mts`;
    measure(root, undefined, JSON.stringify({ [a]: entry(a) }));
    write(root, 'src/a.mts', 'export const a = 2;\n');
    stage(root);
    const out = join(trackRoot(mkdtempSync(join(tmpdir(), 'coverage-ship-pruned-'))), 'f.json');

    const r = spawnSync(process.execPath, [helper, root, join(root, 'coverage'), out], {
      encoding: 'utf8',
    });

    expect(r.stdout).toBe('pruned\n');
    expect(r.stderr).toContain(
      'devkit ship: fallow scores CRAP for 1 file(s) from static estimates',
    );
    expect(readFileSync(out, 'utf8')).toBe('{}');
  });
});
