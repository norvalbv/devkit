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

import { type IndexRow, NOTE_BULLET_RE, parseTargetFields } from '../decision-format.mts';
import { sections } from '../recall/markdown.mts';
import { validateAxisAmends } from '../recall/note-relations.mts';

export const INTEGRITY_CHECK_IDS = [
  'index-stale',
  'frontmatter-slug-mismatch',
  'frontmatter-created-after-target',
  'h1-slug-mismatch',
  'target-heading-depth',
  'duplicate-field-text',
  'retarget-missing-evidence-change',
  'note-amends-unresolvable',
  'target-missing-required-field',
] as const;

export type IntegrityCheckId = (typeof INTEGRITY_CHECK_IDS)[number];

export interface IntegrityFinding {
  check: IntegrityCheckId;
  slug: string;
  detail: string;
  /** The Target block this finding belongs to, for the checks that report PER BLOCK rather than per
   * axis. Without it, an allowlist keyed on (slug, check) is coarser than the finding it excepts, so
   * grandfathering one historical block would silently except every future block on the same axis. */
  block?: string;
}

/**
 * The identity of a finding, at the granularity the finding itself reports at.
 *
 * Keyed on the BLOCK, not just (slug, check): retarget-missing-evidence-change reports per Target
 * block, so a coarser key would be broader than the finding it names — grandfathering one historical
 * block would silently swallow every future regression on the same axis. Shared by the save-quality
 * bench's known-exception set and by the staged pre-commit gate's HEAD diff, which must agree about
 * what "the same finding" means or a pre-existing finding would read as new.
 */
export const integrityFindingKey = (f: { slug: string; check: string; block?: string }): string =>
  `${f.slug}:${f.check}:${f.block ?? ''}`;

/** One parsed axis file — frontmatter + body, already split by parseDecision. Never re-parsed here. */
export interface AxisDoc {
  slug: string;
  fm: Record<string, string>;
  body: string;
}

const H1_RE = /^\s*#\s+(.+?)\s*$/m;
// Matches a "Target · <date>" heading at ANY depth — used to find both well-formed (depth 2) blocks
// and the misplaced-depth defect (depth 1 or 3+) with one pattern, so the two checks can never disagree
// about what counts as "a Target heading".
const ANY_DEPTH_TARGET_RE = /^#{1,6}\s*Target\s*·\s*(\d{4}-\d{2}-\d{2})/;
// `\r?$` for the same reason TARGET_FIELD_RE carries it: these run per line after a split on `\n`,
// so a CRLF checkout leaves a `\r` that `(.+)` cannot match and `$` cannot look past. The bullet
// would read as absent, and duplicate-field-text — whose whole job is comparing this text against
// the prose fields — would quietly compare nothing and report the record clean.
const POSITIVE_BULLET_RE = /^-\s*Positive:\s*(.+?)\r?$/;
const NEGATIVE_BULLET_RE = /^-\s*Negative:\s*(.+?)\r?$/;
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
] as const;

interface AxisSection {
  heading: string;
  depth: number;
  prose: string;
  items: string[];
}

function h1Of(body: string): string | null {
  return body.match(H1_RE)?.[1] ?? null;
}

function targetHeadingSections(body: string): AxisSection[] {
  return sections(body).filter((s) => ANY_DEPTH_TARGET_RE.test(s.heading.trim()));
}

/** Well-formed (depth-2) Target blocks, in document order — the shape currentTarget()/allTargetBlocks
 * already assume. A misdepth heading (checked separately below) is deliberately excluded here: once a
 * heading is demoted to `###`, sections() itself no longer treats it as a block boundary the rest of
 * this file's checks can reason about — it is reported once, as its own defect, not folded in. */
