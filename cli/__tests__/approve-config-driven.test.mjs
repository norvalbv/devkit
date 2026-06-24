// commit-guard approve.sh must derive its reviewer triggers from guard.config.json — NOT from any
// hardcoded directory layout. These run the REAL script in throwaway git repos with non-frink
// configs (app/, server/) to prove a consumer with a different layout is gated correctly.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { rootRegistry } from './_helpers.mjs';

const APPROVE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'skills',
  'commit-guard',
  'scripts',
  'approve.sh',
);

const { mkTmp, cleanup } = rootRegistry();
afterEach(cleanup);

const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' });

function repo(config) {
  const root = mkTmp('approve-');
  if (config) writeFileSync(join(root, 'guard.config.json'), JSON.stringify(config));
  git(root, 'init', '-q');
  return root;
}

const stage = (root, rel, body = 'export {};\n') => {
  mkdirSync(join(root, dirname(rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
  git(root, 'add', '-A');
};

// Run from `cwd` (defaults to the repo root) — devkit runs the gates from the PACKAGE dir, so a
// monorepo package is exercised by pointing cwd at it.
function run(root, cwd = root) {
  try {
    return { code: 0, out: execFileSync('bash', [APPROVE], { cwd, encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('commit-guard approve.sh — config-driven roots (no frink hardcoding)', () => {
  it('uses a non-frink scanRoots layout (app/) for the source gate', () => {
    const root = repo({ scanRoots: ['app'] });
    stage(root, 'app/x.ts');
    const r = run(root);
    expect(r.code).toBe(1); // commit-guard marker missing → blocks
    expect(r.out).toContain('commit-guard');
  });

  it('does NOT trigger on a path outside the declared roots', () => {
    const root = repo({ scanRoots: ['app'] });
    stage(root, 'docs/readme.md');
    expect(run(root).code).toBe(0); // outside app/ → no source change → no marker required
  });

  it('skips backend/frontend reviewers when their roots are undeclared', () => {
    const root = repo({ scanRoots: ['app'] });
    stage(root, 'app/x.ts');
    const r = run(root);
    expect(r.out).not.toContain('api-security');
    expect(r.out).not.toContain('frontend-security');
  });

  it('triggers backend reviewers from review.backendRoots (e.g. server/)', () => {
    const root = repo({ scanRoots: ['server'], review: { backendRoots: ['server'] } });
    stage(root, 'server/api.ts');
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('api-security-reviewer');
  });

  it('falls back to ALL staged files when no guard.config.json exists', () => {
    const root = repo(null);
    stage(root, 'anything/here.ts');
    const r = run(root);
    expect(r.code).toBe(1); // source gate still fires (never silently no-ops)
    expect(r.out).toContain('commit-guard');
  });

  // Monorepo: the package's guard.config.json lives in its subdir with PACKAGE-relative scanRoots;
  // devkit runs the gate from the package dir, so config + git pathspecs both resolve there.
  describe('monorepo (package in a subdir, run from the package dir)', () => {
    function monorepo() {
      const root = mkTmp('approve-mono-');
      git(root, 'init', '-q');
      mkdirSync(join(root, 'services/web'), { recursive: true });
      writeFileSync(
        join(root, 'services/web/guard.config.json'),
        JSON.stringify({ scanRoots: ['src'] }),
      );
      return root;
    }

    it('fires for a change under the package scanRoots', () => {
      const root = monorepo();
      stage(root, 'services/web/src/x.ts');
      const r = run(root, join(root, 'services/web'));
      expect(r.code).toBe(1);
      expect(r.out).toContain('commit-guard');
    });

    it('does NOT fire for a sibling package change (isolation)', () => {
      const root = monorepo();
      stage(root, 'services/api/y.ts'); // different package, outside services/web/src
      const r = run(root, join(root, 'services/web'));
      expect(r.code).toBe(0);
    });
  });
});
