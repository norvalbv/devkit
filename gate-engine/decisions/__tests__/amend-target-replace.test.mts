import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../decisions.mts', import.meta.url));
const RULING = 'Searches stay exact-v1, and find is allowed. Redirections are refused';

let dir: string;
let file: string;
let index: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'decisions-target-replace-'));
  file = join(dir, 'axis.md');
  index = join(dir, 'INDEX.md');
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'decisions@test.invalid'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'Decision Tests'], { cwd: dir });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(args: string[]) {
  return spawnSync('node', [SCRIPT, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GUARD_DECISIONS_DIR: dir,
      DECISIONS_TODAY: '2026-05-29',
      DECISIONS_NO_EMBED: '1',
      DECISIONS_INDEX: join(dir, 'vec-index.json'),
    },
  });
}

function addTarget(extra: string[] = [], context = 'agents kept rewriting the whole record') {
  const added = run([
    'add',
    'axis',
    '--target',
    '--new',
    '--context',
    context,
    '--ruling',
    RULING,
    '--consequences',
    'one-clause edits are cheap',
    '--tradeoff',
    'one more amend mode',
    '--vision-fit',
    'friendly dev tool for everyone',
    '--scope',
    'gate-engine/decisions/**',
    ...extra,
  ]);
  expect(added.status, added.stderr).toBe(0);
}

