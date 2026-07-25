import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { git, stagedFiles } from '../git-io.mts';

// sc-1227: detect (capture B) and check-alignment (capture C) each carried a byte-identical copy of
// this wrapper and its own staged-name listing — the co-occurrence matcher flagged the pair at
// 0.98/0.96. Both now import ONE module, so its contract is pinned here rather than implied by two
// gate suites that happen to exercise it.
describe('decisions git-io', () => {
  let repo: string;
  const sh = (cmd: string) => execSync(`git ${cmd}`, { cwd: repo, stdio: 'ignore' });

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'git-io-'));
    sh('init -q');
    sh('config user.email t@t.t');
    sh('config user.name t');
    writeFileSync(join(repo, 'base.ts'), 'export const x = 1;\n');
    sh('add .');
    sh('commit -qm base');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('git runs argv-form in the given cwd and returns stdout', () => {
    expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBeTruthy();
  });

  it('stagedFiles lists staged paths with no empty records', () => {
    writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(repo, 'b.ts'), 'export const b = 2;\n');
    sh('add a.ts b.ts');
    const files = stagedFiles(repo);
    expect(files).toEqual(['a.ts', 'b.ts']);
    expect(files).not.toContain('');
  });

  it('stagedFiles is empty when nothing is staged — never [""]', () => {
    expect(stagedFiles(repo)).toEqual([]);
  });

  // These names are fed straight back to git (check-alignment: `git diff --cached -- <paths>`;
  // detect: matched against decisionFileRe). Plain --name-only C-quotes the tab one to
  // `"tab\tx.ts"` and line-splitting can't undo it, and trimming records eats the real leading
  // spaces git emits unquoted — either way the downstream lookup silently matches nothing.
  it('stagedFiles returns awkward names VERBATIM — no C-quoting, no trimmed leading space', () => {
    const tabbed = 'tab\tx.ts';
    const leading = '  lead.ts';
    writeFileSync(join(repo, tabbed), 'export const t = 1;\n');
    writeFileSync(join(repo, leading), 'export const l = 1;\n');
    sh('add -A');
    const files = stagedFiles(repo);
    expect(files).toContain(tabbed);
    expect(files).toContain(leading);
    expect(files.some((f) => f.startsWith('"'))).toBe(false);
  });

  // The whole point of returning them verbatim: git must find them again.
  it('a verbatim awkward name round-trips back through git', () => {
    const tabbed = 'tab\tx.ts';
    writeFileSync(join(repo, tabbed), 'export const t = 1;\n');
    sh('add -A');
    const only = stagedFiles(repo).filter((f) => f.includes('\t'));
    expect(only).toHaveLength(1);
    expect(git(repo, ['diff', '--cached', '--name-only', '--', only[0]]).trim()).toBeTruthy();
  });

  // Thin by design: a git failure is the CALLER's to classify (fail-open vs block), so it must
  // surface rather than being swallowed into an empty result that reads as "nothing staged".
  it('git throws on a failing command instead of returning empty', () => {
    expect(() => git(repo, ['rev-parse', '--verify', 'refs/heads/nope'])).toThrow();
  });
});
