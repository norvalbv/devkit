import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveGuardConfig } from '../../config.mts';
import { normalizeLineEndings, VERDICT_LINE_RE } from '../contracts/response.mts';
import { LIGHT_JUDGE_MODEL } from '../../judge/judge-isolation.mts';
import { devkitVersion } from '../../devkit-version.mts';
import { parseConventionEvidencePairs, parseConventionFindings } from '../evidence/conventions.mts';
import { countLines } from '../evidence/line-counts.mts';
import { domainsDisabledByEmptyRoots } from '../evidence/scope.mts';
import {
  allowedToolsFor,
  cacheKey,
  effectiveReviewConfig,
  escalatePrompt,
  parseReviewVerdict,
  REVIEWERS,
  rootsFor,
  selectReviewers,
  stripFrontmatter,
  wrapConventionsPrompt,
  wrapPrompt,
} from '../reviewers.mts';
import { verifyChecklist } from '../runtime.mts';

// A frink-shaped review config without touching disk: defaults + explicit roots.
const defaults = resolveGuardConfig('/nonexistent-cwd-defaults-only');
const cfg = {
  ...defaults,
  scanRoots: ['src', 'server'],
  review: {
    ...defaults.review,
    backendRoots: ['src/main', 'server'],
    frontendRoots: ['src/renderer', 'src/preload'],
  },
};

const names = (sel) => sel.map((s) => s.reviewer.name);
const filesFor = (sel, reviewer) => sel.find((s) => s.reviewer.name === reviewer)?.files;

describe('test fixture invariant', () => {
  it('keeps the resolved review model knobs — dropping them would silently un-pin every config-resolved reviewer', () => {
    expect(cfg.review.model).toBe(defaults.review.model);
    expect(cfg.review.escalationModel).toBe(defaults.review.escalationModel);
    expect(cfg.review.correctnessModel).toBe(defaults.review.correctnessModel);
  });
});

describe('parseReviewVerdict', () => {
  it('clean PASS', () => {
    expect(parseReviewVerdict('All hunks fine.\nVERDICT: PASS')).toEqual({
      verdict: 'PASS',
      reason: '',
    });
  });
  it('FAIL captures the one-line reason', () => {
    expect(
      parseReviewVerdict('Bad.\nVERDICT: FAIL — SQL built by string concat in db.ts:12'),
    ).toEqual({ verdict: 'FAIL', reason: 'SQL built by string concat in db.ts:12' });
  });
  it('markdown-dressed verdict lines still parse', () => {
    expect(parseReviewVerdict('notes\n**VERDICT: PASS**').verdict).toBe('PASS');
    expect(parseReviewVerdict('- VERDICT: **FAIL** - missing auth check').verdict).toBe('FAIL');
  });
  it('prose full of pass/fail words WITHOUT a VERDICT line is null — no bare-word fallback', () => {
    expect(
      parseReviewVerdict('The tests pass but the check could fail under load. Looks fine.').verdict,
    ).toBe(null);
  });
  it('multiple VERDICT lines → the LAST wins', () => {
    expect(parseReviewVerdict('VERDICT: FAIL — hasty\nRe-reading…\nVERDICT: PASS').verdict).toBe(
      'PASS',
    );
  });
  it('empty / no output → null', () => {
    expect(parseReviewVerdict('').verdict).toBe(null);
  });

  it.each([
    ['CRLF', '\r\n'],
    ['CR', '\r'],
  ])('captures the FAIL reason when the judge emits %s', (_name, eol) => {
    expect(
      parseReviewVerdict(`Bad.${eol}VERDICT: FAIL — SQL built by string concat in db.ts:12`),
    ).toEqual({ verdict: 'FAIL', reason: 'SQL built by string concat in db.ts:12' });
  });

  it('does not absorb a trailing CRLF into the reason', () => {
    expect(parseReviewVerdict('Bad.\r\nVERDICT: FAIL — missing auth check\r\n')).toEqual({
      verdict: 'FAIL',
      reason: 'missing auth check',
    });
  });

  it('still strips markdown dressing on a CRLF verdict line', () => {
    expect(parseReviewVerdict('notes\r\n- VERDICT: **FAIL** - missing auth check')).toEqual({
      verdict: 'FAIL',
      reason: 'missing auth check',
    });
  });

  it.each([
    ['CRLF', '\r\n'],
    ['CR', '\r'],
  ])('still lets the LAST of several verdict lines win under %s', (_name, eol) => {
    expect(
      parseReviewVerdict(`VERDICT: FAIL — hasty${eol}Re-reading…${eol}VERDICT: PASS`).verdict,
    ).toBe('PASS');
  });
});

// sc-2284: consumers slice a transcript at this regex's match index, so the index must be the
// verdict line's own start. An unguarded leading dressing class consumed the `\n` of a CRLF —
// multiline `^` already matches after the bare `\r` — leaving the slice ending in a dangling `\r`
// that the non-multiline evidence-label regexes cannot match.
describe('VERDICT_LINE_RE match position', () => {
  const DRESSING = [
    ['plain', 'VERDICT: FAIL — why'],
    ['blockquote and bold', '> **VERDICT: FAIL** — reason'],
    ['heading', '## VERDICT: FAIL - why'],
    ['indented', '   VERDICT: FAIL'],
    ['list item and bold', '- VERDICT: **FAIL** - missing auth check'],
  ];
  const EOLS = [
    ['LF', '\n'],
    ['CRLF', '\r\n'],
    ['CR', '\r'],
  ];
  const cases = DRESSING.flatMap(([dressing, line]) =>
    EOLS.map(([eolName, eol]) => [`${dressing} under ${eolName}`, line, eol]),
  );

  it.each(cases)('anchors on the verdict line start — %s', (_name, line, eol) => {
    const head = `preceding prose${eol}more prose`;
    const transcript = head + eol + line;
    expect([...transcript.matchAll(VERDICT_LINE_RE)].at(-1)?.index).toBe((head + eol).length);
  });

  it('anchors past a blank line rather than swallowing it', () => {
    // HEAD returned 2 here (the class ate the blank line's own newline). Both slices parse to the
    // same findings, so this pins the intent, not a behaviour change.
    expect([...'x\n\nVERDICT: FAIL'.matchAll(VERDICT_LINE_RE)].at(-1)?.index).toBe(3);
  });

  it('stays unadvanced when read repeatedly, so concurrent reviewers sharing it agree', () => {
    const transcript = 'notes\r\nVERDICT: FAIL — why';
    const first = [...transcript.matchAll(VERDICT_LINE_RE)].at(-1)?.index;
    expect([...transcript.matchAll(VERDICT_LINE_RE)].at(-1)?.index).toBe(first);
    expect(VERDICT_LINE_RE.lastIndex).toBe(0);
    expect(parseReviewVerdict(transcript)).toEqual(parseReviewVerdict(transcript));
  });

  it('leaves a CRLF evidence slice newline-terminated, never ending in a dangling CR', () => {
    const transcript =
      'VIOLATION: rule — CLAUDE.md:1\r\nOFFENDING: x — src/a.ts:1\r\nVERDICT: FAIL — why';
    const last = [...transcript.matchAll(VERDICT_LINE_RE)].at(-1);
    expect(transcript.slice(0, last?.index)).toMatch(/\r\n$/);
    expect(parseReviewVerdict(transcript)).toEqual({ verdict: 'FAIL', reason: 'why' });
  });
});

