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

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectResults } from '../commands/doctor.mts';
import { rootRegistry } from './_helpers.mts';

const { mkTmp, cleanup } = rootRegistry();
afterEach(() => {
  cleanup();
  delete process.env.SEARCH_CODE_DB;
  delete process.env.GUARD_INDEX_PATH;
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
    const result = await required({
      guardConfig: { indexPath: '.search-code/index.db' },
      index: true,
    });
    expect(result.status).toBe('OK');
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
    process.env.GUARD_INDEX_PATH = '/tmp/some-index.db';
    expect((await required({ index: true })).status).toBe('OK');
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
