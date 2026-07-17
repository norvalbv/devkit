import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveGuardConfig } from '../../config.mts';
import {
  allowedToolsFor,
  cacheKey,
  escalatePrompt,
  parseConventionFindings,
  parseReviewVerdict,
  REVIEWERS,
  rootsFor,
  selectReviewers,
  stripFrontmatter,
  verifyChecklist,
  wrapConventionsPrompt,
  wrapPrompt,
} from '../reviewers.mts';

// A frink-shaped review config without touching disk: defaults + explicit roots.
const cfg = {
  ...resolveGuardConfig('/nonexistent-cwd-defaults-only'),
  scanRoots: ['src', 'server'],
  review: {
    backendRoots: ['src/main', 'server'],
    frontendRoots: ['src/renderer', 'src/preload'],
    trustBoundaries: '',
    shortcutTracking: false,
    accessibility: { skipTouchTargets: false },
    agentsDir: '.claude/agents',
  },
};

const names = (sel) => sel.map((s) => s.reviewer.name);

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
  it('empty frontendRoots → frontend reviewers never selected', () => {
    const noFe = { ...cfg, review: { ...cfg.review, frontendRoots: [] } };
    expect(names(selectReviewers(['src/renderer/App.tsx', 'src/main/a.ts'], noFe))).toEqual([
      'api-security-reviewer',
      'backend-performance-reviewer',
      'commit-guard',
      'correctness-reviewer', // domain 'all' still sees both files under scanRoot src
      'conventions-reviewer', // domain 'conventions' shares that same union
    ]);
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
  it('is pinned single-pass to sonnet (bench: recall 0.76→0.92 vs haiku; the opus cascade subtracts recall — see run-review.mts)', () => {
    expect(corr.model).toBe('sonnet');
    // correctness (sonnet) and conventions are the two deliberately model-pinned exceptions;
    // domain reviewers stay unpinned so they keep the haiku→opus cascade.
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
        'Bash(node .claude/skills/api-security/scripts/checklist.mjs:*)',
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
  it('a skill-less reviewer (conventions) gets EXACTLY Read,Grep,Glob — no Bash at all, per its AC', () => {
    const conv = REVIEWERS.find((r) => r.name === 'conventions-reviewer');
    expect(allowedToolsFor(conv, cfg)).toBe('Read,Grep,Glob');
  });
});

describe('conventions-reviewer (domain conventions, skill-less)', () => {
  const conv = REVIEWERS.find((r) => r.name === 'conventions-reviewer');
  it('has no skill/stateFile/cmds — the checklist workflow is architecturally unavailable to it', () => {
    expect(conv.skill).toBeUndefined();
    expect(conv.stateFile).toBeUndefined();
    expect(conv.cmds).toBeUndefined();
  });
  it('is pinned single-pass to haiku, same mechanism as correctness', () => {
    expect(conv.model).toBe('haiku');
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
      { offendingPath: 'src/a.ts', offendingLine: 12 },
    ]);
  });
  it('multiple violations produce multiple distinct lenses', () => {
    const transcript =
      'OFFENDING: x — src/a.ts:1\nOFFENDING: y — src/b.ts:2\nVERDICT: FAIL — two violations';
    expect(parseConventionFindings(transcript)).toEqual([
      { offendingPath: 'src/a.ts', offendingLine: 1 },
      { offendingPath: 'src/b.ts', offendingLine: 2 },
    ]);
  });
  it('no OFFENDING blocks → empty (a PASS transcript has none to key on)', () => {
    expect(parseConventionFindings('NO_VIOLATIONS\nVERDICT: PASS')).toEqual([]);
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
});

describe('wrapPrompt / escalatePrompt / stripFrontmatter', () => {
  const body = '---\nname: api-security-reviewer\nmodel: opus\n---\nCheck auth on every route.';
  it('wraps the brief with the gate preamble, checklist mandate and pinned verdict format, frontmatter stripped', () => {
    const p = wrapPrompt(body, REVIEWERS[0], ['src/main/a.ts']);
    expect(p).toContain('HEADLESS COMMIT GATE');
    expect(p).toContain('Check auth on every route.');
    expect(p).not.toContain('model: opus');
    expect(p).toContain('VERDICT: PASS | FAIL');
    expect(p).toContain('src/main/a.ts');
    // the checklist workflow is mandated with the reviewer's own script + command names —
    // but cleanup is FORBIDDEN (the gate must find the artifact to verify it)
    expect(p).toContain('node .claude/skills/api-security/scripts/checklist.mjs generate');
    expect(p).toContain('check-item');
    expect(p).toContain('finalize');
    expect(p).toContain('Do NOT run the `cleanup` step');
  });
  it("commit-guard's wrapper mandates its per-file commands (init / check-file)", () => {
    const guard = REVIEWERS.find((r) => r.name === 'commit-guard');
    const p = wrapPrompt('brief', guard, ['src/a.ts']);
    expect(p).toContain('node .claude/skills/commit-guard/scripts/checklist.mjs init');
    expect(p).toContain('check-file');
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
  });
});