describe('REVIEWERS table invariant — skill/stateFile/cmds always travel together', () => {
  // Reviewer.skill docstring documents this as a hard invariant (hasChecklist keys ONLY off
  // `skill`). A future entry that sets one of the three but not the others would silently pass
  // TypeScript's structural check yet crash at runtime — checklistScript would build a path off
  // an undefined skill, or wrapPrompt would dereference an undefined cmds.gen. This test fails
  // the moment the table itself drifts from the invariant it documents, independent of which
  // reviewer causes it.
  it('every entry has ALL THREE checklist fields set, or NONE of them — never a partial mix', () => {
    for (const r of REVIEWERS) {
      const present = [r.skill, r.stateFile, r.cmds].map((v) => v !== undefined);
      const allSame = present.every((p) => p === present[0]);
      expect(allSame, `${r.name}: skill/stateFile/cmds must be all-set or all-unset`).toBe(true);
    }
  });
});

describe('selectReviewers', () => {
  it('backend-only staged → backend pair + commit-guard + correctness + conventions', () => {
    expect(names(selectReviewers(['src/main/db.ts'], cfg))).toEqual([
      'api-security-reviewer',
      'backend-performance-reviewer',
      'commit-guard',
      'correctness-reviewer',
      'conventions-reviewer', // domain 'conventions' shares 'all'\'s root union, no source filter
    ]);
  });
  it('frontend-only staged → frontend pair + commit-guard + correctness + conventions', () => {
    expect(names(selectReviewers(['src/renderer/App.tsx'], cfg))).toEqual([
      'frontend-security-reviewer',
      'frontend-performance-reviewer',
      'commit-guard',
      'correctness-reviewer',
      'conventions-reviewer',
    ]);
  });
  it('mixed staged → every reviewer in the table', () => {
    expect(names(selectReviewers(['src/main/a.ts', 'src/preload/b.ts'], cfg))).toEqual(
      REVIEWERS.map((r) => r.name),
    );
  });
  it('docs-only staged → nothing runs (neither docs/ nor CLAUDE.md sit under a declared root)', () => {
    expect(selectReviewers(['docs/readme.md', 'CLAUDE.md'], cfg)).toEqual([]);
  });
  it('prose-only staged UNDER a backend root → domain pair skips (their checklist scripts skip prose; selecting would strand the judge inconclusive)', () => {
    const picked = names(selectReviewers(['src/main/README.md'], cfg));
    expect(picked).not.toContain('api-security-reviewer');
    expect(picked).not.toContain('backend-performance-reviewer');
  });
  it('prose riding along with source under a backend root → reviewer selected, prose dropped from its file list', () => {
    const sel = selectReviewers(['src/main/a.ts', 'src/main/README.md'], cfg);
    const api = sel.find((s) => s.reviewer.name === 'api-security-reviewer');
    expect(api?.files).toEqual(['src/main/a.ts']);
  });
  it('a totally UNCONFIGURED consumer (no guard.config.json — pure resolveGuardConfig defaults) still fires conventions-reviewer for the default src/ root, with zero custom config', () => {
    const defaults = resolveGuardConfig('/nonexistent-defaults-only');
    expect(names(selectReviewers(['src/a.ts'], defaults))).toContain('conventions-reviewer');
  });
  it("...but a file OUTSIDE that default root (e.g. a bare top-level file, or infra/ — never declared) selects nothing, even for conventions — the AC's documented coverage boundary", () => {
    const defaults = resolveGuardConfig('/nonexistent-defaults-only');
    expect(selectReviewers(['infra/main.tf'], defaults)).toEqual([]);
  });
  it('empty frontendRoots → frontend reviewers never selected (but the gate says so out loud)', () => {
    const noFe = { ...cfg, review: { ...cfg.review, frontendRoots: [] } };
    const staged = ['src/renderer/App.tsx', 'src/main/a.ts'];
    expect(names(selectReviewers(staged, noFe))).toEqual([
      'api-security-reviewer',
      'backend-performance-reviewer',
      'commit-guard',
      'correctness-reviewer', // domain 'all' still sees both files under scanRoot src
      'conventions-reviewer', // domain 'conventions' shares that same union
    ]);
    // Silence is NOT the contract — the other half of it lives in empty-roots.test.mts. Asserted
    // here too so the two halves cannot drift apart.
    expect(domainsDisabledByEmptyRoots(staged, noFe).map((d) => d.reviewer)).toEqual([
      'frontend-security-reviewer',
      'frontend-performance-reviewer',
    ]);
  });
  it('review mode fills an empty domain from scanRoots so it never silently skips', () => {
    const noFe = { ...cfg, review: { ...cfg.review, frontendRoots: [] } };
    const effective = effectiveReviewConfig(noFe, {});
    expect(effective.review.frontendRoots).toEqual(['src', 'server']);
    expect(names(selectReviewers(['src/renderer/App.tsx'], effective))).toContain(
      'frontend-security-reviewer',
    );
  });

  it('normalizes scanRoots for every reviewer that consumes the effective config', () => {
    const effective = effectiveReviewConfig({
      ...cfg,
      scanRoots: [' src '],
      review: { backendRoots: [], frontendRoots: [] },
    });

    expect(effective.scanRoots).toEqual(['src']);
    expect(names(selectReviewers(['src/a.ts'], effective))).toContain('commit-guard');
  });
  it('review mode uses the repository-wide dot fallback when no roots exist at all', () => {
    const noRoots = {
      ...cfg,
      scanRoots: [],
      review: { ...cfg.review, backendRoots: [], frontendRoots: [] },
    };
    const effective = effectiveReviewConfig(noRoots, {});
    expect(effective.scanRoots).toEqual(['.']);
    expect(effective.review.backendRoots).toEqual(['.']);
    expect(effective.review.frontendRoots).toEqual(['.']);
    expect(names(selectReviewers(['top-level.ts'], effective))).toEqual([
      'api-security-reviewer',
      'backend-performance-reviewer',
      'frontend-security-reviewer',
      'frontend-performance-reviewer',
      'commit-guard',
      'correctness-reviewer',
      'conventions-reviewer',
    ]);
  });
  it('review-mode injected roots override config while malformed injection fails loudly', () => {
    const effective = effectiveReviewConfig(cfg, {
      DEVKIT_REVIEW_FRONTEND_ROOTS: JSON.stringify([' apps/web ']),
    });
    expect(effective.review.frontendRoots).toEqual(['apps/web']);
    expect(names(selectReviewers(['apps/web/A.tsx'], effective))).toContain(
      'frontend-security-reviewer',
    );
    expect(() => effectiveReviewConfig(cfg, { DEVKIT_REVIEW_FRONTEND_ROOTS: '["", 3]' })).toThrow(
      /DEVKIT_REVIEW_FRONTEND_ROOTS/,
    );
    expect(() =>
      effectiveReviewConfig(cfg, {
        DEVKIT_REVIEW_FRONTEND_ROOTS: JSON.stringify([':(exclude)**']),
      }),
    ).toThrow(/DEVKIT_REVIEW_FRONTEND_ROOTS/);
  });
  it('commit-guard sees only SOURCE files under scanRoots (a staged JSON is not its business)', () => {
    const sel = selectReviewers(['src/config.json', 'src/main/a.ts'], cfg);
    const guard = sel.find((s) => s.reviewer.name === 'commit-guard');
    expect(guard.files).toEqual(['src/main/a.ts']);
  });
  it('conventions-reviewer, unlike commit-guard/correctness, is NOT filtered to source-only (a JSON/config can carry a CLAUDE.md violation)', () => {
    const sel = selectReviewers(['src/config.json', 'src/main/a.ts'], cfg);
    const conv = sel.find((s) => s.reviewer.name === 'conventions-reviewer');
    expect(conv.files).toEqual(['src/config.json', 'src/main/a.ts']);
  });
  it('conventions-reviewer, unlike correctness, is NOT filtered to exclude test files (a test can violate a convention too)', () => {
    const sel = selectReviewers(['src/main/a.ts', 'src/main/a.test.ts'], cfg);
    const conv = sel.find((s) => s.reviewer.name === 'conventions-reviewer');
    expect(conv.files).toEqual(['src/main/a.ts', 'src/main/a.test.ts']);
  });
  it('root matching is prefix-per-segment — src/mainframe is NOT under src/main', () => {
    const sel = selectReviewers(['src/mainframe/x.ts'], cfg);
    // under scanRoot src (→ commit-guard + correctness + conventions), not backendRoot src/main
    expect(names(sel)).toEqual(['commit-guard', 'correctness-reviewer', 'conventions-reviewer']);
  });
});

