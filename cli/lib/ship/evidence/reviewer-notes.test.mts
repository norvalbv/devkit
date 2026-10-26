import { homedir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import type { GateEvent } from '../digest/gate-digest.mts';
import {
  carryEvidenceBlock,
  EVIDENCE_BEGIN,
  EVIDENCE_END,
  replaceKeepingSections,
  sectionBegin,
  sectionEnd,
} from './block.mts';
import { withQaSection } from './media.mts';
import { FINDING_SEPARATOR } from '../../../../gate-engine/judge/advisory/emit.mts';
import { noteLines, upsertNotes } from './reviewer-notes.mts';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const attempt: GateEvent = { type: 'ship_attempt' };
const advisory = (gate: string, detail: string): GateEvent => ({
  type: 'advisory_result',
  gate,
  status: 'finding',
  detail,
});
const NOTES = /<!-- devkit:evidence:notes:begin -->[\s\S]*?<!-- devkit:evidence:notes:end -->/g;

describe('noteLines', () => {
  it('turns each review:* advisory into one bullet naming the reviewer and the commit', () => {
    const lines = noteLines(
      [attempt, advisory('review:correctness-reviewer', 'src/a.ts:12 — guard the null case')],
      SHA_A,
    );
    expect(lines).toEqual([
      `- **correctness-reviewer** at \`${SHA_A.slice(0, 12)}\`: src/a.ts:12 — guard the null case`,
    ]);
  });

  it('gives each finding of a row its own bullet and keeps a union type whole', () => {
    const findings = ['a.ts:1 — `x: string | null` is never narrowed', 'b.ts:2 — dead branch'];
    const detail = findings.join(FINDING_SEPARATOR);
    const lines = noteLines([attempt, advisory('review:commit-guard', detail)], SHA_A);
    expect(lines).toEqual(
      findings.map((text) => `- **commit-guard** at \`${SHA_A.slice(0, 12)}\`: ${text}`),
    );
  });

  it('reads only the newest attempt and ignores advisories that are not a reviewer', () => {
    const lines = noteLines(
      [
        attempt,
        advisory('review:correctness-reviewer', 'from a run that is already over'),
        attempt,
        advisory('fallow-advisory', 'complexity introduced'),
        advisory('ui-evidence', 'attach a screenshot'),
        { type: 'review_result', gate: 'review:commit-guard', detail: 'PASS' },
        advisory('review:commit-guard', 'x.ts:3 — reuse y'),
      ],
      SHA_A,
    );
    expect(lines).toEqual([`- **commit-guard** at \`${SHA_A.slice(0, 12)}\`: x.ts:3 — reuse y`]);
  });

  it('escapes markup, shortens the home directory and skips an empty detail', () => {
    const lines = noteLines(
      [
        attempt,
        advisory('review:r', `${homedir()}/repo/a.ts:1 — <!-- devkit:evidence:notes:end -->`),
        advisory('review:empty', '   '),
      ],
      SHA_A,
    );
    expect(lines).toEqual([
      `- **r** at \`${SHA_A.slice(0, 12)}\`: ~/repo/a.ts:1 — &lt;!-- devkit:evidence:notes:end -->`,
    ]);
  });

  // A container or service user can run with HOME=/, and a home is a prefix of its siblings' names.
  it.each([
    ['/', '/src/a.ts:1 — x', '/src/a.ts:1 — x'],
    ['/Users/ben', '/Users/benji/a.ts:1 and /Users/ben/b.ts:2', '/Users/benji/a.ts:1 and ~/b.ts:2'],
  ])('shortens only a whole home directory (HOME=%s)', (home, detail, shown) => {
    vi.stubEnv('HOME', home);
    try {
      expect(noteLines([attempt, advisory('review:r', detail)], SHA_A)).toEqual([
        `- **r** at \`${SHA_A.slice(0, 12)}\`: ${shown}`,
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('upsertNotes', () => {
  const first = noteLines([attempt, advisory('review:r', 'a.ts:1 — first')], SHA_A);
  const second = noteLines([attempt, advisory('review:r', 'b.ts:2 — second')], SHA_B);

  it('opens an evidence block holding only the notes section after the caller prose', () => {
    const body = upsertNotes('Caller prose.\n', first, false);
    expect(body).toBe(
      [
        'Caller prose.',
        '',
        EVIDENCE_BEGIN,
        sectionBegin('notes'),
        '<details><summary>💬 <b>Reviewer notes</b> · 1 non-blocking advisory</summary>',
        '',
        ...first,
        '',
        '</details>',
        '',
        sectionEnd('notes'),
        EVIDENCE_END,
        '',
      ].join('\n'),
    );
  });

  it('leaves the body untouched when there is nothing to add, even on a rewrite', () => {
    expect(upsertNotes('Caller prose.\n', [], false)).toBe('Caller prose.\n');
    const noted = upsertNotes('Caller prose.\n', first, false);
    expect(upsertNotes(noted, [], true)).toBe(noted);
  });

  it('keeps earlier notes on an append re-ship and never duplicates one', () => {
    const once = upsertNotes('Prose.', first, false);
    const twice = upsertNotes(once, second, false);
    expect(twice).toContain(first[0]);
    expect(twice).toContain(second[0]);
    expect(upsertNotes(twice, second, false)).toBe(twice);
    expect(twice.match(NOTES)).toHaveLength(1);
    expect(twice).toContain(
      '<summary>💬 <b>Reviewer notes</b> · 2 non-blocking advisories</summary>',
    );
  });

  it('keeps one note when a cached PASS replays the same advisory under a later commit', () => {
    const replay = noteLines([attempt, advisory('review:r', 'a.ts:1 — first')], SHA_B);
    const body = upsertNotes(upsertNotes('Prose.', first, false), replay, false);
    expect(body).toContain(first[0]);
    expect(body).not.toContain(replay[0]);
  });

  it('keeps one note when one ship emits the same advisory twice (a split reviewer replaying parts)', () => {
    const twice = noteLines(
      [attempt, advisory('review:r', 'a.ts:1 — first'), advisory('review:r', 'a.ts:1 — first')],
      SHA_A,
    );
    expect(upsertNotes('Prose.', twice, false).split(first[0])).toHaveLength(2);
  });

  it('replaces every earlier note on a history rewrite', () => {
    const body = upsertNotes(upsertNotes('Prose.', first, false), second, true);
    expect(body).not.toContain(first[0]);
    expect(body).toContain(second[0]);
    expect(body.startsWith('Prose.\n\n')).toBe(true);
  });

  it('sits inside the regression block and survives its re-render beside the QA section', () => {
    const regression = (text: string) =>
      `${EVIDENCE_BEGIN}\n#### Regression evidence\n${text}\n<!-- devkit:evidence:data {} -->\n${EVIDENCE_END}`;
    const qa = `${sectionBegin('qa')}\n#### QA capture\n${sectionEnd('qa')}`;
    const noted = upsertNotes(withQaSection(`Prose.\n\n${regression('old')}\n`, qa), first, false);
    expect(noted.match(/<!-- devkit:evidence:begin -->/g)).toHaveLength(1);
    expect(noted.indexOf(first[0])).toBeLessThan(noted.indexOf('<!-- devkit:evidence:data'));
    const rerendered = replaceKeepingSections(noted, regression('new'));
    expect(rerendered).toContain('new');
    expect(rerendered).toContain(first[0]);
    expect(rerendered).toContain('#### QA capture');
  });
});

describe('carrying notes through a caller body', () => {
  it("drops a pasted block, defuses a quoted marker and keeps the PR's current notes", () => {
    const current = upsertNotes(
      'Old prose.',
      [`- **r** at \`${SHA_A.slice(0, 12)}\`: kept`],
      false,
    );
    const pasted = upsertNotes('', [`- **r** at \`${SHA_B.slice(0, 12)}\`: pasted`], false);
    const caller = `New prose quoting <!-- devkit:evidence:notes:begin --> inline.\n\n${pasted}`;
    const carried = carryEvidenceBlock(caller, current);
    expect(carried).toContain('kept');
    expect(carried).not.toContain('pasted');
    expect(carried).toContain('New prose quoting <!-- devkit:evidence​:notes:begin --> inline.');
    expect(carried.match(NOTES)).toHaveLength(1);
  });
});
