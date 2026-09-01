import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AxisDoc,
  checkAxis,
  checkDuplicateFieldText,
  checkFrontmatterCreated,
  checkFrontmatterSlug,
  checkH1Slug,
  checkIndexStale,
  integrityFindingKey,
  checkRetargetEvidenceChange,
  checkTargetHeadingDepth,
  checkTargetRequiredFields,
} from '../integrity/checks.mts';
import { currentTarget, parseTargetFields } from '../decision-format.mts';
import { MUTATIONS } from '../integrity/perturb.mts';
import { runIntegrity, scanCorpus } from '../integrity/scan.mts';

// A single well-formed Target block — every check must clear this as-is. Mirrors what
// `guard-decisions add --target` itself would render (decision-format.mts's renderTarget).
function cleanBody(slug: string, opts: { extra?: string } = {}) {
  return (
    `\n# ${slug}\n\n` +
    `## Target · 2026-01-05 — a clean ruling\n\n` +
    `**Context:** a forcing failure that made the status quo untenable.\n` +
    `**Ruling:** the mechanism actually chosen, spelled out in full.\n` +
    `**Consequences:**\n` +
    `- Positive: the value this protects, described concretely.\n` +
    `- Negative: the cost knowingly paid, described concretely.\n` +
    `**Vision-fit:** n/a — internal tooling.\n` +
    `**Source:** manual\n${opts.extra ?? ''}`
  );
}

function cleanAxis(slug: string, opts: { extra?: string } = {}): AxisDoc {
  return { slug, fm: { slug, created: '2026-01-01' }, body: cleanBody(slug, opts) };
}

/** A two-block re-targeted axis — the only shape checkRetargetEvidenceChange's positive case, and
 * the retarget-missing-evidence-change mutation, need. `secondBlockExtra` is where a test supplies
 * (or omits) the second block's `**Evidence-change:**` line. */
function retargetedAxis(secondBlockExtra: string): AxisDoc {
  return {
    slug: 'my-axis',
    fm: { slug: 'my-axis', created: '2026-01-01' },
    body:
      cleanBody('my-axis') +
      `\n## Target · 2026-02-01 — a re-targeted ruling\n\n` +
      `**Context:** the evidence that shifted.\n**Ruling:** the new mechanism.\n**Consequences:**\n` +
      `- Positive: new value.\n- Negative: new cost.\n**Vision-fit:** n/a\n**Source:** manual\n${secondBlockExtra}`,
  };
}

describe('checkFrontmatterSlug', () => {
  it('is silent when frontmatter slug matches the filename', () => {
    expect(checkFrontmatterSlug(cleanAxis('my-axis'))).toEqual([]);
  });

  it('fires when frontmatter slug diverges from the filename — break and restore', () => {
    const clean = cleanAxis('my-axis');
    expect(checkFrontmatterSlug(clean)).toEqual([]); // restored state: clean

    const broken: AxisDoc = { ...clean, fm: { ...clean.fm, slug: 'a-different-slug' } };
    const findings = checkFrontmatterSlug(broken);
    expect(findings).toHaveLength(1);
    expect(findings[0].check).toBe('frontmatter-slug-mismatch');
    expect(findings[0].detail).toContain('a-different-slug');

    // restore: the original object is untouched (pure function, no mutation in place)
    expect(checkFrontmatterSlug(clean)).toEqual([]);
  });
});

describe('checkFrontmatterCreated', () => {
  it('is silent when created predates the first Target', () => {
    expect(checkFrontmatterCreated(cleanAxis('my-axis'))).toEqual([]);
  });

  it('is silent when a legacy (pre-Target) axis has no Target block at all', () => {
    const legacy: AxisDoc = {
      slug: 'legacy',
      fm: { slug: 'legacy', created: '2026-06-01' },
      body: '\n# legacy\n\n## 2026-01-01 — an old ruling\n\n**Ruling:** something.\n',
    };
    expect(checkFrontmatterCreated(legacy)).toEqual([]);
  });

  it('fires when created postdates the first Target', () => {
    const broken: AxisDoc = {
      slug: 'my-axis',
      fm: { slug: 'my-axis', created: '2026-01-06' }, // one day AFTER the Target's 2026-01-05
      body: cleanBody('my-axis'),
    };
    const findings = checkFrontmatterCreated(broken);
    expect(findings).toHaveLength(1);
    expect(findings[0].check).toBe('frontmatter-created-after-target');
  });
});

