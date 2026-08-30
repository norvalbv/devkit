import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { dirs as shipDirs, dropWorktree, seedShipRepo } from './_ship-branch-fixture.mts';
import { testExecFileSync as execFileSync, testSpawnSync as spawnSync } from './_helpers.mts';

// sc-1489: a consumer committed `.qavis/receipt.json`, so the base checkout kept putting a stale copy
// in the ship worktree, the link was skipped as "already present", and the qavis-advisory gate could
// never be cleared by running qavis — GUARD_QAVIS_OK=1 was the only exit.

const scriptPath = fileURLToPath(new URL('../lib/ship/ship-branch.sh', import.meta.url));
const GENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const WT_RE = /worktree kept at (.+?)\. Remove/;
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// The hook reports the receipt's CONTENT. Presence is not enough to see this bug: the shadow handed
// the gate a file, just the wrong one, so a `-e` probe passes straight through it.
const HOOK =
  '#!/bin/sh\ngrep -q live .qavis/receipt.json 2>/dev/null && echo RECEIPT_LIVE || echo RECEIPT_STALE\nexit 0\n';

function seedRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'shipcache-'));
  dirs.push(dir);
  const env = { ...process.env, ...GENV };
  const git = (args: string[], opts = {}) =>
    execFileSync('git', args, { cwd: dir, env, encoding: 'utf8', ...opts });
  mkdirSync(join(dir, '.husky/_'), { recursive: true });
  writeFileSync(join(dir, '.husky/.keep'), '');
  writeFileSync(join(dir, '.husky/_/pre-commit'), HOOK); // gitignored runner; ship fails closed without it
  chmodSync(join(dir, '.husky/_/pre-commit'), 0o755);
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
  mkdirSync(join(dir, '.qavis'), { recursive: true });
  writeFileSync(join(dir, '.qavis/recipe.json'), '{"from":"acme/qavis"}\n');
  return { dir, env, git };
}

