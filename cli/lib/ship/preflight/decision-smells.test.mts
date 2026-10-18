import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adviseStaged, renderAdvisory } from './decision-smells.mts';

const CLI = fileURLToPath(new URL('./decision-smells.mts', import.meta.url));
const BIG = `${Array.from({ length: 150 }, (_, i) => `line ${i}`).join('\n')}\n`;
const ENV_KEYS = ['GUARD_NO_LOG', 'GUARD_DECISION_NO_LLM'] as const;

let dir: string;
let extra: string | undefined;
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

/** Makes the decisions dir a symlink to a directory outside the repo, as an overlay worktree links it. */
function symlinkDecisionsDir() {
  extra = mkdtempSync(join(tmpdir(), 'dec-advise-target-'));
  mkdirSync(join(dir, 'docs'));
  symlinkSync(extra, join(dir, 'docs/decisions'));
}

const saved = ENV_KEYS.map((k) => [k, process.env[k]] as const);
beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
  if (extra) rmSync(extra, { recursive: true, force: true });
  extra = undefined;
});

describe('decision advisory', () => {
  it('names the smell and file, says the judge may clear it, and offers a record when tracked', () => {
    seedDeletion();
    const lines = adviseStaged(dir, dir);
    expect(lines[0]).toMatch(
      /decision smell \(regex only, not a verdict\): legacy-deletion — old\.ts/,
    );
    expect(lines[1]).toMatch(/No action needed now: .* may clear this as ROUTINE/);
    expect(lines[2]).toMatch(/If it blocks: .*pass the record's path to devkit ship/);
  });

  it('warns against passing a record when the decisions dir is git-ignored', () => {
    seedDeletion('docs/decisions/\n');
    const lines = adviseStaged(dir, dir);
    expect(lines[0]).toMatch(/legacy-deletion — old\.ts/);
    expect(lines[2]).toMatch(/docs\/decisions is git-ignored here, so do not pass a record/);
    expect(lines[2]).toMatch(/GUARD_NO_LOG=1 only with the user's OK/);
  });

  it('names the configured decisionsDir when an overlay ignores it through .git/info/exclude', () => {
    seedDeletion();
    writeFileSync(join(dir, 'guard.config.json'), '{"decisionsDir": ".devkit/decisions"}\n');
    writeFileSync(join(dir, '.git/info/exclude'), '.devkit\n');
    expect(adviseStaged(dir, dir)[2]).toMatch(
      /^ {3}If it blocks: \.devkit\/decisions is git-ignored/,
    );
  });

  it('never offers a record when the decisions dir is a symlink git cannot see through', () => {
    seedDeletion();
    symlinkDecisionsDir();
    const lines = adviseStaged(dir, dir);
    expect(lines[2]).toMatch(/docs\/decisions is git-ignored here, so do not pass a record/);
    expect(lines.join('\n')).not.toMatch(/pass the record's path/);
  });

  it('says a ship will likely block when the judge is disabled, without a conflicting remedy', () => {
    seedDeletion();
    symlinkDecisionsDir();
    process.env.GUARD_DECISION_NO_LLM = '1';
    const lines = adviseStaged(dir, dir);
    expect(lines[1]).toMatch(/judge is disabled here \(noLlm\), so a ship will likely block/);
    expect(lines.join('\n')).not.toMatch(/record is staged|pass the record's path|ROUTINE/);
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
    expect(renderAdvisory([], { ignored: false, noLlm: false, decisionsDir: 'd' })).toEqual([]);
  });

  it('caps a mass deletion at five named files, so the tail repeat cannot bury the verdict', () => {
    const sources = Array.from({ length: 300 }, (_, i) => ({
      label: 'legacy-deletion',
      path: `v/${i}.ts`,
    }));
    const lines = renderAdvisory(sources, { ignored: false, noLlm: false, decisionsDir: 'd' });
    expect(lines.filter((l) => l.includes('decision smell (regex only'))).toHaveLength(5);
    expect(lines[5]).toBe('   … and 295 more smelly file(s); the decisions gate judges every one.');
    expect(lines).toHaveLength(8);
  });

  it("never prints the gate's own block key, which ship uses to attribute a block", () => {
    const opts = [true, false].flatMap((ignored) =>
      [true, false].map((noLlm) => ({ ignored, noLlm, decisionsDir: 'docs/decisions' })),
    );
    for (const o of opts) {
      const text = renderAdvisory([{ label: 'legacy-deletion', path: 'a.ts' }], o).join('\n');
      expect(text).not.toMatch(/decision smells|decision-gate: /);
    }
  });

  it('prints on stdout as a CLI, and exits 0 with no output when the config cannot be read', () => {
    seedDeletion();
    const ok = spawnSync(process.execPath, [CLI, dir], { cwd: dir, encoding: 'utf8' });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/legacy-deletion — old\.ts/);
    writeFileSync(join(dir, 'guard.config.json'), '{not json');
    const bad = spawnSync(process.execPath, [CLI, dir], { cwd: dir, encoding: 'utf8' });
    expect(bad.status).toBe(0);
    expect(bad.stdout + bad.stderr).toBe('');
  });
});
