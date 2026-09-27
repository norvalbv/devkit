import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ConventionFinding,
  parseConventionFindingCandidates,
} from '../evidence/conventions.mts';
import {
  type GroundingSource,
  groundConventionFindings,
  groundedConventionFindings,
  normalizeQuote,
  stagedGroundingSource,
} from '../contracts/conventions-grounding.mts';

const RULE = 'VIOLATION: Keep every file under 500 lines. — CLAUDE.md:3';
const transcript = (...offending: string[]) =>
  [...offending.flatMap((line) => [RULE, `OFFENDING: ${line}`]), 'VERDICT: FAIL — cited'].join(
    '\n',
  );

const numbered = (count: number, first: string) =>
  [first, ...Array.from({ length: count - 1 }, (_, i) => `export const v${i + 2} = ${i + 2};`)]
    .join('\n')
    .concat('\n');

const hunk = (start: number, removed: string[], added: string[]) =>
  [
    'diff --git a/src/flows.ts b/src/flows.ts',
    '--- a/src/flows.ts',
    '+++ b/src/flows.ts',
    `@@ -${start},${removed.length} +${start},${added.length} @@`,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
    '',
  ].join('\n');

function source(files: {
  staged: string | null;
  head: string | null;
  diff: string;
  path?: string;
}): GroundingSource {
  const path = files.path ?? 'src/flows.ts';
  return {
    reviewedFiles: [path],
    readStaged: (file) => (file === path ? files.staged : null),
    readHead: (file) => (file === path ? files.head : null),
    readDiff: (file) => (file === path ? files.diff : ''),
  };
}

const grounded = (raw: string, src: GroundingSource): ConventionFinding[] =>
  groundConventionFindings(parseConventionFindingCandidates(raw), src);

const DISABLE = '/* eslint-disable max-lines */';

describe('groundConventionFindings — story sc-3580', () => {
  // The same 520-line file at HEAD and staged, with one line changed deep inside it.
  const staged = numbered(520, DISABLE).replace('v300 = 300', 'v300 = 301');
  const head = numbered(520, DISABLE);
  const diff = hunk(300, ['export const v300 = 300;'], ['export const v300 = 301;']);

  it('drops a quoted symbol that does not exist in the cited file', () => {
    expect(
      grounded(transcript('FLOW_OUTPUT_SCHEMAS — src/flows.ts:1'), source({ staged, head, diff })),
    ).toEqual([]);
  });

  it('drops a verbatim quote of unchanged size debt in a file that did not grow', () => {
    expect(
      grounded(transcript(`${DISABLE} — src/flows.ts:1`), source({ staged, head, diff })),
    ).toEqual([]);
  });

  it('keeps a size finding once the change grows the file', () => {
    const grown = `${staged}export const extra = 1;\n`;
    const growDiff = hunk(521, [], ['export const extra = 1;']);
    expect(
      grounded(
        transcript(`${DISABLE} — src/flows.ts:1`),
        source({ staged: grown, head, diff: growDiff }),
      ),
    ).toHaveLength(1);
  });

  it('keeps a genuine quote of an added line even when a fabricated pair precedes it', () => {
    const findings = grounded(
      transcript(
        'FLOW_OUTPUT_SCHEMAS — src/flows.ts:1',
        'export const v300 = 301; — src/flows.ts:300',
      ),
      source({ staged, head, diff }),
    );
    expect(findings).toEqual([
      expect.objectContaining({ offendingPath: 'src/flows.ts', offendingLine: 300 }),
    ]);
  });
});

