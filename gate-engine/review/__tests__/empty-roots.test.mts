import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveGuardConfig, resolveGuardConfigJson } from '../../config.mts';
import {
  domainsDisabledByEmptyRoots,
  filesRoutedToNoDomain,
  filesUnseenByCorrectness,
  reportNonRuns,
  REVIEW_ROUTING_ADVISORY,
  SYNCED_ASSET_EXCLUDES,
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

let sinkDir = '';
afterEach(() => {
  delete process.env.GUARD_REVIEW_NO_TOPOLOGY_WARN;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (sinkDir) rmSync(sinkDir, { recursive: true, force: true });
  sinkDir = '';
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
        '(src/shared/validate.ts) — add each path or its directory to review.backendRoots/frontendRoots ' +
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

  const selfHost = () =>
    resolveGuardConfigJson(
      readFileSync(join(REPO_ROOT, 'guard.config.json'), 'utf8'),
      '/nonexistent-cwd-defaults-only',
    );

  it("devkit's own self-host config routes every scanRoot, so a commit inside them stays quiet", () => {
    const cfg = selfHost();
    expect(
      unrouted(
        cfg.scanRoots.map((r) => `${r}/x.mts`),
        cfg,
      ),
    ).toEqual([]);
  });

  it('names a root-level implementation file shipped beside a test under a domain root', () => {
    const staged = ['vitest.setup.mjs', 'cli/__tests__/vitest-setup-env-scrub.test.mts'];
    expect(unrouted(staged, selfHost())).toEqual(['vitest.setup.mjs']);
  });

  it('stays silent for prose, data and test files outside the domain roots', () => {
    expect(unrouted(['README.md', 'package.json', 'scripts/x.test.mts'], selfHost())).toEqual([]);
  });

  it('names a declared source extension outside the JS/TS family', () => {
    const python = { ...electron, sourceExtensions: ['py'] };
    expect(unrouted(['src/shared/validate.py', 'src/shared/notes.txt'], python)).toEqual([
      'src/shared/validate.py',
    ]);
  });

  it('never names a file no reviewer received', () => {
    const cfg = make(['app', 'lib'], ['app/api', 'lib'], ['app']);
    expect(unrouted(['.claude/skills/x/scripts/checklist.mjs', 'app/api/x.ts'], cfg)).toEqual([]);
  });

  const advisoryRows = (staged: string[]) => {
    sinkDir = mkdtempSync(join(tmpdir(), 'review-routing-'));
    const sink = join(sinkDir, 'events.jsonl');
    vi.stubEnv('DEVKIT_GATE_EVENTS', sink);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const selection = selectReviewers(staged, electron);
    reportNonRuns(staged, electron, selection, new Set(), new Set(), selection);
    return readFileSync(sink, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((event) => event.type === 'advisory_result');
  };

  it('writes one bounded advisory row, so the ship digest carries the notice', () => {
    const rows = advisoryRows(
      Array.from({ length: 40 }, (_, i) => `src/shared/${'n'.repeat(200)}${i}.ts`),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ gate: REVIEW_ROUTING_ADVISORY, status: 'finding' });
    expect(rows[0].detail).toContain('40 source file(s) reached no security/performance reviewer');
    expect(rows[0].detail).toHaveLength(500);
  });

  it('keeps the advisory row to the fact: the digest cuts a detail short, and a remedy would not fit', () => {
    const [row] = advisoryRows(['src/shared/validate.ts']);
    expect(row.detail).toBe(
      '1 source file(s) reached no security/performance reviewer (src/shared/validate.ts)',
    );
  });

  it('a remedy the notice names routes the file: an exact path under backendRoots', () => {
    const cfg = selfHost();
    const routed = {
      ...cfg,
      review: { ...cfg.review, backendRoots: [...cfg.review.backendRoots, 'vitest.setup.mjs'] },
    };
    const selection = selectReviewers(['vitest.setup.mjs'], routed);
    expect(selection.find((s) => s.reviewer.name === 'api-security-reviewer')?.files).toEqual([
      'vitest.setup.mjs',
    ]);
    expect(filesRoutedToNoDomain(selection, routed)).toEqual([]);
  });

  it('writes no advisory row when every code file reached a domain reviewer', () => {
    expect(advisoryRows(['src/main/ipc.ts', 'src/shared/README.md'])).toEqual([]);
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

describe('filesUnseenByCorrectness', () => {
  // No review.paths: the legacy selector gives correctness only declared roots with a ts/tsx suffix.
  const legacy = make(['src'], ['src'], []);
  const unseen = (staged: string[], cfg = legacy) =>
    filesUnseenByCorrectness(staged, selectReviewers(staged, cfg), cfg);
  const templateCfg = (template: string) =>
    resolveGuardConfigJson(
      readFileSync(join(REPO_ROOT, 'templates', template, 'guard.config.json'), 'utf8'),
      '/nonexistent-cwd-defaults-only',
    );
  const report = (staged: string[], cfg = legacy) => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const selection = selectReviewers(staged, cfg);
    reportNonRuns(staged, cfg, selection, new Set(), new Set(), selection);
    return spy.mock.calls.map((c) => String(c[0]));
  };

  it('names code that reached no reviewer at all, on one line', () => {
    const lines = report(['drizzle.config.ts', 'src/a.ts']);
    expect(lines).toEqual([
      'guard-review: 1 code file(s) reached no correctness reviewer (drizzle.config.ts) — ' +
        'review.paths is absent, so correctness reviews only declared roots with a sourceExtensions ' +
        'suffix: declare review.paths in guard.config.json (templates ship include ["**"] with ' +
        'excludes), or add the extension to sourceExtensions',
    ]);
  });

  it("stays silent for devkit's synced agent assets and build output", () => {
    const synced = [
      '.claude/skills/x/scripts/checklist.mjs',
      '.codex/hooks/base-drift-brief.mjs',
      'dist/index.mjs',
      'src/a.ts',
    ];
    expect(report(synced)).toEqual([]);
  });

  it('names in-root code outside sourceExtensions that only domain reviewers received', () => {
    expect(unseen(['src/db.mts', 'src/a.ts'])).toEqual(['src/db.mts']);
  });

  it('stays silent for test, prose and data files', () => {
    expect(unseen(['a.test.ts', 'README.md', 'package.json', 'src/a.ts'])).toEqual([]);
  });

  it('names code when correctness received nothing at all but another reviewer ran', () => {
    expect(report(['src/db.mts'])).toEqual([
      expect.stringContaining('1 code file(s) reached no correctness reviewer (src/db.mts)'),
    ]);
  });

  it('counts a file the HEAD review.paths policy routed to correctness as seen', () => {
    const staged = ['drizzle.config.ts', 'src/a.ts'];
    const routing = selectReviewers(staged, legacy, templateCfg('generic'));
    expect(filesUnseenByCorrectness(staged, routing, legacy)).toEqual([]);
  });

  it('never re-names a file the empty-frontendRoots line already named', () => {
    const lines = report(['src/App.jsx', 'src/a.ts']);
    expect(lines.filter((l) => l.includes('src/App.jsx'))).toHaveLength(1);
    expect(lines.some((l) => l.includes('correctness'))).toBe(false);
  });

  it('stays silent when review.paths is declared', () => {
    expect(unseen(['drizzle.config.ts', 'src/a.ts'], templateCfg('generic'))).toEqual([]);
  });

  it('stays silent under the opt-out and on a recheck', () => {
    expect(filesUnseenByCorrectness(['drizzle.config.ts'], [], legacy)).toEqual([]);
    process.env.GUARD_REVIEW_NO_TOPOLOGY_WARN = '1';
    expect(unseen(['drizzle.config.ts', 'src/a.ts'])).toEqual([]);
  });

  it('joins both routing facts into one advisory row', () => {
    sinkDir = mkdtempSync(join(tmpdir(), 'review-routing-'));
    const sink = join(sinkDir, 'events.jsonl');
    vi.stubEnv('DEVKIT_GATE_EVENTS', sink);
    const cfg = make(['src'], ['src/main'], ['src/renderer']);
    report(['src/shared/v.ts', 'drizzle.config.ts', 'src/main/a.ts'], cfg);
    const rows = readFileSync(sink, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((event) => event.type === 'advisory_result');
    expect(rows).toHaveLength(1);
    expect(rows[0].detail).toBe(
      '1 source file(s) reached no security/performance reviewer (src/shared/v.ts); ' +
        '1 code file(s) reached no correctness reviewer (drizzle.config.ts)',
    );
  });

  it.each(readdirSync(join(REPO_ROOT, 'templates')).filter((t) => !t.startsWith('_')))(
    'templates/%s excludes every synced asset path',
    (template) => {
      expect(templateCfg(template).review.paths?.exclude).toEqual(
        expect.arrayContaining(SYNCED_ASSET_EXCLUDES),
      );
    },
  );
});
