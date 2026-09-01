/**
 * Mechanical, single-mutation perturbations of a CLEAN fixture — one per structural-integrity check
 * (checks.mts). Pure string surgery, never hand-typed defect files: a hand-authored "broken" fixture
 * can drift from the real defect shape over time (a typo "fixes" it by accident); a mutation function
 * applies exactly the transform a check exists to catch, so the case and the check can never disagree
 * about what the defect IS.
 *
 * Mirrors the design's Stratum P protocol: clone a known-clean fixture, apply exactly one targeted
 * mutation, and the corpus/bench asserts that mutation — and ONLY that mutation — is what fires.
 *
 * Also what proves each check "by breaking and restoring": a test applies a mutation, asserts the
 * check now fires, then asserts the ORIGINAL (unmutated) fixture stays clean — the false-positive
 * direction required alongside every positive case.
 */
const TARGET_DATE_RE = /^## Target · (\d{4}-\d{2}-\d{2})/gm;
const FIRST_TARGET_HEADING_RE = /^## Target · /m;
const H1_LINE_RE = /^(# .+)$/m;
const RULING_LINE_RE = /^\*\*Ruling:\*\*\s*(.+)$/m;
const NEGATIVE_LINE_RE = /^-\s*Negative:\s*.+$/m;
// Global on purpose: the mutation must strip the LAST Evidence-change in the body, and a non-global
// regex would make `.replace()` hit the FIRST one instead. Today's fixtures all have exactly two
// Target blocks, where first and last coincide, so a non-global version is masked — but real
// multi-retarget axes (this repo's own overlay-self-heal has four blocks, two carrying the field)
// would have a middle block silently corrupted, defeating this module's whole guarantee that the
// case and the check can never disagree about what the defect IS.
const EVIDENCE_CHANGE_RE_G = /\n\*\*Evidence-change:\*\*[^\n]*/g;
/** The `**Amends:** <id>` prefix of a tagged note, without its trailing prose. */
const AMENDS_ID_RE = /\*\*Amends:\*\*\s*\S+/;
// Leading `[ \t]*` so this finds the line whether or not a markdown formatter has already indented
// it under the Consequences bullet — the parser reads both shapes now, so the mutation must be able
// to remove either one. Non-global: the FIRST Target's Vision-fit is the one to strip, because an
// index-0 block is exactly the position #7's early return leaves uncovered.
const VISION_FIT_LINE_RE = /\n[ \t]*\*\*Vision-fit:\*\*[^\n]*/;
function targetDates(body) {
    return [...body.matchAll(TARGET_DATE_RE)].map((m) => m[1]);
}
function shiftDay(iso, delta) {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + delta);
    return d.toISOString().slice(0, 10);
}
/** #1 — backdate the INDEX row's Updated cell to before the axis's own last Target date. */
export function mutateIndexStale(f) {
    const last = targetDates(f.axis.body).at(-1);
    if (!last)
        throw new Error('fixture has no Target block — cannot mutate index-stale');
    return { axis: f.axis, indexRow: { ...f.indexRow, updated: shiftDay(last, -1) } };
}
/** #2 — frontmatter `slug:` no longer matches the filename. */
export function mutateFrontmatterSlug(f) {
    return {
        indexRow: f.indexRow,
        axis: { ...f.axis, fm: { ...f.axis.fm, slug: `${f.axis.slug}-renamed` } },
    };
}
/** #3 — frontmatter `created:` postdates the axis's own first Target. */
export function mutateFrontmatterCreated(f) {
    const first = targetDates(f.axis.body)[0];
    if (!first)
        throw new Error('fixture has no Target block — cannot mutate created-after-target');
    return {
        indexRow: f.indexRow,
        axis: { ...f.axis, fm: { ...f.axis.fm, created: shiftDay(first, 1) } },
    };
}
/** #4 — the body's `# <slug>` H1 no longer matches the filename. */
export function mutateH1Slug(f) {
    if (!H1_LINE_RE.test(f.axis.body))
        throw new Error('fixture has no H1 — cannot mutate h1-slug');
    return {
        indexRow: f.indexRow,
        axis: { ...f.axis, body: f.axis.body.replace(H1_LINE_RE, `# ${f.axis.slug}-renamed`) },
    };
}
/** #5 — demote the FIRST `## Target · ` heading to `### Target · ` (depth 3, no longer a block
 * boundary sections() recognises as one). */
export function mutateTargetHeadingDepth(f) {
    if (!FIRST_TARGET_HEADING_RE.test(f.axis.body))
        throw new Error('fixture has no Target heading — cannot mutate heading-depth');
    return {
        indexRow: f.indexRow,
        axis: { ...f.axis, body: f.axis.body.replace(FIRST_TARGET_HEADING_RE, '### Target · ') },
    };
}
/** #6 — copy the Ruling text verbatim into the Negative bullet (a copy-paste that leaves two fields
 * saying the same thing). */