describe('groundedConventionFindings — dedupe after grounding', () => {
  it('keeps a genuine pair that shares its path:line with an earlier fabricated pair', () => {
    const head = 'const a = 1;\n';
    const staged = 'const bad = eval(input);\nconst a = 1;\n';
    const src = source({ staged, head, diff: hunk(1, [], ['const bad = eval(input);']) });
    const raw = transcript(
      'FLOW_OUTPUT_SCHEMAS — src/flows.ts:1',
      'const bad = eval(input); — src/flows.ts:1',
    );
    expect(groundedConventionFindings(raw, src)).toEqual([
      expect.objectContaining({ offendingLine: 1, offendingQuote: 'const bad = eval(input);' }),
    ]);
  });

  it('still reports one finding per path:line when several grounded pairs share it', () => {
    const src = source({
      staged: 'const bad = eval(input);\n',
      head: null,
      diff: '',
    });
    const raw = transcript(
      'const bad = eval(input); — src/flows.ts:1',
      '`const bad = eval(input);` — src/flows.ts:1',
    );
    expect(groundedConventionFindings(raw, src)).toHaveLength(1);
  });
});

describe('groundConventionFindings — quote shapes real judges emit', () => {
  const head = 'const a = 1;\nconst b = 2;\n';
  const staged = 'const a = 1;\n    const bad = eval(input);\nconst b = 2;\n';
  const diff = hunk(2, [], ['    const bad = eval(input);']);
  const src = source({ staged, head, diff });

  it.each([
    ['backticked', '`const bad = eval(input);`'],
    ['diff-marked', '+    const bad = eval(input);'],
    ['indentation stripped', 'const bad = eval(input);'],
    ['double-quoted', '"const bad = eval(input);"'],
    ['truncated with an ellipsis', 'const bad = eval(…'],
    ['truncated with three dots', 'const bad = ev...'],
    ['collapsed inner whitespace', 'const   bad  =  eval(input);'],
  ])('grounds a %s quote', (_form, quote) => {
    expect(grounded(transcript(`${quote} — src/flows.ts:2`), src)).toHaveLength(1);
  });

  it('grounds a quote cited a couple of lines off, but not one far away', () => {
    expect(grounded(transcript('const bad = eval(input); — src/flows.ts:4'), src)).toHaveLength(1);
    expect(grounded(transcript('const bad = eval(input); — src/flows.ts:40'), src)).toEqual([]);
  });

  it('grounds CRLF staged content against an LF quote', () => {
    const crlf = source({
      staged: staged.replaceAll('\n', '\r\n'),
      head: head.replaceAll('\n', '\r\n'),
      diff: hunk(2, [], ['    const bad = eval(input);\r']),
    });
    expect(grounded(transcript('const bad = eval(input); — src/flows.ts:2'), crlf)).toHaveLength(1);
  });

  it('reports every spelling of one cited path under its canonical path, deduped to one lens', () => {
    const raw = transcript(
      'const bad = eval(input); — `src/flows.ts`:2',
      'const bad = eval(input); — ./src/flows.ts:2',
      'const bad = eval(input); — src\\flows.ts:2',
    );
    expect(groundedConventionFindings(raw, src)).toEqual([
      expect.objectContaining({ offendingPath: 'src/flows.ts', offendingLine: 2 }),
    ]);
  });

  it('accepts a backticked, ./-prefixed or backslashed offending path', () => {
    for (const path of ['`src/flows.ts`', './src/flows.ts', 'src\\flows.ts'])
      expect(grounded(transcript(`const bad = eval(input); — ${path}:2`), src)).toHaveLength(1);
  });
});

