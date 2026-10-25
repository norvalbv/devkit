/** Executable labels for the commit-guard corpus, outside anything the judge sees: the duplication
 * passes at base, reproduces in the buggy postimage and passes again in the repair. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const rows = Object.fromEntries(
  readFileSync(new URL('../cases-commit-guard.jsonl', import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .map((row) => [row.id, row]),
);
const gold = rows['cg-tel-sc3700-copied-helpers'];
const repair = rows['cg-tel-sc3700-copied-helpers-pair'];
const move = rows['cg-git-31122e0c6-pure-move'];

const DEPS = 'gate-engine/coverage/dependencies.mts';
const defines = (text, name) =>
  new RegExp(`^(export\\s+)?(const|function)\\s+${name}\\b`, 'm').test(text ?? '');
// The copies the gate flagged, against the base state of each file that already held one.
const duplicatedHelpers = (files) =>
  ['shellWord', 'canonical'].filter((name) => defines(files[DEPS], name));

describe('commit-guard copied-helpers pair', () => {
  it('the copies are absent at base, present in the bug and gone in the repair', () => {
    expect(duplicatedHelpers(gold.repo.base)).toEqual([]);
    expect(duplicatedHelpers(gold.repo.staged)).toEqual(['shellWord', 'canonical']);
    expect(duplicatedHelpers(repair.repo.staged)).toEqual([]);
  });

  it('the repair keeps one realpath helper: the copy it adds is deleted from gate-shared and failures', () => {
    expect(defines(repair.repo.staged[DEPS], 'canonicalPath')).toBe(true);
    expect(defines(repair.repo.base['gate-engine/coverage/gate-shared.mts'], 'canonicalPath')).toBe(
      true,
    );
    expect(
      defines(repair.repo.staged['gate-engine/coverage/gate-shared.mts'], 'canonicalPath'),
    ).toBe(false);
    expect(defines(repair.repo.staged['gate-engine/coverage/failures.mts'], 'canonical')).toBe(
      false,
    );
  });

  it('both rows share one base, so the pair differs only in what it stages', () => {
    expect(repair.repo.base).toEqual(gold.repo.base);
  });
});

// A move rewires imports and may export what was private: imports are left out (a multi-line import
// is one statement) and a leading `export` is ignored.
const lines = (text) =>
  new Set(
    (text ?? '')
      .replace(/^import\b[\s\S]*?;$/gm, '')
      .split('\n')
      .map((l) => l.trim().replace(/^export /, ''))
      .filter(Boolean),
  );

describe('commit-guard pure-move row', () => {
  it('every deleted line outside imports reappears as an added line in another staged file', () => {
    const { base, staged } = move.repo;
    const added = Object.fromEntries(
      Object.keys(staged).map((f) => [
        f,
        [...lines(staged[f])].filter((l) => !lines(base[f]).has(l)),
      ]),
    );
    for (const file of Object.keys(staged)) {
      const deleted = [...lines(base[file])].filter((l) => !lines(staged[file]).has(l));
      const elsewhere = new Set(Object.entries(added).flatMap(([f, ls]) => (f === file ? [] : ls)));
      expect(
        deleted.filter((l) => !elsewhere.has(l)),
        file,
      ).toEqual([]);
    }
  });
});
