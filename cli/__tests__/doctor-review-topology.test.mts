// `devkit doctor`'s review-topology check: does the repo's CURRENT dependency set contradict the
// review roots guard.config.json declares? An empty `review.frontendRoots` — the shipped
// templates/generic default — makes selectReviewers drop both frontend reviewers silently, so a
// browser-only repo can commit for months with them never once selected.
//
// Reported as an ADVISORY (CheckResult.advisory): a true finding, but devkit itself still ships the
// inverted default for Next, so blocking would exit 1 on a repo devkit's own init just produced,
// with a `--fix` that cannot repair it. The rule table is pure, so most of this is fs-free.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { check } from '../lib/doctor/check-result.mts';
import {
  checkGuardConfig,
  REVIEW_TOPOLOGY_CHECK,
  type ReviewRoots,
  reviewTopologyResult,
} from '../lib/doctor/guard-config-checks.mts';
import { rootRegistry } from './_helpers.mts';

const { mkTmp, cleanup } = rootRegistry();
afterEach(cleanup);

const roots = (backendRoots: string[], frontendRoots: string[]): ReviewRoots => ({
  backendRoots,
  frontendRoots,
});

// A repo whose package.json drives detectStack, plus the review block under test.
function repo(pkg: Record<string, unknown>, review: ReviewRoots | null) {
  const root = mkTmp('doctopo-');
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'x', version: '1.0.0', ...pkg }),
  );
  if (review) {
    writeFileSync(join(root, 'guard.config.json'), JSON.stringify({ scanRoots: ['src'], review }));
  }
  return root;
}

const topologyRow = async (root: string) =>
  (await checkGuardConfig(root, false, false)).find((r) => r.name === REVIEW_TOPOLOGY_CHECK);

const REACT = { dependencies: { react: '^19.0.0' } };
const ELECTRON = { dependencies: { electron: '^30.0.0' } };
const ESM_SERVICE = { type: 'module' };

describe('reviewTopologyResult — the pure rule table', () => {
  it('flags an empty frontendRoots on a frontend stack, naming the reviewers that never run', () => {
    const r = reviewTopologyResult('react-app', roots(['src'], []));
    expect(r?.status).toBe('DRIFT');
    expect(r?.detail).toContain('stack "react-app" detected but review.frontendRoots is empty');
    // Derived from REVIEWERS, so a reviewer added later joins the message automatically.
    expect(r?.detail).toContain('frontend-security-reviewer + frontend-performance-reviewer');
    expect(r?.remediation).toContain('guard.config.json');
  });

  it('is advisory and unfixable — reported, never a reason to call the repo unhealthy', () => {
    const r = reviewTopologyResult('react-app', roots(['src'], []));
    expect(r?.advisory).toBe(true);
    expect(r?.fixable).toBe(false);
  });

  it.each(['react-app', 'next', 'component-lib'] as const)('%s requires frontendRoots', (stack) => {
    expect(reviewTopologyResult(stack, roots(['src'], []))?.status).toBe('DRIFT');
    expect(reviewTopologyResult(stack, roots([], ['src']))?.status).toBe('OK');
  });

  it('node-service requires backendRoots', () => {
    expect(reviewTopologyResult('node-service', roots([], []))?.status).toBe('DRIFT');
    expect(reviewTopologyResult('node-service', roots(['src'], []))?.status).toBe('OK');
  });

  it('an explicit frontendRoots outranks the node-service residual bucket', () => {
    // detectStack's node-service branch is "type:module and no frontend dep" — a repo that went out
    // of its way to declare frontendRoots is contradicting that guess, not drifting from it.
    expect(reviewTopologyResult('node-service', roots([], ['src']))).toBeNull();
  });

  it('electron names both domains in one line', () => {
    const r = reviewTopologyResult('electron', roots([], []));
    expect(r?.status).toBe('DRIFT');
    expect(r?.detail).toContain('review.backendRoots + review.frontendRoots are empty');
    expect(r?.detail).toContain('api-security-reviewer');
    expect(r?.detail).toContain('frontend-security-reviewer');
    expect(reviewTopologyResult('electron', roots(['src/main'], ['src/renderer']))?.status).toBe(
      'OK',
    );
  });

  it('asserts nothing for the generic stack', () => {
    // No framework signal → a backend-only repo and a misconfigured frontend one are
    // indistinguishable, and a false positive would fire on most repos.
    expect(reviewTopologyResult('generic', roots([], []))).toBeNull();
  });
});

describe('the topology row inside checkGuardConfig', () => {
  it('reads the dependency manifest, not the recorded stack', async () => {
    expect((await topologyRow(repo(REACT, roots(['src'], []))))?.status).toBe('DRIFT');
    expect((await topologyRow(repo(REACT, roots([], ['src']))))?.status).toBe('OK');
  });

  it('flags an electron repo missing both', async () => {
    expect((await topologyRow(repo(ELECTRON, roots([], []))))?.status).toBe('DRIFT');
  });

  it('is silent for an ESM service that declares its backend roots', async () => {
    expect((await topologyRow(repo(ESM_SERVICE, roots(['src'], []))))?.status).toBe('OK');
  });

  it('emits no row for a framework-less manifest (the monorepo-root case)', async () => {
    // detect-stack reads the manifest at cwd only, so a monorepo root whose React lives in a subdir
    // resolves to generic — fail-safe silence rather than a wrong assertion.
    expect(await topologyRow(repo({}, roots([], [])))).toBeUndefined();
  });

  it('never double-reports what the validity check already owns', async () => {
    const missing = await checkGuardConfig(repo(REACT, null), false, false);
    expect(missing.map((r) => r.name)).toEqual(['guard.config.json']);
    const corrupt = repo(REACT, roots([], []));
    writeFileSync(join(corrupt, 'guard.config.json'), '{ not json');
    expect(await topologyRow(corrupt)).toBeUndefined();
  });
});

describe('the advisory tier', () => {
  it('keeps a flagged topology out of doctor’s drifted verdict', () => {
    // Mirrors run()'s predicate. A plain DRIFT row flips it; an advisory one must not — otherwise
    // every freshly-inited Next repo exits 1 on devkit's own output.
    const drifted = (rs: ReturnType<typeof check>[]) =>
      rs.some((r) => r.status !== 'OK' && !r.advisory);
    const advisory = reviewTopologyResult('react-app', roots(['src'], []));
    expect(advisory).not.toBeNull();
    expect(drifted([check('ok', 'OK', ''), advisory as ReturnType<typeof check>])).toBe(false);
    expect(drifted([check('real', 'DRIFT', 'genuine drift')])).toBe(true);
  });
});
