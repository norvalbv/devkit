/**
 * Structural-integrity checks for the decision-log WRITE path.
 *
 * The read path (recall/) has a 29-case benchmark; the write path had none. This is not a rationale
 * judge (that already exists — check-alignment's depth pass) and it is NOT similarity-based duplicate
 * detection (measured in sc-1236 to reject every real corpus's top BM25 pair as a legitimately
 * distinct decision — see decision-duplicate-axes-surfaced-not-blocked.md). It is a narrower, cheaper
 * claim: does this record still have the shape the CLI would have written?
 *
 * Every check here answers that question with the SAME parser the rest of the engine trusts
 * (decision-format.mts's parseDecision/parseTargetFields, recall/markdown.mts's sections()) — never a
 * second regex-based reader. A file that fails one of these was not produced by
 * `guard-decisions add`/`amend` on this content: it was hand-edited, corrupted by a bad merge, or
 * written by a tool outside the CLI's reach. That is exactly the gap
 * decision-records-cli-owned-writes.md names as open for v1 ("shell, MCP, human, and OS-level writes
 * remain outside v1") — this module is the deterministic backstop for it.
 *
 * Measured against the real corpus (32 axis files / 39 Target blocks, 2026-07): six of these checks
 * fire 0/32 or 0/39 — zero grandfathering pain, safe to gate immediately. The seventh
 * (retarget-missing-evidence-change) fires 1/39 blocks: a genuine, narrow, actionable finding
 * (overlay-self-heal's 2026-07-14 re-target), not systemic noise. None of the checks that fired on
 * more than a handful of records made it in here — those are reported by the design survey, never
 * gated (duplicate-ruling similarity, unscoped multi-Target-without-Supersedes, note relation tags,
 * `// DECISION:` markers — every one either forbidden outright or 100% false-positive on this corpus).
 *
 * Zero LLM calls, zero network, pure string/AST work over already-loaded text — cheap enough to run
 * on every commit touching docs/decisions/**.
 */
import { parseTargetFields } from '../decision-format.mjs';
import { sections } from '../recall/markdown.mjs';
import { validateAxisAmends } from '../recall/note-relations.mjs';
export const INTEGRITY_CHECK_IDS = [
    'index-stale',
    'frontmatter-slug-mismatch',
    'frontmatter-created-after-target',
    'h1-slug-mismatch',
    'target-heading-depth',
    'duplicate-field-text',
    'retarget-missing-evidence-change',
    'note-amends-unresolvable',
];
/**
 * The identity of a finding, at the granularity the finding itself reports at.
 *
 * Keyed on the BLOCK, not just (slug, check): retarget-missing-evidence-change reports per Target
 * block, so a coarser key would be broader than the finding it names — grandfathering one historical
 * block would silently swallow every future regression on the same axis. Shared by the save-quality
 * bench's known-exception set and by the staged pre-commit gate's HEAD diff, which must agree about
 * what "the same finding" means or a pre-existing finding would read as new.
 */
export const integrityFindingKey = (f) => `${f.slug}:${f.check}:${f.block ?? ''}`;
const H1_RE = /^\s*#\s+(.+?)\s*$/m;
// Matches a "Target · <date>" heading at ANY depth — used to find both well-formed (depth 2) blocks
// and the misplaced-depth defect (depth 1 or 3+) with one pattern, so the two checks can never disagree
// about what counts as "a Target heading".
const ANY_DEPTH_TARGET_RE = /^#{1,6}\s*Target\s*·\s*(\d{4}-\d{2}-\d{2})/;
const POSITIVE_BULLET_RE = /^-\s*Positive:\s*(.+)$/;
const NEGATIVE_BULLET_RE = /^-\s*Negative:\s*(.+)$/;
// A field this short (an "n/a", "manual", a bare date) legitimately repeats across unrelated fields —
// flagging those would misfire on ordinary terse-but-honest records. Only prose long enough to be a
// real copy-paste is in scope; see decision-scope-drift-detected-not-assumed.md's own "must not fire
// on every pre-existing record" lesson, which this threshold exists to honour for THIS check.
const MIN_DUP_LEN = 20;
// Structured fields (glob, enum, id, tool name) are compared against nothing — two records sharing a
// Category or both saying "Source: manual" is normal, not a copy-paste defect. Only prose fields, the
// ones a human actually writes free-text into, are eligible.
const PROSE_FIELD_KEYS = [
    'context',
    'ruling',
    'vision-fit',
    'researched',
    'rejected',
    'anchored-bet',
    'revisit-when',
];
function h1Of(body) {
    return body.match(H1_RE)?.[1] ?? null;
}
function targetHeadingSections(body) {
    return sections(body).filter((s) => ANY_DEPTH_TARGET_RE.test(s.heading.trim()));
}
/** Well-formed (depth-2) Target blocks, in document order — the shape currentTarget()/allTargetBlocks
 * already assume. A misdepth heading (checked separately below) is deliberately excluded here: once a
 * heading is demoted to `###`, sections() itself no longer treats it as a block boundary the rest of
 * this file's checks can reason about — it is reported once, as its own defect, not folded in. */