describe('correctness-reviewer (domain all)', () => {
  const corr = REVIEWERS.find((r) => r.name === 'correctness-reviewer');
  it('is pinned single-pass (bench: recall scales with model; the opus cascade subtracts recall) — shipped pin gpt-5.6-sol since sc-2054', () => {
    expect(corr.model).toBe('gpt-5.6-sol');
    // correctness (sonnet) and conventions are the two deliberately model-pinned exceptions;
    // domain reviewers stay unpinned so they keep the first-pass→escalation cascade.
    const pinned = new Set(['correctness-reviewer', 'conventions-reviewer']);
    for (const r of REVIEWERS.filter((r) => !pinned.has(r.name))) expect(r.model).toBeUndefined();
  });
  it('sees SOURCE files across the UNION of every declared root, deduped', () => {
    expect([...rootsFor(corr, cfg)].sort()).toEqual(
      ['server', 'src', 'src/main', 'src/preload', 'src/renderer'].sort(),
    );
  });
  it('is selected for a source file under any single root', () => {
    expect(names(selectReviewers(['server/worker.ts'], cfg))).toContain('correctness-reviewer');
  });
  it('excludes test files — a runtime defect cannot come from a test hunk', () => {
    const sel = selectReviewers(['src/main/a.ts', 'src/main/a.test.ts'], cfg);
    const c = sel.find((s) => s.reviewer.name === 'correctness-reviewer');
    expect(c.files).toEqual(['src/main/a.ts']);
  });
  it('excludes non-source (a staged JSON/doc is not a correctness concern)', () => {
    const sel = selectReviewers(['src/main/data.json'], cfg);
    expect(names(sel)).not.toContain('correctness-reviewer');
  });
  it('applies explicit repo-wide runtime paths to the whole reviewer fleet without widening language tooling', () => {
    const scoped = {
      ...cfg,
      review: {
        ...cfg.review,
        paths: {
          include: ['src/**'],
          exclude: ['**/*.test.*'],
        },
      },
    };
    const sel = selectReviewers(
      [
        'src/main/ship.sh',
        'src/main/worker.custom',
        'src/main/worker.test.sh',
        'src/renderer/app.css',
      ],
      scoped,
    );
    expect(filesFor(sel, 'api-security-reviewer')).toEqual([
      'src/main/ship.sh',
      'src/main/worker.custom',
    ]);
    expect(filesFor(sel, 'backend-performance-reviewer')).toEqual([
      'src/main/ship.sh',
      'src/main/worker.custom',
    ]);
    expect(filesFor(sel, 'frontend-security-reviewer')).toEqual(['src/renderer/app.css']);
    expect(filesFor(sel, 'frontend-performance-reviewer')).toEqual(['src/renderer/app.css']);
    expect(filesFor(sel, 'correctness-reviewer')).toEqual([
      'src/main/ship.sh',
      'src/main/worker.custom',
      'src/renderer/app.css',
    ]);
    expect(filesFor(sel, 'conventions-reviewer')).toEqual([
      'src/main/ship.sh',
      'src/main/worker.custom',
      'src/renderer/app.css',
    ]);
    expect(names(sel)).not.toContain('commit-guard');
  });

  it('unions HEAD and staged path policy for every reviewer when the caller supplies a baseline config', () => {
    const baseline = {
      ...cfg,
      review: {
        ...cfg.review,
        paths: { include: ['src/main/legacy/**'], exclude: [] },
      },
    };
    const staged = {
      ...cfg,
      review: {
        ...cfg.review,
        paths: { include: ['src/main/new/**'], exclude: [] },
      },
    };
    const selected = selectReviewers(
      ['src/main/legacy/a.ts', 'src/main/new/b.ts', 'outside/c.ts'],
      staged,
      baseline,
    );
    for (const selection of selected)
      expect(selection.files).toEqual(['src/main/legacy/a.ts', 'src/main/new/b.ts']);
  });

  it('Devkit self-scope reviews authored tests, evals, docs, references, and hidden project files', () => {
    const self = resolveGuardConfig(process.cwd());
    const authored = [
      'agents-hooks/decision-stop-check.sh',
      'cli/index.mts',
      'skills/_devkit/review-roots.mjs',
      'skills/correctness/scripts/checklist.mjs',
      'gate-engine/review/__tests__/reviewers.test.mts',
      'gate-engine/review/eval/reviewers/bench.mts',
      'docs/decisions/review-gate-in-chain.md',
      'skills/correctness/references/checklist.md',
      'README.md',
      '.github/workflows/gate.yml',
      'packages/ui/.storybook/main.ts',
    ];
    const excluded = [
      '.agents/skills/correctness/SKILL.md',
      '.claude/agents/correctness-reviewer.md',
      '.codex/agents/correctness-reviewer.toml',
      '.cursor/agents/correctness-reviewer.md',
      '.devkit/agents-manifest.json',
      '.env',
      '.env.local',
      '.envrc',
      'packages/api/.env.production',
      'packages/api/.envrc',
      'packages/ui/node_modules/package/index.js',
      'packages/ui/dist/index.mjs',
      'packages/ui/coverage/coverage-final.json',
    ];
    const selected = selectReviewers(
      [...authored, ...excluded, 'dist/gate-engine/review/reviewers.mjs', 'bun.lock'],
      self,
    );
    expect(selected.find((s) => s.reviewer.name === 'correctness-reviewer')?.files).toEqual(
      authored,
    );
    expect(selected.find((s) => s.reviewer.name === 'conventions-reviewer')?.files).toEqual(
      authored,
    );
  });
  it('gets the semantic search tool ONLY when the consumer wired an index (indexPath set)', () => {
    expect(allowedToolsFor(corr, { ...cfg, indexPath: null })).not.toContain(cfg.searchTool);
    expect(allowedToolsFor(corr, { ...cfg, indexPath: '.idx/db' })).toContain(cfg.searchTool);
  });
});

