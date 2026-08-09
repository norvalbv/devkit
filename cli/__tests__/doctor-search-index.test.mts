/**
 * doctor's check for a search-code index that exists but is not wired to the dup gate.
 *
 * The bug it exists for is silence: a repo carried a fully-built `.search-code/index.db` while the
 * co-occurrence matcher opted out on every commit, because `indexPath` had gone missing from
 * guard.config.json. Fail-open is correct there — so the only way to notice is for doctor to look.
 *
 * The OK cases carry most of the weight. This check runs in every repo with the dup guard selected,
 * and a false positive exits 1 forever in the many repos that legitimately have no search-code.
 */

import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectResults } from '../commands/doctor.mts';
import {
  adviseSearchIndex,
  checkGuardConfig,
  checkSearchIndex,
} from '../lib/doctor/guard-config-checks.mts';
import { rootRegistry } from './_helpers.mts';

const { mkTmp, cleanup } = rootRegistry();
afterEach(() => {
  cleanup();
  delete process.env.SEARCH_CODE_DB;
  delete process.env.GUARD_INDEX_PATH;
  // Without this a console spy survives into the next test and carries its calls with it, so a
  // "stayed silent" assertion reads the PREVIOUS test's output and fails for the wrong reason.
  vi.restoreAllMocks();
});

const CHECK = 'search-code index';

interface RepoOpts {
  /** guard.config.json contents; omit the key entirely to model the drift being detected. */
  guardConfig?: Record<string, unknown>;
  /** Write a stub `.search-code/index.db`. */
  index?: boolean;
  guards?: string[];
  searchCode?: boolean;
}

function repo({
  guardConfig = {},
  index = false,
  guards = ['dup'],
  searchCode = false,
}: RepoOpts = {}): { root: string; cfg: object } {
  const root = mkTmp('doctor-search-index-');
  writeFileSync(join(root, 'guard.config.json'), JSON.stringify(guardConfig, null, 2));
  if (index) {
    mkdirSync(join(root, '.search-code'), { recursive: true });
    writeFileSync(join(root, '.search-code', 'index.db'), 'stub');
  }
  return {
    root,
    cfg: {
      components: {
        husky: false,
        biome: false,
        tsconfig: false,
        skills: false,
        guards,
        searchCode,
      },
    },
  };
}

async function indexCheck(opts: RepoOpts = {}) {
  const { root, cfg } = repo(opts);
  const { results } = await collectResults(root, cfg, { name: 'config.json', status: 'OK' });
  return results.find((r) => r.name === CHECK);
}

/** Same, but asserts the check was actually wired in — a silent absence would pass every OK test. */
async function required(opts: RepoOpts = {}) {
  const result = await indexCheck(opts);
  if (!result) throw new Error(`no "${CHECK}" result — check is not wired into collectResults`);
  return result;
}

function writeIndex(root: string, storedMtime?: number): void {
  const source = join(root, 'src.ts');
  writeFileSync(source, 'export const indexed = true;\n');
  mkdirSync(join(root, '.search-code'), { recursive: true });
  const db = new DatabaseSync(join(root, '.search-code', 'index.db'));
  db.exec('CREATE TABLE chunks (file_path TEXT, file_mtime INTEGER)');
  db.prepare('INSERT INTO chunks (file_path, file_mtime) VALUES (?, ?)').run(
    'src.ts',
    storedMtime ?? statSync(source).mtimeMs,
  );
  db.close();
}

describe('doctor — an unwired search-code index is drift', () => {
  it('flags an index on disk that nothing points at', async () => {
    const result = await required({ index: true });
    expect(result.status).toBe('DRIFT');
    expect(result.detail).toContain('.search-code/index.db exists');
    expect(result.detail).toContain('silently opted out');
  });

  it('flags a repo that selected search-code but never got an indexPath', async () => {
    const result = await required({ searchCode: true });
    expect(result.status).toBe('DRIFT');
    expect(result.detail).toContain('search-code is selected');
  });

  // --fix repairs by re-running `devkit init --search-code`, and selectionFlags emits that flag only
  // for a repo whose RECORDED selection already has it. Claiming fixable elsewhere would promise a
  // repair that cannot happen, leaving a warning that never clears.
  it('is fixable only when the recorded selection can reproduce the wiring', async () => {
    expect((await required({ index: true, searchCode: true })).fixable).toBe(true);
    const unowned = await required({ index: true, searchCode: false });
    expect(unowned.fixable).toBe(false);
    expect(unowned.remediation).toContain('devkit init --search-code');
  });
});

