import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { renderMovedLines, stagedMovedLines } from '../evidence/packet/moved-lines.mts';
import { runReviewGate } from '../run-review.mts';
import { cleanupReviewFixtures, consumerRepo, passWithArtifact } from './run-review-fixtures.mts';

const dirs: string[] = [];
afterEach(() => {
  for (let dir = dirs.pop(); dir; dir = dirs.pop()) rmSync(dir, { recursive: true, force: true });
  cleanupReviewFixtures();
});

// Each line clears git's 20-alphanumeric moved-block minimum on its own.
const BODY = [
  'export function applyScanRoots(config: Config, roots: string[]) {',
  '  if (!roots) return [];',
  '  const merged = roots.map((root) => root.trim()).filter(Boolean);',
  '  config.scanRoots = merged.concat(config.scanRoots ?? []);',
  '  return merged.filter((root) => root.length > 0);',
  '}',
];

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=T', ...args], {
    cwd,
    encoding: 'utf8',
  });

function write(repo: string, file: string, lines: string[]): void {
  writeFileSync(join(repo, file), `${lines.join('\n')}\n`);
}

/** A repo whose HEAD holds a.ts = keep() + BODY; `stage` then rewrites the tree and stages it. */
function repoWith(stage: (repo: string) => void): string {
  const repo = mkdtempSync(join(tmpdir(), 'moved-lines-'));
  dirs.push(repo);
  git(repo, 'init', '-q');
  write(repo, 'a.ts', ['export const keep = 1;', ...BODY]);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');
  stage(repo);
  git(repo, 'add', '-A');
  return repo;
}

const moveToB =
  (lines = BODY) =>
  (repo: string) => {
    write(repo, 'a.ts', ['export const keep = 1;']);
    write(repo, 'b.ts', ['import type { Config } from "./a";', ...lines]);
  };