function commitAll() {
  spawnSync('git', ['add', '.'], { cwd: dir });
  const result = spawnSync('git', ['commit', '-qm', 'baseline'], { cwd: dir, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
}

function expectRefused(args: string[], message: string) {
  const before = readFileSync(file, 'utf8');
  const beforeIndex = readFileSync(index, 'utf8');
  const result = run(['amend', 'axis', ...args]);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(message);
  expect(readFileSync(file, 'utf8')).toBe(before);
  expect(readFileSync(index, 'utf8')).toBe(beforeIndex);
}

describe('amend --target-replace', () => {
  it('changes one clause of a draft Ruling, keeps every other byte, and refreshes INDEX', () => {
    addTarget(['--title', 'Explicit exact-v1 title']);
    const before = readFileSync(file, 'utf8');
    const beforeIndex = readFileSync(index, 'utf8');

    const amended = run(['amend', 'axis', '--target-replace', 'Redirections', 'Pipes']);

    expect(amended.status, amended.stderr).toBe(0);
    expect(amended.stdout).toContain('Amended draft target on "axis" (2026-05-29).');
    expect(readFileSync(file, 'utf8')).toBe(before.replace('Redirections', 'Pipes'));
    expect(readFileSync(index, 'utf8')).toBe(beforeIndex.replace('Redirections', 'Pipes'));
  });

  it('re-derives an auto-generated heading title and keeps an explicit one', () => {
    addTarget();
    const auto = readFileSync(file, 'utf8');
    expect(auto).toContain('## Target · 2026-05-29 — Searches stay exact-v1, and find is allowed');
    expect(run(['amend', 'axis', '--target-replace', 'exact-v1', 'exact-v2']).status).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(auto.replaceAll('exact-v1', 'exact-v2'));

    rmSync(file);
    addTarget(['--title', 'Explicit exact-v1 title']);
    const explicit = readFileSync(file, 'utf8');
    expect(
      run(['amend', 'axis', '--target-replace', 'stay exact-v1', 'stay exact-v2']).status,
    ).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(explicit.replace('stay exact-v1', 'stay exact-v2'));
    expect(readFileSync(file, 'utf8')).toContain('— Explicit exact-v1 title');
  });

  it('keeps trailing draft notes byte-identical and never matches inside them', () => {
    addTarget();
    expect(run(['add', 'axis', '--note', 'only-in-note detail']).status).toBe(0);
    const before = readFileSync(file, 'utf8');

    expectRefused(
      ['--target-replace', 'only-in-note', 'x'],
      'does not occur in the newest draft Target',
    );
    expect(run(['amend', 'axis', '--target-replace', 'Redirections', 'Pipes']).status).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(before.replace('Redirections', 'Pipes'));
  });

  it('never matches inside an archived section that follows the Target', () => {
    addTarget();
    writeFileSync(
      file,
      `${readFileSync(file, 'utf8')}\n## [archived — impl-note, not an epic]\n\nlegacy archived clause\n`,
    );
    expectRefused(
      ['--target-replace', 'legacy archived clause', 'x'],
      'does not occur in the newest draft Target',
    );
  });

  it('refuses a missing or ambiguous substring', () => {
    addTarget();
    expectRefused(
      ['--target-replace', 'absent text', 'x'],
      'does not occur in the newest draft Target',
    );
    expectRefused(['--target-replace', 'one', 'x'], 'occurs 3 times in the newest draft Target');
  });

  it('refuses a committed Target with the re-target remedy', () => {
    addTarget();
    commitAll();
    expectRefused(['--target-replace', 'Redirections', 'Pipes'], 'is already committed; re-target');
  });

  it('refuses an edit that changes a field label or empties a field', () => {
    addTarget();
    expectRefused(['--target-replace', 'Scope:**', 'Scop:**'], 'would change a **Field:** label');
    expectRefused(
      ['--target-replace', 'gate-engine/decisions/**', ''],
      'would change a **Field:** label or empty a field',
    );
  });

  it('refuses an edit that drops a Consequences bullet marker or empties its value', () => {
    addTarget();
    expectRefused(['--target-replace', '- Negative: ', ''], 'would change a **Field:** label');
    expectRefused(['--target-replace', 'one more amend mode', ''], 'or empty a field');
  });

  it('refuses a <new> that starts a heading or note line inside a multi-line field', () => {
    addTarget([], 'first line\nsecond line');
    for (const intruder of ['## Pipes', '## Target · 2026-05-30 — x', '- 2026-05-30 — x']) {
      expectRefused(
        ['--target-replace', 'second line', intruder],
        'would start a new heading or note',
      );
    }
    expect(run(['amend', 'axis', '--target-replace', 'second line', 'Pipes ## x']).status).toBe(0);
  });

  it('refuses a Category the write-time vocabulary does not allow', () => {
    addTarget(['--category', 'decision-log']);
    expectRefused(['--target-replace', 'decision-log', 'decision-logs'], 'Unknown category');
    expect(run(['amend', 'axis', '--target-replace', 'decision-log', 'commit-gates']).status).toBe(
      0,
    );
  });

  it('writes shell-hostile <new> text literally', () => {
    addTarget();
    const before = readFileSync(file, 'utf8');
    const literal = String.raw`f\ind, $& and $(cmd)`;
    const amended = run(['amend', 'axis', '--target-replace', 'Redirections', literal]);
    expect(amended.status, amended.stderr).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(before.split('Redirections').join(literal));
  });

  it('edits only the appended draft Target and leaves the committed one byte-identical', () => {
    addTarget();
    commitAll();
    const committed = readFileSync(file, 'utf8');
    const appended = run([
      'add',
      'axis',
      '--target',
      '--context',
      'the narrower contract shipped',
      '--ruling',
      'Searches stay exact-v1 and Redirections stay refused',
      '--consequences',
      'pos',
      '--tradeoff',
      'neg',
      '--vision-fit',
      'fit',
      '--evidence-change',
      'review narrowed the contract',
    ]);
    expect(appended.status, appended.stderr).toBe(0);
    const draft = readFileSync(file, 'utf8').slice(committed.trimEnd().length);

    const amended = run(['amend', 'axis', '--target-replace', 'Redirections', 'Pipes']);

    expect(amended.status, amended.stderr).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(
      committed.trimEnd() + draft.replaceAll('Redirections', 'Pipes'),
    );
    expect(readFileSync(index, 'utf8')).toContain('Searches stay exact-v1 and Pipes stay refused');
  });

  it('refuses a multi-line <old> and folds a multi-line <new> with a warning', () => {
    addTarget();
    expectRefused(
      ['--target-replace', 'cheap\n- Negative: one', 'x'],
      'requires a single-line "<old>" substring',
    );
    const before = readFileSync(file, 'utf8');
    const amended = run([
      'amend',
      'axis',
      '--target-replace',
      'Redirections',
      'Pipes\nand redirections',
    ]);
    expect(amended.status, amended.stderr).toBe(0);
    expect(amended.stderr).toContain('line breaks in --target-replace were joined');
    expect(readFileSync(file, 'utf8')).toBe(
      before.replace('Redirections', 'Pipes and redirections'),
    );
  });

  it('requires a single mode and both replacement arguments', () => {
    addTarget();
    expectRefused(
      ['--target-replace', 'Redirections', 'Pipes', '--note-replace', 'a', 'b'],
      'Usage: guard-decisions amend',
    );
    expectRefused(['--target-replace', 'Redirections'], 'requires both "<old>" and "<new>"');
    expectRefused(['--target-replace', '', 'Pipes'], 'requires a non-empty "<old>" substring');
  });

  it('keeps CRLF line endings outside the replaced clause', () => {
    addTarget();
    const crlf = readFileSync(file, 'utf8').replace(/\n/g, '\r\n');
    writeFileSync(file, crlf);

    const amended = run(['amend', 'axis', '--target-replace', 'Redirections', 'Pipes']);

    expect(amended.status, amended.stderr).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(crlf.replace('Redirections', 'Pipes'));
    expect(readFileSync(index, 'utf8')).toContain('Pipes are refused');
  });
});
