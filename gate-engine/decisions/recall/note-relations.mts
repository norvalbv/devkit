/**
 * Note identity, and the `**Amends:**` relation one note declares over another.
 *
 * A note was never addressable. `retrieval.mts` minted `note:<date>` for the current section's
 * bullets, but without an occurrence suffix — so on an axis carrying six notes dated 2026-07-03
 * (the real frink corpus does) all six answered to the SAME id. Nothing could point at one note and
 * mean it. That is the whole reason the `**Amends:**` marker has existed in retrieval.mts since
 * sc-1236 as a bare flag with no target, and has zero uses across 181 real notes: there was no id to
 * put after it.
 *
 * WHY DECLARED, NOT DETECTED. ~25% of notes in the real corpus supersede an earlier note on their
 * own axis, and no cheap check finds them: a narrow supersede/reverse grep recovers 25% while a
 * broader one overshoots to 48%, because several notes use reversal vocabulary precisely to DENY
 * they are reversals ("not a reversal", "reconfirms"). Telling a genuine supersession from a
 * refinement means reading a note against its specific predecessor — an LLM job, and the commit gate
 * runs on every commit with zero LLM and zero network. So the writer DECLARES the edge and this
 * module checks the declaration is well-formed. Detection stays in the offline benchmark, where a
 * judge is affordable and a wrong answer costs a report line rather than a blocked commit.
 *
 * Minting lives HERE, once, and both retrieval.mts and the gate import it. supersession.mts learned
 * this the hard way for Targets (see its axisEntryIds comment): when two places mint ids
 * independently they drift, and a perfectly valid reference reads as dangling — the gate then cries
 * wolf on correct work, which is how a gate gets switched off.
 */

import { sections } from './markdown.mts';

/** A dated note bullet: `- <date> — <text>`. Shared with retrieval.mts so both read notes alike. */
export const NOTE_LINE_RE = /^-\s+(\d{4}-\d{2}-\d{2})\s+—\s+(.+)$/;
/** Top-level: axisNotes runs this once per note, per file, on every scan. */
const WS_RE = /\s+/;

/**
 * A note's declared relation: `**Amends:** <id> — <text>`.
 *
 * Mirrors the shape `rescope` already writes (`**Scope:** <globs> — <reason>`), so a tagged note
 * stays one ordinary bullet a human reads without tooling.
 *
 * Deliberately matches the PREFIX only, keeping "is tagged" separate from "names a resolvable note".
 * The marker predates ids — sc-1236 shipped it as a bare flag and retrieval has set
 * `relation: 'amends'` off the prefix alone ever since, including for prose-only tags like
 * `**Amends:** narrows the ruling to the http transport`. Folding the two questions into one regex
 * silently demoted those to untagged, changing retrieval behaviour the original explicitly promised
 * not to touch. So: the prefix decides the RELATION (unchanged), the first token decides the
 * POINTER, and a tag without a usable pointer is a finding rather than a silent downgrade.
 */
const AMENDS_PREFIX_RE = /^\*\*Amends:\*\*\s*(.*)$/;

/**
 * A minted note id, optionally qualified by another axis. `~N` disambiguates the Nth note sharing a
 * date, exactly as supersession.mts does for same-day Targets — and for the same reason: without it
 * an id names several blocks, so a note could reference ITSELF and a self-amending note would read
 * as a resolved edge. `~`, never `#`, because `#` is already the cross-axis qualifier.
 */