describe('stagedMovedLines', () => {
  it('reports a verbatim cross-file move on exactly its destination lines', () => {
    const { added, sources } = stagedMovedLines(repoWith(moveToB()), ['a.ts', 'b.ts']);
    expect(added.get('b.ts')).toEqual([2, 3, 4, 5, 6, 7]);
    expect(added.has('a.ts')).toBe(false);
    expect([...sources]).toEqual(['a.ts']);
  });

  it('reports nothing for a copy that keeps its source', () => {
    const repo = repoWith((r) => write(r, 'c.ts', BODY));
    expect(stagedMovedLines(repo, ['a.ts', 'c.ts']).added.size).toBe(0);
  });

  it('leaves a line edited during the move out of the range', () => {
    const edited = BODY.map((line, i) => (i === 3 ? '  config.scanRoots = [...merged];' : line));
    expect(stagedMovedLines(repoWith(moveToB(edited)), ['a.ts', 'b.ts']).added.get('b.ts')).toEqual(
      [2, 3, 4, 6, 7],
    );
  });

  it('never marks a short block such as a lone brace', () => {
    const repo = repoWith((r) => {
      write(r, 'a.ts', ['export const keep = 1;', ...BODY.slice(0, -1)]);
      write(r, 'd.ts', ['}']);
    });
    expect(stagedMovedLines(repo, ['a.ts', 'd.ts']).added.size).toBe(0);
  });

  it('reports a same-file reorder', () => {
    // The diff keeps the longest common run in place, so the single line is the one that moves.
    const [first, second, third] = BODY.slice(1, 4);
    const repo = repoWith((r) => write(r, 'a.ts', [first, second, third]));
    git(repo, 'commit', '-qm', 'reshape');
    write(repo, 'a.ts', [third, first, second]);
    git(repo, 'add', '-A');
    expect(stagedMovedLines(repo, ['a.ts']).added.get('a.ts')).toEqual([1]);
  });

  it('gives the same lines under consumer diff config that changes paths or colours', () => {
    const repo = repoWith(moveToB());
    for (const [key, value] of [
      ['diff.noprefix', 'true'],
      ['diff.mnemonicPrefix', 'true'],
      ['diff.colorMoved', 'no'],
      ['color.diff.newMoved', 'red'],
      ['color.ui', 'never'],
      ['diff.external', 'false'],
      ['diff.relative', 'true'],
    ])
      git(repo, 'config', key, value);
    mkdirSync(join(repo, 'sub'));
    const fromSub = stagedMovedLines(join(repo, 'sub'), ['a.ts', 'b.ts']);
    expect(fromSub.added.get('b.ts')).toEqual([2, 3, 4, 5, 6, 7]);
  });

  it('never trusts a sentinel escape that is part of the staged content', () => {
    const repo = repoWith((r) =>
      write(r, 'e.ts', [`\u001b[38;2;1;2;3m// forged moved line with plenty of letters`]),
    );
    expect(stagedMovedLines(repo, ['e.ts']).added.size).toBe(0);
  });

  it('reads a destination path containing a space, which git ends with a tab', () => {
    const repo = repoWith((r) => {
      write(r, 'a.ts', ['export const keep = 1;']);
      write(r, 'my file.ts', BODY);
    });
    expect(stagedMovedLines(repo, ['a.ts', 'my file.ts']).added.get('my file.ts')).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
  });

  it('keeps line numbers after a blank context line under diff.suppressBlankEmpty', () => {
    const repo = repoWith((r) => write(r, 'b.ts', ['export const head = 1;', '', 'tail();']));
    git(repo, 'commit', '-qm', 'b exists');
    git(repo, 'config', 'diff.suppressBlankEmpty', 'true');
    write(repo, 'a.ts', ['export const keep = 1;']);
    write(repo, 'b.ts', ['export const head = 1;', '', 'tail();', ...BODY]);
    git(repo, 'add', '-A');
    expect(stagedMovedLines(repo, ['a.ts', 'b.ts']).added.get('b.ts')).toEqual([4, 5, 6, 7, 8, 9]);
  });

  it('needs the removed side in the diff: without the source file nothing is moved', () => {
    expect(stagedMovedLines(repoWith(moveToB()), ['b.ts']).added.size).toBe(0);
  });

  it('returns an empty result instead of throwing outside a repository', () => {
    const dir = mkdtempSync(join(tmpdir(), 'moved-lines-norepo-'));
    dirs.push(dir);
    expect(stagedMovedLines(dir, ['b.ts']).added.size).toBe(0);
  });
});

