/** doctor's advisory for a populated search-code index with no `indexCommand`, where an edited
 * function in a flagged dup pair is dropped as stale instead of re-judged. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adviseSearchIndex, checkGuardConfig } from '../lib/doctor/guard-config-checks.mts';
import {
  DEFAULT_INDEX_COMMAND,
  INDEX_REFRESH_CHECK,
  guardConfigKeyPresent,
} from '../lib/install/install-search-code.mts';
import { rootRegistry } from './_helpers.mts';

const { mkTmp, cleanup } = rootRegistry();
afterEach(() => {
  cleanup();
  delete process.env.GUARD_INDEX_COMMAND;
  vi.restoreAllMocks();
});

/** A repo whose guard.config.json is `config`, with an index holding `usable` embedded chunks. */
function repo(
  config: { indexPath?: string; indexCommand?: string | null },
  usable: number,
): string {
  const root = mkTmp('doctor-index-command-');
  writeFileSync(join(root, 'guard.config.json'), JSON.stringify(config));
  mkdirSync(join(root, '.search-code'));
  const db = new DatabaseSync(join(root, '.search-code', 'index.db'));
  db.exec('CREATE TABLE chunks (symbol_name TEXT, embedding BLOB, code_embedding BLOB)');
  const insert = db.prepare('INSERT INTO chunks VALUES (?, ?, ?)');
  for (let i = 0; i < usable; i++) insert.run(`fn${i}`, new Uint8Array(4), new Uint8Array(4));
  db.close();
  return root;
}

async function refreshRow(root: string) {
  const results = await checkGuardConfig(root, true, false, { review: false, sentry: false });
  return results.find((r) => r.name === INDEX_REFRESH_CHECK);
}

const WIRED = { indexPath: '.search-code/index.db' };

describe('doctor — a populated index with no indexCommand', () => {
  it('advises the bounded default, without promising a --fix that cannot clear it', async () => {
    const row = await refreshRow(repo(WIRED, 2));
    expect(row).toMatchObject({ status: 'DRIFT', advisory: true, fixable: false });
    expect(row?.detail).toContain('dropped from its flagged pair as stale');
    expect(row?.remediation).toContain(`"indexCommand": "${DEFAULT_INDEX_COMMAND}"`);
    expect(row?.remediation).toContain('"indexCommand": null');
  });

  it('reaches the overlay / self-host advisory, which prints only named rows', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await adviseSearchIndex(repo(WIRED, 1), { guards: ['dup'] });
    const out = log.mock.calls.flat().join('\n');
    expect(out).toContain(`⚠ ${INDEX_REFRESH_CHECK}`);
    expect(out).toContain(DEFAULT_INDEX_COMMAND);
  });
});

describe('doctor — when the refresh advisory stays silent', () => {
  it.each([
    ['a command in the file', { ...WIRED, indexCommand: 'search-code index' }],
    ['an explicit null, a declared opt-out', { ...WIRED, indexCommand: null }],
    ['no indexPath', {}],
  ])('%s', async (_, config) => {
    expect(await refreshRow(repo(config, 2))).toBeUndefined();
  });

  it('a command from GUARD_INDEX_COMMAND', async () => {
    process.env.GUARD_INDEX_COMMAND = 'search-code index';
    expect(await refreshRow(repo(WIRED, 2))).toBeUndefined();
  });

  // The index check already names "populate it"; a per-commit refresh there is a cold build.
  it('an index with no usable chunk', async () => {
    expect(await refreshRow(repo(WIRED, 0))).toBeUndefined();
  });
});

describe('guardConfigKeyPresent', () => {
  // A config that does not parse must never read as a declared opt-out.
  it('is false for a guard.config.json that does not parse', () => {
    const root = mkTmp('doctor-index-command-bad-');
    writeFileSync(join(root, 'guard.config.json'), '{ "indexCommand": null, oops');
    expect(guardConfigKeyPresent(root, 'indexCommand')).toBe(false);
  });
});