describe('checkH1Slug', () => {
  it('is silent when the H1 matches the filename', () => {
    expect(checkH1Slug(cleanAxis('my-axis'))).toEqual([]);
  });

  it('fires when the H1 diverges from the filename', () => {
    const broken: AxisDoc = {
      slug: 'my-axis',
      fm: { slug: 'my-axis', created: '2026-01-01' },
      body: cleanBody('my-axis').replace('# my-axis', '# some-other-name'),
    };
    const findings = checkH1Slug(broken);
    expect(findings).toHaveLength(1);
    expect(findings[0].check).toBe('h1-slug-mismatch');
  });
});

describe('checkTargetHeadingDepth', () => {
  it('is silent when the Target heading is depth-2', () => {
    expect(checkTargetHeadingDepth(cleanAxis('my-axis'))).toEqual([]);
  });

  it('fires when a Target heading is demoted to depth-3', () => {
    const broken: AxisDoc = {
      ...cleanAxis('my-axis'),
      body: cleanBody('my-axis').replace('## Target · 2026-01-05', '### Target · 2026-01-05'),
    };
    const findings = checkTargetHeadingDepth(broken);
    expect(findings).toHaveLength(1);
    expect(findings[0].check).toBe('target-heading-depth');
    expect(findings[0].detail).toContain('depth 3');
  });

  it('fires when a Target heading is promoted to depth-1', () => {
    const broken: AxisDoc = {
      ...cleanAxis('my-axis'),
      body: cleanBody('my-axis').replace('## Target · 2026-01-05', '# Target · 2026-01-05'),
    };
    expect(checkTargetHeadingDepth(broken)).toHaveLength(1);
  });
});

describe('checkDuplicateFieldText', () => {
  it('is silent on distinct prose fields', () => {
    expect(checkDuplicateFieldText(cleanAxis('my-axis'))).toEqual([]);
  });

  it('does NOT fire on a short duplicated value (e.g. two "n/a" fields) — the false-positive guard', () => {
    const axis: AxisDoc = {
      slug: 'my-axis',
      fm: { slug: 'my-axis', created: '2026-01-01' },
      body: cleanBody('my-axis', { extra: '**Rejected:** n/a\n' }).replace(
        '**Vision-fit:** n/a — internal tooling.',
        '**Vision-fit:** n/a',
      ),
    };
    // Vision-fit and Rejected are both the literal "n/a" — identical, but below MIN_DUP_LEN.
    expect(checkDuplicateFieldText(axis)).toEqual([]);
  });

  it('fires when the Negative bullet is a verbatim copy of the Ruling text', () => {
    const ruling = 'the mechanism actually chosen, spelled out in full.';
    const broken: AxisDoc = {
      ...cleanAxis('my-axis'),
      body: cleanBody('my-axis').replace(
        `- Negative: the cost knowingly paid, described concretely.`,
        `- Negative: ${ruling}`,
      ),
    };
    const findings = checkDuplicateFieldText(broken);
    expect(findings).toHaveLength(1);
    expect(findings[0].check).toBe('duplicate-field-text');
    expect(findings[0].detail).toContain('ruling');
    expect(findings[0].detail).toContain('negative');
  });
});

function formatterIndentedAxis(slug: string): AxisDoc {
  return {
    slug,
    fm: { slug, created: '2026-01-01' },
    body:
      `\n# ${slug}\n\n` +
      `## Target · 2026-01-05 — a ruling a formatter reindented\n\n` +
      `**Context:** a forcing failure that made the status quo untenable.\n` +
      `**Ruling:** the mechanism actually chosen, spelled out in full.\n` +
      `**Consequences:**\n\n` +
      `- Positive: the value this protects, described concretely.\n` +
      `- Negative: the cost knowingly paid, described concretely.\n` +
      `  **Vision-fit:** n/a — internal tooling.\n` +
      `  **Scope:** gate-engine/review/**\n` +
      `  **Source:** manual\n`,
  };
}

