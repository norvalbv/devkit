import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseDecision } from '../decision-format.mts';
import { liveRulingIdOf } from '../recall/note-relations.mts';
import { axisEntries, effectiveScope } from '../recall/retrieval.mts';
import { linkCheck, type Spawn } from '../ruling-checks/enforce.mts';
import { liveLink } from '../ruling-checks/links.mts';

const SCRIPT = fileURLToPath(new URL('../decisions.mts', import.meta.url));
const TODAY = '2026-05-29';
const TARGET = [
  '## Target · 2026-05-01 — Notes land under the live ruling',
  '',
  '**Context:** notes were written past the live ruling',
  '**Ruling:** a note goes to the end of the live ruling section',
  '**Consequences:**',
  '- Positive: readers serve every note',
  '- Negative: the writer reads structure',
  '**Tradeoff:** a parse per note',
  '**Vision-fit:** n/a',
  '**Scope:** src/**',
].join('\n');
// The shape of a real record: hand-written sections after the live Target, one holding a note.
const TAIL = [
  '## Implementation note · 2026-05-02 — Hand-written',
  '',
  'Prose under a hand-written heading.',
  '',
  '## Evidence boundary',
  '',
  'Prose before a stranded note.',
  '- 2026-05-03 — An older note filed under the trailing section.',
].join('\n');

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'decisions-note-placement-'));
  mkdirSync(join(dir, 'docs', 'decisions'), { recursive: true });
  file = join(dir, 'docs', 'decisions', 'axis.md');
  for (const args of [
    ['init', '-q'],
    ['config', 'user.email', 'decisions@test.invalid'],
    ['config', 'user.name', 'Decision Tests'],
  ])
    spawnSync('git', args, { cwd: dir });
  vi.stubEnv('DECISIONS_TODAY', TODAY);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function writeRecord(...blocks: string[]) {
  writeFileSync(
    file,
    [
      '---',
      'slug: axis',
      'created: 2026-05-01',
      '---',
      '',
      '# axis',
      '',
      ...blocks.flatMap((b) => [b, '']),
    ].join('\n'),
  );
}

function run(...args: string[]) {
  return spawnSync('node', [SCRIPT, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, DECISIONS_TODAY: TODAY, DECISIONS_NO_EMBED: '1' },
  });
}

function ok(...args: string[]) {
  const result = run(...args);
  expect(result.status, result.stderr).toBe(0);
  return result;
}

function refused(message: string, ...args: string[]) {
  const before = readFileSync(file, 'utf8');
  const result = run(...args);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(message);
  expect(readFileSync(file, 'utf8')).toBe(before);
  return result;
}

function commit() {
  spawnSync('git', ['add', '.'], { cwd: dir });
  expect(spawnSync('git', ['commit', '-qm', 'baseline'], { cwd: dir }).status).toBe(0);
}

function served(hasTarget = true) {
  const { body } = parseDecision(readFileSync(file, 'utf8'));
  return axisEntries(body, liveRulingIdOf(body, hasTarget)).map((e) => e.text);
}

const tailOf = (text: string) => text.slice(text.indexOf('## Implementation note'));

describe('a note lands in the live ruling section when a later heading follows it', () => {
  it('add --note, rescope and enforce link are all served, and the trailing sections keep every byte', async () => {
    writeRecord(TARGET, TAIL);
    ok('add', 'axis', '--note', 'Placement now follows the parser.');
    expect(served().at(-1)).toBe('Placement now follows the parser.');

    ok('rescope', 'axis', '--scope', 'lib/**', '--reason', 'moved');
    expect(effectiveScope(parseDecision(readFileSync(file, 'utf8')).body)).toBe('lib/**');

    const spawn = vi.fn<Spawn>(() => ({ status: 0 }));
    expect(await linkCheck('axis', 'node check.mjs', 'pins the ruling', dir, spawn)).toBe(0);
    const text = readFileSync(file, 'utf8');
    expect(liveLink(text)?.cmd).toBe('node check.mjs');
    expect(tailOf(text)).toBe(`${TAIL}\n`);
    expect(text.indexOf(`- ${TODAY} — **Check:**`)).toBeLessThan(
      text.indexOf('## Implementation note'),
    );
  });

  it('writes the same bytes as an end-of-file append when the live ruling is the last section', () => {
    writeRecord(TARGET);
    const before = readFileSync(file, 'utf8');
    ok('add', 'axis', '--note', 'Appended as before.');
    expect(readFileSync(file, 'utf8')).toBe(
      `${before.trimEnd()}\n- ${TODAY} — Appended as before.\n`,
    );
  });

  it('notes the last legacy block when an archived section follows it', () => {
    writeRecord(
      '## 2026-04-01 — Old ruling\n\nSuperseded prose.',
      '## 2026-04-10 — Current ruling\n\nCurrent prose.',
      '## [archived — misfiled]\n\n- 2026-04-11 — A misfiled note.',
    );
    ok('add', 'axis', '--note', 'Lands under the current legacy ruling.');
    expect(served(false).at(-1)).toBe('Lands under the current legacy ruling.');
    expect(readFileSync(file, 'utf8')).toMatch(
      /Lands under the current legacy ruling\.\n\n## \[archived/,
    );
  });

  it('refuses a note that would renumber a same-day note below the live ruling', () => {
    writeRecord(TARGET, `## [archived — misfiled]\n\n- ${TODAY} — Filed today, then archived.`);
    refused(
      'already sits under "## [archived — misfiled]"',
      'add',
      'axis',
      '--note',
      'Would take its id.',
    );
  });

  it('enforce link refuses with exit 1, not a crash, when the note cannot be placed', async () => {
    writeRecord(TARGET, `## [archived — misfiled]\n\n- ${TODAY} — Filed today, then archived.`);
    const before = readFileSync(file, 'utf8');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const spawn = vi.fn<Spawn>(() => ({ status: 0 }));
    expect(await linkCheck('axis', 'node check.mjs', 'pins the ruling', dir, spawn)).toBe(1);
    expect(errors.mock.calls.flat().join('\n')).toContain('already sits under "## [archived');
    expect(readFileSync(file, 'utf8')).toBe(before);
    errors.mockRestore();
  });

  it('serves a note on a Target whose free-text field holds a `###` line', () => {
    writeRecord(TARGET.replace('**Scope:**', '**Rejected:** plan A\n### also plan B\n**Scope:**'));
    ok('add', 'axis', '--note', 'Served despite the field heading.');
    expect(served().at(-1)).toBe('Served despite the field heading.');
    ok('rescope', 'axis', '--scope', 'lib/**', '--reason', 'moved');
    expect(effectiveScope(parseDecision(readFileSync(file, 'utf8')).body)).toBe('lib/**');
  });

  it('refuses a note on a record with no ruling heading', () => {
    writeRecord('Prose with no ruling heading.');
    refused('guard-decisions add <slug> --target', 'add', 'axis', '--note', 'Nowhere to land.');
    // A `##` section that is not a ruling must not stand in for one.
    writeRecord('## Notes\n\n- 2026-05-02 — A bullet under a non-ruling heading.');
    refused('guard-decisions add <slug> --target', 'add', 'axis', '--note', 'Nowhere to land.');
  });
});