describe('allowedToolsFor', () => {
  it('domain reviewers get the read-only base + ONLY their own checklist script — no naked Bash, no write tools', () => {
    const tools = allowedToolsFor(REVIEWERS[0], cfg);
    expect(tools).toBe(
      'Read,Grep,Glob,Bash(git diff:*),Bash(git log:*),Bash(git status:*),' +
        'Bash(node .claude/skills/api-security/scripts/checklist.mjs:*),' +
        'mcp__codebase__*,mcp__context7__*,mcp__autonomous_bugs__*',
    );
    expect(tools).not.toMatch(/(^|,)Bash(,|$)/); // never an unscoped Bash
    expect(tools).not.toMatch(/Write|Edit/);
  });
  it('commit-guard additionally gets the configured semantic search tool', () => {
    const guard = REVIEWERS.find((r) => r.name === 'commit-guard');
    const tools = allowedToolsFor(guard, cfg);
    expect(tools).toContain(',mcp__codebase__searchCode');
    expect(tools).toContain('Bash(node .claude/skills/commit-guard/scripts/checklist.mjs:*)');
  });
  it('grants a provider-projected checklist path when the consumer resolver supplies one', () => {
    const tools = allowedToolsFor(REVIEWERS[0], cfg, '.agents');
    expect(tools).toContain('Bash(node .agents/skills/api-security/scripts/checklist.mjs:*)');
    expect(tools).not.toContain('Bash(node .claude/skills/api-security/scripts/checklist.mjs:*)');
  });
  it('a skill-less reviewer gets read tools plus the three named MCPs, but no Bash', () => {
    const conv = REVIEWERS.find((r) => r.name === 'conventions-reviewer');
    expect(allowedToolsFor(conv, cfg)).toBe(
      'Read,Grep,Glob,mcp__codebase__*,mcp__context7__*,mcp__autonomous_bugs__*',
    );
    expect(allowedToolsFor(conv, cfg)).not.toContain('Bash');
  });
});

describe('conventions-reviewer (domain conventions, skill-less)', () => {
  const conv = REVIEWERS.find((r) => r.name === 'conventions-reviewer');
  it('has no skill/stateFile/cmds — the checklist workflow is architecturally unavailable to it', () => {
    expect(conv.skill).toBeUndefined();
    expect(conv.stateFile).toBeUndefined();
    expect(conv.cmds).toBeUndefined();
  });
  it('is pinned single-pass at the light judge default, same mechanism as correctness', () => {
    expect(conv.model).toBe(LIGHT_JUDGE_MODEL);
  });
  it('declares the response contract that grants blocking authority', () => {
    expect(conv.responseContract).toBe('conventions-v1');
  });
  it("shares 'all''s root union — never ['.'], never restricted to a single declared-root kind", () => {
    expect([...rootsFor(conv, cfg)].sort()).toEqual(
      [
        ...rootsFor(
          REVIEWERS.find((r) => r.name === 'correctness-reviewer'),
          cfg,
        ),
      ].sort(),
    );
  });
});

