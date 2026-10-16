import { afterEach, describe, expect, it } from 'vitest';
import { cleanupHomes, runHook } from './_husky-hook-harness.mts';

// A commit or ship runs every cheap gate before it stops, so one attempt reports a deterministic
// failure and a fallow or overlay finding together, and still never reaches a paid AI guard.

afterEach(cleanupHomes);

const SEL = { biome: false, guards: ['comments', 'decisions', 'review'], fallow: true };
const AI_CALLS = ['guard-decisions', 'guard-review'];
const FLUSH = '✗ commit blocked before the AI gates:';

describe('commit/ship flush the cheap gates once, before the AI guards', () => {
  for (const mode of ['', 'ship']) {
    it.each([
      ['package', {}],
      ['standalone', {}],
      ['overlay', {}],
      ['package', { pkgRel: 'pkg/a' }],
      ['overlay', { pkgRel: 'pkg/a' }],
    ])(
      `%s %o: a deterministic and a fallow failure both report (mode=${mode || 'commit'})`,
      (builder, opts) => {
        const r = runHook({ DET_RC: '1', FALLOW_RC: '1', DEVKIT_RUN_MODE: mode }, SEL, {
          builder,
          fallow: true,
          staged: true,
          ...opts,
        });
        expect(r.status).toBe(1);
        expect(r.calls).toContain('guard-deterministic');
        expect(r.calls).toContain('fallow audit --diff-stdin');
        for (const ai of AI_CALLS) expect(r.calls).not.toContain(ai);
        expect(r.stdout).toContain(`${FLUSH} deterministic-gates fallow (findings above)`);
      },
    );
  }

  it('an overlay eslint failure after a deterministic one is one flush, not two attempts', () => {
    const r = runHook({ DET_RC: '1', ESLINT_RC: '1' }, SEL, {
      builder: 'overlay',
      staged: true,
      eslintOverlay: true,
    });
    expect(r.status).toBe(1);
    expect(r.calls).toContain('eslint');
    for (const ai of AI_CALLS) expect(r.calls).not.toContain(ai);
    expect(r.stdout).toContain(`${FLUSH} deterministic-gates eslint-overlay (findings above)`);
  });

  it('a green cheap set prints no flush line and reaches the AI guards', () => {
    const r = runHook({}, SEL, { fallow: true, staged: true });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain(FLUSH);
    for (const ai of AI_CALLS) expect(r.calls).toContain(ai);
  });

  it('dry-gates keeps deferring past the flush to the finalizer', () => {
    const r = runHook(
      {
        DET_RC: '1',
        FALLOW_RC: '1',
        DEVKIT_RUN_MODE: 'dry-gates',
        DEVKIT_REVIEW_GUARDS: 'comments',
      },
      SEL,
      { fallow: true, staged: true },
    );
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain(FLUSH);
    expect(r.stdout).toContain('✗ dry-gates: failed gates: deterministic-gates fallow');
  });
});
