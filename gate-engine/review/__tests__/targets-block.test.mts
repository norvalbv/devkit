/**
 * evidence/targets-block.mts — the shared governing-Targets prompt block (sc-1440). The
 * extraction contract: completeness's bytes are IDENTICAL to its pre-extraction renderer, the
 * reviewer framing swaps only the words around the rulings, and the size cap drops whole rulings
 * NAMED — silent truncation would read as "no other Targets govern".
 */
import { describe, expect, it } from 'vitest';
import {
  COMPLETENESS_TARGETS_FRAMING,
  REVIEWER_TARGETS_FRAMING,
  renderTargets,
  type TargetBlock,
} from '../evidence/targets-block.mts';

const block = (slug: string, ruling = 'Ruling text.'): TargetBlock => ({
  slug,
  ruling,
  scope: 'gate-engine/**',
  via: 'scope-match',
});

describe('renderTargets — shared governing-Targets block', () => {
  it('default framing reproduces completeness.mts pre-extraction bytes exactly', () => {
    // The literal output of the original completeness renderer for this input — pinned so the
    // extraction can never drift the bytes the completeness judge reads.
    expect(renderTargets([block('a-slug')])).toBe(
      '## RELEVANT RECORDED TARGETS (authoritative — a recorded decision is NOT a completeness gap)\n' +
        '\n' +
        '### a-slug · scope: `gate-engine/**` _(scope-match)_\n' +
        'Ruling text.\n' +
        '',
    );
    expect(renderTargets([])).toBe(
      '## RELEVANT RECORDED TARGETS — SKIP\n' +
        'No governing Target found (index unreachable, or none match). Do not claim ' +
        'decision-alignment you did not check; a recorded decision is not a completeness gap.',
    );
  });

  it('the reviewer framing swaps only the words around the rulings', () => {
    const out = renderTargets([block('a-slug')], REVIEWER_TARGETS_FRAMING);
    expect(out).toContain("## RECORDED TARGETS (authoritative — what this product's");
    expect(out).toContain('### a-slug · scope: `gate-engine/**` _(scope-match)_');
    expect(out).toContain('Ruling text.');
    expect(renderTargets([], REVIEWER_TARGETS_FRAMING)).toContain('Review on the checklist alone');
  });

  it('the cap drops whole rulings from the end and NAMES every omission', () => {
    const big = block('huge-ruling', 'x'.repeat(10_000));
    const small = block('small-ruling');
    const out = renderTargets([small, big], COMPLETENESS_TARGETS_FRAMING, 2_000);
    expect(out).toContain('small-ruling');
    expect(out).not.toContain('x'.repeat(100));
    expect(out).toContain('OMITTED: 1 further governing Target(s) over the size cap — huge-ruling');
  });

  it('under-cap input is byte-identical to uncapped output', () => {
    const blocks = [block('a'), block('b')];
    expect(renderTargets(blocks, COMPLETENESS_TARGETS_FRAMING, 8_192)).toBe(renderTargets(blocks));
  });

  // sc-1474: the cap guards argv BYTES. Em-dash-dense rulings (the norm in this repo) are ~3 bytes
  // per visible char; measuring string.length let them blow the documented cap with no OMITTED note.
  it('the cap measures UTF-8 bytes, not UTF-16 chars (sc-1474)', () => {
    // 1000 em-dashes = 1000 chars but 3000 UTF-8 bytes: under a 2600 cap by CHAR count (plus the
    // ~150-char section overhead), over it by BYTE count. The pre-fix char measure kept it.
    const emHeavy = block('em-heavy', '—'.repeat(1_000));
    const out = renderTargets([emHeavy], COMPLETENESS_TARGETS_FRAMING, 2_600);
    expect(out).toContain('OMITTED: 1 further governing Target(s) over the size cap — em-heavy');
    expect(out).not.toContain('———');
    // The equivalent ASCII ruling (same char count, 1 byte each) stays comfortably under the cap.
    const ascii = block('ascii-ruling', 'x'.repeat(1_000));
    expect(renderTargets([ascii], COMPLETENESS_TARGETS_FRAMING, 2_600)).toContain(
      'x'.repeat(1_000),
    );
  });
});