describe('groundConventionFindings — diff markers bind a quote to its side of the diff', () => {
  const head = 'keep();\n';
  const staged = 'keep();\nfoo();\n';
  const addedOnly = source({ staged, head, diff: hunk(2, [], ['foo();']) });

  it('never grounds a "-" quote against an added line with the same body', () => {
    expect(grounded(transcript('-foo(); — src/flows.ts:2'), addedOnly)).toEqual([]);
  });

  it('grounds a "-" quote against the line the change removes', () => {
    const removed = source({
      staged: 'keep();\n',
      head: 'keep();\nfoo();\n',
      diff: hunk(2, ['foo();'], []),
    });
    expect(grounded(transcript('-foo(); — src/flows.ts:2'), removed)).toHaveLength(1);
  });

  it('never grounds a "+" quote against a line the change only removed', () => {
    const removed = source({
      staged: 'keep();\n',
      head: 'keep();\nfoo();\n',
      diff: hunk(2, ['foo();'], []),
    });
    expect(grounded(transcript('+foo(); — src/flows.ts:2'), removed)).toEqual([]);
  });

  it('never grounds a "+" quote against a removed line that literally starts with "+"', () => {
    const removed = source({
      staged: 'keep();\n',
      head: 'keep();\n+foo();\n',
      diff: hunk(2, ['+foo();'], []),
    });
    expect(grounded(transcript('+foo(); — src/flows.ts:2'), removed)).toEqual([]);
  });

  it('grounds an added line whose own text starts with "-", such as a markdown bullet', () => {
    const doc = source({
      staged: '# Notes\n- never skip hooks\n',
      head: '# Notes\n',
      diff: hunk(2, [], ['- never skip hooks']),
    });
    expect(grounded(transcript('- never skip hooks — src/flows.ts:2'), doc)).toHaveLength(1);
    expect(grounded(transcript('+- never skip hooks — src/flows.ts:2'), doc)).toHaveLength(1);
  });
});

describe('groundConventionFindings — quotes the judge wrapped across lines', () => {
  const wrapped = (location: string) =>
    [
      'VIOLATION: Never build SQL by hand. — CLAUDE.md:3',
      'OFFENDING: db.raw(',
      `query) — ${location}`,
      'VERDICT: FAIL — raw SQL',
    ].join('\n');

  it('grounds a wrapped quote against the added lines it spans', () => {
    const src = source({
      staged: 'const a = 1;\ndb.raw(\n  query)\n',
      head: 'const a = 1;\n',
      diff: hunk(2, [], ['db.raw(', '  query)']),
    });
    expect(grounded(wrapped('src/flows.ts:2'), src)).toHaveLength(1);
  });

  it('grounds a wrapped quote against consecutive removed lines', () => {
    const src = source({
      staged: 'const a = 1;\n',
      head: 'const a = 1;\ndb.raw(\nquery)\n',
      diff: hunk(2, ['db.raw(', 'query)'], []),
    });
    expect(grounded(wrapped('src/flows.ts:2'), src)).toHaveLength(1);
  });

  it('does not ground a wrapped quote whose lines are all unchanged', () => {
    const src = source({
      staged: 'db.raw(\nquery)\nconst b = 2;\n',
      head: 'db.raw(\nquery)\nconst b = 1;\n',
      diff: hunk(3, ['const b = 1;'], ['const b = 2;']),
    });
    expect(grounded(wrapped('src/flows.ts:1'), src)).toEqual([]);
  });
});

describe('groundConventionFindings — guards', () => {
  const head = 'a();\n';
  const staged = 'a();\n}\nconst ok = 1;\n';
  const diff = hunk(2, [], ['}', 'const ok = 1;']);
  const src = source({ staged, head, diff });

  it('drops a quote too short to identify a line', () => {
    expect(grounded(transcript('} — src/flows.ts:2'), src)).toEqual([]);
    expect(grounded(transcript('`});` — src/flows.ts:2'), src)).toEqual([]);
  });

  it('drops a finding on a file outside the reviewed set', () => {
    expect(grounded(transcript('const ok = 1; — src/other.ts:3'), src)).toEqual([]);
  });

  it.each([0, -1, Number.MAX_SAFE_INTEGER])(
    'handles a cited line of %s without throwing',
    (line) => {
      const raw = transcript(`const ok = 1; — src/flows.ts:${line}`);
      expect(() => grounded(raw, src)).not.toThrow();
    },
  );

  it('grounds line 0 against the first lines of the file', () => {
    const top = source({
      staged: 'const ok = 1;\n',
      head: '',
      diff: hunk(1, [], ['const ok = 1;']),
    });
    expect(grounded(transcript('const ok = 1; — src/flows.ts:0'), top)).toHaveLength(1);
  });

  it('never matches an empty quote against every line', () => {
    expect(normalizeQuote('``')).toBeNull();
    expect(normalizeQuote('   ')).toBeNull();
    expect(normalizeQuote('…')).toBeNull();
  });

  it('treats an unreadable staged file as ungrounded rather than throwing', () => {
    const broken: GroundingSource = {
      reviewedFiles: ['src/flows.ts'],
      readStaged: () => {
        throw new Error('git exploded');
      },
      readHead: () => null,
      readDiff: () => '',
    };
    expect(() => grounded(transcript('const ok = 1; — src/flows.ts:3'), broken)).not.toThrow();
    expect(grounded(transcript('const ok = 1; — src/flows.ts:3'), broken)).toEqual([]);
  });
});