describe('wrapConventionsPrompt / parseConventionFindings', () => {
  it('never mentions a checklist script or git diff — there is no Bash to run either with', () => {
    const p = wrapConventionsPrompt(
      'Check the rules.',
      ['a.ts'],
      'GOVERNING CLAUDE.md FILES: none',
    );
    expect(p).not.toContain('checklist.mjs');
    expect(p).not.toContain('git diff');
    expect(p).toContain('NO Bash');
    expect(p).toContain('Check the rules.');
    expect(p).toContain('GOVERNING CLAUDE.md FILES: none');
    expect(p).toContain('VERDICT: PASS | FAIL');
  });
  it('states the VIOLATION/OFFENDING quote-both-or-silent contract', () => {
    const p = wrapConventionsPrompt('brief', ['a.ts'], 'rules');
    expect(p).toContain('VIOLATION:');
    expect(p).toContain('OFFENDING:');
    expect(p).toContain('NO_VIOLATIONS');
  });
  it('extracts stable path:line lenses from OFFENDING blocks, independent of VERDICT-reason wording', () => {
    const transcript =
      'VIOLATION: never use console.log — CLAUDE.md:4\n' +
      'OFFENDING: console.log(x) — src/a.ts:12\n' +
      'VERDICT: FAIL — logging rule violated';
    expect(parseConventionFindings(transcript)).toEqual([
      {
        rulePath: 'CLAUDE.md',
        ruleLine: 4,
        offendingPath: 'src/a.ts',
        offendingLine: 12,
      },
    ]);
  });
  it('multiple complete violations produce multiple distinct lenses', () => {
    const transcript =
      'VIOLATION: rule a — CLAUDE.md:1\n' +
      'OFFENDING: x — src/a.ts:1\n' +
      'VIOLATION: rule b — docs/CLAUDE.md:2\n' +
      'OFFENDING: y — src/b.ts:2\n' +
      'VERDICT: FAIL — two violations';
    expect(parseConventionFindings(transcript)).toEqual([
      { rulePath: 'CLAUDE.md', ruleLine: 1, offendingPath: 'src/a.ts', offendingLine: 1 },
      {
        rulePath: 'docs/CLAUDE.md',
        ruleLine: 2,
        offendingPath: 'src/b.ts',
        offendingLine: 2,
      },
    ]);
  });
  it('accepts numeric line ranges while keeping their start as the stable lens line', () => {
    const transcript =
      'VIOLATION: multi-line rule — db/CLAUDE.md:3-4\n' +
      'OFFENDING: multi-line call — src/db/client.ts:42–44\n' +
      'VERDICT: FAIL — cited range';
    expect(parseConventionFindings(transcript)).toEqual([
      {
        rulePath: 'db/CLAUDE.md',
        ruleLine: 3,
        offendingPath: 'src/db/client.ts',
        offendingLine: 42,
      },
    ]);
  });
  it('accepts an observed rule citation with no line when OFFENDING still has a stable lens', () => {
    const transcript =
      'VIOLATION: Components must not accept className. — packages/ui/CLAUDE.md\n' +
      'OFFENDING: className?: string; — packages/ui/Button.tsx:10\n' +
      'VERDICT: FAIL — cited rule';
    expect(parseConventionFindings(transcript)).toEqual([
      {
        rulePath: 'packages/ui/CLAUDE.md',
        ruleLine: null,
        offendingPath: 'packages/ui/Button.tsx',
        offendingLine: 10,
      },
    ]);
  });
  it('accepts an observed parenthetical rule location', () => {
    const transcript =
      'VIOLATION: Never call console.* directly. — CLAUDE.md (repo root):2-3\n' +
      "OFFENDING: console.log('total'); — services/orders/pricing.ts:4\n" +
      'VERDICT: FAIL — cited rule';
    expect(parseConventionFindings(transcript)).toEqual([
      {
        rulePath: 'CLAUDE.md (repo root)',
        ruleLine: 2,
        offendingPath: 'services/orders/pricing.ts',
        offendingLine: 4,
      },
    ]);
  });
  it('preserves wrapped quoted content that starts with non-closer protocol labels', () => {
    const transcript =
      'VIOLATION:\n' +
      'OFFENDING: labels in quoted rule text\n' +
      '— db/CLAUDE.md:3-4\n' +
      'OFFENDING:\n' +
      'VIOLATION: quoted source label\n' +
      '— src/db/client.ts:42–44\n' +
      'VERDICT: FAIL — cited wrapped labels';
    expect(parseConventionFindings(transcript)).toEqual([
      {
        rulePath: 'db/CLAUDE.md',
        ruleLine: 3,
        offendingPath: 'src/db/client.ts',
        offendingLine: 42,
      },
    ]);
  });
  it('preserves protocol-label-like content before an inline citation trailer', () => {
    const transcript =
      'VIOLATION: Every migration must declare a primary key. — db/CLAUDE.md:3\n' +
      'OFFENDING: CREATE TABLE order_events (\n' +
      'VIOLATION: quoted column label\n' +
      '); — db/migrations/0007_order_events.sql:1-5\n' +
      'VERDICT: FAIL — cited wrapped content';
    expect(parseConventionFindings(transcript)).toEqual([
      {
        rulePath: 'db/CLAUDE.md',
        ruleLine: 3,
        offendingPath: 'db/migrations/0007_order_events.sql',
        offendingLine: 1,
      },
    ]);
  });
  it('keeps mixed plain/em-dash citation blocks separate with correct lenses', () => {
    const transcript =
      'VIOLATION: rule A - CLAUDE.md:5\n' +
      'OFFENDING: code A - foo.ts:10\n' +
      'some unrelated prose\n' +
      'VIOLATION:\n' +
      'Real rule B text — CLAUDE.md:8\n' +
      'OFFENDING: code B — bar.ts:20\n' +
      'VERDICT: FAIL — two violations';
    expect(parseConventionFindings(transcript)).toEqual([
      { rulePath: 'CLAUDE.md', ruleLine: 5, offendingPath: 'foo.ts', offendingLine: 10 },
      { rulePath: 'CLAUDE.md', ruleLine: 8, offendingPath: 'bar.ts', offendingLine: 20 },
    ]);
  });
  it('does not mistake subtraction inside a wrapped quote for a citation trailer', () => {
    const transcript =
      'VIOLATION: Avoid manual result adjustment. — CLAUDE.md:5\n' +
      'OFFENDING: const result = total - 1\n' +
      '— src/utils.ts:20\n' +
      'VERDICT: FAIL — cited subtraction';
    expect(parseConventionFindings(transcript)).toEqual([
      {
        rulePath: 'CLAUDE.md',
        ruleLine: 5,
        offendingPath: 'src/utils.ts',
        offendingLine: 20,
      },
    ]);
  });
  it('uses the final citation when a wrapped quote contains an incidental path:line', () => {
    const transcript =
      'VIOLATION: Cite the actual staged line. — CLAUDE.md:5\n' +
      'OFFENDING: "the pattern used here resembles rule-9 — old/decoy.ts:10\n' +
      'but actually flags this line" — src/actual.ts:200\n' +
      'VERDICT: FAIL — cited wrapped content';
    expect(parseConventionFindings(transcript)).toEqual([
      {
        rulePath: 'CLAUDE.md',
        ruleLine: 5,
        offendingPath: 'src/actual.ts',
        offendingLine: 200,
      },
    ]);
  });
  it('rejects orphan VIOLATION and OFFENDING lines', () => {
    expect(parseConventionFindings('VIOLATION: rule a — CLAUDE.md:1\nVERDICT: FAIL')).toEqual([]);
    expect(parseConventionFindings('OFFENDING: x — src/a.ts:1\nVERDICT: FAIL')).toEqual([]);
  });
  it.each([
    ['unrelated prose', 'Reviewer abandoned this point.\n'],
    ['a code fence', '```\n'],
    ['a verdict closer', 'VERDICT: FAIL — abandoned point\n'],
  ])('does not pair an orphan violation across %s', (_boundary, boundary) => {
    const transcript = `VIOLATION: Never use raw SQL. — CLAUDE.md:3\n${boundary}OFFENDING: const x = 1 — src/unrelated.ts:80`;
    expect(parseConventionEvidencePairs(transcript)).toEqual([]);
  });
  it('treats a verdict closer before a delayed citation as a hard evidence boundary', () => {
    const transcript =
      'VIOLATION: Never use raw SQL.\n' +
      'VERDICT: FAIL — abandoned point\n' +
      '— CLAUDE.md:3\n' +
      'OFFENDING: const x = 1 — src/unrelated.ts:80';
    expect(parseConventionEvidencePairs(transcript)).toEqual([]);
  });
  it('preserves quoted verdict text without treating it as a protocol closer', () => {
    const transcript =
      'VIOLATION: Test fixtures must not hardcode verdict strings. — CLAUDE.md:5\n' +
      'OFFENDING: The fixture writes\n' +
      '"VERDICT: FAIL"\n' +
      '— src/fixture.test.ts:42\n' +
      'VERDICT: FAIL — cited fixture';
    expect(parseConventionFindings(transcript)).toEqual([
      {
        rulePath: 'CLAUDE.md',
        ruleLine: 5,
        offendingPath: 'src/fixture.test.ts',
        offendingLine: 42,
      },
    ]);
  });
  it('preserves a blank-line-separated evidence pair', () => {
    const transcript =
      'VIOLATION: Never use raw SQL. — CLAUDE.md:3\n\nOFFENDING: db.raw(query) — src/db.ts:80';
    expect(parseConventionEvidencePairs(transcript)).toEqual([
      {
        violation: 'Never use raw SQL. — CLAUDE.md:3',
        offending: 'db.raw(query) — src/db.ts:80',
      },
    ]);
  });
  it('rejects a missing rule citation even when the wrapped OFFENDING citation is complete', () => {
    const transcript =
      'VIOLATION: rule text\n' +
      "OFFENDING: console.log('debug')\n" +
      '— src/app.ts:42\n\n' +
      'VERDICT: FAIL — uncited rule';
    expect(parseConventionEvidencePairs(transcript)).toEqual([
      {
        violation: 'rule text',
        offending: "console.log('debug') — src/app.ts:42",
      },
    ]);
    expect(parseConventionFindings(transcript)).toEqual([]);
  });
  it('rejects arbitrary trailing prose where a line-less CLAUDE.md rule location is required', () => {
    const transcript =
      'VIOLATION: rule text — see repo guidelines for context\n' +
      'OFFENDING: setState(x) — src/component.tsx:42\n' +
      'VERDICT: FAIL — uncited rule';
    expect(parseConventionFindings(transcript)).toEqual([]);
  });
  it('mixed malformed and valid blocks authorize only the complete pair', () => {
    const transcript =
      'OFFENDING: orphan — src/orphan.ts:9\n' +
      'VIOLATION: real rule — CLAUDE.md:2\n' +
      'OFFENDING: bad value — src/config.ts:4\n' +
      'VERDICT: FAIL — one real violation\n' +
      'VIOLATION: appendix — CLAUDE.md:8\n' +
      'OFFENDING: too late — src/late.ts:3';
    expect(parseConventionFindings(transcript)).toEqual([
      {
        rulePath: 'CLAUDE.md',
        ruleLine: 2,
        offendingPath: 'src/config.ts',
        offendingLine: 4,
      },
    ]);
  });
  it('no OFFENDING blocks → empty (a PASS transcript has none to key on)', () => {
    expect(parseConventionFindings('NO_VIOLATIONS\nVERDICT: PASS')).toEqual([]);
  });
});