describe('indented Target fields (a markdown formatter nested them under the Consequences list)', () => {
  it('recovers every field, so a formatted record parses identically to an unformatted one', () => {
    const target = currentTarget(formatterIndentedAxis('formatted-axis').body);
    expect(Object.keys(target?.fields ?? {})).toEqual([
      'context',
      'ruling',
      'consequences',
      'vision-fit',
      'scope',
      'source',
    ]);
  });

  it('still reads **Scope:**, which is what arms the alignment gate', () => {
    expect(currentTarget(formatterIndentedAxis('formatted-axis').body)?.scope).toBe(
      'gate-engine/review/**',
    );
  });

  it('clears every structural check — a formatted record is not a damaged one', () => {
    const axis = formatterIndentedAxis('formatted-axis');
    const row = { slug: 'formatted-axis', ruling: 'r', why: 'w', updated: '2026-01-05' };
    expect(checkAxis(axis, row)).toEqual([]);
  });

  it('does not read an indented field out of a dated NOTE', () => {
    const axis = retargetedAxis(
      '- 2026-02-02 — a convergence note whose continuation was reflowed.\n' +
        '  **Evidence-change:** this text belongs to the NOTE, not to the Target.\n',
    );
    const findings = checkRetargetEvidenceChange(axis);
    expect(findings).toHaveLength(1);
    expect(findings[0].check).toBe('retarget-missing-evidence-change');
  });

  it('excludes a note whose date carries a parenthetical ref, not just the bare `date —` shape', () => {
    const axis = retargetedAxis(
      '- 2026-02-02 (sc-2473) — a note whose date is followed by a story ref.\n' +
        '  **Evidence-change:** this text belongs to the NOTE, not to the Target.\n',
    );
    expect(checkRetargetEvidenceChange(axis)).toHaveLength(1);
  });
});

describe('parseTargetFields — the shapes a real checkout actually hands it', () => {
  it('reads a field a formatter indented with two spaces', () => {
    expect(parseTargetFields('  **Scope:** src/a/**')).toEqual({ scope: 'src/a/**' });
  });

  it('reads a field indented four spaces or with a tab', () => {
    // Formatters disagree: prettier emits two spaces, a `useTabs` config emits a tab, and a
    // four-space list-content indent is ordinary CommonMark. All three are the same intent.
    expect(parseTargetFields('    **Scope:** src/a/**')).toEqual({ scope: 'src/a/**' });
    expect(parseTargetFields('\t**Scope:** src/a/**')).toEqual({ scope: 'src/a/**' });
  });

  it('reads a field line that ends in CRLF', () => {
    // A Windows clone with git's default core.autocrlf=true has CRLF in the working tree, and this
    // repo ships no .gitattributes to normalise it. The value must not depend on the line ending.
    expect(parseTargetFields('**Scope:** src/a/**\r')).toEqual({ scope: 'src/a/**' });
    expect(parseTargetFields('  **Scope:** src/a/**\r')).toEqual({ scope: 'src/a/**' });
  });

  it('keeps a field with an empty value DISTINCT from an absent one', () => {
    // `''` and `undefined` are read differently downstream: every check tests `?.trim()`, so an
    // empty value fires and an absent key is a missing field. Collapsing them would hide one.
    expect(parseTargetFields('**Scope:**')).toEqual({ scope: '' });
    expect(parseTargetFields('  **Scope:**   \r')).toEqual({ scope: '' });
  });
});

describe('a CRLF checkout parses identically to an LF one', () => {
  // The whole read path shares one line-splitting convention, so a line-ending defect is never
  // confined to one field — it takes Scope (the alignment gate's arming) and Ruling with it.
  const crlf = (body: string) => body.replace(/\n/g, '\r\n');

  it('recovers every field, and Scope with them', () => {
    const body = crlf(cleanBody('my-axis', { extra: '**Scope:** src/a/**\n' }));
    const target = currentTarget(body);
    expect(target?.scope).toBe('src/a/**');
    expect(target?.fields['vision-fit']).toBeTruthy();
  });

  it('does not make every Target block look like a damaged one', () => {
    // Without this, the integrity gate fires on every block of every axis on Windows — a gate that
    // blocks every commit is as broken as one that blocks none.
    const axis = cleanAxis('my-axis');
    expect(checkTargetRequiredFields({ ...axis, body: crlf(axis.body) })).toEqual([]);
  });

  it('still reads the Consequences bullets', () => {
    const axis = cleanAxis('my-axis');
    expect(checkAxis({ ...axis, body: crlf(axis.body) }, undefined)).toEqual([]);
  });
});

