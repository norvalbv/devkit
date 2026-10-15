import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import antiSlop from '../../../commands/oxc/anti-slop.mts';
import {
  CLEAN_SOURCE,
  commit,
  DICTIONARY_FINDING_SOURCE,
  err,
  FINDING_SOURCE,
  git,
  installedRepository,
  out,
  overlayRepository,
  roots,
  installAntiSlopCommandHarness,
} from './__tests__/_base-capability-fixture.mts';
import { baselineFromGroups, readBaseline, writeBaseline } from './baseline.mts';
import { ANTI_SLOP_BASELINE_REL } from './constants.mts';
import { collectAntiSlopGroups } from './runner.mts';

installAntiSlopCommandHarness();

describe('anti-slop relocation across existing files', () => {
  const OTHER_SOURCE = 'export const other = "other";\n';
  const FILLER = Array.from(
    { length: 12 },
    (_, index) => `export const filler${index} = ${index};\n`,
  ).join('');

  interface DebtEntry {
    file: string;
    count: number;
  }

  function entries(cwd: string): DebtEntry[] {
    // SAFETY: every anti-slop writer validates the baseline schema before these reads.
    const baseline = JSON.parse(readFileSync(join(cwd, ANTI_SLOP_BASELINE_REL), 'utf8')) as {
      entries: DebtEntry[];
    };
    return baseline.entries;
  }

  function debtAt(cwd: string, file: string): number {
    return entries(cwd)
      .filter((entry) => entry.file === file)
      .reduce((sum, entry) => sum + entry.count, 0);
  }

  /** Committed, baselined debt in src/file.ts plus an existing src/other.ts to move it into. */
  function debtRepository(prefix = '', source = `${CLEAN_SOURCE}${FINDING_SOURCE}`): string {
    const cwd = installedRepository(prefix);
    rmSync(join(cwd, ANTI_SLOP_BASELINE_REL));
    writeFileSync(join(cwd, 'src', 'file.ts'), source);
    writeFileSync(join(cwd, 'src', 'other.ts'), OTHER_SOURCE);
    expect(antiSlop(['create'], cwd)).toBe(0);
    commit(cwd, 'adopt debt');
    return cwd;
  }

  /** Move the finding's declaration out of src/file.ts (which survives) into src/other.ts. */
  function moveFinding(cwd: string): void {
    writeFileSync(join(cwd, 'src', 'file.ts'), CLEAN_SOURCE);
    writeFileSync(join(cwd, 'src', 'other.ts'), `${OTHER_SOURCE}${FINDING_SOURCE}`);
    git(cwd, ['add', '-A']);
  }

  it('labels a partial move as relocated debt, re-anchors it once, and passes both gates', () => {
    const cwd = debtRepository();
    moveFinding(cwd);

    expect(antiSlop(['check', '--staged'], cwd)).toBe(1);
    expect(out.join('\n')).toMatch(
      /RELOCATED anti-slop\/no-object-parameters src\/other\.ts:2:\d+ <- src\/file\.ts \(\+1\)/u,
    );
    expect(out.join('\n')).not.toContain('ERROR anti-slop/no-object-parameters src/other.ts');
    expect(err.join('\n')).toContain(
      'anti-slop: FAIL — 0 new, 1 relocated from src/file.ts; baseline unchanged',
    );
    expect(err.join('\n')).toContain(
      '`devkit anti-slop adopt-relocations`, then stage .anti-slop-baseline.json',
    );

    expect(antiSlop(['adopt-relocations'], cwd)).toBe(0);
    expect([debtAt(cwd, 'src/file.ts'), debtAt(cwd, 'src/other.ts')]).toEqual([0, 1]);
    // Re-running before the baseline is staged must not move the same debt twice.
    const path = join(cwd, ANTI_SLOP_BASELINE_REL);
    const historical = new Date('2001-01-01T00:00:00.000Z');
    utimesSync(path, historical, historical);
    const mtimeMs = statSync(path).mtimeMs;
    expect(antiSlop(['adopt-relocations'], cwd)).toBe(0);
    expect(statSync(path).mtimeMs).toBe(mtimeMs);
    expect(out.join('\n')).toContain('adopted 0 relocated finding(s); baseline unchanged');

    git(cwd, ['add', ANTI_SLOP_BASELINE_REL]);
    expect(antiSlop(['check', '--staged'], cwd)).toBe(0);
    expect(out.join('\n')).toContain('accepted 1 relocated baseline finding(s) from src/file.ts');
    expect(antiSlop(['check', '--base', 'HEAD'], cwd)).toBe(0);
    commit(cwd, 'move debt with its baseline');
    expect(antiSlop(['check', '--base', 'HEAD~1'], cwd)).toBe(0);
  });

  it('counts a genuinely new finding apart from relocated debt and adopts only the moved one', () => {
    const cwd = debtRepository();
    moveFinding(cwd);
    writeFileSync(
      join(cwd, 'src', 'other.ts'),
      `${OTHER_SOURCE}${FINDING_SOURCE}${DICTIONARY_FINDING_SOURCE}`,
    );
    git(cwd, ['add', '-A']);

    expect(antiSlop(['check', '--staged'], cwd)).toBe(1);
    expect(err.join('\n')).toMatch(/FAIL — [1-9]\d* new, 1 relocated from src\/file\.ts/u);
    expect(out.join('\n')).toMatch(/ERROR anti-slop\/\S+ src\/other\.ts:5:/u);

    expect(antiSlop(['adopt-relocations'], cwd)).toBe(0);
    expect(debtAt(cwd, 'src/other.ts')).toBe(1);
    git(cwd, ['add', ANTI_SLOP_BASELINE_REL]);
    err.length = 0;
    expect(antiSlop(['check', '--staged'], cwd)).toBe(1);
    expect(err.join('\n')).toMatch(/FAIL — [1-9]\d* new error finding\(s\)/u);
  });

  it('refuses a baseline-only edit that re-anchors debt the source still carries', () => {
    const cwd = debtRepository();
    const sourceKeepsFinding = `${CLEAN_SOURCE}${FINDING_SOURCE}export const touched = 1;\n`;
    writeFileSync(join(cwd, 'src', 'file.ts'), sourceKeepsFinding);
    writeFileSync(join(cwd, 'src', 'other.ts'), `${OTHER_SOURCE}${FINDING_SOURCE}`);
    writeBaseline(cwd, baselineFromGroups(collectAntiSlopGroups(cwd, ['src/other.ts'])));
    git(cwd, ['add', '-A']);

    expect(antiSlop(['check', '--staged'], cwd)).toBe(1);
    expect(err.join('\n')).toContain('BASELINE-GROWTH anti-slop/no-object-parameters src/other.ts');
    err.length = 0;
    expect(antiSlop(['check', '--base', 'HEAD'], cwd)).toBe(1);
    expect(err.join('\n')).toContain('BASELINE-GROWTH anti-slop/no-object-parameters src/other.ts');
    expect(out.join('\n')).not.toContain('relocated baseline finding(s)');
  });

  it('refuses relocated growth when the candidate baseline keeps the source entry', () => {
    const cwd = debtRepository();
    moveFinding(cwd);
    const committed = readBaseline(cwd);
    const moved = baselineFromGroups(collectAntiSlopGroups(cwd, ['src/other.ts']));
    writeBaseline(cwd, {
      ...moved,
      entries: [...(committed?.entries ?? []), ...moved.entries].sort((a, b) =>
        a.fingerprint.localeCompare(b.fingerprint),
      ),
    });
    git(cwd, ['add', '-A']);

    expect(antiSlop(['check', '--staged'], cwd)).toBe(1);
    expect(err.join('\n')).toContain('BASELINE-GROWTH anti-slop/no-object-parameters src/other.ts');
  });

  it('treats a deleted source as vacated when its debt moves into an existing file', () => {
    const cwd = debtRepository();
    rmSync(join(cwd, 'src', 'file.ts'));
    writeFileSync(join(cwd, 'src', 'other.ts'), `${OTHER_SOURCE}${FINDING_SOURCE}`);
    git(cwd, ['add', '-A']);

    expect(antiSlop(['check', '--staged'], cwd)).toBe(1);
    expect(out.join('\n')).toContain('<- src/file.ts (+1)');
    expect(antiSlop(['adopt-relocations'], cwd)).toBe(0);
    expect(entries(cwd).some((entry) => entry.file === 'src/file.ts')).toBe(false);
    git(cwd, ['add', ANTI_SLOP_BASELINE_REL]);
    expect(antiSlop(['check', '--staged'], cwd)).toBe(0);
  });

  it('re-anchors a committed move against the same locked base as the CI check', () => {
    const cwd = debtRepository();
    moveFinding(cwd);
    commit(cwd, 'commit the move without its baseline');
    git(cwd, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    const base = git(cwd, ['rev-parse', 'HEAD~1']);

    expect(antiSlop(['check', '--base', 'HEAD~1'], cwd)).toBe(1);
    expect(err.join('\n')).toContain(`adopt-relocations --base ${base}`);
    expect(antiSlop(['adopt-relocations', '--base', 'origin/main~1'], cwd)).toBe(2);
    expect(err.join('\n')).toContain('--base cannot be locked');
    expect(antiSlop(['adopt-relocations', '--base', 'HEAD~1'], cwd)).toBe(0);
    git(cwd, ['add', ANTI_SLOP_BASELINE_REL]);
    expect(antiSlop(['check', '--base', 'HEAD~1'], cwd)).toBe(0);

    expect(antiSlop(['adopt-relocations', '--base', 'HEAD'], cwd)).toBe(2);
    expect(err.join('\n')).toContain('no lint-evidenced relocations from HEAD to the index');
  });

  it('follows debt through a rename and a partial move out of the renamed file', () => {
    const cwd = debtRepository('', `${FILLER}${FINDING_SOURCE}`);
    git(cwd, ['mv', 'src/file.ts', 'src/renamed.ts']);
    writeFileSync(join(cwd, 'src', 'renamed.ts'), FILLER);
    writeFileSync(join(cwd, 'src', 'other.ts'), `${OTHER_SOURCE}${FINDING_SOURCE}`);
    git(cwd, ['add', '-A']);

    expect(antiSlop(['check', '--staged'], cwd)).toBe(1);
    expect(err.join('\n')).toContain(
      'BASELINE-RENAME anti-slop/no-object-parameters src/file.ts -> src/renamed.ts',
    );
    expect(antiSlop(['adopt-relocations'], cwd)).toBe(2);
    expect(err.join('\n')).toContain('run `devkit anti-slop adopt-renames` first');
    expect(antiSlop(['adopt-renames'], cwd)).toBe(0);
    git(cwd, ['add', ANTI_SLOP_BASELINE_REL]);

    expect(antiSlop(['check', '--staged'], cwd)).toBe(1);
    expect(out.join('\n')).toContain('<- src/renamed.ts (+1)');
    expect(antiSlop(['adopt-relocations'], cwd)).toBe(0);
    git(cwd, ['add', ANTI_SLOP_BASELINE_REL]);
    expect(antiSlop(['check', '--staged'], cwd)).toBe(0);
    expect(entries(cwd).map((entry) => entry.file)).toEqual(['src/other.ts']);
  });

  it('names every source that could supply a moved finding and spends only one', () => {
    const cwd = installedRepository();
    rmSync(join(cwd, ANTI_SLOP_BASELINE_REL));
    writeFileSync(join(cwd, 'src', 'a.ts'), FINDING_SOURCE);
    writeFileSync(join(cwd, 'src', 'b.ts'), FINDING_SOURCE);
    writeFileSync(join(cwd, 'src', 'other.ts'), OTHER_SOURCE);
    expect(antiSlop(['create'], cwd)).toBe(0);
    commit(cwd, 'two sources of one pattern');
    writeFileSync(join(cwd, 'src', 'a.ts'), CLEAN_SOURCE);
    writeFileSync(join(cwd, 'src', 'b.ts'), CLEAN_SOURCE);
    writeFileSync(join(cwd, 'src', 'other.ts'), `${OTHER_SOURCE}${FINDING_SOURCE}`);
    git(cwd, ['add', '-A']);

    expect(antiSlop(['check', '--staged'], cwd)).toBe(1);
    expect(out.join('\n')).toContain('<- src/a.ts, src/b.ts (+1)');
    expect(antiSlop(['adopt-relocations'], cwd)).toBe(0);
    expect(['src/a.ts', 'src/b.ts', 'src/other.ts'].map((file) => debtAt(cwd, file))).toEqual([
      0, 1, 1,
    ]);
    git(cwd, ['add', ANTI_SLOP_BASELINE_REL]);
    expect(antiSlop(['check', '--staged'], cwd)).toBe(0);
  });

  it('fails closed when a scoped CI check never linted the source file', () => {
    const cwd = debtRepository();
    moveFinding(cwd);
    commit(cwd, 'commit the move');

    expect(antiSlop(['check', '--base', 'HEAD~1', '--', 'src/other.ts'], cwd)).toBe(1);
    expect(out.join('\n')).not.toContain('RELOCATED');
    expect(err.join('\n')).toContain('new error finding(s)');
  });

  it('relocates within a monorepo package using package-relative paths', () => {
    const cwd = debtRepository('packages/app');
    moveFinding(cwd);

    expect(antiSlop(['check', '--staged'], cwd)).toBe(1);
    expect(out.join('\n')).toMatch(/src\/other\.ts:2:\d+ <- src\/file\.ts \(\+1\)/u);
    expect(antiSlop(['adopt-relocations'], cwd)).toBe(0);
    git(cwd, ['add', ANTI_SLOP_BASELINE_REL]);
    expect(antiSlop(['check', '--staged'], cwd)).toBe(0);
  });

  it('never relocates debt the source carried without a baseline entry', () => {
    const cwd = installedRepository();
    writeFileSync(join(cwd, 'src', 'file.ts'), `${CLEAN_SOURCE}${FINDING_SOURCE}`);
    writeFileSync(join(cwd, 'src', 'other.ts'), OTHER_SOURCE);
    commit(cwd, 'unbaselined debt');
    moveFinding(cwd);

    expect(antiSlop(['check', '--staged'], cwd)).toBe(1);
    expect(out.join('\n')).not.toContain('RELOCATED');
    expect(err.join('\n')).toContain('1 new error finding(s)');
    expect(antiSlop(['adopt-relocations'], cwd)).toBe(0);
    expect(out.join('\n')).toContain('adopted 0 relocated finding(s)');
  });

  it('classifies nothing without Git evidence and names an empty index instead of succeeding silently', () => {
    const cwd = debtRepository();
    writeFileSync(join(cwd, 'src', 'file.ts'), CLEAN_SOURCE);
    writeFileSync(join(cwd, 'src', 'other.ts'), `${OTHER_SOURCE}${FINDING_SOURCE}`);

    expect(antiSlop(['check'], cwd)).toBe(1);
    expect(out.join('\n')).not.toContain('RELOCATED');
    expect(antiSlop(['adopt-relocations'], cwd)).toBe(0);
    expect(out.join('\n')).toContain('nothing is staged, so stage the moved files first');
    expect(antiSlop(['adopt-relocations', 'src'], cwd)).toBe(2);
    expect(err.join('\n')).toContain('adopt-relocations accepts no flags or paths');
  });

  it('refuses to guess relocations when the base tree cannot be linted', () => {
    const cwd = debtRepository();
    const config = readFileSync(join(cwd, '.oxlintrc.json'), 'utf8');
    writeFileSync(join(cwd, '.oxlintrc.json'), '{}\n');
    commit(cwd, 'base whose consumer config does not load the managed base');
    writeFileSync(join(cwd, '.oxlintrc.json'), config);
    moveFinding(cwd);

    expect(antiSlop(['check', '--staged'], cwd)).toBe(1);
    expect(out.join('\n')).not.toContain('RELOCATED');
    expect(out.join('\n')).toContain('ERROR anti-slop/no-object-parameters src/other.ts');
    expect(antiSlop(['adopt-relocations'], cwd)).toBe(2);
    expect(err.join('\n')).toContain('relocation evidence unavailable');
  });

  it('refuses to plan relocations from an index that changed after the write guard captured it', () => {
    const cwd = debtRepository();
    moveFinding(cwd);
    writeFileSync(join(cwd, 'src', 'extra.ts'), CLEAN_SOURCE);
    const path = join(cwd, ANTI_SLOP_BASELINE_REL);
    const before = readFileSync(path, 'utf8');
    const delegatePath = process.env.PATH;
    if (!delegatePath) throw new Error('test requires PATH to locate Git');
    const shim = mkdtempSync(join(tmpdir(), 'devkit-anti-slop-aba-shim-'));
    roots.push(shim);
    // The SECOND write-tree (the plan's snapshot) sees an extra staged file that is unstaged again
    // before the write guard re-reads the index — a stage-then-revert between the two reads.
    writeFileSync(
      join(shim, 'git'),
      [
        '#!/bin/sh',
        'PATH="$DEVKIT_TEST_GIT_PATH"; export PATH',
        'if [ "$1" = "write-tree" ]; then',
        `  count=$(cat "${shim}/count" 2>/dev/null || echo 0); count=$((count + 1)); echo "$count" > "${shim}/count"`,
        '  if [ "$count" = 2 ]; then',
        '    git add -- src/extra.ts; tree=$(git write-tree); git rm -q --cached -- src/extra.ts',
        '    echo "$tree"; exit 0',
        '  fi',
        'fi',
        'exec git "$@"',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    process.env.DEVKIT_TEST_GIT_PATH = delegatePath;
    process.env.PATH = `${shim}:${delegatePath}`;
    try {
      expect(() => antiSlop(['adopt-relocations'], cwd)).toThrow(
        'Git index changed while relocations were being planned',
      );
    } finally {
      process.env.PATH = delegatePath;
      delete process.env.DEVKIT_TEST_GIT_PATH;
    }
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  /** An overlay install: git-excluded capability and baseline, with committed debt in src/file.ts. */
  function overlayDebtRepository(source = `${CLEAN_SOURCE}${FINDING_SOURCE}`): string {
    const root = overlayRepository();
    writeFileSync(join(root, 'src', 'file.ts'), source);
    writeFileSync(join(root, 'src', 'other.ts'), OTHER_SOURCE);
    expect(antiSlop(['create'], root)).toBe(0);
    commit(root, 'overlay debt');
    return root;
  }

  it('relocates and re-anchors in an overlay install, where --base stays refused', () => {
    const root = overlayDebtRepository();
    moveFinding(root);

    expect(antiSlop(['check', '--staged'], root)).toBe(1);
    expect(out.join('\n')).toContain('<- src/file.ts (+1)');
    expect(out.join('\n')).toContain('anti-slop: overlay');
    expect(antiSlop(['adopt-relocations', '--base', 'HEAD'], root)).toBe(2);
    expect(err.join('\n')).toContain('--base is unavailable in an overlay install');
    expect(antiSlop(['adopt-relocations'], root)).toBe(0);
    expect(antiSlop(['check', '--staged'], root)).toBe(0);
  });

  it('re-keys overlay debt across a staged rename, without adopting a new finding', () => {
    const root = overlayDebtRepository();
    const debt = debtAt(root, 'src/file.ts');
    git(root, ['mv', 'src/file.ts', 'src/renamed.ts']);

    expect(antiSlop(['check', '--staged'], root)).toBe(1);
    expect(err.join('\n')).toContain('persist renamed debt with `devkit anti-slop adopt-renames`');
    expect(err.join('\n')).not.toContain('stage the baseline');
    expect(out.join('\n')).toContain('anti-slop: overlay');
    expect(antiSlop(['adopt-renames', '--base', 'HEAD'], root)).toBe(2);
    expect(err.join('\n')).toContain('--base is unavailable in an overlay install');
    expect(antiSlop(['adopt-renames'], root)).toBe(0);
    expect(out.join('\n')).not.toContain(`stage ${ANTI_SLOP_BASELINE_REL}`);
    expect(debtAt(root, 'src/file.ts')).toBe(0);
    expect(debtAt(root, 'src/renamed.ts')).toBe(debt);
    expect(antiSlop(['check', '--staged'], root)).toBe(0);
    expect(antiSlop(['check', 'src/renamed.ts'], root)).toBe(0);

    appendFileSync(join(root, 'src', 'renamed.ts'), DICTIONARY_FINDING_SOURCE);
    git(root, ['add', '-A']);
    expect(antiSlop(['check', '--staged'], root)).toBe(1);
    expect(err.join('\n')).toContain('1 new error finding(s)');
    expect(debtAt(root, 'src/renamed.ts')).toBe(debt);
  });

  it('passes an overlay rename that also fixes the debt, with nothing left to re-key', () => {
    const root = overlayDebtRepository(`${FILLER}${FINDING_SOURCE}`);
    git(root, ['mv', 'src/file.ts', 'src/renamed.ts']);
    writeFileSync(join(root, 'src', 'renamed.ts'), FILLER);
    git(root, ['add', '-A']);
    expect(git(root, ['diff', '--cached', '--name-status', '-M'])).toContain('src/renamed.ts');
    expect(git(root, ['diff', '--cached', '--name-status', '-M'])).toMatch(/^R/u);

    expect(antiSlop(['check', '--staged'], root)).toBe(0);
    expect(err.join('\n')).not.toContain('BASELINE-RENAME');
  });
});