// sc-2284: the evidence contract must be line-ending agnostic. A CRLF transcript used to lose the
// pair adjacent to the VERDICT line (one pair -> inconclusive; two -> a SILENT truncation that
// still blocked), and a CR-only transcript lost everything because the splitter never split. Rows
// carry their expected findings as a LITERAL rather than comparing CRLF output to LF output: an
// LF-vs-CRLF comparison is vacuously green if a future edit breaks both, and the literal is what
// pins the two-pair row at exactly 2.
describe('conventions evidence parsing is line-ending agnostic', () => {
  const LINE_ENDING_FIXTURES = [
    {
      name: 'a single cited pair',
      transcript:
        'VIOLATION: never use console.log — CLAUDE.md:4\n' +
        'OFFENDING: console.log(x) — src/a.ts:12\n' +
        'VERDICT: FAIL — logging rule violated',
      findings: [
        { rulePath: 'CLAUDE.md', ruleLine: 4, offendingPath: 'src/a.ts', offendingLine: 12 },
      ],
    },
    {
      name: 'two cited pairs',
      transcript:
        'VIOLATION: rule a — CLAUDE.md:1\n' +
        'OFFENDING: x — src/a.ts:1\n' +
        'VIOLATION: rule b — docs/CLAUDE.md:2\n' +
        'OFFENDING: y — src/b.ts:2\n' +
        'VERDICT: FAIL — two violations',
      findings: [
        { rulePath: 'CLAUDE.md', ruleLine: 1, offendingPath: 'src/a.ts', offendingLine: 1 },
        { rulePath: 'docs/CLAUDE.md', ruleLine: 2, offendingPath: 'src/b.ts', offendingLine: 2 },
      ],
    },
    {
      name: 'numeric line ranges',
      transcript:
        'VIOLATION: multi-line rule — db/CLAUDE.md:3-4\n' +
        'OFFENDING: multi-line call — src/db/client.ts:42–44\n' +
        'VERDICT: FAIL — cited range',
      findings: [
        {
          rulePath: 'db/CLAUDE.md',
          ruleLine: 3,
          offendingPath: 'src/db/client.ts',
          offendingLine: 42,
        },
      ],
    },
    {
      name: 'a line-less rule citation',
      transcript:
        'VIOLATION: Components must not accept className. — packages/ui/CLAUDE.md\n' +
        'OFFENDING: className?: string; — packages/ui/Button.tsx:10\n' +
        'VERDICT: FAIL — cited rule',
      findings: [
        {
          rulePath: 'packages/ui/CLAUDE.md',
          ruleLine: null,
          offendingPath: 'packages/ui/Button.tsx',
          offendingLine: 10,
        },
      ],
    },
    {
      name: 'a parenthetical rule location',
      transcript:
        'VIOLATION: Never call console.* directly. — CLAUDE.md (repo root):2-3\n' +
        "OFFENDING: console.log('total'); — services/orders/pricing.ts:4\n" +
        'VERDICT: FAIL — cited rule',
      findings: [
        {
          rulePath: 'CLAUDE.md (repo root)',
          ruleLine: 2,
          offendingPath: 'services/orders/pricing.ts',
          offendingLine: 4,
        },
      ],
    },
    {
      name: 'a quoted verdict string inside the offending block',
      transcript:
        'VIOLATION: Test fixtures must not hardcode verdict strings. — CLAUDE.md:5\n' +
        'OFFENDING: The fixture writes\n' +
        '"VERDICT: FAIL"\n' +
        '— src/fixture.test.ts:42\n' +
        'VERDICT: FAIL — cited fixture',
      findings: [
        {
          rulePath: 'CLAUDE.md',
          ruleLine: 5,
          offendingPath: 'src/fixture.test.ts',
          offendingLine: 42,
        },
      ],
    },
    {
      name: 'a blank-line-separated pair',
      transcript:
        'VIOLATION: Never use raw SQL. — CLAUDE.md:3\n\nOFFENDING: db.raw(query) — src/db.ts:80',
      findings: [
        { rulePath: 'CLAUDE.md', ruleLine: 3, offendingPath: 'src/db.ts', offendingLine: 80 },
      ],
    },
    {
      name: 'mixed malformed and valid blocks',
      transcript:
        'OFFENDING: orphan — src/orphan.ts:9\n' +
        'VIOLATION: real rule — CLAUDE.md:2\n' +
        'OFFENDING: bad value — src/config.ts:4\n' +
        'VERDICT: FAIL — one real violation\n' +
        'VIOLATION: appendix — CLAUDE.md:8\n' +
        'OFFENDING: too late — src/late.ts:3',
      findings: [
        { rulePath: 'CLAUDE.md', ruleLine: 2, offendingPath: 'src/config.ts', offendingLine: 4 },
      ],
    },
    {
      name: 'an orphan VIOLATION',
      transcript: 'VIOLATION: rule a — CLAUDE.md:1\nVERDICT: FAIL',
      findings: [],
    },
    {
      name: 'an orphan OFFENDING',
      transcript: 'OFFENDING: x — src/a.ts:1\nVERDICT: FAIL',
      findings: [],
    },
    {
      name: 'an uncited rule trailer',
      transcript:
        'VIOLATION: rule text — see repo guidelines for context\n' +
        'OFFENDING: setState(x) — src/component.tsx:42\n' +
        'VERDICT: FAIL — uncited rule',
      findings: [],
    },
  ];

  it.each(LINE_ENDING_FIXTURES)(
    '$name parses to its recorded findings under LF',
    ({ transcript, findings }) => {
      expect(parseConventionFindings(transcript)).toEqual(findings);
    },
  );

  it.each(LINE_ENDING_FIXTURES)(
    '$name parses identically when the judge emits CRLF',
    ({ transcript, findings }) => {
      const crlf = transcript.replaceAll('\n', '\r\n');
      expect(parseConventionFindings(crlf)).toEqual(findings);
      expect(parseConventionEvidencePairs(crlf)).toEqual(parseConventionEvidencePairs(transcript));
    },
  );

  it.each(LINE_ENDING_FIXTURES)(
    '$name parses identically under CR-only line endings',
    ({ transcript, findings }) => {
      const cr = transcript.replaceAll('\n', '\r');
      expect(parseConventionFindings(cr)).toEqual(findings);
      expect(parseConventionEvidencePairs(cr)).toEqual(parseConventionEvidencePairs(transcript));
    },
  );

  // The three shapes a wholesale \n -> \r\n swap cannot generate. A bare CR is what a judge emits
  // when it quotes a line out of a CRLF-checked-out file; only collapsing `\r\n?` (never `\r\n`)
  // reads it as a break, so these are the rows that keep the normalizer from being narrowed.
  it('reads a bare CR inside a VIOLATION quote as a line break', () => {
    const transcript =
      'VIOLATION: Never edit generated files.\rSee the header. — CLAUDE.md:1\n' +
      'OFFENDING: export const icons = [] — src/icons.ts:9\n' +
      'VERDICT: FAIL — cited rule';
    expect(parseConventionFindings(transcript)).toEqual([
      { rulePath: 'CLAUDE.md', ruleLine: 1, offendingPath: 'src/icons.ts', offendingLine: 9 },
    ]);
  });

  it('reads a bare CR inside an OFFENDING quote as a line break', () => {
    const transcript =
      'VIOLATION: Never use raw SQL. — CLAUDE.md:3\n' +
      'OFFENDING: db.raw(\rquery) — src/db.ts:80\n' +
      'VERDICT: FAIL — cited query';
    expect(parseConventionFindings(transcript)).toEqual([
      { rulePath: 'CLAUDE.md', ruleLine: 3, offendingPath: 'src/db.ts', offendingLine: 80 },
    ]);
  });

  it('parses a CR-only transcript the splitter would otherwise never split', () => {
    const transcript =
      'VIOLATION: never use console.log — CLAUDE.md:4\r' +
      'OFFENDING: console.log(x) — src/a.ts:12\r' +
      'VERDICT: FAIL — logging rule violated';
    expect(parseConventionFindings(transcript)).toEqual([
      { rulePath: 'CLAUDE.md', ruleLine: 4, offendingPath: 'src/a.ts', offendingLine: 12 },
    ]);
  });

  // The likeliest production shape of all, and the one a uniform \n -> \r\n swap cannot produce: a
  // judge writing LF prose that pastes a quoted line out of a CRLF-checked-out file. Whichever side
  // of the pair carries the CRLF, the finding must survive.
  it.each([
    ['the rule citation', '\r\n', '\n'],
    ['the offending citation', '\n', '\r\n'],
  ])('parses a transcript with mixed line endings around %s', (_name, first, second) => {
    const transcript =
      `VIOLATION: never use console.log — CLAUDE.md:4${first}` +
      `OFFENDING: console.log(x) — src/a.ts:12${second}` +
      'VERDICT: FAIL — mixed endings';
    expect(parseConventionFindings(transcript)).toEqual([
      { rulePath: 'CLAUDE.md', ruleLine: 4, offendingPath: 'src/a.ts', offendingLine: 12 },
    ]);
  });

  // Slice-boundary values for the terminal-verdict index: end-of-transcript, 0, and absent.
  it('ignores a trailing terminator after the verdict line', () => {
    const transcript =
      'VIOLATION: never use console.log — CLAUDE.md:4\r\n' +
      'OFFENDING: console.log(x) — src/a.ts:12\r\n' +
      'VERDICT: FAIL — why\r\n';
    expect(parseConventionFindings(transcript)).toEqual([
      { rulePath: 'CLAUDE.md', ruleLine: 4, offendingPath: 'src/a.ts', offendingLine: 12 },
    ]);
  });

  it('treats a CRLF transcript whose verdict comes FIRST as evidence-free', () => {
    // Index 0 — the evidence slice is empty, so a pair below the verdict can never authorize it.
    const transcript =
      'VERDICT: FAIL — no evidence\r\n' +
      'VIOLATION: r — CLAUDE.md:1\r\n' +
      'OFFENDING: x — src/a.ts:1';
    expect(parseConventionFindings(transcript)).toEqual([]);
  });

  it('parses a CRLF transcript with NO verdict line, scanning the whole of it', () => {
    const transcript =
      'VIOLATION: never use console.log — CLAUDE.md:4\r\nOFFENDING: console.log(x) — src/a.ts:12';
    expect(parseConventionFindings(transcript)).toEqual([
      { rulePath: 'CLAUDE.md', ruleLine: 4, offendingPath: 'src/a.ts', offendingLine: 12 },
    ]);
  });

  // parseConventionFindings normalizes, then hands the slice to parseConventionEvidencePairs which
  // normalizes again. That double pass is only safe because the collapse is idempotent.
  it('normalizes idempotently, so both entry points may normalize independently', () => {
    const mixed = 'a\r\nb\rc\nd';
    expect(normalizeLineEndings(mixed)).toBe('a\nb\nc\nd');
    expect(normalizeLineEndings(normalizeLineEndings(mixed))).toBe(normalizeLineEndings(mixed));
  });
});