describe('checkTargetRequiredFields', () => {
  it('is silent on a well-formed axis', () => {
    expect(checkTargetRequiredFields(cleanAxis('my-axis'))).toEqual([]);
  });

  it('fires when a block loses **Vision-fit:** — break and restore', () => {
    const clean = cleanAxis('my-axis');
    expect(checkTargetRequiredFields(clean)).toEqual([]); // restored state: clean

    const broken: AxisDoc = {
      ...clean,
      body: clean.body.replace(/\n\*\*Vision-fit:\*\*[^\n]*/, ''),
    };
    const findings = checkTargetRequiredFields(broken);
    expect(findings).toHaveLength(1);
    expect(findings[0].check).toBe('target-missing-required-field');
    expect(findings[0].detail).toContain('vision-fit');

    expect(checkTargetRequiredFields(clean)).toEqual([]); // original object untouched
  });

  it('fires when a block loses **Source:**', () => {
    const clean = cleanAxis('my-axis');
    const broken: AxisDoc = { ...clean, body: clean.body.replace(/\n\*\*Source:\*\*[^\n]*/, '') };
    expect(checkTargetRequiredFields(broken)[0].detail).toContain('source');
  });

  it('names both fields in one finding when a block loses both', () => {
    const clean = cleanAxis('my-axis');
    const broken: AxisDoc = {
      ...clean,
      body: clean.body.replace(/\n\*\*(Vision-fit|Source):\*\*[^\n]*/g, ''),
    };
    const findings = checkTargetRequiredFields(broken);
    expect(findings).toHaveLength(1);
    expect(findings[0].detail).toContain('vision-fit');
    expect(findings[0].detail).toContain('source');
  });

  it('flags the FIRST Target block — the position retarget-missing-evidence-change exempts', () => {
    // The real corpus case sat at index 0, which is precisely why the existing suite never saw it.
    const axis = retargetedAxis('**Evidence-change:** what shifted.\n');
    const broken: AxisDoc = {
      ...axis,
      body: axis.body.replace(/\n\*\*Vision-fit:\*\*[^\n]*/, ''),
    };
    const findings = checkTargetRequiredFields(broken);
    expect(findings).toHaveLength(1);
    expect(findings[0].block).toBe('2026-01-05');
  });

  it('reports per block, so an allowlist can except one block and not the whole axis', () => {
    const clean = cleanAxis('my-axis');
    const broken: AxisDoc = {
      ...clean,
      body: clean.body.replace(/\n\*\*Vision-fit:\*\*[^\n]*/, ''),
    };
    expect(checkTargetRequiredFields(broken)[0].block).toBe('2026-01-05');
  });

  it('never fires on a legacy `## <date> —` block, which predates both fields', () => {
    const axis: AxisDoc = {
      slug: 'legacy-axis',
      fm: { slug: 'legacy-axis', created: '2025-01-01' },
      body:
        '\n# legacy-axis\n\n## 2025-06-01 — a ruling from the old schema\n\n' +
        'Prose rationale, with no Target fields at all.\n',
    };
    expect(checkTargetRequiredFields(axis)).toEqual([]);
  });

  it('is silent on an axis with no Target block at all', () => {
    const axis: AxisDoc = {
      slug: 'empty-axis',
      fm: { slug: 'empty-axis', created: '2026-01-01' },
      body: '\n# empty-axis\n\nA stub with no ruling yet.\n',
    };
    expect(checkTargetRequiredFields(axis)).toEqual([]);
  });

  it('fires on a whitespace-only value, which reads as present but carries nothing', () => {
    const clean = cleanAxis('my-axis');
    const hollow: AxisDoc = {
      ...clean,
      body: clean.body.replace(/\n\*\*Vision-fit:\*\*[^\n]*/, '\n**Vision-fit:**    '),
    };
    expect(checkTargetRequiredFields(hollow)).toHaveLength(1);
  });

  it('is NOT satisfied by a field the notes carry rather than the ruling', () => {
    // The note guard in its sharpest form. Without it a convergence note whose continuation was
    // reflowed hands the block a Source it does not have, and the check reports the record clean.
    const clean = cleanAxis('my-axis');
    const broken: AxisDoc = {
      ...clean,
      body: `${clean.body.replace(/\n\*\*Source:\*\*[^\n]*/, '')}- 2026-01-06 (sc-1) — a note.\n  **Source:** manual\n`,
    };
    const findings = checkTargetRequiredFields(broken);
    expect(findings).toHaveLength(1);
    expect(findings[0].detail).toContain('source');
  });

  it('reports two same-dated damaged blocks separately rather than collapsing them', () => {
    const clean = cleanAxis('my-axis');
    const oneBlock = clean.body.slice(clean.body.indexOf('## Target'));
    const damaged = oneBlock.replace(/\n\*\*Vision-fit:\*\*[^\n]*/, '');
    const axis: AxisDoc = { ...clean, body: `\n# my-axis\n\n${damaged}\n${damaged}` };
    const findings = checkTargetRequiredFields(axis);
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.block)).toEqual(['2026-01-05', '2026-01-05']);
  });

  it('leaves a misdepth `### Target` heading to its own check instead of double-reporting', () => {
    const clean = cleanAxis('my-axis');
    const axis: AxisDoc = { ...clean, body: clean.body.replace('## Target', '### Target') };
    expect(checkTargetRequiredFields(axis)).toEqual([]);
    expect(checkAxis(axis, undefined).map((f) => f.check)).toEqual(['target-heading-depth']);
  });
});