describe('groundConventionFindings — removed lines and whole-file changes', () => {
  it('grounds a quote of a line the change deletes', () => {
    const head = '# Title\n## Required header\nbody\n';
    const staged = '# Title\nbody\n';
    const src = source({
      path: 'docs/guide.md',
      staged,
      head,
      diff: hunk(2, ['## Required header'], []).replaceAll('src/flows.ts', 'docs/guide.md'),
    });
    expect(grounded(transcript('## Required header — docs/guide.md:2'), src)).toHaveLength(1);
  });

  it('grounds a deleted file only through its removed lines', () => {
    const src = source({
      staged: null,
      head: 'export const legacy = 1;\n',
      diff: hunk(1, ['export const legacy = 1;'], []),
    });
    expect(grounded(transcript('export const legacy = 1; — src/flows.ts:1'), src)).toHaveLength(1);
    expect(grounded(transcript('FLOW_OUTPUT_SCHEMAS — src/flows.ts:1'), src)).toEqual([]);
  });

  it('treats every line of a brand-new file as part of the change', () => {
    const staged = numbered(600, DISABLE);
    const src = source({ staged, head: null, diff: '' });
    expect(grounded(transcript(`${DISABLE} — src/flows.ts:1`), src)).toHaveLength(1);
  });

  it('does not ground a quote that only appears in unchanged context lines', () => {
    const head = 'const same = 1;\nconst old = 2;\n';
    const staged = 'const same = 1;\nconst neu = 2;\n';
    const diff = [
      'diff --git a/src/flows.ts b/src/flows.ts',
      '--- a/src/flows.ts',
      '+++ b/src/flows.ts',
      '@@ -1,2 +1,2 @@',
      ' const same = 1;',
      '-const old = 2;',
      '+const neu = 2;',
      '',
    ].join('\n');
    expect(
      grounded(transcript('const same = 1; — src/flows.ts:1'), source({ staged, head, diff })),
    ).toEqual([]);
  });
});