describe('verifyChecklist — the gate-side anti-hallucination contract', () => {
  const items = (statuses) => ({ items: statuses.map((s, i) => ({ name: `c${i}`, status: s })) });
  it('complete all-pass artifact + PASS verdict → null (ok)', () => {
    expect(verifyChecklist(items(['pass', 'pass']), 'PASS')).toBe(null);
  });
  it('missing/corrupt/empty artifact voids a PASS', () => {
    expect(verifyChecklist(null, 'PASS')).toContain('skipped the checklist');
    expect(verifyChecklist({}, 'PASS')).toContain('skipped the checklist');
    expect(verifyChecklist({ items: [] }, 'PASS')).toContain('skipped the checklist');
  });
  it('pending items void a PASS and are named', () => {
    const reason = verifyChecklist(items(['pass', 'pending', 'pending']), 'PASS');
    expect(reason).toContain('2 item(s) never resolved');
    expect(reason).toContain('c1');
  });
  it('failed items with a PASS verdict are a mismatch', () => {
    expect(verifyChecklist(items(['pass', 'fail']), 'PASS')).toContain('FAILED item(s)');
  });
  it("commit-guard's files[] shape verifies the same way", () => {
    expect(verifyChecklist({ files: [{ path: 'a.ts', status: 'pass' }] }, 'PASS')).toBe(null);
    expect(verifyChecklist({ files: [{ path: 'a.ts', status: 'pending' }] }, 'PASS')).toContain(
      'a.ts',
    );
  });
  it('a FAIL verdict needs no artifact — it blocks regardless', () => {
    expect(verifyChecklist(null, 'FAIL')).toBe(null);
  });

  // sc-1439: emptiness must be EXPLAINED, never mute — a named skip is valid, a bare empty voids.
  it('an empty artifact with a NAMED skip reason is valid; unnamed emptiness still voids', () => {
    expect(verifyChecklist({ items: [], skipped: 'filters excluded every file' }, 'PASS')).toBe(
      null,
    );
    expect(verifyChecklist({ files: [], skipped: 'filters excluded every file' }, 'PASS')).toBe(
      null,
    );
    expect(verifyChecklist({ items: [], skipped: '' }, 'PASS')).toContain('skipped the checklist');
  });
});