describe('doctor — the silence cases (a false positive here punishes every consumer)', () => {
  it('stays OK for the common repo: no index, never opted in', async () => {
    const result = await required();
    expect(result.status).toBe('OK');
    expect(result.detail).toContain('no search-code index');
  });

  it('stays OK when indexPath is set', async () => {
    const { root } = repo({ guardConfig: { indexPath: '.search-code/index.db' } });
    writeIndex(root);
    const result = checkSearchIndex(root, '.search-code/index.db', false);
    expect(result.status).toBe('OK');
    expect(result.detail).toContain('match the source checkout');
  });

  // The escape hatch. An explicit null is a DECLARED opt-out; only an ABSENT key is drift.
  // resolveGuardConfig collapses both to null, so the raw file is the one place they differ.
  it('honours an explicit `"indexPath": null` as a deliberate opt-out', async () => {
    const result = await required({ guardConfig: { indexPath: null }, index: true });
    expect(result.status).toBe('OK');
    expect(result.detail).toContain('explicit');
  });

  // SEARCH_CODE_DB is read only by matcher.mts and never reaches resolveGuardConfig, so without an
  // explicit check a correctly-wired matcher would be reported as drift.
  it('stays OK when the matcher is wired by SEARCH_CODE_DB', async () => {
    process.env.SEARCH_CODE_DB = '/tmp/some-index.db';
    expect((await required({ index: true })).status).toBe('OK');
  });

  it('stays OK when the matcher is wired by GUARD_INDEX_PATH', async () => {
    const { root } = repo();
    writeIndex(root);
    process.env.GUARD_INDEX_PATH = join(root, '.search-code', 'index.db');
    const results = await checkGuardConfig(root, true, false);
    expect(results.find((r) => r.name === CHECK)?.status).toBe('OK');
  });
});

describe('doctor — scoping', () => {
  // dup is the only gate that reads the index. A repo running size+fanout must never be told its
  // dup wiring drifted, so the check should not appear at all.
  it('does not run when the dup guard is not selected', async () => {
    expect(await indexCheck({ index: true, guards: ['size', 'fanout'] })).toBeUndefined();
  });

  // An absent guard.config.json is already reported by the validity check; a second line about a key
  // missing from a file that does not exist names the same root cause twice.
  it('stays quiet when guard.config.json itself is missing', async () => {
    const root = mkTmp('doctor-search-index-nocfg-');
    mkdirSync(join(root, '.search-code'), { recursive: true });
    writeFileSync(join(root, '.search-code', 'index.db'), 'stub');
    const cfg = { components: { husky: false, biome: false, tsconfig: false, guards: ['dup'] } };
    const { results } = await collectResults(root, cfg, { name: 'config.json', status: 'OK' });
    expect(results.find((r) => r.name === CHECK)).toBeUndefined();
    expect(results.find((r) => r.name === 'guard.config.json')?.status).toBe('MISSING');
  });
});

// The advisory path for overlay + self-host, which short-circuit before collectResults. It had NO
// coverage, and its failure mode is the check silently vanishing in the mode devkit dogfoods —
// the same shape of silent gap this whole change exists to close.
describe('doctor — the overlay / self-host advisory', () => {
  function advisoryRepo(opts: RepoOpts = {}) {
    const { root, cfg } = repo(opts);
    return { root, sel: (cfg as { components: Record<string, unknown> }).components };
  }

  it('prints an OK line when the matcher is wired', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { root, sel } = advisoryRepo({ guardConfig: { indexPath: '.search-code/index.db' } });
    writeIndex(root);
    await adviseSearchIndex(root, sel);
    expect(log.mock.calls.flat().join('\n')).toContain('✓ search-code index');
  });

  it('prints the warning AND its remediation on drift', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { root, sel } = advisoryRepo({ index: true });
    await adviseSearchIndex(root, sel);
    const out = log.mock.calls.flat().join('\n');
    expect(out).toContain('⚠ search-code index');
    expect(out).toContain('→');
    expect(out).toContain('indexPath');
  });

  it('stays silent when the dup guard is not selected', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { root, sel } = advisoryRepo({ index: true, guards: ['size', 'fanout'] });
    await adviseSearchIndex(root, sel);
    expect(log).not.toHaveBeenCalled();
  });

  // An advisory must not invent a finding out of an absent config — that is the validity check's
  // job, and it runs on a different surface.
  it('stays silent when guard.config.json is absent', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const root = mkTmp('doctor-advise-nocfg-');
    mkdirSync(join(root, '.search-code'), { recursive: true });
    writeFileSync(join(root, '.search-code', 'index.db'), 'stub');
    await adviseSearchIndex(root, { guards: ['dup'] });
    expect(log).not.toHaveBeenCalled();
  });
});