describe('checkRetargetEvidenceChange', () => {
  it('is silent when the axis has only one Target (never a re-target)', () => {
    expect(checkRetargetEvidenceChange(cleanAxis('my-axis'))).toEqual([]);
  });

  it('is silent when the re-target block carries Evidence-change', () => {
    const axis = retargetedAxis('**Evidence-change:** what shifted.\n');
    expect(checkRetargetEvidenceChange(axis)).toEqual([]);
  });

  it('fires when a re-target block omits Evidence-change', () => {
    const axis = retargetedAxis('');
    const findings = checkRetargetEvidenceChange(axis);
    expect(findings).toHaveLength(1);
    expect(findings[0].check).toBe('retarget-missing-evidence-change');
    expect(findings[0].detail).toContain('2026-02-01');
  });

  it('never flags the FIRST Target block, even without Evidence-change', () => {
    // A brand-new axis's first Target never carries Evidence-change (there is nothing to re-target
    // from), and must never be treated as if it were a re-target missing the field.
    expect(checkRetargetEvidenceChange(cleanAxis('first-only'))).toEqual([]);
  });

  it('reports the offending block date, so an allowlist can except one block and not the whole axis', () => {
    const [finding] = checkRetargetEvidenceChange(retargetedAxis(''));
    expect(finding.block).toBe('2026-02-01');
  });
});

describe('checkIndexStale', () => {
  it("is silent when the INDEX row is at least as new as the axis's last Target", () => {
    const axis = cleanAxis('my-axis');
    expect(
      checkIndexStale(axis, { slug: 'my-axis', ruling: 'r', why: 'w', updated: '2026-01-05' }),
    ).toEqual([]);
    expect(
      checkIndexStale(axis, { slug: 'my-axis', ruling: 'r', why: 'w', updated: '2026-02-01' }),
    ).toEqual([]);
  });

  it("is silent when there is no INDEX row at all (a different, already-known gap — not this check's job)", () => {
    expect(checkIndexStale(cleanAxis('my-axis'), undefined)).toEqual([]);
  });

  it("fires when the INDEX row predates the axis's own last Target", () => {
    const axis = cleanAxis('my-axis');
    const findings = checkIndexStale(axis, {
      slug: 'my-axis',
      ruling: 'r',
      why: 'w',
      updated: '2026-01-04',
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].check).toBe('index-stale');
  });
});