describe('wrapPrompt / escalatePrompt / stripFrontmatter', () => {
  // sc-1441: the governing-Targets block rides between the file list and the checklist contract.
  it('includes the targets block when provided and the evidence wording always (sc-1441)', () => {
    const reviewer = REVIEWERS.find((r) => r.name === 'api-security-reviewer');
    const withTargets = wrapPrompt('body', reviewer as never, ['a.ts'], undefined, undefined, {
      targetsBlock: '## RECORDED TARGETS\n### some-slug\nRuling.',
    });
    expect(withTargets).toContain('## RECORDED TARGETS');
    expect(withTargets).toContain('some-slug');
    expect(withTargets).toContain('per-file diff evidence is on stdin');
    const without = wrapPrompt('body', reviewer as never, ['a.ts']);
    expect(without).not.toContain('RECORDED TARGETS');
  });

  // sc-1442: the advisory message block rides in both wrappers when provided.
  it('includes the commit-message block in checklist and conventions prompts (sc-1442)', () => {
    const reviewer = REVIEWERS.find((r) => r.name === 'api-security-reviewer');
    const extras = { commitMsgBlock: 'The commit message (…):\n─────\nfeat: x\n─────' };
    const checklist = wrapPrompt('body', reviewer as never, ['a.ts'], undefined, undefined, extras);
    expect(checklist).toContain('─────\nfeat: x\n─────');
    const conventions = wrapConventionsPrompt('brief', ['a.ts'], 'rules', extras);
    expect(conventions).toContain('─────\nfeat: x\n─────');
    expect(wrapConventionsPrompt('brief', ['a.ts'], 'rules')).not.toContain('feat: x');
  });
  const body = '---\nname: api-security-reviewer\nmodel: opus\n---\nCheck auth on every route.';
  it('keeps exact registered checklist commands in ordinary commit/ship prompts', () => {
    const p = wrapPrompt(body, REVIEWERS[0], ['src/main/a.ts']);
    expect(p).toContain('HEADLESS COMMIT GATE');
    expect(p).toContain('Check auth on every route.');
    expect(p).not.toContain('model: opus');
    expect(p).toContain('VERDICT: PASS | FAIL');
    expect(p).toContain('src/main/a.ts');
    expect(p).toContain('node .claude/skills/api-security/scripts/checklist.mjs generate');
    expect(p).toContain('check-item <name> --pass');
    expect(p).toContain('Never delete the checklist artifact');
  });
  it('rewrites ordinary commit/ship prompts to the resolved consumer checklist root', () => {
    const p = wrapPrompt(
      'Try .agents/skills/api-security/SKILL.md, .claude/skills/api-security/SKILL.md, then .cursor/skills/api-security/SKILL.md.',
      REVIEWERS[0],
      ['src/main/a.ts'],
      undefined,
      undefined,
      undefined,
      '.agents',
    );
    expect(p).toContain('node .agents/skills/api-security/scripts/checklist.mjs generate');
    expect(p.match(/\.agents\/skills\/api-security/g)).toHaveLength(6);
    expect(p).not.toContain('.claude/skills/api-security');
    expect(p).not.toContain('.cursor/skills/api-security');
    expect(p).toContain('MANDATORY CHECKLIST WORKFLOW');
  });
  it('lets the packaged brief own enumeration and rewrites its skill paths in review mode', () => {
    const guard = REVIEWERS.find((r) => r.name === 'commit-guard');
    const p = wrapPrompt(
      'Try .agents/skills/commit-guard/SKILL.md, .claude/skills/commit-guard/SKILL.md, then .cursor/skills/commit-guard/SKILL.md.',
      guard,
      ['src/a.ts'],
      '/tmp/devkit-review-assets',
    );
    expect(p).toContain('/tmp/devkit-review-assets/skills/commit-guard/SKILL.md');
    expect(p).not.toContain('.claude/skills/commit-guard/SKILL.md');
    expect(p).not.toContain('.agents/skills/commit-guard');
    expect(p).not.toContain('.cursor/skills/commit-guard');
    expect(p).toContain('The reviewer brief owns checklist enumeration');
    expect(p).not.toContain('check-file <name>');
  });
  it('adds a contract reminder on retry without taking checklist ownership from the brief', () => {
    const p = wrapPrompt(
      body,
      REVIEWERS[0],
      ['src/main/a.ts'],
      '/tmp/devkit-review-assets',
      'checklist artifact missing',
    );
    expect(p).toContain('CHECKLIST-CONTRACT RETRY');
    expect(p).toContain('prior attempt did not satisfy the brief-owned workflow');
    expect(p).not.toContain('check-item <name>');
  });
  it('escalation embeds the first-pass transcript and keeps the wrapped brief', () => {
    const wrapped = wrapPrompt(body, REVIEWERS[0], ['src/main/a.ts']);
    const esc = escalatePrompt(wrapped, 'first pass notes\nVERDICT: FAIL — x');
    expect(esc).toContain(wrapped);
    expect(esc).toContain('first pass notes');
    expect(esc).toContain('confirm or overturn');
  });
  it('stripFrontmatter is a no-op without frontmatter', () => {
    expect(stripFrontmatter('no header here')).toBe('no header here');
  });
});

describe('REVIEWERS table ↔ checklist script coupling', () => {
  // verifyChecklist reads reviewer.stateFile while each skill script hardcodes its own
  // CHECKLIST_PATH. A divergence voids every PASS silently (normal) / blocks every ship (strict),
  // so the two constants are pinned to each other here.
  it("every checklist-driven reviewer's stateFile equals its checklist script's CHECKLIST_PATH (skill-less reviewers have no script to check)", () => {
    for (const r of REVIEWERS.filter((r) => r.skill)) {
      const script = readFileSync(
        new URL(`../../../skills/${r.skill}/scripts/checklist.mjs`, import.meta.url),
        'utf8',
      );
      const m = script.match(/const CHECKLIST_PATH = '([^']+)'/);
      expect(m, `${r.skill}/scripts/checklist.mjs has no CHECKLIST_PATH`).not.toBeNull();
      expect(m[1], `stateFile mismatch for ${r.name}`).toBe(r.stateFile);
    }
  });
});

describe('cacheKey', () => {
  it('same reviewer + same diff bytes → same key; any change → different key', () => {
    expect(cacheKey('commit-guard', 'diff-a')).toBe(cacheKey('commit-guard', 'diff-a'));
    expect(cacheKey('commit-guard', 'diff-a')).not.toBe(cacheKey('commit-guard', 'diff-b'));
    expect(cacheKey('commit-guard', 'diff-a')).not.toBe(
      cacheKey('api-security-reviewer', 'diff-a'),
    );
    expect(cacheKey('commit-guard', 'diff-a', 'brief-v1')).not.toBe(
      cacheKey('commit-guard', 'diff-a', 'brief-v2'),
    );
  });

  // The gap this closes: identitySalt covers reviewer ASSET bytes and gate config, so a devkit
  // upgrade that changes review-ENGINE semantics (escalation policy, model selection, verdict
  // parsing, lens grouping) leaves every asset byte-identical. Without the version in the key, a
  // PASS earned under the old engine is replayed by the new one. prefix-cache.mts already salts
  // its key this way; this reviewer key did not.
  it('same assets + same diff but a different devkit version → different key', () => {
    expect(cacheKey('commit-guard', 'diff-a', 'brief-v1', '0.47.1')).not.toBe(
      cacheKey('commit-guard', 'diff-a', 'brief-v1', '0.47.2'),
    );
  });

  it('the version salt is injectable and otherwise defaults to the running package version', () => {
    expect(cacheKey('commit-guard', 'diff-a', '', devkitVersion())).toBe(
      cacheKey('commit-guard', 'diff-a'),
    );
  });

  // A guard on the salt SEPARATOR, not on hashing: concatenating the parts without the NUL
  // delimiter lets a boundary shift between identity and version produce one shared key.
  it('identity/version boundary shifts do not collide', () => {
    expect(cacheKey('commit-guard', 'diff-a', 'a', 'bc')).not.toBe(
      cacheKey('commit-guard', 'diff-a', 'ab', 'c'),
    );
  });
});

describe('countLines', () => {
  it.each([
    ['a\nb\nc\n', 3, 'trailing newline terminates the last line'],
    ['a\nb\nc', 3, 'an unterminated last line still counts — wc -l would say 2'],
    ['', 0, 'empty content has no lines — wc -l agrees'],
    ['\n', 1, 'a lone newline is one line, not two'],
    ['a\r\nb\r\n', 2, 'CRLF counts the same as LF'],
    ['a\rb\rc\r', 3, 'a lone CR separates lines too'],
  ])('%s -> %i (%s)', (content, expected) => {
    expect(countLines(content)).toBe(expected);
  });

  it('equals wc -l for newline-terminated content, the shape every tracked file has', () => {
    const file = 'gate-engine/review/evidence/line-counts.mts';
    const wc = Number(execSync(`wc -l < ${file}`, { encoding: 'utf8' }).trim());
    expect(countLines(readFileSync(file, 'utf8'))).toBe(wc);
  });
});