describe('amend on a draft note that sits above a committed trailing section', () => {
  it('replaces the newest draft, keeps the earlier draft and the trailing bytes', () => {
    writeRecord(TARGET, TAIL);
    commit();
    ok('add', 'axis', '--note', 'First draft.');
    ok('add', 'axis', '--note', 'Second draft.');

    ok('amend', 'axis', '--note', 'Second, corrected.');
    ok('amend', 'axis', '--note-replace', 'corrected', 'final');
    const text = readFileSync(file, 'utf8');
    expect(served().slice(-2)).toEqual(['First draft.', 'Second, final.']);
    expect(text).not.toContain('Second draft.');
    expect(tailOf(text)).toBe(`${TAIL}\n`);
  });

  it('refuses, naming the edited line, when committed history below the draft differs from HEAD', () => {
    writeRecord(TARGET, TAIL);
    commit();
    ok('add', 'axis', '--note', 'A draft.');
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace('Prose under a', 'Edited prose under a'),
    );
    const result = refused(
      'differs from HEAD at "Prose under a hand-written heading."',
      'amend',
      'axis',
      '--note',
      'Changed.',
    );
    expect(result.stderr).not.toContain('restore it');
  });

  it('amends a draft an older CLI wrote at EOF, below the trailing section', () => {
    writeRecord(TARGET, TAIL);
    commit();
    writeFileSync(file, `${readFileSync(file, 'utf8')}- ${TODAY} — Appended at EOF.\n`);
    ok('amend', 'axis', '--note', 'Corrected at EOF.');
    const text = readFileSync(file, 'utf8');
    expect(text).toContain(`- ${TODAY} — Corrected at EOF.`);
    expect(text).not.toContain('Appended at EOF.');
    expect(text).toContain(TAIL);
  });

  it('refuses to amend a draft that repeats a committed note below it', () => {
    writeRecord(TARGET, `## [archived — misfiled]\n\n- ${TODAY} — Confirmed.`);
    commit();
    const committed = readFileSync(file, 'utf8');
    writeFileSync(
      file,
      committed.replace('\n\n## [archived', `\n- ${TODAY} — Confirmed.\n\n## [archived`),
    );
    refused('appears twice and only one is committed', 'amend', 'axis', '--note', 'New.');
  });

  it('resolves --supersedes against a committed note in the trailing section', () => {
    writeRecord(TARGET, TAIL);
    commit();
    ok('add', 'axis', '--note', 'A draft.');
    ok('amend', 'axis', '--note', 'Replaces it.', '--supersedes', 'note:2026-05-03');
    expect(served().at(-1)).toBe('**Amends:** note:2026-05-03 — Replaces it.');
  });

  it('re-targets after the trailing section, and amend --target keeps the notes under it', () => {
    writeRecord(TARGET, TAIL);
    commit();
    const fields = [
      '--context',
      'evidence moved',
      '--ruling',
      'the new ruling',
      '--consequences',
      'c',
      '--tradeoff',
      't',
      '--vision-fit',
      'v',
    ];
    ok('add', 'axis', '--note', 'Drafted under the old Target.');
    ok('add', 'axis', '--target', '--evidence-change', 'a benchmark moved', ...fields);
    ok('add', 'axis', '--note', 'Under the new Target.');
    ok(
      'amend',
      'axis',
      '--target',
      '--evidence-change',
      'a benchmark moved',
      ...fields.slice(0, 3),
      'the amended ruling',
      ...fields.slice(4),
    );
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('the amended ruling');
    expect(served().at(-1)).toBe('Under the new Target.');
    expect(text).toContain(TAIL);
    expect(text.indexOf('Drafted under the old Target.')).toBeLessThan(
      text.indexOf('## Implementation note'),
    );
  });
});