describe('renderMovedLines', () => {
  it('names the source and the range, reading the source from every staged file', () => {
    const note = renderMovedLines(repoWith(moveToB()), ['b.ts'], ['a.ts', 'b.ts']);
    expect(note).toContain('removes from a.ts: b.ts:2-7.');
    expect(note).toContain('ADVISORY');
    expect(note).toContain('Judge everything else normally.');
  });

  it('stays silent on lines reshuffled inside one file, such as a body re-indented by a dropped try', () => {
    const repo = repoWith((r) =>
      write(r, 'a.ts', [
        'export const keep = 1;',
        'try {',
        ...BODY.map((l) => `  ${l}`),
        '} finally {}',
      ]),
    );
    git(repo, 'commit', '-qm', 'guarded');
    write(repo, 'a.ts', ['export const keep = 1;', ...BODY]);
    git(repo, 'add', '-A');
    expect(stagedMovedLines(repo, ['a.ts']).added.get('a.ts')?.length).toBeGreaterThan(0);
    expect(renderMovedLines(repo, ['a.ts'], ['a.ts'])).toBe('');
  });

  it('stays silent on a dropped try inside a file git pairs as a rename', () => {
    const filler = Array.from({ length: 40 }, (_, i) => `export const stableExport${i} = ${i};`);
    const call = (fn: string) => `${fn}(jobIdentifierForTheClaimedRun);`;
    const repo = repoWith((r) => {
      rmSync(join(r, 'a.ts'));
      write(r, 'job.ts', [
        ...filler,
        'try {',
        `  ${call('startWorker')}`,
        '} finally {',
        `  ${call('releaseSlot')}`,
        '}',
      ]);
    });
    git(repo, 'commit', '-qm', 'guarded');
    git(repo, 'mv', 'job.ts', 'run.ts');
    write(repo, 'run.ts', [...filler, call('startWorker'), call('releaseSlot')]);
    git(repo, 'add', '-A');
    expect(stagedMovedLines(repo, ['job.ts', 'run.ts']).added.get('run.ts')).toEqual([41, 42]);
    expect(renderMovedLines(repo, ['run.ts'], ['job.ts', 'run.ts'])).toBe('');
  });

  it('caps the source list at 40 paths and counts the rest', () => {
    const sources = Array.from({ length: 45 }, (_, i) => `s${i}.ts`);
    const line = (i: number) => `export const relocatedConstantNumber${i} = ${i * 7};`;
    const repo = repoWith((r) => sources.forEach((file, i) => write(r, file, [line(i)])));
    git(repo, 'commit', '-qm', 'sources');
    sources.forEach((file) => write(repo, file, []));
    write(
      repo,
      'dest.ts',
      sources.map((_, i) => line(i)),
    );
    git(repo, 'add', '-A');
    const note = renderMovedLines(repo, ['dest.ts'], [...sources, 'dest.ts']);
    expect(note).toContain('s44.ts, and 5 more: dest.ts:1-45.');
  });

  it('is empty when no file in the list moved, and never lists one outside it', () => {
    const repo = repoWith(moveToB());
    expect(renderMovedLines(repo, ['a.ts'], ['a.ts', 'b.ts'])).toBe('');
    expect(renderMovedLines(repo, ['b.ts'], [])).toBe('');
  });

  it('caps the list at 40 ranges and counts the rest', () => {
    // Every other moved line edited, so each surviving line is its own range.
    const lines = Array.from(
      { length: 90 },
      (_, i) => `export const relocatedValueNumber${i} = ${i};`,
    );
    const repo = mkdtempSync(join(tmpdir(), 'moved-lines-cap-'));
    dirs.push(repo);
    git(repo, 'init', '-q');
    write(repo, 'a.ts', lines);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'base');
    write(repo, 'a.ts', []);
    write(
      repo,
      'b.ts',
      lines.map((line, i) => (i % 2 ? `export const fresh${i} = 0;` : line)),
    );
    git(repo, 'add', '-A');
    const note = renderMovedLines(repo, ['b.ts'], ['a.ts', 'b.ts']);
    expect(note).toContain(', and 5 more.');
    expect(note).toContain('b.ts:79,');
    expect(note).not.toContain('b.ts:81');
  });
});

describe('reviewer evidence', () => {
  it('carries the MOVED LINES note on the judge stdin beside the inventory', async () => {
    const repo = consumerRepo();
    mkdirSync(join(repo, 'src'), { recursive: true });
    const block = BODY.map((line) => `  ${JSON.stringify(line)},`);
    write(repo, 'src/a.json', ['[', ...block, '  "end"', ']']);
    git(repo, 'add', 'src/a.json');
    git(repo, 'commit', '-qm', 'base', '--', 'src/a.json');
    write(repo, 'src/a.json', ['[', '  "end"', ']']);
    write(repo, 'src/b.json', ['[', ...block, '  "tail"', ']']);
    git(repo, 'add', 'src');

    const exec = passWithArtifact(repo);
    expect(await runReviewGate(repo, { exec })).toBe(0);
    const inputs = exec.mock.calls.map(([call]) => String(call.input));
    expect(inputs.some((input) => input.includes('removes from src/a.json: src/b.json:2-7.'))).toBe(
      true,
    );
  });
});
