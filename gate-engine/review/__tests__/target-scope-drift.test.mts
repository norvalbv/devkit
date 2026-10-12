import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadScopedTargets, matchScope } from '../../decisions/check-alignment.mts';
import {
  normalizeCitedPath,
  renderFindingsBlockForParts,
  type ScopeDriftDeps,
  scopeDriftFindings,
  scopeDriftHint,
} from '../evidence/findings.mts';
import type { ReviewItem, ReviewOutcome } from '../runtime.mts';

const SLUG = 'blocking-gates-narrate-attribution-never-depend-on-it';
const PRE_PUSH = 'cli/lib/husky/pre-push-validation.sh';
const CAPTURE = 'cli/lib/ship/commit-with-gate-capture.sh';
const CWD = '/repo';
const REAL = new Set([PRE_PUSH, CAPTURE, 'cli/lib/ship/reship.sh'].map((p) => join(CWD, p)));

const item = (issues: string[], over: Partial<ReviewItem> = {}): ReviewItem => ({
  lens: 'gate-narration',
  status: 'fail',
  issues,
  ...over,
});

// Shaped on the real finding that enforced this Target outside its Scope.
const cite = (...locs: string[]) =>
  `TARGET: ${SLUG} — "the narration can never change the verdict" — attribution at ${locs.join(' and ')} is forgeable`;

function deps(over: Partial<ScopeDriftDeps> = {}) {
  const emit = vi.fn();
  const loadTargets = vi.fn(() => [{ slug: SLUG, scopeGlobs: [PRE_PUSH] }]);
  return {
    emit,
    loadTargets,
    d: { cwd: CWD, exists: (p: string) => REAL.has(p), emit, loadTargets, ...over },
  };
}

describe('normalizeCitedPath', () => {
  const exists = (p: string) => REAL.has(p);
  it('keeps a repo-relative path that exists, and strips ./', () => {
    expect(normalizeCitedPath(CAPTURE, CWD, exists)).toBe(CAPTURE);
    expect(normalizeCitedPath(`./${CAPTURE}`, CWD, exists)).toBe(CAPTURE);
  });
  it('relativises an absolute path inside cwd', () => {
    expect(normalizeCitedPath(join(CWD, CAPTURE), CWD, exists)).toBe(CAPTURE);
  });
  it('is null for a basename, a missing file, or a path outside cwd', () => {
    expect(normalizeCitedPath('commit-with-gate-capture.sh', CWD, exists)).toBeNull();
    expect(normalizeCitedPath('cli/lib/ship/nope.sh', CWD, exists)).toBeNull();
    expect(normalizeCitedPath(`/tmp/wt/${CAPTURE}`, CWD, exists)).toBeNull();
  });
});

