import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveGuardConfig, resolveGuardConfigJson } from '../../config.mts';
import {
  domainsDisabledByEmptyRoots,
  filesRoutedToNoDomain,
  reportNonRuns,
} from '../evidence/scope.mts';
import { selectReviewers } from '../reviewers.mts';

const REPO_ROOT = join(import.meta.dirname, '../../..');

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
  vi.restoreAllMocks();
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

describe('reportNonRuns', () => {
  const notices = (alreadyReported: Set<string>) => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    reportNonRuns(['relay/index.ts', 'README.md'], inverted, [], alreadyReported);
    return spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('no reviewer ran'));
  };

  it('says so when path scope leaves the commit with no reviewer at all', () => {
    expect(notices(new Set())).toEqual([
      'guard-review: no reviewer ran — none of the 2 staged file(s) is in review scope ' +
        '(scanRoots, review roots and review.paths in guard.config.json)',
    ]);
  });

  it('stays quiet when another line already named why a reviewer did not run', () => {
    expect(notices(new Set(['commit-guard']))).toEqual([]);
  });
});

describe('filesRoutedToNoDomain', () => {
  // The electron topology before src/shared was routed: scanRoots covers it, no domain root does.
  const electron = make(['src'], ['src/main'], ['src/renderer', 'src/preload']);
  const unrouted = (staged: string[], cfg = electron, baseline?: typeof electron) =>
    filesRoutedToNoDomain(selectReviewers(staged, cfg, baseline), cfg);

  it('names a source file under scanRoots that no domain root routes', () => {
    expect(unrouted(['src/shared/validate.ts', 'src/main/ipc.ts'])).toEqual([
      'src/shared/validate.ts',
    ]);
  });

  it('prints one advisory line through reportNonRuns', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const staged = ['src/shared/validate.ts'];
    const selection = selectReviewers(staged, electron);
    reportNonRuns(staged, electron, selection, new Set(), new Set(), selection);
    expect(spy.mock.calls.map((c) => String(c[0]))).toContain(
      'guard-review: 1 source file(s) reached no security/performance reviewer ' +
        '(src/shared/validate.ts) — add their directory to review.backendRoots/frontendRoots ' +
        'in guard.config.json',
    );
  });

  it('truncates past three names so a wide diff stays one bounded line', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const staged = ['a', 'b', 'c', 'd'].map((n) => `src/shared/${n}.ts`);
    const selection = selectReviewers(staged, electron);
    reportNonRuns(staged, electron, selection, new Set(), new Set(), selection);
    const line = spy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('4 source'));
    expect(line).toContain('(src/shared/a.ts, src/shared/b.ts, src/shared/c.ts, …)');
  });

  it('never re-names a file the empty-frontendRoots line already named', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cfg = make(['src'], ['src/main'], []);
    const staged = ['src/ui/App.tsx'];
    const selection = selectReviewers(staged, cfg);
    reportNonRuns(staged, cfg, selection, new Set(), new Set(), selection);
    const lines = spy.mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => l.includes('src/ui/App.tsx'))).toHaveLength(1);
  });

  it('stays silent for prose and non-source files', () => {
    expect(unrouted(['src/shared/README.md', 'src/shared/data.json'])).toEqual([]);
  });

  it('stays silent when the topology declares no domain roots, or under the opt-out', () => {
    expect(unrouted(['src/shared/validate.ts'], make(['src'], [], []))).toEqual([]);
    process.env.GUARD_REVIEW_NO_TOPOLOGY_WARN = '1';
    expect(unrouted(['src/shared/validate.ts'])).toEqual([]);
  });

  it('counts a file the HEAD policy routes as routed', () => {
    const head = make(['src'], ['src/main', 'src/shared'], ['src/renderer']);
    expect(unrouted(['src/shared/validate.ts'], electron, head)).toEqual([]);
  });

  it("devkit's own self-host config routes every scanRoot, so dogfood commits stay quiet", () => {
    const raw = readFileSync(join(REPO_ROOT, 'guard.config.json'), 'utf8');
    const cfg = resolveGuardConfigJson(raw, '/nonexistent-cwd-defaults-only');
    expect(
      unrouted(
        cfg.scanRoots.map((r) => `${r}/x.mts`),
        cfg,
      ),
    ).toEqual([]);
  });

  it.each(readdirSync(join(REPO_ROOT, 'templates')).filter((t) => !t.startsWith('_')))(
    'templates/%s routes src/shared to a domain reviewer',
    (template) => {
      const raw = readFileSync(join(REPO_ROOT, 'templates', template, 'guard.config.json'), 'utf8');
      const cfg = resolveGuardConfigJson(raw, '/nonexistent-cwd-defaults-only');
      expect(unrouted(['src/shared/x.ts'], cfg)).toEqual([]);
    },
  );
});
