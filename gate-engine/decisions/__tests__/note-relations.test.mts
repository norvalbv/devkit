import { describe, expect, it } from 'vitest';
import {
  axisNoteIds,
  axisNotes,
  parseNoteId,
  validateAxisAmends,
} from '../recall/note-relations.mts';

/** A Target section carrying the given note bullets, in the shape renderTarget/renderNote write. */
function axis(notes: string[], opts: { date?: string } = {}) {
  return (
    `\n# my-axis\n\n## Target · ${opts.date ?? '2026-01-05'} — a ruling\n\n` +
    `**Context:** a forcing failure.\n**Ruling:** the mechanism.\n**Consequences:**\n` +
    `- Positive: value.\n- Negative: cost.\n**Vision-fit:** n/a\n**Source:** manual\n` +
    `${notes.join('\n')}\n`
  );
}
const note = (date: string, text: string) => `- ${date} — ${text}`;

describe('axisNotes — identity', () => {
  it('mints a bare id for the only note on a date', () => {
    expect(axisNotes(axis([note('2026-02-01', 'converged on X.')])).map((n) => n.id)).toEqual([
      'note:2026-02-01',
    ]);
  });

  // The defect that made **Amends:** unusable for a year: six notes dated 2026-07-03 exist on one
  // real axis, and retrieval.mts gave every one of them the id `note:2026-07-03`. An id that names
  // six bullets cannot be the target of a pointer.
  it('disambiguates same-day notes with ~N so every id names exactly one note', () => {
    const body = axis([
      note('2026-07-03', 'first.'),
      note('2026-07-03', 'second.'),
      note('2026-07-03', 'third.'),
    ]);
    expect(axisNotes(body).map((n) => n.id)).toEqual([
      'note:2026-07-03',
      'note:2026-07-03~2',
      'note:2026-07-03~3',
    ]);
    expect(axisNoteIds(body).size).toBe(3);
  });

  it('numbers per date, not globally — a new date restarts at the bare id', () => {
    expect(
      axisNotes(
        axis([note('2026-02-01', 'a.'), note('2026-02-01', 'b.'), note('2026-02-02', 'c.')]),
      ).map((n) => n.id),
    ).toEqual(['note:2026-02-01', 'note:2026-02-01~2', 'note:2026-02-02']);
  });

  it('ignores a wrapped bullet’s continuation lines rather than minting ids for prose', () => {
    const body = axis([`${note('2026-02-01', 'a long note')}\n  that wraps onto another line.`]);
    expect(axisNotes(body)).toHaveLength(1);
  });

  it('reads the declared Amends value, and leaves an untagged note with none', () => {
    const notes = axisNotes(
      axis([
        note('2026-02-01', 'plain convergence.'),
        note('2026-02-02', '**Amends:** note:2026-02-01 — that turned out wrong.'),
      ]),
    );
    expect(notes[0].amends).toBeNull();
    expect(notes[1].amends).toBe('note:2026-02-01');
  });

  it('parses a bare Amends with no trailing prose', () => {
    const notes = axisNotes(
      axis([note('2026-02-01', 'a.'), note('2026-02-02', '**Amends:** note:2026-02-01')]),
    );
    expect(notes[1].amends).toBe('note:2026-02-01');
  });

  // The marker predates ids: retrieval has set relation:'amends' off the PREFIX alone since sc-1236,
  // including for prose-only tags. Treating "has no id" as "is not tagged" would silently change
  // retrieval behaviour the original promised to leave alone — so the two stay separate facts.
  it('keeps a prose-only tag TAGGED while reporting no pointer', () => {
    const [n] = axisNotes(
      axis([note('2026-02-02', '**Amends:** narrows the ruling to only the http transport')]),
    );
    expect(n.amendsTag).toBe(true);
    expect(parseNoteId(n.amends ?? '')).toBeNull();
  });

  it('treats a marker with nothing after it as tagged, with no pointer at all', () => {
    const [n] = axisNotes(axis([note('2026-02-02', '**Amends:**')]));
    expect(n.amendsTag).toBe(true);
    expect(n.amends).toBeNull();
  });

  it('leaves an untagged note untagged', () => {
    expect(axisNotes(axis([note('2026-02-02', 'plain progress.')]))[0].amendsTag).toBe(false);
  });
});

describe('parseNoteId', () => {
  it('accepts bare, suffixed, and cross-axis ids', () => {
    expect(parseNoteId('note:2026-02-01')).toEqual({ slug: null, id: 'note:2026-02-01' });
    expect(parseNoteId('note:2026-02-01~3')).toEqual({ slug: null, id: 'note:2026-02-01~3' });
    expect(parseNoteId('other-axis#note:2026-02-01')).toEqual({
      slug: 'other-axis',
      id: 'note:2026-02-01',
    });
  });

  it('rejects a Target id — Amends relates notes to notes, not notes to rulings', () => {
    expect(parseNoteId('target:2026-02-01')).toBeNull();
  });

  it('rejects free text', () => {
    expect(parseNoteId('the earlier note')).toBeNull();
  });
});

