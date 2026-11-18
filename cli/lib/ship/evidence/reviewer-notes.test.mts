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
import { type Note, reviewerNotes, upsertNotes } from './reviewer-notes.mts';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const REPO = 'o/r';
const attempt: GateEvent = { type: 'ship_attempt' };
const advisory = (gate: string, detail: string): GateEvent => ({
  type: 'advisory_result',
  gate,
  status: 'finding',
  detail,
});
const note = (text: string, sha = SHA_A, reviewer = 'correctness-reviewer'): Note => ({
  reviewer,
  sha,
  text,
});
const blob = (sha: string, path: string, anchor: string) =>
  `https://github.com/${REPO}/blob/${sha}/${path}${anchor}`;
const NOTES = /<!-- devkit:evidence:notes:begin -->[\s\S]*?<!-- devkit:evidence:notes:end -->/g;
const upsert = (body: string, notes: Note[], replace = false) =>
  upsertNotes(body, notes, replace, REPO);

describe('reviewerNotes', () => {
  it('turns each review:* advisory into one note naming the reviewer and the commit', () => {
    const notes = reviewerNotes(
      [attempt, advisory('review:correctness-reviewer', 'src/a.ts:12 — guard the null case')],
      SHA_A,
    );
    expect(notes).toEqual([note('src/a.ts:12 — guard the null case')]);
  });

  it('gives each finding of a row its own note and keeps a union type whole', () => {
    const findings = ['a.ts:1 — `x: string | null` is never narrowed', 'b.ts:2 — dead branch'];
    const detail = findings.join(FINDING_SEPARATOR);
    const notes = reviewerNotes([attempt, advisory('review:commit-guard', detail)], SHA_A);
    expect(notes).toEqual(findings.map((text) => note(text, SHA_A, 'commit-guard')));
  });

  it('reads only the newest attempt and ignores advisories that are not a reviewer', () => {
    const notes = reviewerNotes(
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
    expect(notes).toEqual([note('x.ts:3 — reuse y', SHA_A, 'commit-guard')]);
  });

  it('flattens to one line, shortens the home directory and skips an empty detail', () => {
    const notes = reviewerNotes(
      [
        attempt,
        advisory('review:r', `${homedir()}/repo/a.ts:1 —\t  <b>raw</b>`),
        advisory('review:empty', '   '),
      ],
      SHA_A,
    );
    expect(notes).toEqual([note('~/repo/a.ts:1 — <b>raw</b>', SHA_A, 'r')]);
  });

  // A container or service user can run with HOME=/, and a home is a prefix of its siblings' names.
  it.each([
    ['/', '/src/a.ts:1 — x', '/src/a.ts:1 — x'],
    ['/Users/ben', '/Users/benji/a.ts:1 and /Users/ben/b.ts:2', '/Users/benji/a.ts:1 and ~/b.ts:2'],
  ])('shortens only a whole home directory (HOME=%s)', (home, detail, shown) => {
    vi.stubEnv('HOME', home);
    try {
      expect(reviewerNotes([attempt, advisory('review:r', detail)], SHA_A)).toEqual([
        note(shown, SHA_A, 'r'),
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('upsertNotes', () => {
  const first = note('a.ts:1 — first');
  const second = note('b.ts:2 — second', SHA_B);

  it('opens an evidence block holding only the notes section after the caller prose', () => {
    const body = upsert('Caller prose.\n', [first]);
    expect(body).toBe(
      [
        'Caller prose.',
        '',
        EVIDENCE_BEGIN,
        sectionBegin('notes'),
        '<details><summary>💬 <b>Reviewer notes</b> · 1 note at <code>aaaaaaaaaaaa</code></summary>',
        '',
        '`a.ts`',
        `- [L1](${blob(SHA_A, 'a.ts', '#L1')}) — first · <sub>correctness</sub>`,
        '',
        '',
        '</details>',
        '',
        `<!-- devkit:evidence:notes:data ${JSON.stringify([first])} -->`,
        sectionEnd('notes'),
        EVIDENCE_END,
        '',
      ].join('\n'),
    );
  });

  it('groups a commit by file, orders by line, nests one line notes and puts uncited ones last', () => {
    const body = upsert('', [
      note('LOW: a regex copies another | x.ts, y.ts', SHA_A, 'completeness'),
      note('src/b.ts:30 — later line'),
      note('**src/b.ts:4** — earlier line', SHA_A, 'backend-performance-reviewer'),
      note('src/a.ts:9 — one view'),
      note('`src/a.ts:9`: the same line, again'),
    ]);
    const order = [
      '`src/b.ts`',
      `- [L4](${blob(SHA_A, 'src/b.ts', '#L4')}) — earlier line · <sub>backend-performance</sub>`,
      `- [L30](${blob(SHA_A, 'src/b.ts', '#L30')}) — later line · <sub>correctness</sub>`,
      '`src/a.ts`',
      `- [L9](${blob(SHA_A, 'src/a.ts', '#L9')})`,
      '  - one view · <sub>correctness</sub>',
      '  - the same line, again · <sub>correctness</sub>',
      'Not tied to a line',
      '- LOW: a regex copies another | x.ts, y.ts · <sub>completeness</sub>',
    ];
    const at = order.map((line) => body.indexOf(`\n${line}\n`));
    expect(at.every((index) => index > 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it('escapes markup in prose but leaves code spans raw, where an entity would print literally', () => {
    const body = upsert('', [
      note('a.ts:1 — `Amends: <date>~N` breaks <!-- devkit:evidence:notes:end -->', SHA_A, '<r>'),
    ]);
    expect(body).toContain(
      '— `Amends: <date>~N` breaks &lt;!-- devkit:evidence:notes:end --> · <sub>&lt;r></sub>',
    );
    expect(body.match(NOTES)).toHaveLength(1);
  });

  it('links a range and a column, but not a path outside the repository or a commit it cannot name', () => {
    const body = upsert('', [
      note('src/x.mts:406-408 — a range'),
      note('~/repo/y.ts:3 — a home path'),
      note('z.ts:5 — a short sha', 'abc123'),
      note('../other/a.ts:3 — a parent path'),
      note('c.ts:12:34 — a column'),
      note('`d.ts:9 — wrapped whole`'),
    ]);
    expect(body).toContain(`- [L406-408](${blob(SHA_A, 'src/x.mts', '#L406-L408')}) — a range`);
    expect(body).toContain('- L3 — a home path');
    expect(body).toContain('- L5 — a short sha');
    expect(body).toContain('- L3 — a parent path');
    expect(body).toContain(`- [L12](${blob(SHA_A, 'c.ts', '#L12')}) — a column`);
    expect(body).toContain(
      'Not tied to a line\n- `d.ts:9 — wrapped whole` · <sub>correctness</sub>',
    );
  });

  it('leaves the body untouched when there is nothing to add, even on a rewrite', () => {
    expect(upsert('Caller prose.\n', [])).toBe('Caller prose.\n');
    const noted = upsert('Caller prose.\n', [first]);
    expect(upsert(noted, [], true)).toBe(noted);
  });

  it('shows the newest commit open, collapses earlier ones and never duplicates a note', () => {
    const once = upsert('Prose.', [first]);
    const twice = upsert(once, [second]);
    expect(twice).toContain(
      '<summary>💬 <b>Reviewer notes</b> · 1 note at <code>bbbbbbbbbbbb</code> · 1 at earlier commits</summary>',
    );
    expect(twice.indexOf('second')).toBeLessThan(
      twice.indexOf('<details><summary>1 note at earlier commit <code>aaaaaaaaaaaa</code>'),
    );
    expect(twice.indexOf('<code>aaaaaaaaaaaa</code></summary>')).toBeLessThan(
      twice.indexOf('— first'),
    );
    expect(upsert(twice, [second])).toBe(twice);
    expect(twice.match(NOTES)).toHaveLength(1);
  });

  it('moves a note to the newer commit when a cached PASS raises it again there', () => {
    const replay = note(first.text, SHA_B);
    const body = upsert(upsert('Prose.', [first]), [replay]);
    expect(body).toContain('· 1 note at <code>bbbbbbbbbbbb</code></summary>');
    expect(body).toContain(blob(SHA_B, 'a.ts', '#L1'));
    expect(body).not.toContain(SHA_A);
  });

  it('keeps one note when one ship emits the same advisory twice (a split reviewer replaying parts)', () => {
    expect(upsert('Prose.', [first, first]).split('— first · ')).toHaveLength(2);
  });

  it('replaces every earlier note on a history rewrite', () => {
    const body = upsert(upsert('Prose.', [first]), [second], true);
    expect(body).not.toContain('— first');
    expect(body).toContain('— second');
    expect(body.startsWith('Prose.\n\n')).toBe(true);
  });

  it('reads a section with no readable data line as holding no earlier notes', () => {
    const legacy = upsert('Prose.', [first]).replace(/notes:data \[/, 'notes:data [oops');
    const body = upsert(legacy, [second]);
    expect(body).not.toContain('— first');
    expect(body).toContain('· 1 note at <code>bbbbbbbbbbbb</code></summary>');
  });

  it('sits inside the regression block and survives its re-render beside the QA section', () => {
    const regression = (text: string) =>
      `${EVIDENCE_BEGIN}\n#### Regression evidence\n${text}\n<!-- devkit:evidence:data {} -->\n${EVIDENCE_END}`;
    const qa = `${sectionBegin('qa')}\n#### QA capture\n${sectionEnd('qa')}`;
    const noted = upsert(withQaSection(`Prose.\n\n${regression('old')}\n`, qa), [first]);
    expect(noted.match(/<!-- devkit:evidence:begin -->/g)).toHaveLength(1);
    expect(noted.indexOf('— first')).toBeLessThan(noted.indexOf('<!-- devkit:evidence:data'));
    const rerendered = replaceKeepingSections(noted, regression('new'));
    expect(rerendered).toContain('new');
    expect(rerendered).toContain('— first');
    expect(rerendered).toContain('#### QA capture');
    expect(upsert(rerendered, [second])).toContain('1 at earlier commits');
  });
});

describe('carrying notes through a caller body', () => {
  it("drops a pasted block, defuses a quoted marker and keeps the PR's current notes", () => {
    const current = upsert('Old prose.', [note('a.ts:1 — kept')]);
    const pasted = upsert('', [note('a.ts:1 — pasted', SHA_B)]);
    const caller = `New prose quoting <!-- devkit:evidence:notes:begin --> inline.\n\n${pasted}`;
    const carried = carryEvidenceBlock(caller, current);
    expect(carried).toContain('kept');
    expect(carried).not.toContain('pasted');
    expect(carried).toContain('New prose quoting <!-- devkit:evidence​:notes:begin --> inline.');
    expect(carried.match(NOTES)).toHaveLength(1);
  });
});