function realTargetBlocks(body) {
    return targetHeadingSections(body)
        .filter((s) => s.depth === 2)
        .map((s) => {
        const date = s.heading.trim().match(ANY_DEPTH_TARGET_RE)?.[1] ?? '';
        const fields = parseTargetFields(`${s.prose}\n${s.items.join('\n')}`);
        const positive = s.items.map((i) => i.split('\n')[0]).find((l) => POSITIVE_BULLET_RE.test(l));
        const negative = s.items.map((i) => i.split('\n')[0]).find((l) => NEGATIVE_BULLET_RE.test(l));
        return {
            date,
            fields,
            positive: positive?.match(POSITIVE_BULLET_RE)?.[1]?.trim() ?? '',
            negative: negative?.match(NEGATIVE_BULLET_RE)?.[1]?.trim() ?? '',
        };
    });
}
// ─── Individual checks (pure; one axis file in, its own findings out) ───────────────────────────
/** #2 — frontmatter `slug:` must equal the filename it is written into (a filename rename that left
 * the frontmatter behind, or a hand-copied file). */
export function checkFrontmatterSlug(axis) {
    if (!axis.fm.slug || axis.fm.slug === axis.slug)
        return [];
    return [
        {
            check: 'frontmatter-slug-mismatch',
            slug: axis.slug,
            detail: `frontmatter slug "${axis.fm.slug}" does not match filename "${axis.slug}.md"`,
        },
    ];
}
/** #3 — frontmatter `created:` must not postdate the axis's own first Target. `created` records when
 * the axis was OPENED; a later date means it was rewritten after the fact. */
export function checkFrontmatterCreated(axis) {
    const blocks = realTargetBlocks(axis.body);
    const first = blocks[0]?.date;
    if (!axis.fm.created || !first || axis.fm.created <= first)
        return [];
    return [
        {
            check: 'frontmatter-created-after-target',
            slug: axis.slug,
            detail: `frontmatter created "${axis.fm.created}" postdates the first Target "${first}"`,
        },
    ];
}
/** #4 — the body's `# <slug>` H1 must equal the filename. Both name the same axis; disagreement means
 * one was edited without the other (a hand rename, a merge that kept one side). */
export function checkH1Slug(axis) {
    const h1 = h1Of(axis.body);
    if (h1 === null || h1 === axis.slug)
        return [];
    return [
        {
            check: 'h1-slug-mismatch',
            slug: axis.slug,
            detail: `body H1 "# ${h1}" does not match filename "${axis.slug}.md"`,
        },
    ];
}
/** #5 — a `Target · <date>` heading must be exactly depth-2 (`##`). Depth is not cosmetic: `sections()`
 * treats depth-2 as the block boundary, so a demoted (`###`) or promoted (`#`) heading is invisible to
 * currentTarget()/allTargetBlocks() — the record silently stops being read as a ruling at all. */
export function checkTargetHeadingDepth(axis) {
    const wrong = targetHeadingSections(axis.body).filter((s) => s.depth !== 2);
    return wrong.map((s) => ({
        check: 'target-heading-depth',
        slug: axis.slug,
        detail: `heading "${s.heading.trim()}" is depth ${s.depth}, expected depth 2 (##)`,
    }));
}
/** #6 — exact-string-identical PROSE reused across two fields in one Target block (a copy-paste that
 * left Ruling and Context, or the Positive and Negative bullets, saying the same thing verbatim).
 * Restricted to prose fields long enough that a real duplicate is implausible by coincidence — see
 * MIN_DUP_LEN and PROSE_FIELD_KEYS above for what is deliberately excluded and why. */
