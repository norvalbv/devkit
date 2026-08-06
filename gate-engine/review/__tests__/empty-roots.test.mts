import { afterEach, describe, expect, it } from 'vitest';
import { resolveGuardConfig } from '../../config.mts';
import { domainsDisabledByEmptyRoots } from '../evidence/scope.mts';

// Pure: defaults + explicit roots, no disk. Mirrors reviewers.test.mts's fixture shape.
const base = resolveGuardConfig('/nonexistent-cwd-defaults-only');
const make = (scanRoots: string[], backendRoots: string[], frontendRoots: string[]) => ({
  ...base,
  scanRoots,
  review: { ...base.review, backendRoots, frontendRoots },
});

// The shipped templates/generic topology — the config this whole change exists for.
const inverted = make(['src'], ['src'], []);
const reviewers = (staged: string[], cfg = inverted, skip?: ReadonlySet<string>) =>
  domainsDisabledByEmptyRoots(staged, cfg, skip).map((d) => d.reviewer);

afterEach(() => {
  delete process.env.GUARD_REVIEW_NO_TOPOLOGY_WARN;
});

describe('domainsDisabledByEmptyRoots', () => {
  it('empty frontendRoots + a staged .tsx names both frontend reviewers', () => {
    expect(reviewers(['src/ui/App.tsx'])).toEqual([
      'frontend-security-reviewer',
      'frontend-performance-reviewer',
    ]);
  });

  it('carries the staged files as evidence', () => {
    const [first] = domainsDisabledByEmptyRoots(['src/a.tsx', 'src/b.ts', 'src/c.scss'], inverted);
    expect(first?.rootsKey).toBe('review.frontendRoots');
    expect(first?.evidence).toEqual(['src/a.tsx', 'src/c.scss']);
  });

  it('a backend-only .ts diff never nags', () => {
    expect(reviewers(['src/server/db.ts', 'src/index.ts'])).toEqual([]);
  });

  it('declared frontendRoots means there is nothing to report', () => {
    expect(reviewers(['src/ui/App.tsx'], make(['src'], [], ['src']))).toEqual([]);
  });

  it('a signature file OUTSIDE every declared root is not evidence', () => {
    // A transactional email template in a genuinely frontend-less service.
    expect(reviewers(['emails/welcome.html', 'docs/site/style.css'])).toEqual([]);
  });

  it('falls back to the whole tree when NOTHING is declared', () => {
    // An explicit `"scanRoots": []` survives config resolution, so the declared-root filter would
    // otherwise go silent on the most broken topology there is.
    expect(reviewers(['src/ui/App.tsx'], make([], [], []))).toHaveLength(2);
  });

  it('stays silent on a Next-style app/ tree outside scanRoots (known true negative)', () => {
    // Documented boundary, not an oversight: the filter trusts scanRoots, and `devkit doctor`
    // is what catches this repo. Pinned so a future widening is a decision, not a surprise.
    expect(reviewers(['app/page.tsx', 'app/layout.tsx'])).toEqual([]);
  });

  it('a .scss-only diff — which selects no reviewer at all — still reports', () => {
    expect(reviewers(['src/ui/theme.scss'])).toHaveLength(2);
  });

  it('never double-reports a reviewer GUARD_REVIEW_SKIP already named', () => {
    const skip = new Set(['frontend-security-reviewer']);
    expect(reviewers(['src/ui/App.tsx'], inverted, skip)).toEqual([
      'frontend-performance-reviewer',
    ]);
    expect(
      reviewers(['src/ui/App.tsx'], inverted, new Set([...skip, 'frontend-performance-reviewer'])),
    ).toEqual([]);
  });

  it('GUARD_REVIEW_NO_TOPOLOGY_WARN silences it without disabling the reviewers', () => {
    process.env.GUARD_REVIEW_NO_TOPOLOGY_WARN = '1';
    expect(reviewers(['src/ui/App.tsx'])).toEqual([]);
  });

  it.each(['tsx', 'jsx', 'vue', 'svelte', 'astro', 'css', 'scss', 'sass', 'less', 'html'])(
    '.%s is a frontend signature',
    (ext) => {
      expect(reviewers([`src/ui/thing.${ext}`])).toHaveLength(2);
    },
  );

  it.each(['ts', 'js', 'mjs', 'json', 'md'])('.%s is NOT a frontend signature', (ext) => {
    expect(reviewers([`src/ui/thing.${ext}`])).toEqual([]);
  });

  it('never reports a backend domain, whatever the config', () => {
    // Backend has no diff-decidable falsifier (`.ts` is both domains) — doctor carries that case.
    for (const staged of [['src/server/db.ts'], ['src/ui/App.tsx'], ['src/x.scss', 'src/y.ts']])
      expect(reviewers(staged, make(['src'], [], ['src']))).toEqual([]);
    expect(reviewers(['src/server/db.ts'], make(['src'], [], []))).toEqual([]);
  });
});