describe('checkAxis (combinator)', () => {
  it('returns no findings for a fully clean single-Target record', () => {
    expect(
      checkAxis(cleanAxis('my-axis'), {
        slug: 'my-axis',
        ruling: 'r',
        why: 'w',
        updated: '2026-01-05',
      }),
    ).toEqual([]);
  });

  it('proves every mutation IN perturb.mts trips exactly the check it names, and nothing else', () => {
    for (const [checkId, mutate] of Object.entries(MUTATIONS)) {
      // Two mutations need a richer fixture than a bare single-Target axis: a re-target to strip
      // Evidence-change from, and a RESOLVED Amends edge to break. Every other one works on the
      // single-Target fixture.
      const amendsAxis = cleanAxis('mutation-target', {
        extra:
          '- 2026-01-06 — the first convergence.\n' +
          '- 2026-01-07 — **Amends:** note:2026-01-06 — that turned out wrong.\n',
      });
      const fixture =
        checkId === 'retarget-missing-evidence-change'
          ? {
              axis: retargetedAxis('**Evidence-change:** what shifted.\n'),
              indexRow: { slug: 'my-axis', ruling: 'r', why: 'w', updated: '2026-02-01' },
            }
          : checkId === 'note-amends-unresolvable'
            ? {
                axis: amendsAxis,
                indexRow: { slug: 'mutation-target', ruling: 'r', why: 'w', updated: '2026-01-07' },
              }
            : {
                axis: cleanAxis('mutation-target'),
                indexRow: { slug: 'mutation-target', ruling: 'r', why: 'w', updated: '2026-01-05' },
              };
      const mutated = mutate(fixture);
      const findings = checkAxis(mutated.axis, mutated.indexRow);
      expect(findings.map((f) => f.check)).toEqual([checkId]);
    }
  });

  // Every fixture above has exactly TWO Target blocks, where "first Evidence-change in the body" and
  // "the last block's Evidence-change" are the same line — which masks a mutation that strips the
  // wrong one. Real multi-retarget axes are not two blocks (this repo's own overlay-self-heal has
  // four, two carrying the field), so the mutation is proven here on the shape that can tell them
  // apart. Without this, perturb.mts could corrupt a MIDDLE block and every test would still pass.
  it('strips the LAST Evidence-change, not the first, on an axis re-targeted more than once', () => {
    const threeBlocks: AxisDoc = {
      slug: 'my-axis',
      fm: { slug: 'my-axis', created: '2026-01-01' },
      body:
        `${retargetedAxis('**Evidence-change:** the FIRST shift.\n').body}` +
        `\n## Target · 2026-03-01 — a third ruling\n\n` +
        `**Context:** more evidence.\n**Ruling:** the newest mechanism.\n**Consequences:**\n` +
        `- Positive: newest value.\n- Negative: newest cost.\n**Vision-fit:** n/a\n` +
        `**Source:** manual\n**Evidence-change:** the LAST shift.\n`,
    };
    const mutated = MUTATIONS['retarget-missing-evidence-change']({
      axis: threeBlocks,
      indexRow: { slug: 'my-axis', ruling: 'r', why: 'w', updated: '2026-03-01' },
    });

    expect(mutated.axis.body).toContain('the FIRST shift.');
    expect(mutated.axis.body).not.toContain('the LAST shift.');
    // …and the check must therefore name the LAST block, not a middle one.
    const findings = checkRetargetEvidenceChange(mutated.axis);
    expect(findings.map((f) => f.block)).toEqual(['2026-03-01']);
  });

  // "Last occurrence of the field" and "the last block's field" coincide only while the fixture is
  // CLEAN. On an already-defective one they diverge, and silently stripping an earlier block would
  // build a two-defect fixture out of a protocol that promises exactly one — so the mutation must
  // refuse instead of quietly doing something other than what it is named for.
  it('refuses a fixture whose LAST block already lacks Evidence-change, rather than corrupting an earlier one', () => {
    const lastBlockAlreadyBare: AxisDoc = {
      slug: 'my-axis',
      fm: { slug: 'my-axis', created: '2026-01-01' },
      body:
        `${retargetedAxis('**Evidence-change:** the only shift.\n').body}` +
        `\n## Target · 2026-03-01 — a third ruling, already missing the field\n\n` +
        `**Context:** more evidence.\n**Ruling:** the newest mechanism.\n**Consequences:**\n` +
        `- Positive: newest value.\n- Negative: newest cost.\n**Vision-fit:** n/a\n**Source:** manual\n`,
    };
    expect(() =>
      MUTATIONS['retarget-missing-evidence-change']({
        axis: lastBlockAlreadyBare,
        indexRow: { slug: 'my-axis', ruling: 'r', why: 'w', updated: '2026-03-01' },
      }),
    ).toThrow(/LAST Target block has no Evidence-change/);
  });
});

