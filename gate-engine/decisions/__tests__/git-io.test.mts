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

  it('stagedFiles lists staged paths and drops the trailing blank line', () => {
    writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(repo, 'b.ts'), 'export const b = 2;\n');
    sh('add a.ts b.ts');
    const files = stagedFiles(repo);
    expect(files).toEqual(['a.ts', 'b.ts']);
    // The blank-line drop is load-bearing: detect's decisionStaged now maps its matcher over THIS
    // list instead of over raw split('\n') output.
    expect(files).not.toContain('');
  });

  it('stagedFiles is empty when nothing is staged — never [""]', () => {
    expect(stagedFiles(repo)).toEqual([]);
  });

  // Thin by design: a git failure is the CALLER's to classify (fail-open vs block), so it must
  // surface rather than being swallowed into an empty result that reads as "nothing staged".
  it('git throws on a failing command instead of returning empty', () => {
    expect(() => git(repo, ['rev-parse', '--verify', 'refs/heads/nope'])).toThrow();
  });
});
