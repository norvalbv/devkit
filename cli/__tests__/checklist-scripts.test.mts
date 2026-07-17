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

const REVIEW_ROOT_CASES = [
  ['api-security', 'DEVKIT_REVIEW_BACKEND_ROOTS', '.api-security-review.json'],
  ['backend-performance', 'DEVKIT_REVIEW_BACKEND_ROOTS', '.backend-performance-review.json'],
  ['frontend-security', 'DEVKIT_REVIEW_FRONTEND_ROOTS', '.frontend-security-review.json'],
  ['frontend-performance', 'DEVKIT_REVIEW_FRONTEND_ROOTS', '.frontend-performance-review.json'],
  ['frontend-accessibility', 'DEVKIT_REVIEW_FRONTEND_ROOTS', '.frontend-accessibility-review.json'],
] as const;

const CHECKLIST_CASES = [
  ['api-security', '.api-security-review.json'],
  ['backend-performance', '.backend-performance-review.json'],
  ['commit-guard', '.pre-commit-review.json'],
  ['correctness', '.correctness-review.json'],
  ['frontend-accessibility', '.frontend-accessibility-review.json'],
  ['frontend-performance', '.frontend-performance-review.json'],
  ['frontend-security', '.frontend-security-review.json'],
] as const;

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

  it.each(
    REVIEW_ROOT_CASES,
  )('%s consumes the exact review-mode roots injected by the gate', (skill, envName, stateName) => {
    const repo = mkdtempSync(join(tmpdir(), 'checklist-review-roots-'));
    dirs.push(repo);
    const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    git(['init', '-q']);
    writeFileSync(
      join(repo, 'guard.config.json'),
      JSON.stringify({ review: { backendRoots: [], frontendRoots: [] } }),
    );
    mkdirSync(join(repo, 'apps', 'web'), { recursive: true });
    mkdirSync(join(repo, 'outside'), { recursive: true });
    writeFileSync(
      join(repo, 'apps', 'web', 'changed.tsx'),
      'export const login = (password) => fetch("/api", { body: password });\n',
    );
    writeFileSync(join(repo, 'outside', 'ignored.tsx'), 'export const unrelated = true;\n');
    git(['add', '.']);
    const script = fileURLToPath(
      new URL(`../../skills/${skill}/scripts/checklist.mjs`, import.meta.url),
    );
    const r = spawnSync('node', [script, 'generate'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, [envName]: JSON.stringify(['apps/web']) },
    });
    expect(r.status, r.stderr).toBe(0);
    const state = JSON.parse(readFileSync(join(repo, '.claude', stateName), 'utf8'));
    expect(state.files ?? state.items).not.toHaveLength(0);
    expect(JSON.stringify(state)).not.toContain('outside/ignored.tsx');
  });

  it.each(
    CHECKLIST_CASES,
  )('%s preserves its artifact for independent review-mode verification', (skill, stateName) => {
    const repo = mkdtempSync(join(tmpdir(), 'checklist-review-cleanup-'));
    dirs.push(repo);
    const stateDir = join(repo, '.claude');
    const stateFile = join(stateDir, stateName);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(stateFile, '{}');
    const script = fileURLToPath(
      new URL(`../../skills/${skill}/scripts/checklist.mjs`, import.meta.url),
    );

    const reviewCleanup = spawnSync('node', [script, 'cleanup'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, DEVKIT_RUN_MODE: 'review' },
    });
    expect(reviewCleanup.status, reviewCleanup.stderr).toBe(0);
    expect(existsSync(stateFile)).toBe(true);

    const normalCleanup = spawnSync('node', [script, 'cleanup'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, DEVKIT_RUN_MODE: 'commit' },
    });
    expect(normalCleanup.status, normalCleanup.stderr).toBe(0);
    expect(existsSync(stateFile)).toBe(false);
  });

  it('correctness unions scanRoots with injected domain roots outside the static topology', () => {
    const repo = mkdtempSync(join(tmpdir(), 'checklist-correctness-review-roots-'));
    dirs.push(repo);
    const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    git(['init', '-q']);
    writeFileSync(
      join(repo, 'guard.config.json'),
      JSON.stringify({
        scanRoots: ['src'],
        review: { backendRoots: ['static-api'], frontendRoots: ['static-web'] },
      }),
    );
    for (const dir of ['src', 'apps/web', 'static-api'])
      mkdirSync(join(repo, dir), { recursive: true });
    writeFileSync(join(repo, 'src', 'shared.ts'), 'export const shared = true;\n');
    writeFileSync(join(repo, 'apps/web', 'changed.tsx'), 'export const changed = true;\n');
    writeFileSync(join(repo, 'static-api', 'excluded.ts'), 'export const excluded = true;\n');
    git(['add', '.']);
    const script = fileURLToPath(
      new URL('../../skills/correctness/scripts/checklist.mjs', import.meta.url),
    );
    const r = spawnSync('node', [script, 'generate'], {
      cwd: repo,
      encoding: 'utf8',
      env: {
        ...process.env,
        DEVKIT_REVIEW_BACKEND_ROOTS: JSON.stringify(['apps/api']),
        DEVKIT_REVIEW_FRONTEND_ROOTS: JSON.stringify(['apps/web']),
      },
    });
    expect(r.status, r.stderr).toBe(0);
    const state = JSON.parse(
      readFileSync(join(repo, '.claude', '.correctness-review.json'), 'utf8'),
    );
    expect(state.files).toEqual(['apps/web/changed.tsx', 'src/shared.ts']);
    expect(JSON.stringify(state)).not.toContain('static-api/excluded.ts');
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
