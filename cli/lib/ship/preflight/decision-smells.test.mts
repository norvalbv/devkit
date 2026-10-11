import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adviseStaged, renderAdvisory } from './decision-smells.mts';

const CLI = fileURLToPath(new URL('./decision-smells.mts', import.meta.url));
const BIG = `${Array.from({ length: 150 }, (_, i) => `line ${i}`).join('\n')}\n`;

let dir: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });

/** A repo whose staged set deletes a 150-line tracked file — the legacy-deletion smell. */
function seedDeletion(ignore = '') {
  dir = mkdtempSync(join(tmpdir(), 'dec-advise-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'a');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'old.ts'), BIG);
  writeFileSync(join(dir, '.gitignore'), ignore);
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  git('rm', '-q', 'old.ts');
}

const prevNoLog = process.env.GUARD_NO_LOG;
beforeEach(() => delete process.env.GUARD_NO_LOG);
afterEach(() => {
  if (prevNoLog === undefined) delete process.env.GUARD_NO_LOG;
  else process.env.GUARD_NO_LOG = prevNoLog;
  rmSync(dir, { recursive: true, force: true });
});

describe('decision advisory', () => {
  it('names the smell and file, with the stage-a-record remedy when the dir is tracked', () => {
    seedDeletion();
    const lines = adviseStaged(dir, dir);
    expect(lines[0]).toMatch(/legacy-deletion — old\.ts/);
    expect(lines[1]).toMatch(/pass the record's path to devkit ship/);
  });

  it('warns against passing a record when the decisions dir is git-ignored', () => {
    seedDeletion('docs/decisions/\n');
    const lines = adviseStaged(dir, dir);
    expect(lines[0]).toMatch(/legacy-deletion — old\.ts/);
    expect(lines[1]).toMatch(/docs\/decisions is git-ignored here: do not pass a record/);
    expect(lines[1]).toMatch(/GUARD_NO_LOG=1 needs the user's OK/);
  });

  it('names the configured decisionsDir when an overlay ignores it through .git/info/exclude', () => {
    seedDeletion();
    writeFileSync(join(dir, 'guard.config.json'), '{"decisionsDir": ".devkit/decisions"}\n');
    writeFileSync(join(dir, '.git/info/exclude'), '.devkit\n');
    const lines = adviseStaged(dir, dir);
    expect(lines[1]).toMatch(/^ {3}\.devkit\/decisions is git-ignored here/);
  });

  it('is silent when a decision record is staged, as the real gate would pass', () => {
    seedDeletion();
    mkdirSync(join(dir, 'docs/decisions'), { recursive: true });
    writeFileSync(join(dir, 'docs/decisions/x.md'), '# x\n');
    git('add', 'docs/decisions/x.md');
    expect(adviseStaged(dir, dir)).toEqual([]);
  });

  it('is silent under GUARD_NO_LOG and when nothing smells', () => {
    seedDeletion();
    process.env.GUARD_NO_LOG = '1';
    expect(adviseStaged(dir, dir)).toEqual([]);
    delete process.env.GUARD_NO_LOG;
    git('reset', '-q');
    expect(adviseStaged(dir, dir)).toEqual([]);
    expect(renderAdvisory([], false, 'docs/decisions')).toEqual([]);
  });

  it('exits 0 silently as a CLI when the config cannot be read', () => {
    seedDeletion();
    writeFileSync(join(dir, 'guard.config.json'), '{not json');
    const r = spawnSync(process.execPath, [CLI, '--root', dir], { cwd: dir, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });
});