describe('scanCorpus / runIntegrity', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dk-integrity-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function writeIndex(rows: string) {
    writeFileSync(
      join(dir, 'INDEX.md'),
      `# Decision Index\n\n| Axis | Current ruling | Why (hook) | Updated |\n|---|---|---|---|\n${rows}`,
    );
  }

  it('reports zero findings for a clean corpus', () => {
    writeFileSync(join(dir, 'my-axis.md'), cleanBody('my-axis'));
    writeIndex('| [my-axis](my-axis.md) | r | w | 2026-01-05 |\n');
    expect(scanCorpus(dir).findings).toEqual([]);
    expect(scanCorpus(dir).filesScanned).toBe(1);
  });

  it('finds a broken axis and stays silent about every other one in the same corpus', () => {
    writeFileSync(join(dir, 'good.md'), cleanBody('good'));
    writeFileSync(join(dir, 'bad.md'), cleanBody('bad').replace('# bad', '# not-bad'));
    writeIndex(
      '| [good](good.md) | r | w | 2026-01-05 |\n| [bad](bad.md) | r | w | 2026-01-05 |\n',
    );
    const { findings } = scanCorpus(dir);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ slug: 'bad', check: 'h1-slug-mismatch' });
  });

  it('runIntegrity exits 0 and logs a pass on a clean corpus', () => {
    writeFileSync(join(dir, 'my-axis.md'), cleanBody('my-axis'));
    writeIndex('| [my-axis](my-axis.md) | r | w | 2026-01-05 |\n');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(runIntegrity(dir)).toBe(0);
    expect(log.mock.calls.join('\n')).toContain('every record has the shape');
    log.mockRestore();
  });

  it('runIntegrity exits 1 and names the finding on a broken corpus', () => {
    writeFileSync(join(dir, 'bad.md'), cleanBody('bad').replace('# bad', '# not-bad'));
    writeIndex('| [bad](bad.md) | r | w | 2026-01-05 |\n');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(runIntegrity(dir)).toBe(1);
    expect(err.mock.calls.join('\n')).toContain('h1-slug-mismatch');
    err.mockRestore();
  });

  it('runIntegrity exits 2 for a missing directory rather than reporting a false pass', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(runIntegrity(join(dir, 'does-not-exist'))).toBe(2);
    err.mockRestore();
  });
});

// integrityFindingKey is a CROSS-MODULE contract: the save-quality bench keys its known-exception
// set with it, and the staged pre-commit gate keys its HEAD diff with it. If the two ever disagreed
// about what "the same finding" means, a grandfathered defect would start blocking commits — or, in
// the other direction, a new regression would be swallowed as already-known.
describe('integrityFindingKey', () => {
  it('includes the Target block, so two blocks on one axis are distinct findings', () => {
    const axis = { slug: 'a', check: 'retarget-missing-evidence-change' };
    expect(integrityFindingKey({ ...axis, block: '2026-07-14' })).not.toBe(
      integrityFindingKey({ ...axis, block: '2026-08-01' }),
    );
  });

  it('separates two checks reported against the same block', () => {
    expect(integrityFindingKey({ slug: 'a', check: 'index-stale', block: '2026-07-14' })).not.toBe(
      integrityFindingKey({
        slug: 'a',
        check: 'retarget-missing-evidence-change',
        block: '2026-07-14',
      }),
    );
  });

  it('separates the same check on two different axes', () => {
    expect(integrityFindingKey({ slug: 'a', check: 'index-stale' })).not.toBe(
      integrityFindingKey({ slug: 'b', check: 'index-stale' }),
    );
  });

  it('treats an absent block as the empty segment, so axis-level findings stay stable', () => {
    expect(integrityFindingKey({ slug: 'a', check: 'index-stale' })).toBe('a:index-stale:');
    expect(integrityFindingKey({ slug: 'a', check: 'index-stale', block: undefined })).toBe(
      'a:index-stale:',
    );
  });
});
