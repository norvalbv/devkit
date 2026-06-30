// commit-guard checklist.mjs must FAIL SAFE on a PRESENT-but-invalid `scanRoots`: warn loudly and
// scan ALL staged files, never let a bad entry crash the git call into an empty result that silently
// waves the commit through (the CodeRabbit regression where `scanRoots: ['app', 123]` → execFileSync
// throws → getStagedFiles returns [] → init exits 0 "no staged files"). Runs the REAL script in
// throwaway git repos.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { gitRepoFixtures } from './_helpers.mjs';

const CHECKLIST = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'skills',
  'commit-guard',
  'scripts',
  'checklist.mjs',
);

// `repo(config)` writes guard.config.json when `config != null` — pass `{}` for a present-but-empty
// config (absent scanRoots key) or undefined for no config file at all.
const { repo, stage, cleanup } = gitRepoFixtures('checklist-');
afterEach(cleanup);

function run(cwd) {
  const r = spawnSync('node', [CHECKLIST, 'init'], { cwd, encoding: 'utf8' });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

// init writes the checklist file only when it found staged files — its existence proves the gate
// did NOT silently no-op.
const checklistWritten = (root) => existsSync(join(root, '.claude', '.pre-commit-review.json'));

describe('commit-guard checklist.mjs — scanRoots validation (fail-safe, never silent)', () => {
  it('non-string array entry → warns + scans all (checklist written, not a silent no-op)', () => {
    const root = repo({ scanRoots: ['app', 123] });
    stage(root, 'app/x.ts');
    const r = run(root);
    expect(r.err).toContain('invalid');
    expect(checklistWritten(root)).toBe(true);
  });

  it('non-array scanRoots → warns + scans all', () => {
    const root = repo({ scanRoots: 'app' });
    stage(root, 'app/x.ts');
    const r = run(root);
    expect(r.err).toContain('invalid');
    expect(checklistWritten(root)).toBe(true);
  });

  it('empty-string entry → warns + scans all', () => {
    const root = repo({ scanRoots: [''] });
    stage(root, 'app/x.ts');
    const r = run(root);
    expect(r.err).toContain('invalid');
    expect(checklistWritten(root)).toBe(true);
  });

  it('absent scanRoots key → scans all, no warning', () => {
    const root = repo({});
    stage(root, 'anything/here.ts');
    const r = run(root);
    expect(r.err).not.toContain('invalid');
    expect(checklistWritten(root)).toBe(true);
  });

  it('no guard.config.json → scans all, no warning', () => {
    const root = repo(undefined);
    stage(root, 'anything/here.ts');
    const r = run(root);
    expect(r.err).not.toContain('invalid');
    expect(checklistWritten(root)).toBe(true);
  });

  it('valid scanRoots scopes the checklist — an out-of-scope change is a clean no-op', () => {
    const root = repo({ scanRoots: ['app'] });
    stage(root, 'docs/readme.md');
    const r = run(root);
    expect(r.err).not.toContain('invalid');
    expect(checklistWritten(root)).toBe(false);
  });

  it('valid scanRoots with an in-scope change → checklist written', () => {
    const root = repo({ scanRoots: ['app'] });
    stage(root, 'app/x.ts');
    const r = run(root);
    expect(r.err).not.toContain('invalid');
    expect(checklistWritten(root)).toBe(true);
  });
});