function ship(dir: string, env: NodeJS.ProcessEnv, git, branch: string, paths = ['note.txt']) {
  const r = spawnSync('/bin/bash', [scriptPath, branch, 't', ...paths], {
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
  return {
    ...r,
    gateLog: () =>
      readFileSync(join(dir, `.devkit/last-ship-gates-${branch.replace(/\//g, '-')}.log`), 'utf8'),
  };
}

describe('ship — a committed gate cache must lose to the live one', () => {
  it('uses an ignore rule shipped from a linked worktree to classify a main-worktree index', () => {
    const { dir, env, git } = seedShipRepo();
    writeFileSync(join(dir, 'guard.config.json'), '{"indexPath":".search-code/index.db"}\n');
    writeFileSync(join(dir, '.gitignore'), '.base-cache/\n');
    git(['add', 'guard.config.json', '.gitignore'], { stdio: 'ignore' });
    git(['commit', '-q', '--no-verify', '-m', 'track config + base ignores'], {
      stdio: 'ignore',
    });
    mkdirSync(join(dir, '.search-code'), { recursive: true });
    writeFileSync(join(dir, '.search-code/index.db'), 'index');

    const linkedParent = mkdtempSync(join(tmpdir(), 'ship-linked-ignore-'));
    shipDirs.push(linkedParent);
    const linked = join(linkedParent, 'checkout');
    git(['worktree', 'add', '-q', '-b', 'linked-ignore-task', linked], { stdio: 'ignore' });
    writeFileSync(join(linked, '.gitignore'), '.base-cache/\n.search-code/\n');
    writeFileSync(join(linked, 'note.txt'), 'hi\n');

    const r = spawnSync(
      '/bin/bash',
      [scriptPath, 'feat/same-ship-ignore', 't', '--', '.gitignore', 'note.txt'],
      {
        cwd: linked,
        input: 'b\n',
        encoding: 'utf8',
        env: { ...env, SHIP_DRY_RUN: '1' },
      },
    );
    dropWorktree(git, r.stderr);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/\.search-code\/index\.db .*gitignored cache/);
    expect(r.stderr).not.toMatch(/\.search-code\/index\.db .*commit it/);
  });

  it('links the live receipt over the stale committed copy, without touching the shipped commit', () => {
    const { dir, env, git } = seedRepo();
    writeFileSync(join(dir, '.qavis/receipt.json'), '{"sha":"stale"}\n');
    git(['add', '.qavis'], { stdio: 'ignore' });
    git(['commit', '-q', '-m', 'accidentally track the receipt'], { stdio: 'ignore' });
    writeFileSync(join(dir, '.qavis/receipt.json'), '{"sha":"live"}\n'); // a real pass, post-commit
    writeFileSync(join(dir, 'note.txt'), 'hi\n');

    const r = ship(dir, env, git, 'feat/committed-receipt');

    expect(r.status, r.stderr).toBe(0);
    expect(r.gateLog()).toMatch(/RECEIPT_LIVE/); // the gate read the pass, not the committed staleness
    expect(r.gateLog()).not.toMatch(/RECEIPT_STALE/);
    expect(r.stderr).toMatch(/gate cache\(s\) are COMMITTED/);
    expect(r.stderr).toContain('git rm .qavis/receipt.json'); // pasteable, and landable by ship
    expect(r.stderr).not.toContain('git rm --cached'); // --cached leaves it on disk → ship re-adds it
    // It must not ALSO reach the linked-config classifier, which would tell the operator to commit the
    // very file the notice above says to untrack (and "untracked" is false — the base tracks it).
    expect(r.stderr).not.toMatch(/\.qavis\/receipt\.json \(untracked/);
    expect(r.stderr).not.toMatch(/commit it so gates/);
    // The override is worktree-only: the shipped commit must not delete or rewrite the tracked receipt.
    expect(git(['diff', '--name-only', 'work', 'feat/committed-receipt']).trim()).toBe('note.txt');
  });

  // The notice is only worth printing if devkit can LAND what it prints, in the sequence an operator
  // actually follows: `git rm` deletes their live receipt too, so they re-run the tool and it comes
  // back — untracked AND gitignored, exactly what ship's force-add pass sweeps up. Regenerating it here
  // is the whole point of the test; without that write the deletion lands trivially and pins nothing.
  it('lands the untracking even after the tool regenerates the cache', () => {
    const { dir, env, git } = seedRepo();
    writeFileSync(join(dir, '.qavis/receipt.json'), '{"sha":"stale"}\n');
    git(['add', '.qavis'], { stdio: 'ignore' });
    git(['commit', '-q', '-m', 'accidentally track the receipt'], { stdio: 'ignore' });
    git(['rm', '-q', '.qavis/receipt.json'], { stdio: 'ignore' }); // exactly what the notice prints
    writeFileSync(join(dir, '.gitignore'), '.qavis/receipt.json\n');
    writeFileSync(join(dir, '.qavis/receipt.json'), '{"sha":"live"}\n'); // `qavis qa` re-run
    writeFileSync(join(dir, 'note.txt'), 'hi\n');

    const r = ship(dir, env, git, 'feat/untrack-receipt', [
      '.gitignore',
      '.qavis/receipt.json',
      'note.txt',
    ]);

    expect(r.status, r.stderr).toBe(0);
    const tree = git(['ls-tree', '-r', '--name-only', 'feat/untrack-receipt']).trim().split('\n');
    expect(tree).not.toContain('.qavis/receipt.json'); // the defect is gone from the base, for good
    expect(tree).toContain('.gitignore');
    // Nothing stale reached the worktree, so the notice must stay quiet on the ship that fixes it.
    expect(r.stderr).not.toMatch(/gate cache\(s\) are COMMITTED/);
    // ...and the regenerated cache still reached the gate, so this ship is QA-clearable like any other.
    expect(r.gateLog()).toMatch(/RECEIPT_LIVE/);
  });

  it('leaves an already-gitignored receipt on the normal link path', () => {
    const { dir, env, git } = seedRepo();
    writeFileSync(join(dir, '.gitignore'), '.qavis/receipt.json\n');
    git(['add', '.qavis/recipe.json', '.gitignore'], { stdio: 'ignore' });
    git(['commit', '-q', '-m', 'track recipe, ignore receipt'], { stdio: 'ignore' });
    writeFileSync(join(dir, '.qavis/receipt.json'), '{"sha":"live"}\n');
    writeFileSync(join(dir, 'note.txt'), 'hi\n');

    const r = ship(dir, env, git, 'feat/ignored-receipt');

    expect(r.status, r.stderr).toBe(0);
    expect(r.gateLog()).toMatch(/RECEIPT_LIVE/);
    expect(r.stderr).toMatch(/\.qavis\/receipt\.json \(gitignored cache/);
    expect(r.stderr).not.toMatch(/gate cache\(s\) are COMMITTED/); // no false positive
  });
});