function realTargetBlocks(body: string) {
  return targetHeadingSections(body)
    .filter((s) => s.depth === 2)
    .map((s) => {
      const date = s.heading.trim().match(ANY_DEPTH_TARGET_RE)?.[1] ?? '';
      // Notes are excluded from the FIELD text, not from the block. sections() returns the
      // Consequences bullets and the dated notes in one undifferentiated `items` array (it does no
      // classification), and the ruling's fields ride in as a lazy continuation of the last
      // Consequences bullet — so the fields can only be read by scanning items. Now that
      // TARGET_FIELD_RE tolerates indentation, an indented continuation line of a NOTE that opens
      // with bold text would read as a Target-level field and could satisfy a check the block does
      // not actually satisfy. currentTarget avoids this by stopping at the first note bullet; this
      // is the same boundary, applied where the item array has already flattened it away.
      const fieldItems = s.items.filter((i) => !NOTE_BULLET_RE.test(i.split('\n')[0]));
      const fields = parseTargetFields(`${s.prose}\n${fieldItems.join('\n')}`);
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
export function checkFrontmatterSlug(axis: AxisDoc): IntegrityFinding[] {
  if (!axis.fm.slug || axis.fm.slug === axis.slug) return [];
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
export function checkFrontmatterCreated(axis: AxisDoc): IntegrityFinding[] {
  const blocks = realTargetBlocks(axis.body);
  const first = blocks[0]?.date;
  if (!axis.fm.created || !first || axis.fm.created <= first) return [];
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
export function checkH1Slug(axis: AxisDoc): IntegrityFinding[] {
  const h1 = h1Of(axis.body);
  if (h1 === null || h1 === axis.slug) return [];
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
export function checkTargetHeadingDepth(axis: AxisDoc): IntegrityFinding[] {
  const wrong = targetHeadingSections(axis.body).filter((s) => s.depth !== 2);
  return wrong.map((s) => ({
    check: 'target-heading-depth' as const,
    slug: axis.slug,
    detail: `heading "${s.heading.trim()}" is depth ${s.depth}, expected depth 2 (##)`,
  }));
}

/** #6 — exact-string-identical PROSE reused across two fields in one Target block (a copy-paste that
 * left Ruling and Context, or the Positive and Negative bullets, saying the same thing verbatim).
 * Restricted to prose fields long enough that a real duplicate is implausible by coincidence — see
 * MIN_DUP_LEN and PROSE_FIELD_KEYS above for what is deliberately excluded and why. */
export function checkDuplicateFieldText(axis: AxisDoc): IntegrityFinding[] {
  const out: IntegrityFinding[] = [];
  for (const block of realTargetBlocks(axis.body)) {
    const values: [string, string][] = [
      ...PROSE_FIELD_KEYS.map((k) => [k, block.fields[k] ?? ''] as [string, string]),
      ['positive', block.positive] as [string, string],
      ['negative', block.negative] as [string, string],
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
export function checkRetargetEvidenceChange(axis: AxisDoc): IntegrityFinding[] {
  const blocks = realTargetBlocks(axis.body);
  const out: IntegrityFinding[] = [];
  blocks.forEach((block, i) => {
    if (i === 0) return; // the axis's first Target is never a re-target
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

/** Emitted unconditionally by renderTarget for EVERY Target block, so their absence is proof the
 * block did not come from the CLI. Deliberately just these two: every other field is conditional on
 * a flag, and Context/Ruling/Consequences already sit in `prose` where no list-nesting can reach
 * them — these two are the first fields to ride in as a lazy continuation, and so the first to be
 * lost when a block's shape degrades. */
const REQUIRED_TARGET_FIELDS = ['vision-fit', 'source'] as const;

/** #9 — every Target block must carry the fields renderTarget always writes.
 *
 * The read-time backstop for a block whose fields became UNREADABLE rather than absent. #7 covers
 * the same class for Evidence-change but skips block index 0, and every other check keys on
 * identity or cross-file linkage — so a first Target whose whole field tail was swallowed by a list
 * item passed the entire suite silently, taking its `**Scope:**` (and with it the alignment gate's
 * arming) along with it. That is the exact defect measured on this corpus: 1/88 blocks before
 * TARGET_FIELD_RE learned to tolerate indentation, 0/88 after, which is the fire rate the six
 * shape checks already sit at.
 *
 * Per BLOCK, never per axis, and with no index-0 exemption: the case that motivated it was a first
 * Target, and an axis-level count would have laundered it behind its healthy siblings. */
export function checkTargetRequiredFields(axis: AxisDoc): IntegrityFinding[] {
  const out: IntegrityFinding[] = [];
  for (const block of realTargetBlocks(axis.body)) {
    const missing = REQUIRED_TARGET_FIELDS.filter((f) => !block.fields[f]?.trim());
    if (missing.length === 0) continue;
    out.push({
      check: 'target-missing-required-field',
      slug: axis.slug,
      block: block.date,
      detail: `Target block dated ${block.date} is missing ${missing.map((f) => `**${f}**`).join(', ')} — the CLI writes these on every block, so the block's field lines are absent or unreadable`,
    });
  }
  return out;
}

/** #1 — the INDEX.md row's `Updated` date must not be older than the axis file's own last Target
 * date. Under compliant use `add --target`/`amend --target` regenerate both together, so a mismatch
 * means something wrote the axis file without going through the index-upserting path. */
export function checkIndexStale(axis: AxisDoc, indexRow: IndexRow | undefined): IntegrityFinding[] {
  const blocks = realTargetBlocks(axis.body);
  const last = blocks.at(-1)?.date;
  if (!last || !indexRow?.updated || indexRow.updated >= last) return [];
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
export function checkNoteAmends(
  axis: AxisDoc,
  foreignNoteIds: Map<string, Set<string>> = new Map(),
): IntegrityFinding[] {
  return validateAxisAmends(axis.slug, axis.body, foreignNoteIds).map((f) => ({
    check: 'note-amends-unresolvable' as const,
    slug: f.slug,
    block: f.noteId,
    detail: f.detail,
  }));
}

/** Every structural check, in the order they read most naturally (identity → shape → content →
 * cross-file). Combined here once so scan.mts and the benchmark share a single check list. */
export function checkAxis(
  axis: AxisDoc,
  indexRow: IndexRow | undefined,
  foreignNoteIds: Map<string, Set<string>> = new Map(),
): IntegrityFinding[] {
  return [
    ...checkFrontmatterSlug(axis),
    ...checkFrontmatterCreated(axis),
    ...checkH1Slug(axis),
    ...checkTargetHeadingDepth(axis),
    ...checkDuplicateFieldText(axis),
    ...checkTargetRequiredFields(axis),
    ...checkRetargetEvidenceChange(axis),
    ...checkNoteAmends(axis, foreignNoteIds),
    ...checkIndexStale(axis, indexRow),
  ];
}