export function mutateDuplicateFieldText(f) {
    const ruling = f.axis.body.match(RULING_LINE_RE)?.[1];
    if (!ruling || !NEGATIVE_LINE_RE.test(f.axis.body))
        throw new Error('fixture has no Ruling/Negative pair — cannot mutate duplicate-field-text');
    return {
        indexRow: f.indexRow,
        axis: { ...f.axis, body: f.axis.body.replace(NEGATIVE_LINE_RE, `- Negative: ${ruling}`) },
    };
}
/**
 * #7 — strip `**Evidence-change:**` from the LAST Target block of a re-targeted fixture.
 *
 * Anchored to the last block's own offset, NOT to the last occurrence of the field text. Those
 * coincide only while every re-target already carries the field — i.e. only while the fixture is
 * clean. Hand an ALREADY-defective fixture (4 blocks, field on 2 and 3, absent from 4) to an
 * occurrence-based version and it silently strips block 3, yielding a fixture with TWO defects when
 * the protocol calls for exactly one. Refusing outright is the honest answer: the caller asked to
 * remove a field that is not there, and a mutation that quietly does something else is precisely the
 * "case and check disagree about what the defect IS" failure this module exists to prevent.
 */
export function mutateMissingEvidenceChange(f) {
    if (targetDates(f.axis.body).length < 2)
        throw new Error('fixture has fewer than 2 Target blocks — cannot mutate a re-target');
    const lastBlockAt = [...f.axis.body.matchAll(TARGET_DATE_RE)].at(-1)?.index ?? 0;
    const inLastBlock = [...f.axis.body.matchAll(EVIDENCE_CHANGE_RE_G)].find((m) => (m.index ?? 0) > lastBlockAt);
    if (!inLastBlock)
        throw new Error("fixture's LAST Target block has no Evidence-change line — nothing to remove for " +
            'retarget-missing-evidence-change (it is already the defect this mutation creates)');
    const at = inLastBlock.index ?? 0;
    return {
        indexRow: f.indexRow,
        axis: {
            ...f.axis,
            body: f.axis.body.slice(0, at) + f.axis.body.slice(at + inLastBlock[0].length),
        },
    };
}
/** #8 — repoint a note's `**Amends:**` at a date no note on the axis carries, turning a RESOLVED
 * supersession edge into a dangling one. Repointing rather than deleting the marker on purpose:
 * deleting it just yields an untagged note, which is no defect at all — the failure this check exists
 * for is an assertion that outlives the thing it names. */
export function mutateBreakNoteAmends(f) {
    if (!AMENDS_ID_RE.test(f.axis.body))
        throw new Error('fixture has no **Amends:** note — cannot mutate note-amends-unresolvable');
    return {
        indexRow: f.indexRow,
        axis: { ...f.axis, body: f.axis.body.replace(AMENDS_ID_RE, '**Amends:** note:1999-01-01') },
    };
}
/** #9 — strip a Target block's `**Vision-fit:**`, the field renderTarget writes unconditionally.
 *
 * Removal rather than indentation, though indentation is what produced the real corpus case: the
 * parser now READS an indented field, so indenting one is no longer a defect and a mutation that
 * applied it would trip nothing. What survives the fix is the narrower failure the fix cannot
 * reach — a field line that is genuinely gone, from a block a non-CLI writer truncated or a merge
 * mangled. Targets the FIRST block on purpose: #7 exempts index 0, so that position is the one the
 * suite was blind at. */
export function mutateMissingRequiredField(f) {
    if (!VISION_FIT_LINE_RE.test(f.axis.body))
        throw new Error('fixture has no **Vision-fit:** line — nothing to remove for target-missing-required-field ' +
            '(it is already the defect this mutation creates)');
    return {
        indexRow: f.indexRow,
        axis: { ...f.axis, body: f.axis.body.replace(VISION_FIT_LINE_RE, '') },
    };
}
/** Every mutation, keyed by the check id it is designed to trip — one name-to-function map so a test
 * or the bench can drive "apply the mutation for check X" generically. */
export const MUTATIONS = {
    'index-stale': mutateIndexStale,
    'frontmatter-slug-mismatch': mutateFrontmatterSlug,
    'frontmatter-created-after-target': mutateFrontmatterCreated,
    'h1-slug-mismatch': mutateH1Slug,
    'target-heading-depth': mutateTargetHeadingDepth,
    'duplicate-field-text': mutateDuplicateFieldText,
    'retarget-missing-evidence-change': mutateMissingEvidenceChange,
    'note-amends-unresolvable': mutateBreakNoteAmends,
    'target-missing-required-field': mutateMissingRequiredField,
};
