/**
 * Machine-readable supersession: does ruling B replace ruling A?
 *
 * A Target's `**Supersedes:** <id>` field is a POINTER, never an edit — the block it names is never
 * touched (append-only survives). So whether a ruling is still LIVE cannot be read off the block
 * alone; it depends on whether anything, anywhere in the corpus, later named it. This module builds
 * that reverse edge fresh on every call — the same read-time, no-write-back shape loadAxisRows
 * already uses for the candidate set, never a status flag persisted on the superseded file.
 *
 * The motivating gap: two decision files can each carry a live-looking Target that flatly
 * contradicts the other, dated the same day, with no pointer between them ("via npx-skills" vs "NOT
 * npx-skills") — nothing recorded which one won. Supersedes exists so the later ruling can say,
 * machine-readably, which one it replaces.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveFromCwd, resolveGuardConfig } from "../../config.mjs";
import { parseDecision, parseTargetFields } from "../decision-format.mjs";
import { sections } from "./markdown.mjs";
// id syntax retrieval.mts already mints for a block: `target:<date>` (modern) or `entry:<date>`
// (legacy `## <date> —` schema, still 49 of 86 blocks in the real corpus). A `slug#` qualifier is
// needed ONLY when the reference crosses axis files — unqualified always means "this axis", so a
// same-file Supersedes reads exactly like the id a human already sees in `guard-decisions show`.
const SUPERSEDES_ID_RE = /^(?:([\w-]+)#)?((?:target|entry):\d{4}-\d{2}-\d{2}(?:~\d+)?)$/;
const TARGET_SECTION_RE = /^## Target · (\d{4}-\d{2}-\d{2})/;
const LEGACY_SECTION_RE = /^## (\d{4}-\d{2}-\d{2}) /;
/** Parse a `**Supersedes:**` value into {slug, id}; null when it isn't the minted id shape. */
export function parseSupersedesId(raw) {
    const m = raw.trim().match(SUPERSEDES_ID_RE);
    return m ? { slug: m[1] ?? null, id: m[2] } : null;
}
/**
 * Every modern Target block in an axis body — not just the last one `currentTarget` resolves to.
 *
 * A genuine sibling, never a change to currentTarget's contract: many callers depend on "the last
 * block wins", and supersession needs to see the whole stack instead. Read via markdown.mts's
 * sections(), never a second body.split — decision-format-parsed-not-regexed named `Supersedes:` by
 * name as the next parsing surface, and ruled that surface must go through the one parser.
 */
export function allTargetBlocks(body) {
    const out = [];
    // Two Target blocks CAN share a date — an axis amended twice in one calendar day, which the real
    // corpus contains (fallow-gate-owned-by-fallow carries two dated 2026-07-25). A bare
    // `target:<date>` id would then name both, so a block could reference ITSELF: the reverse edge
    // would mark the live ruling superseded by itself, collapse the live set to zero, and slip past
    // the ambiguity guard — drift would exit 0 on exactly the corruption it exists to catch. The
    // second and later blocks on a date get a `~N` occurrence suffix so every id names one block
    // (`~`, not `#`, because `#` is already the cross-axis `slug#id` qualifier).
    const seenDates = new Map();
    for (const section of sections(body)) {
        if (section.depth !== 2)
            continue;
        const m = section.heading.match(TARGET_SECTION_RE);
        if (!m)
            continue;
        // Everything renderTarget writes AFTER the Consequences bullets (Vision-fit, Scope, Supersedes,
        // Source, …) has no blank line before it, so CommonMark treats it as a LAZY CONTINUATION of the
        // list's last item, not new prose — section.prose never sees it, only section.items does. Safe
        // to scan every item alongside prose: a real dated note (`- <date> — …`) never matches
        // `**Field:**`, so this can't misread a note's text as a field.
        const fields = parseTargetFields(`${section.prose}\n${section.items.join('\n')}`);
        const nth = (seenDates.get(m[1]) ?? 0) + 1;
        seenDates.set(m[1], nth);
        out.push({
            id: nth === 1 ? `target:${m[1]}` : `target:${m[1]}~${nth}`,
            date: m[1],
            ruling: fields.ruling ?? '',
            supersedes: fields.supersedes?.trim() || null,
        });
    }
    return out;
}
/** Every id (modern or legacy) that names a real block in this axis — existence only, for
 * resolving a pointer. A legacy block never DECLARES Supersedes itself (the field postdates that
 * schema), but stays a valid REFERENT for a modern block elsewhere that names one. */