export const NOTE_ID_RE = /^(?:([\w-]+)#)?(note:\d{4}-\d{2}-\d{2}(?:~\d+)?)$/;

export interface NoteRef {
  /** null means "this axis" — an unqualified id always reads as same-file, like Supersedes. */
  slug: string | null;
  id: string;
}

export interface AxisNote {
  id: string;
  date: string;
  /** Note text with the `**Amends:** <id> —` prefix still attached, as it appears on disk. */
  text: string;
  /** The note's text begins `**Amends:**` — it qualifies the ruling rather than logging progress.
   * This alone drives retrieval's `relation`, exactly as it did before ids existed. */
  amendsTag: boolean;
  /** The first token after the marker: the candidate pointer, still unresolved and not yet known to
   * be a well-formed id. null when the note is untagged, or tagged with nothing after it. */
  amends: string | null;
  /** Index into `sections(body)` of the block this note sits under. Lets a caller that serves only
   * ONE section (retrieval) still use the axis-wide ids minted here, instead of re-minting its own
   * and drifting from this module. */
  sectionIndex: number;
}

/** Parse an `**Amends:**` id into {slug, id}; null when it is not the minted id shape. */
export function parseNoteId(raw: string): NoteRef | null {
  const m = raw.trim().match(NOTE_ID_RE);
  return m ? { slug: m[1] ?? null, id: m[2] } : null;
}

/**
 * Every note on an axis, in document order, with a stable axis-wide id.
 *
 * Axis-wide rather than per-section: an id has to name one note across the WHOLE file, or a
 * reference from a later section could resolve to two different bullets depending on where the
 * reader started. Notes under superseded Target blocks are included for exactly that reason — they
 * remain valid REFERENTS (append-only means they are still on disk and still readable), even though
 * retrieval only ever SERVES the current section's notes.
 */
export function axisNotes(body: string): AxisNote[] {
  const out: AxisNote[] = [];
  const seenDates = new Map<string, number>();
  const all = sections(body);
  for (const [sectionIndex, section] of all.entries()) {
    if (section.depth !== 2) continue;
    for (const item of section.items) {
      // Only the item's FIRST line: a wrapped bullet's continuation lines are part of the same note,
      // and matching them separately would mint ids for text that is not a note at all.
      const m = item.split('\n')[0].match(NOTE_LINE_RE);
      if (!m) continue;
      const nth = (seenDates.get(m[1]) ?? 0) + 1;
      seenDates.set(m[1], nth);
      const text = m[2].trim();
      const rest = text.match(AMENDS_PREFIX_RE)?.[1];
      out.push({
        id: nth === 1 ? `note:${m[1]}` : `note:${m[1]}~${nth}`,
        date: m[1],
        text,
        amendsTag: rest !== undefined,
        amends: rest?.trim().split(WS_RE)[0] || null,
        sectionIndex,
      });
    }
  }
  return out;
}

export interface AmendsFinding {
  slug: string;
  /** The id of the note DECLARING the relation — the one to fix. */
  noteId: string;
  detail: string;
}

/**
 * Check every `**Amends:**` a single axis declares.
 *
 * Same-axis references are resolved here; a cross-axis `slug#note:<date>` needs the rest of the
 * corpus, so `foreignIds` supplies it (empty map ⇒ cross-axis refs are skipped rather than reported
 * dangling — claiming a reference is broken because the CALLER did not load the other file would be
 * the gate crying wolf again).
 */
export function validateAxisAmends(
  slug: string,
  body: string,
  foreignIds: Map<string, Set<string>> = new Map(),
): AmendsFinding[] {
  const notes = axisNotes(body);
  const ownIds = new Map(notes.map((n) => [n.id, n]));
  const out: AmendsFinding[] = [];

  for (const note of notes) {
    if (!note.amendsTag) continue;
    // Tagged but pointing at nothing usable. Reported rather than ignored: `**Amends:**` asserts this
    // note supersedes another, and an assertion nothing can resolve is the dangling-pointer problem
    // the Targets' Supersedes check already exists to catch — just at note granularity.
    const ref = note.amends ? parseNoteId(note.amends) : null;
    if (!ref) {
      out.push({
        slug,
        noteId: note.id,
        detail: note.amends
          ? `Amends value "${note.amends}" is not a note id (expected note:<date> or <slug>#note:<date>, optionally ~N)`
          : 'Amends declares no note id (expected `**Amends:** note:<date> — <what changed>`)',
      });
      continue;
    }

    if (ref.slug && ref.slug !== slug) {
      // An EMPTY map means the caller loaded one axis and cannot judge cross-axis references at all
      // (stay silent — reporting those would be the gate crying wolf). A POPULATED map comes from a
      // whole-corpus scan, so an absent slug is not "unknown", it is a slug that does not exist:
      // a typo like `wrong-axsi#note:2026-01-01` must not pass just because nothing answers to it.
      if (!foreignIds.size) continue;
      const known = foreignIds.get(ref.slug);
      if (!known)
        out.push({
          slug,
          noteId: note.id,
          detail: `Amends "${note.amends}" names axis "${ref.slug}", which is not in the corpus`,
        });
      else if (!known.has(ref.id))
        out.push({
          slug,
          noteId: note.id,
          detail: `Amends "${note.amends}" names no note in axis "${ref.slug}"`,
        });
      continue;
    }

    // A note amending ITSELF is a closed loop that reads as a resolved edge while asserting nothing.
    // Checked before existence so the message names the real problem rather than "dangling".
    if (ref.id === note.id) {
      out.push({ slug, noteId: note.id, detail: `Amends points at itself (${note.id})` });
      continue;
    }

    const target = ownIds.get(ref.id);
    if (!target) {
      out.push({
        slug,
        noteId: note.id,
        detail: `Amends "${note.amends}" names no note on this axis`,
      });
      continue;
    }

    // Time only runs one way. A note may amend an earlier note or an earlier same-day one (ordered by
    // the ~N the minter already assigned), never a later one — that would be the superseded entry
    // claiming to supersede its own successor, and the reverse edge would contradict itself.
    if (
      target.date > note.date ||
      (target.date === note.date && ownIndex(notes, target) > ownIndex(notes, note))
    )
      out.push({
        slug,
        noteId: note.id,
        detail: `Amends "${ref.id}" is dated ${target.date}, at or after the amending note (${note.date}) — a note may only amend an earlier one`,
      });
  }
  return out;
}

/** Document position, which for same-day notes is the only thing that orders them. */
function ownIndex(notes: AxisNote[], note: AxisNote): number {
  return notes.indexOf(note);
}

/** Every note id an axis defines — for resolving cross-axis references. */
export function axisNoteIds(body: string): Set<string> {
  return new Set(axisNotes(body).map((n) => n.id));
}

/**
 * The text `add --note` should write, given an optional `--supersedes <id>`.
 *
 * ONE verb, rendered as the right field for the entry kind: `--supersedes` on a `--target` writes
 * `**Supersedes:**` (renderTarget), on a `--note` it writes `**Amends:**` — the note-level marker
 * retrieval has keyed on since sc-1236. A second `--amends` flag would be a synonym users have to
 * learn, and the flag is already parsed and silently ignored on this path today.
 *
 * Validation happens HERE, at write time, not only in the read-time `integrity` scan. sc-1282 shipped
 * the opposite mistake and had to fix it: a CLI that writes a record its own check then rejects. So a
 * pointer that cannot resolve fails the write, while the corpus-wide scan stays the backstop for
 * records that reached disk some other way.
 */
export function noteTextWithRelation(
  text: string,
  supersedes: string | undefined,
  body: string,
): string {
  const raw = supersedes?.trim();
  if (!raw) return text;
  const ref = parseNoteId(raw);
  if (!ref)
    throw new Error(
      `--supersedes "${raw}" is not a note id. A note amends a NOTE: pass note:<date> (add ~N for ` +
        'the Nth note that day), or <slug>#note:<date> across axes. `guard-decisions show <slug>` lists them.',
    );
  // Cross-axis pointers are resolved by the corpus-wide scan, which can read the other file; failing
  // the write here would mean rejecting a valid reference just because this command only loaded one axis.
  if (!ref.slug && !axisNoteIds(body).has(ref.id))
    throw new Error(
      `--supersedes "${raw}" names no note on this axis. See \`guard-decisions show <slug>\` for its note ids.`,
    );
  return `**Amends:** ${raw} — ${text}`;
}