describe('scopeDriftHint', () => {
  it('hints an out-of-Scope citation with a prefilled rescope that keeps the existing globs', () => {
    const { d, emit } = deps();
    const out = scopeDriftHint('backend-performance-reviewer', [item([cite(`${CAPTURE}:475`)])], d);
    expect(out).toContain(
      `Target ${SLUG} was enforced outside its Scope (${PRE_PUSH}) on ${CAPTURE}`,
    );
    expect(out).toContain(`--scope "${PRE_PUSH},${CAPTURE}"`);
    expect(out).toContain('if not, the finding applies a ruling outside its Scope');
    expect(emit).toHaveBeenCalledExactlyOnceWith({
      type: 'decision_scope_drift',
      reviewer: 'backend-performance-reviewer',
      slug: SLUG,
      path: CAPTURE,
    });
  });

  it('judges each cited path on its own: the in-Scope precedent stays silent', () => {
    const { d } = deps();
    const out = scopeDriftHint('r', [item([cite(`${PRE_PUSH}:40`, `${CAPTURE}:475`)])], d);
    expect(out.split('\n')).toHaveLength(1);
    expect(out).toContain(` on ${CAPTURE}.`);
  });

  it('folds a repeated (slug, path) into one hint and one event', () => {
    const { d, emit } = deps();
    const out = scopeDriftHint(
      'r',
      [item([cite(`${CAPTURE}:10`)]), item([cite(`${CAPTURE}:90`)])],
      d,
    );
    expect(out.split('\n')).toHaveLength(1);
    expect(emit).toHaveBeenCalledOnce();
  });

  it('stays silent for in-Scope, unresolvable or unknown-slug citations', () => {
    const { d, emit } = deps();
    expect(scopeDriftHint('r', [item([cite(`${PRE_PUSH}:40`)])], d)).toBe('');
    expect(scopeDriftHint('r', [item([cite('commit-with-gate-capture.sh:475')])], d)).toBe('');
    expect(scopeDriftHint('r', [item([`TARGET: some-other-axis at ${CAPTURE}:1`])], d)).toBe('');
    expect(emit).not.toHaveBeenCalled();
  });

  it('never loads Targets without a blocking TARGET: citation', () => {
    const { d, loadTargets } = deps();
    expect(scopeDriftHint('r', [item([`plain finding at ${CAPTURE}:1`])], d)).toBe('');
    for (const disposition of ['waived', 'dropped_out_of_charter'] as const)
      expect(scopeDriftHint('r', [item([cite(`${CAPTURE}:1`)], { disposition })], d)).toBe('');
    expect(scopeDriftHint('r', [item([cite(`${CAPTURE}:1`)], { status: 'pass' })], d)).toBe('');
    expect(loadTargets).not.toHaveBeenCalled();
  });

  it('fails open when the Targets cannot load', () => {
    const { d } = deps({
      loadTargets: () => {
        throw new Error('unreadable decisions dir');
      },
    });
    expect(scopeDriftHint('r', [item([cite(`${CAPTURE}:1`)])], d)).toBe('');
  });
});

describe('renderFindingsBlockForParts with scope drift', () => {
  it('appends the hint after the findings lines', () => {
    const { d } = deps();
    const res: ReviewOutcome = {
      name: 'r',
      status: 'fail',
      reason: 'r',
      escalated: false,
      items: [item([cite(`${CAPTURE}:475`)])],
    };
    const lines = renderFindingsBlockForParts('r', [res], () => null, d).split('\n');
    expect(lines[0]).toBe('r: 1 finding(s):');
    expect(lines[1]).toContain('• gate-narration');
    expect(lines[2]).toContain(`↳ Target ${SLUG} was enforced outside its Scope`);
  });

  // Catches broken production wiring: every other test injects the loader, fs probe and emitter.
  it('uses the real decisions dir and gate-event sink by default, without issue text', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scope-drift-'));
    const sink = join(dir, 'gate-events.jsonl');
    vi.stubEnv('DEVKIT_GATE_EVENTS', sink);
    try {
      const res: ReviewOutcome = {
        name: 'backend-performance-reviewer',
        status: 'fail',
        reason: 'r',
        escalated: false,
        items: [item([cite('cli/lib/ship/reship.sh:10')])],
      };
      const block = renderFindingsBlockForParts(res.name, [res], () => null);
      expect(block).toContain(`on cli/lib/ship/reship.sh. If it governs this file`);
      const events = readFileSync(sink, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'decision_scope_drift',
        reviewer: 'backend-performance-reviewer',
        slug: SLUG,
        path: 'cli/lib/ship/reship.sh',
      });
      expect(JSON.stringify(events[0])).not.toContain('forgeable');
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the recorded Scope of this Target', () => {
  it('covers the narration sites reviewers enforce it on, and still pre-push', () => {
    const target = loadScopedTargets(join(import.meta.dirname, '../../../docs/decisions')).find(
      (t) => t.slug === SLUG,
    );
    if (!target) throw new Error(`${SLUG} has no effective Scope`);
    for (const f of [PRE_PUSH, CAPTURE, 'cli/lib/ship/digest/gate-digest.mts'])
      expect(matchScope([f], target.scopeGlobs)).toBe(true);
    const items = [item([cite(`${CAPTURE}:475`)])];
    expect(scopeDriftFindings(items, [target], CWD, (p) => REAL.has(p))).toEqual([]);
  });
});
