import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { testExecFileSync as execFileSync, testSpawnSync as spawnSync } from './_helpers.mts';

// sc-1489. link-gate-configs.sh links gate inputs a fresh checkout cannot carry into the ephemeral
// ship worktree, and skips any path the checkout already put there. `.qavis/receipt.json` is in that
// set: the gitignored, content-addressed cache `qavis qa` writes on a pass, which the ship-time
// qavis-advisory gate reads to clear its block.
//
// Commit that receipt by accident and the stale copy rides the base checkout into $WT, the link is
// skipped, and the gate compares the staged sha against staleness forever — no number of real QA
// passes can clear it (GUARD_QAVIS_OK=1 the only exit). A cache candidate the BASE materialised must
// therefore lose to the live one, loudly.

const scriptPath = fileURLToPath(new URL('../lib/ship/ship-branch.sh', import.meta.url));
const GENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const WT_RE = /worktree kept at (.+?)\. Remove/;
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/**
 * A repo on branch `work` whose husky pre-commit hook reports the receipt's CONTENT. Presence is not
 * enough to see this bug: the shadow delivered a file to the gate, just the wrong one, so a `-e` probe
 * passes straight through it.
 */
function seedRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'shipcache-'));
  dirs.push(dir);
  const env = { ...process.env, ...GENV };
  const git = (args: string[], opts = {}) =>
    execFileSync('git', args, { cwd: dir, env, encoding: 'utf8', ...opts });
  mkdirSync(join(dir, '.husky/_'), { recursive: true });
  writeFileSync(join(dir, '.husky/.keep'), '');
  for (const a of [
    ['init', '-q', '-b', 'work'],
    ['config', 'user.email', 'a@b.c'],
    ['config', 'user.name', 'a'],
    ['config', 'commit.gpgsign', 'false'],
    ['add', '.husky/.keep'],
    ['commit', '-q', '-m', 'base'],
    ['config', 'core.hooksPath', '.husky/_'],
    ['remote', 'add', 'origin', 'git@github.com:acme/app.git'],
  ])
    git(a, { stdio: 'ignore' });
  writeFileSync(
    join(dir, '.husky/_/pre-commit'),
    '#!/bin/sh\ngrep -q LIVE .qavis/receipt.json 2>/dev/null && echo RECEIPT_LIVE || echo RECEIPT_STALE\nexit 0\n',
  );
  chmodSync(join(dir, '.husky/_/pre-commit'), 0o755);
  return { dir, env, git };
}

describe('ship — a COMMITTED gate cache cannot shadow the live one', () => {
  it('links the live qavis receipt over a tracked stale one, and says to untrack it', () => {
    const { dir, env, git } = seedRepo();
    mkdirSync(join(dir, '.qavis'), { recursive: true });
    writeFileSync(join(dir, '.qavis/recipe.json'), '{"from":"acme/qavis"}\n');
    writeFileSync(join(dir, '.qavis/receipt.json'), '{"sha":"STALE"}\n'); // the accident
    git(['add', '.qavis/recipe.json', '.qavis/receipt.json'], { stdio: 'ignore' });
    git(['commit', '-q', '--no-verify', '-m', 'accidentally track the receipt'], {
      stdio: 'ignore',
    });
    writeFileSync(join(dir, '.qavis/receipt.json'), '{"sha":"LIVE"}\n'); // a real pass, post-commit
    writeFileSync(join(dir, 'note.txt'), 'hi\n');

    const r = spawnSync('/bin/bash', [scriptPath, 'feat/qavis-shadow', 't', 'note.txt'], {
      cwd: dir,
      input: 'b\n',
      encoding: 'utf8',
      env: { ...env, SHIP_DRY_RUN: '1' },
    });
    const wt = WT_RE.exec(r.stderr)?.[1]; // dry-run keeps it; drop so afterAll's rm isn't blocked
    if (wt) {
      try {
        git(['worktree', 'remove', '--force', wt], { stdio: 'ignore' });
      } catch {
        /* best-effort */
      }
    }

    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/\.qavis\/receipt\.json .*COMMITTED copy shadowed the live cache/);
    expect(r.stderr).toMatch(/git rm --cached \.qavis\/receipt\.json/); // names the permanent fix
    const log = readFileSync(join(dir, '.devkit/last-ship-gates-feat-qavis-shadow.log'), 'utf8');
    expect(log).toMatch(/RECEIPT_LIVE/); // the gate read the pass, not the committed staleness
    expect(log).not.toMatch(/RECEIPT_STALE/);
    // WORKTREE-only override: the shipped commit must not delete or rewrite the tracked receipt.
    expect(git(['diff', '--name-only', 'work', 'feat/qavis-shadow']).trim()).toBe('note.txt');
  });
});