describe('stagedGroundingSource — real git index', () => {
  const repos: string[] = [];
  afterEach(() => {
    for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
  });

  const repo = () => {
    const dir = mkdtempSync(join(tmpdir(), 'devkit-grounding-'));
    repos.push(dir);
    const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: dir, stdio: 'pipe' });
    git('init -q');
    git('config user.email t@t');
    git('config user.name t');
    git('config commit.gpgsign false');
    return { dir, git };
  };

  it('ignores a consumer color.ui=always setting when reading hunks', () => {
    const { dir, git } = repo();
    git('config color.ui always');
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'a.ts'), 'const a = 1;\n');
    git('add .');
    git('commit -qm base');
    writeFileSync(join(dir, 'src', 'a.ts'), 'const a = 1;\nconst bad = eval(x);\n');
    git('add .');
    const src = stagedGroundingSource(dir, ['src/a.ts']);
    expect(grounded(transcript('const bad = eval(x); — src/a.ts:2'), src)).toHaveLength(1);
  });

  it('grounds nothing when the index moved after the judge evidence was pinned', () => {
    const { dir, git } = repo();
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'a.ts'), 'const a = 1;\n');
    git('add .');
    git('commit -qm base');
    writeFileSync(join(dir, 'src', 'a.ts'), 'const a = 1;\nconst ok = 2;\n');
    git('add .');
    const pinned = execSync('git write-tree', { cwd: dir, encoding: 'utf8' }).trim();
    expect(
      grounded(
        transcript('const ok = 2; — src/a.ts:2'),
        stagedGroundingSource(dir, ['src/a.ts'], pinned),
      ),
    ).toHaveLength(1);
    writeFileSync(join(dir, 'src', 'a.ts'), 'const a = 1;\nconst ok = 2;\nconst more = 3;\n');
    git('add .');
    expect(
      grounded(
        transcript('const ok = 2; — src/a.ts:2'),
        stagedGroundingSource(dir, ['src/a.ts'], pinned),
      ),
    ).toEqual([]);
  });

  it('grounds nothing once the index moves after the source was created', () => {
    const { dir, git } = repo();
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'a.ts'), 'const a = 1;\n');
    git('add .');
    git('commit -qm base');
    writeFileSync(join(dir, 'src', 'a.ts'), 'const a = 1;\nconst ok = 2;\n');
    git('add .');
    const src = stagedGroundingSource(dir, ['src/a.ts']);
    expect(grounded(transcript('const ok = 2; — src/a.ts:2'), src)).toHaveLength(1);
    writeFileSync(join(dir, 'src', 'a.ts'), 'const a = 1;\nconst ok = 2;\nconst more = 3;\n');
    git('add .');
    expect(grounded(transcript('const ok = 2; — src/a.ts:2'), src)).toEqual([]);
  });

  it('grounds nothing while the index has unmerged paths', () => {
    const { dir, git } = repo();
    writeFileSync(join(dir, 'a.ts'), 'const a = 1;\n');
    git('add .');
    git('commit -qm base');
    git('checkout -qb other');
    writeFileSync(join(dir, 'a.ts'), 'const a = 2;\n');
    git('commit -qam other');
    git('checkout -q -');
    writeFileSync(join(dir, 'a.ts'), 'const a = 3;\n');
    git('commit -qam main');
    try {
      git('merge -q other');
    } catch {
      // expected conflict
    }
    const src = stagedGroundingSource(dir, ['a.ts']);
    expect(grounded(transcript('const a = 3; — a.ts:1'), src)).toEqual([]);
  });

  it('grounds a path containing spaces', () => {
    const { dir, git } = repo();
    mkdirSync(join(dir, 'my src'));
    writeFileSync(join(dir, 'my src', 'a b.ts'), 'const a = 1;\n');
    git('add .');
    git('commit -qm base');
    writeFileSync(join(dir, 'my src', 'a b.ts'), 'const a = 1;\nconst bad = eval(x);\n');
    git('add .');
    const src = stagedGroundingSource(dir, ['my src/a b.ts']);
    expect(grounded(transcript('const bad = eval(x); — my src/a b.ts:2'), src)).toHaveLength(1);
  });

  it('does not treat a pure rename of an over-cap file as new size debt', () => {
    const { dir, git } = repo();
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'old.ts'), numbered(520, DISABLE));
    git('add .');
    git('commit -qm base');
    git('mv src/old.ts src/new.ts');
    const src = stagedGroundingSource(dir, ['src/new.ts']);
    expect(grounded(transcript(`${DISABLE} — src/new.ts:1`), src)).toEqual([]);
  });

  it('grounds against an unborn HEAD (first commit) as a new file', () => {
    const { dir, git } = repo();
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'a.ts'), numbered(510, DISABLE));
    git('add .');
    const src = stagedGroundingSource(dir, ['src/a.ts']);
    expect(grounded(transcript(`${DISABLE} — src/a.ts:1`), src)).toHaveLength(1);
  });

  it('reads each file from git at most once across repeated validations', () => {
    const { dir, git } = repo();
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'a.ts'), 'const a = 1;\n');
    git('add .');
    git('commit -qm base');
    writeFileSync(join(dir, 'src', 'a.ts'), 'const a = 1;\nconst bad = eval(x);\n');
    git('add .');
    const src = stagedGroundingSource(dir, ['src/a.ts']);
    const first = src.readStaged('src/a.ts');
    writeFileSync(join(dir, 'src', 'a.ts'), 'mutated\n');
    git('add .');
    expect(src.readStaged('src/a.ts')).toBe(first);
  });
});