describe('doctor — a config that does not parse', () => {
  // resolveGuardConfig throws on corrupt JSON. That is the validity signal, and it must not also
  // produce an index line: one broken file, one finding.
  it('reports the config as DRIFT and skips the index check entirely', async () => {
    const root = mkTmp('doctor-search-index-bad-');
    writeFileSync(join(root, 'guard.config.json'), '{ "scanRoots": [oops');
    mkdirSync(join(root, '.search-code'), { recursive: true });
    writeFileSync(join(root, '.search-code', 'index.db'), 'stub');
    const results = await checkGuardConfig(root, true, false);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ name: 'guard.config.json', status: 'DRIFT' });
    expect(results.find((r) => r.name === CHECK)).toBeUndefined();
  });
});

// checkSearchIndex driven directly, for the branches its two callers cannot reach: checkGuardConfig
// bails before it on an unparseable config, so the raw-key read's own failure path is only
// observable from here.
describe('checkSearchIndex — the branches the callers gate off', () => {
  it('does not read a declared opt-out out of a config that does not parse', () => {
    const root = mkTmp('doctor-search-index-rawbad-');
    writeFileSync(join(root, 'guard.config.json'), '{ "indexPath": null,, }');
    mkdirSync(join(root, '.search-code'), { recursive: true });
    writeFileSync(join(root, '.search-code', 'index.db'), 'stub');
    // An explicit null WOULD be an opt-out — but not when the file it is written in is broken.
    const result = checkSearchIndex(root, null, false);
    expect(result.status).toBe('DRIFT');
    expect(result.detail).not.toContain('explicit');
  });

  it('treats an empty SEARCH_CODE_DB as unset, not as wiring', () => {
    process.env.SEARCH_CODE_DB = '';
    const root = mkTmp('doctor-search-index-emptyenv-');
    writeFileSync(join(root, 'guard.config.json'), '{}');
    mkdirSync(join(root, '.search-code'), { recursive: true });
    writeFileSync(join(root, '.search-code', 'index.db'), 'stub');
    expect(checkSearchIndex(root, null, false).status).toBe('DRIFT');
  });

  it('surfaces a configured index that is absent', () => {
    const root = mkTmp('doctor-search-index-resolved-');
    writeFileSync(join(root, 'guard.config.json'), '{}');
    const result = checkSearchIndex(root, '.search-code/index.db', true);
    expect(result.status).toBe('MISSING');
    expect(result.advisory).toBe(true);
    expect(result.detail).toContain('LINKED WORKTREE');
    expect(result.detail).toContain('devkit ship --link');
  });

  it('surfaces a configured index whose file stamps are behind the checkout', () => {
    const root = mkTmp('doctor-search-index-stale-');
    writeFileSync(
      join(root, 'guard.config.json'),
      JSON.stringify({ indexPath: '.search-code/index.db' }),
    );
    writeIndex(root, 1);
    const result = checkSearchIndex(root, '.search-code/index.db', true);
    expect(result.status).toBe('DRIFT');
    expect(result.advisory).toBe(true);
    expect(result.detail).toContain('index is STALE');
    expect(result.detail).toContain('src.ts');
    expect(result.remediation).toContain('search-code index --seed-files');
    expect(result.remediation).toContain('touch');
  });

  it('keeps a legacy index advisory when freshness stamps are unavailable', () => {
    const root = mkTmp('doctor-search-index-legacy-');
    writeFileSync(
      join(root, 'guard.config.json'),
      JSON.stringify({ indexPath: '.search-code/index.db' }),
    );
    mkdirSync(join(root, '.search-code'), { recursive: true });
    const db = new DatabaseSync(join(root, '.search-code', 'index.db'));
    db.exec('CREATE TABLE chunks (file_path TEXT)');
    db.close();
    const result = checkSearchIndex(root, '.search-code/index.db', true);
    expect(result.status).toBe('OK');
    expect(result.detail).toContain('freshness unavailable');
    expect(result.detail).toContain('scan-time body verification');
  });
});