function axisEntryIds(body) {
    const ids = new Set();
    // Mints ids identically to allTargetBlocks, suffix included — if the two disagreed, a perfectly
    // valid reference to a same-day block would read as dangling and drift would cry wolf.
    const seenDates = new Map();
    for (const section of sections(body)) {
        if (section.depth !== 2)
            continue;
        const target = section.heading.match(TARGET_SECTION_RE);
        if (target) {
            const nth = (seenDates.get(target[1]) ?? 0) + 1;
            seenDates.set(target[1], nth);
            ids.add(nth === 1 ? `target:${target[1]}` : `target:${target[1]}~${nth}`);
            continue;
        }
        const legacy = section.heading.match(LEGACY_SECTION_RE);
        if (legacy)
            ids.add(`entry:${legacy[1]}`);
    }
    return ids;
}
/**
 * Read every axis file fresh and resolve every declared Supersedes edge.
 *
 * READ-TIME ONLY: nothing here writes back to a superseded file. The reverse edge is recomputed on
 * every call, exactly like loadAxisRows's candidate set, so an axis can never be left holding a
 * stale "I am superseded" flag the corpus has since stopped agreeing with.
 */
export function resolveSupersession(decisionsDir) {
    const dir = decisionsDir ?? resolveFromCwd(resolveGuardConfig(process.cwd()), 'decisionsDir');
    if (!dir || !existsSync(dir))
        return { supersededBy: new Map(), unresolved: [], multipleLive: [] };
    const slugs = readdirSync(dir)
        .filter((f) => f.endsWith('.md') && f !== 'INDEX.md')
        .map((f) => f.slice(0, -3));
    const bodies = new Map(slugs.map((slug) => [
        slug,
        parseDecision(readFileSync(path.join(dir, `${slug}.md`), 'utf8')).body,
    ]));
    // "targetSlug#targetId" -> the id of the block that names it, qualified per the same convention
    // Supersedes itself uses (bare within one axis, `slug#id` across axes).
    const reverseEdge = new Map();
    const unresolved = [];
    for (const [slug, body] of bodies) {
        for (const block of allTargetBlocks(body)) {
            if (!block.supersedes)
                continue;
            const ref = parseSupersedesId(block.supersedes);
            const targetSlug = ref?.slug ?? slug;
            const targetBody = ref ? bodies.get(targetSlug) : undefined;
            if (!ref || !targetBody || !axisEntryIds(targetBody).has(ref.id)) {
                unresolved.push({ slug, raw: block.supersedes });
                continue;
            }
            const supersedingId = targetSlug === slug ? block.id : `${slug}#${block.id}`;
            reverseEdge.set(`${targetSlug}#${ref.id}`, supersedingId);
        }
    }
    const supersededBy = new Map();
    const multipleLive = [];
    for (const [slug, body] of bodies) {
        const blocks = allTargetBlocks(body);
        const current = blocks.at(-1) ?? null;
        supersededBy.set(slug, current ? (reverseEdge.get(`${slug}#${current.id}`) ?? null) : null);
        const live = blocks.filter((b) => !reverseEdge.has(`${slug}#${b.id}`));
        // Ambiguity is only reportable on an axis that USES Supersedes. Every axis predating the field
        // has several Target blocks and none declared, and the documented rule for those is positional —
        // the last block is current. Flagging them all would report 5 of 5 multi-Target axes on this
        // corpus, i.e. a 100% false-positive rate, which is how a check gets switched off. Partial
        // adoption (some blocks declare, one is left dangling) IS a real inconsistency and still reports.
        const declares = blocks.some((b) => b.supersedes);
        if (declares && live.length > 1)
            multipleLive.push({ slug, ids: live.map((b) => b.id) });
    }
    return { supersededBy, unresolved, multipleLive };
}
