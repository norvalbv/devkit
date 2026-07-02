import { describe, expect, it } from 'vitest';
import { resolveGuardConfig } from '../../config.mjs';
import {
  allowedToolsFor,
  cacheKey,
  escalatePrompt,
  parseReviewVerdict,
  REVIEWERS,
  selectReviewers,
  stripFrontmatter,
  wrapPrompt,
} from '../reviewers.mjs';

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

describe('selectReviewers', () => {
  it('backend-only staged → backend pair + commit-guard', () => {
    expect(names(selectReviewers(['src/main/db.ts'], cfg))).toEqual([
      'api-security-reviewer',
      'backend-performance-reviewer',
      'commit-guard',
    ]);
  });
  it('frontend-only staged → frontend pair + commit-guard', () => {
    expect(names(selectReviewers(['src/renderer/App.tsx'], cfg))).toEqual([
      'frontend-security-reviewer',
      'frontend-performance-reviewer',
      'commit-guard',
    ]);
  });
  it('mixed staged → all five', () => {
    expect(names(selectReviewers(['src/main/a.ts', 'src/preload/b.ts'], cfg))).toEqual(
      REVIEWERS.map((r) => r.name),
    );
  });
  it('docs-only staged → nothing runs', () => {
    expect(selectReviewers(['docs/readme.md', 'CLAUDE.md'], cfg)).toEqual([]);
  });
  it('empty frontendRoots → frontend reviewers never selected', () => {
    const noFe = { ...cfg, review: { ...cfg.review, frontendRoots: [] } };
    expect(names(selectReviewers(['src/renderer/App.tsx', 'src/main/a.ts'], noFe))).toEqual([
      'api-security-reviewer',
      'backend-performance-reviewer',
      'commit-guard',
    ]);
  });
  it('commit-guard sees only SOURCE files under scanRoots (a staged JSON is not its business)', () => {
    const sel = selectReviewers(['src/config.json', 'src/main/a.ts'], cfg);
    const guard = sel.find((s) => s.reviewer.name === 'commit-guard');
    expect(guard.files).toEqual(['src/main/a.ts']);
  });
  it('root matching is prefix-per-segment — src/mainframe is NOT under src/main', () => {
    const sel = selectReviewers(['src/mainframe/x.ts'], cfg);
    expect(names(sel)).toEqual(['commit-guard']); // under scanRoot src, not backendRoot src/main
  });
});

describe('allowedToolsFor', () => {
  it('domain reviewers get the read-only base — no naked Bash, no write tools', () => {
    const tools = allowedToolsFor(REVIEWERS[0], cfg);
    expect(tools).toBe('Read,Grep,Glob,Bash(git diff:*),Bash(git log:*),Bash(git status:*)');
    expect(tools).not.toMatch(/(^|,)Bash(,|$)/); // never an unscoped Bash
    expect(tools).not.toMatch(/Write|Edit/);
  });
  it('commit-guard additionally gets the configured semantic search tool', () => {
    const guard = REVIEWERS.find((r) => r.name === 'commit-guard');
    expect(allowedToolsFor(guard, cfg)).toContain(',mcp__codebase__searchCode');
  });
});

describe('wrapPrompt / escalatePrompt / stripFrontmatter', () => {
  const body = '---\nname: api-security-reviewer\nmodel: opus\n---\nCheck auth on every route.';
  it('wraps the brief with the gate preamble and the pinned verdict format, frontmatter stripped', () => {
    const p = wrapPrompt(body, REVIEWERS[0], ['src/main/a.ts']);
    expect(p).toContain('HEADLESS COMMIT GATE');
    expect(p).toContain('Check auth on every route.');
    expect(p).not.toContain('model: opus');
    expect(p).toContain('VERDICT: PASS | FAIL');
    expect(p).toContain('src/main/a.ts');
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

describe('cacheKey', () => {
  it('same reviewer + same diff bytes → same key; any change → different key', () => {
    expect(cacheKey('commit-guard', 'diff-a')).toBe(cacheKey('commit-guard', 'diff-a'));
    expect(cacheKey('commit-guard', 'diff-a')).not.toBe(cacheKey('commit-guard', 'diff-b'));
    expect(cacheKey('commit-guard', 'diff-a')).not.toBe(
      cacheKey('api-security-reviewer', 'diff-a'),
    );
  });
});
