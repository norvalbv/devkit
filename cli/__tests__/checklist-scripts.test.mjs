import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// The synced skill checklist scripts run INSIDE consumer commit reviews with staged filenames
// as input — the exact place a crafted path must never reach a shell. vitest deliberately
// excludes skills/**, so the source scripts are exercised here by spawning them in a fixture
// repo (they are plain node CLIs reading process.cwd()).

const SCRIPT = fileURLToPath(
  new URL('../../skills/api-security/scripts/checklist.mjs', import.meta.url),
);

const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

function repoWithCraftedFile() {
  const repo = mkdtempSync(join(tmpdir(), 'checklist-inj-'));
  dirs.push(repo);
  const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git(['init', '-q']);
  writeFileSync(
    join(repo, 'guard.config.json'),
    JSON.stringify({ review: { backendRoots: ['src'] } }),
  );
  mkdirSync(join(repo, 'src'), { recursive: true });
  // auth-flavoured content so the generate pass detects at least one checklist item
  writeFileSync(
    join(repo, 'src', 'auth$(touch INJECTED).ts'),
    'export const login = (password) => password;\n',
  );
  git(['add', '.']);
  return repo;
}

const run = (repo, args) => spawnSync('node', [SCRIPT, ...args], { cwd: repo, encoding: 'utf8' });

describe('skill checklist script (spawned source)', () => {
  it('generate with a $(…)-named staged file: scanned via argv git, no shell side effect', () => {
    const repo = repoWithCraftedFile();
    const r = run(repo, ['generate']);
    expect(r.status).toBe(0);
    expect(existsSync(join(repo, 'INJECTED'))).toBe(false);
    expect(existsSync(join(repo, 'src', 'INJECTED'))).toBe(false);
    // the crafted file was actually scanned — its auth content produced a checklist item
    const state = JSON.parse(
      readFileSync(join(repo, '.claude', '.api-security-review.json'), 'utf8'),
    );
    expect(state.items.length).toBeGreaterThan(0);
  });

  it('a recovery pass clears the stale failure trail (finalize cannot fail on history)', () => {
    const repo = repoWithCraftedFile();
    run(repo, ['generate']);
    const stateFile = join(repo, '.claude', '.api-security-review.json');
    const name = JSON.parse(readFileSync(stateFile, 'utf8')).items[0].name;
    expect(run(repo, ['check-item', name, '--fail', 'first look: raw sql']).status).toBe(0);
    expect(run(repo, ['check-item', name, '--pass']).status).toBe(0);
    const item = JSON.parse(readFileSync(stateFile, 'utf8')).items.find((i) => i.name === name);
    expect(item.status).toBe('pass');
    expect(item.issues).toEqual([]); // the old fail reason must not survive the recovery pass
  });
});
