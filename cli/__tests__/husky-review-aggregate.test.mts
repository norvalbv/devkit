import { afterEach, describe, expect, it } from 'vitest';
import { cleanupHomes, hasDash, runHook } from './_husky-hook-harness.mts';

// Consumer PR #108: a guard-comments block hid guard-decisions and the whole reviewer fleet from
// `devkit review`. Review now runs every selected gate and blocks once, naming each failure.
// Since sc-2753 the comment budget runs inside guard-deterministic, so its block is DET_RC here.

afterEach(cleanupHomes);

const BUILDERS = ['package', 'standalone', 'overlay'];
const AI_CHAIN = { biome: false, guards: ['comments', 'decisions', 'review'] };
const WITH_QAVIS = { biome: false, guards: ['comments', 'decisions', 'review', 'qavis-advisory'] };
const review = (extra = {}) => ({
  DEVKIT_RUN_MODE: 'review',
  DEVKIT_REVIEW_GUARDS: 'comments,decisions,review,qavis-advisory',
  ...extra,
});

describe.each(BUILDERS)('%s hook, review mode', (builder) => {
  it('a comment-budget block still runs decisions and the reviewer fleet, then exits 1', () => {
    const r = runHook(review({ DET_RC: '1' }), AI_CHAIN, { builder });
    expect(r.calls).not.toContain('guard-comments');
    expect(r.calls).toContain('guard-decisions detect --gate');
    expect(r.calls).toContain('guard-review --gate');
    expect(r.stdout).toContain('✗ review: failed gates: deterministic-gates (findings above).');
    expect(r.status).toBe(1);
  });

  it('a confirmed decisions finding still runs the reviewer fleet, then exits 1', () => {
    const r = runHook(review({ DEC_RC: '1' }), AI_CHAIN, { builder });
    expect(r.calls).toContain('guard-review --gate');
    expect(r.stdout).toContain('failed gates: guard-decisions');
    expect(r.status).toBe(1);
  });

  it('the summary names every failed gate in run order', () => {
    const r = runHook(review({ DET_RC: '1', DEC_RC: '1', REVIEW_RC: '1' }), AI_CHAIN, {
      builder,
    });
    expect(r.stdout).toContain('failed gates: deterministic-gates guard-decisions guard-review');
    expect(r.status).toBe(1);
  });

  it('a reviewer finding is deferred past the qavis advisory', () => {
    const r = runHook(review({ REVIEW_RC: '1' }), WITH_QAVIS, { builder });
    expect(r.calls).toContain('guard-qavis-advisory');
    expect(r.status).toBe(1);
  });

  it.each(['3', '4'])('a decisions exit %s (outage / unreadable) still stops the run', (rc) => {
    const r = runHook(review({ DEC_RC: rc }), AI_CHAIN, { builder });
    expect(r.calls).toContain('guard-decisions');
    expect(r.calls).not.toContain('guard-review');
    expect(r.status).toBe(1);
  });

  it('a qavis strict block (3) still exits at once', () => {
    const r = runHook(review({ QAVIS_RC: '3' }), WITH_QAVIS, { builder });
    expect(r.status).toBe(1);
  });

  it('an AI-only selection still blocks on a remembered reviewer finding', () => {
    const r = runHook(
      review({ REVIEW_RC: '1' }),
      { biome: false, guards: ['review'] },
      { builder },
    );
    expect(r.calls).toContain('guard-review --gate');
    expect(r.status).toBe(1);
  });

  it('an AI-only selection ignores an inherited failure flag', () => {
    const r = runHook(
      review({ dk_review_failed: '1' }),
      { biome: false, guards: ['review'] },
      {
        builder,
      },
    );
    expect(r.status).toBe(0);
  });

  it('a monorepo package keeps the remembered AI failure inside its subshell', () => {
    const r = runHook(
      review({ REVIEW_RC: '1' }),
      { biome: false, guards: ['review'] },
      {
        builder,
        pkgRel: 'pkg/a',
      },
    );
    expect(r.calls).toContain('guard-review --gate');
    expect(r.status).toBe(1);
  });
});

describe.each(['standalone', 'overlay'])('%s hook, global bins', (builder) => {
  it('a reviewer missing from the installed devkit blocks review, as a missing pinned bin does', () => {
    const r = runHook(review(), AI_CHAIN, { builder, missingBins: ['guard-review'] });
    expect(r.calls).toContain('guard-deterministic');
    expect(r.stdout).toContain('guard-review: unexpected exit 127');
    expect(r.status).toBe(1);
  });
});

describe.each(BUILDERS)('%s hook, commit and dry-gates keep their policy', (builder) => {
  it('a commit stops at the comment-budget block', () => {
    const r = runHook({ DET_RC: '1' }, AI_CHAIN, { builder });
    expect(r.calls).not.toContain('guard-decisions');
    expect(r.calls).not.toContain('guard-review');
    expect(r.status).toBe(1);
  });

  it('dry-gates defers the deterministic comment-budget block to the reviewers', () => {
    const r = runHook(
      { DET_RC: '1', DEVKIT_RUN_MODE: 'dry-gates', DEVKIT_REVIEW_GUARDS: 'comments,review' },
      AI_CHAIN,
      { builder },
    );
    expect(r.calls).toContain('guard-review --gate');
    expect(r.stdout).toContain('✗ dry-gates: failed gates: deterministic-gates');
    expect(r.status).toBe(1);
  });

  it('dry-gates keeps a reviewer finding fail-fast before the qavis advisory', () => {
    const r = runHook(
      {
        REVIEW_RC: '1',
        DEVKIT_RUN_MODE: 'dry-gates',
        DEVKIT_REVIEW_GUARDS: 'review,qavis-advisory',
      },
      WITH_QAVIS,
      { builder },
    );
    expect(r.calls).toContain('guard-review --gate');
    expect(r.calls).not.toContain('guard-qavis-advisory');
    expect(r.status).toBe(1);
  });
});

describe.skipIf(!hasDash)('dash', () => {
  it.each(BUILDERS)('%s review aggregation holds under dash', (builder) => {
    const r = runHook(review({ DET_RC: '1', DEC_RC: '1' }), AI_CHAIN, {
      builder,
      shell: 'dash',
    });
    expect(r.calls).toContain('guard-review --gate');
    expect(r.stdout).toContain('failed gates: deterministic-gates guard-decisions');
    expect(r.status).toBe(1);
  });
});