describe('validateAxisAmends', () => {
  it('is silent on an axis whose notes declare nothing — the 75% that relate to nothing prior', () => {
    expect(
      validateAxisAmends('my-axis', axis([note('2026-02-01', 'a.'), note('2026-02-02', 'b.')])),
    ).toEqual([]);
  });

  it('accepts a well-formed amend of an earlier note', () => {
    expect(
      validateAxisAmends(
        'my-axis',
        axis([
          note('2026-02-01', 'we will retry on failure.'),
          note('2026-02-02', '**Amends:** note:2026-02-01 — retry deleted, it masked the fault.'),
        ]),
      ),
    ).toEqual([]);
  });

  it('accepts an amend of an earlier SAME-DAY note, ordered by ~N', () => {
    expect(
      validateAxisAmends(
        'my-axis',
        axis([
          note('2026-07-03', 'carry-on made real.'),
          note('2026-07-03', '**Amends:** note:2026-07-03 — deleted, it was a lie.'),
        ]),
      ),
    ).toEqual([]);
  });

  it('flags a dangling reference', () => {
    const f = validateAxisAmends(
      'my-axis',
      axis([note('2026-02-02', '**Amends:** note:2026-01-01 — supersedes something absent.')]),
    );
    expect(f).toHaveLength(1);
    expect(f[0].detail).toContain('names no note on this axis');
  });

  it('flags a malformed value rather than silently treating it as untagged', () => {
    const f = validateAxisAmends(
      'my-axis',
      axis([note('2026-02-02', '**Amends:** the-earlier-one — nope.')]),
    );
    expect(f).toHaveLength(1);
    expect(f[0].detail).toContain('is not a note id');
  });

  it('flags a tag that names nothing at all', () => {
    const f = validateAxisAmends('my-axis', axis([note('2026-02-02', '**Amends:**')]));
    expect(f).toHaveLength(1);
    expect(f[0].detail).toContain('declares no note id');
  });

  it('flags a prose-only tag — the assertion is unresolvable, not merely informal', () => {
    const f = validateAxisAmends(
      'my-axis',
      axis([note('2026-02-02', '**Amends:** narrows the ruling to only the http transport')]),
    );
    expect(f).toHaveLength(1);
    expect(f[0].detail).toContain('is not a note id');
  });

  it('flags a self-reference by name, not as a dangling pointer', () => {
    const f = validateAxisAmends(
      'my-axis',
      axis([note('2026-02-02', '**Amends:** note:2026-02-02 — amends itself.')]),
    );
    expect(f).toHaveLength(1);
    expect(f[0].detail).toContain('points at itself');
  });

  // Time runs one way: the superseded entry cannot claim to supersede its own successor.
  it('flags an amend pointing FORWARD in time', () => {
    const f = validateAxisAmends(
      'my-axis',
      axis([
        note('2026-02-01', '**Amends:** note:2026-02-02 — points at the future.'),
        note('2026-02-02', 'the later note.'),
      ]),
    );
    expect(f).toHaveLength(1);
    expect(f[0].detail).toContain('only amend an earlier one');
  });

  it('flags a same-day amend pointing at a LATER note in document order', () => {
    const f = validateAxisAmends(
      'my-axis',
      axis([
        note('2026-07-03', '**Amends:** note:2026-07-03~2 — points at the next bullet.'),
        note('2026-07-03', 'the later same-day note.'),
      ]),
    );
    expect(f).toHaveLength(1);
    expect(f[0].detail).toContain('only amend an earlier one');
  });

  it('resolves a cross-axis reference when the other axis is supplied', () => {
    const body = axis([note('2026-02-02', '**Amends:** other#note:2026-01-01 — cross-axis.')]);
    expect(
      validateAxisAmends('my-axis', body, new Map([['other', new Set(['note:2026-01-01'])]])),
    ).toEqual([]);
    const f = validateAxisAmends(
      'my-axis',
      body,
      new Map([['other', new Set(['note:9999-01-01'])]]),
    );
    expect(f).toHaveLength(1);
    expect(f[0].detail).toContain('names no note in axis "other"');
  });

  // Reporting a reference as broken because the CALLER never loaded the other file would block
  // correct work — the precise way a gate earns a reputation for crying wolf and gets switched off.
  it('stays silent on a cross-axis reference when the other axis was not loaded', () => {
    expect(
      validateAxisAmends(
        'my-axis',
        axis([note('2026-02-02', '**Amends:** other#note:2026-01-01 — cross-axis.')]),
      ),
    ).toEqual([]);
  });
});