export function checkDuplicateFieldText(axis) {
    const out = [];
    for (const block of realTargetBlocks(axis.body)) {
        const values = [
            ...PROSE_FIELD_KEYS.map((k) => [k, block.fields[k] ?? '']),
            ['positive', block.positive],
            ['negative', block.negative],
        ].filter(([, v]) => v.trim().length >= MIN_DUP_LEN);
        for (let a = 0; a < values.length; a += 1) {
            for (let b = a + 1; b < values.length; b += 1) {
                const [ka, va] = values[a];
                const [kb, vb] = values[b];
                if (va.trim() === vb.trim()) {
                    out.push({
                        check: 'duplicate-field-text',
                        slug: axis.slug,
                        detail: `"${ka}" and "${kb}" are identical (block ${block.date}): "${va.slice(0, 60)}"`,
                    });
                }
            }
        }
    }
    return out;
}
/** #7 — every re-target block (every Target after an axis's FIRST) must carry `**Evidence-change:**`.
 * Checked PER BLOCK, not per axis: an axis re-targeted three times but supplying the field only twice
 * is a real, narrow gap the axis-level "5 axes / 5 have the field" count hides (see
 * decision-duplicate-axes-surfaced-not-blocked.md's sibling story for why axis-granularity checks can
 * launder a per-event miss). The CLI's own addTarget/amendDecision already enforce this at WRITE time
 * for anything written through the CLI; this is the read-time backstop for a record that reached disk
 * some other way (a hand-edit, a bad merge, a non-CLI writer). */
export function checkRetargetEvidenceChange(axis) {
    const blocks = realTargetBlocks(axis.body);
    const out = [];
    blocks.forEach((block, i) => {
        if (i === 0)
            return; // the axis's first Target is never a re-target
        if (!block.fields['evidence-change']?.trim()) {
            out.push({
                check: 'retarget-missing-evidence-change',
                slug: axis.slug,
                block: block.date,
                detail: `Target block dated ${block.date} re-targets without an Evidence-change field`,
            });
        }
    });
    return out;
}
/** #1 — the INDEX.md row's `Updated` date must not be older than the axis file's own last Target
 * date. Under compliant use `add --target`/`amend --target` regenerate both together, so a mismatch
 * means something wrote the axis file without going through the index-upserting path. */
export function checkIndexStale(axis, indexRow) {
    const blocks = realTargetBlocks(axis.body);
    const last = blocks.at(-1)?.date;
    if (!last || !indexRow?.updated || indexRow.updated >= last)
        return [];
    return [
        {
            check: 'index-stale',
            slug: axis.slug,
            detail: `INDEX.md says Updated ${indexRow.updated}, but the axis's own last Target is ${last}`,
        },
    ];
}
/** #8 — a note's `**Amends:**` must name a note that exists and predates it. The marker asserts THIS
 * note supersedes THAT one; an assertion nothing can resolve is the same dangling-pointer defect
 * drift already reports for a Target's `**Supersedes:**`, one level down. The pointer is DECLARED by
 * the writer, never inferred — telling a genuine supersession from a refinement needs a note read
 * against its predecessor, which is an LLM job and so belongs in the offline benchmark, not a check
 * that runs on every commit. Fires 0/181 on the real corpora: nothing has ever been tagged, so this
 * grandfathers nobody. */
export function checkNoteAmends(axis, foreignNoteIds = new Map()) {
    return validateAxisAmends(axis.slug, axis.body, foreignNoteIds).map((f) => ({
        check: 'note-amends-unresolvable',
        slug: f.slug,
        block: f.noteId,
        detail: f.detail,
    }));
}
/** Every structural check, in the order they read most naturally (identity → shape → content →
 * cross-file). Combined here once so scan.mts and the benchmark share a single check list. */
export function checkAxis(axis, indexRow, foreignNoteIds = new Map()) {
    return [
        ...checkFrontmatterSlug(axis),
        ...checkFrontmatterCreated(axis),
        ...checkH1Slug(axis),
        ...checkTargetHeadingDepth(axis),
        ...checkDuplicateFieldText(axis),
        ...checkRetargetEvidenceChange(axis),
        ...checkNoteAmends(axis, foreignNoteIds),
        ...checkIndexStale(axis, indexRow),
    ];
}
