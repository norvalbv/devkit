import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { overrideTagLine, tagRecipe } from '../commands/release.mts';
import { testSpawnSync } from './_helpers.mts';

const SHA = 'b'.repeat(40);
const RAN = '[{"databaseId":42}]';
const recipe = tagRecipe({
  releaseBranch: 'release/v1.2.3',
  tag: 'v1.2.3',
  workflow: 'ci.yml',
  baseBranch: 'main',
});
const SHELLS = [
  ['bash', 'bash'],
  ['zsh', '/bin/zsh'],
].filter(([name, path]) => name === 'bash' || existsSync(path));

const GH_STUB = `#!/bin/sh
echo "gh $*" >> "$LOG"
case "$1 $2" in
  "pr view") printf '%s\\n' "$MERGE_SHA" ;;
  "run list")
    while [ $# -gt 0 ]; do [ "$1" = --jq ] && filter=$2; shift; done
    printf '%s' "$RUNS" | jq -r "$filter" ;;
  "run watch") exit "$WATCH_EXIT" ;;
esac
`;
const GIT_STUB = `#!/bin/sh
echo "git $*" >> "$LOG"
if [ "$1" = tag ]; then exit "\${GIT_TAG_EXIT:-0}"; fi
`;

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Runs the printed recipe with stub git and a stub gh whose `run list` applies the recipe's --jq filter. */
function paste(
  shell: string,
  env: { MERGE_SHA: string; RUNS: string; WATCH_EXIT: string; GIT_TAG_EXIT?: string },
  lines = recipe,
) {
  const dir = mkdtempSync(join(tmpdir(), 'devkit-tag-recipe-'));
  made.push(dir);
  for (const [name, body] of [
    ['gh', GH_STUB],
    ['git', GIT_STUB],
  ]) {
    writeFileSync(join(dir, name), body);
    chmodSync(join(dir, name), 0o755);
  }
  writeFileSync(join(dir, 'recipe.sh'), `${lines.join('\n')}\n`);
  const log = join(dir, 'calls.log');
  writeFileSync(log, '');
  const args = shell === 'bash' ? [join(dir, 'recipe.sh')] : ['-f', join(dir, 'recipe.sh')];
  const run = testSpawnSync(shell, args, {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, ...env, PATH: `${dir}:${process.env.PATH}`, LOG: log },
  });
  const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
  return { code: run.status, out: `${run.stdout}${run.stderr}`, calls };
}

describe('tagRecipe', () => {
  it('resolves the merge sha, then reads and waits on its CI run, then tags and pushes', () => {
    const at = (needle: string) => recipe.findIndex((line) => line.includes(needle));
    const order = ['merge_sha=', 'gh run list', 'gh run watch', 'git tag -a', 'git push'].map(at);
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(recipe[at('gh run list')]).toContain("--workflow 'ci.yml' --branch 'main' --event push");
    expect(recipe.slice(0, 2)).toEqual(['(', '  set -e']);
    expect(recipe.at(-1)).toBe(')');
  });

  describe.each(SHELLS)('pasted into %s', (_name, shell) => {
    it('tags and pushes the merge commit once its CI run passed', () => {
      const { code, calls } = paste(shell, { MERGE_SHA: SHA, RUNS: RAN, WATCH_EXIT: '0' });
      expect(code).toBe(0);
      expect(calls).toContain('gh run watch 42 --exit-status');
      expect(calls).toContain('git fetch --quiet origin main');
      expect(calls.filter((c) => c === `git tag -a v1.2.3 ${SHA} -m devkit v1.2.3`)).toHaveLength(
        1,
      );
      expect(calls.filter((c) => c === 'git push origin v1.2.3')).toHaveLength(1);
    });

    it('neither tags nor pushes when the CI run did not pass', () => {
      const { code, calls } = paste(shell, { MERGE_SHA: SHA, RUNS: RAN, WATCH_EXIT: '1' });
      expect(code).not.toBe(0);
      expect(calls).toContain('gh run watch 42 --exit-status');
      expect(calls.some((c) => c.startsWith('git tag') || c.startsWith('git push'))).toBe(false);
    });

    it('stops before waiting when the merge commit has no push run yet, naming workflow and branch', () => {
      const { code, out, calls } = paste(shell, { MERGE_SHA: SHA, RUNS: '[]', WATCH_EXIT: '0' });
      expect(code).not.toBe(0);
      expect(out).toContain(`no push run of ci.yml on main for ${SHA} yet`);
      expect(calls.some((c) => c.startsWith('gh run watch') || c.startsWith('git'))).toBe(false);
    });

    it('never pushes when git tag fails, so a stale local tag of that name stays off origin', () => {
      const env = { MERGE_SHA: SHA, RUNS: RAN, WATCH_EXIT: '0', GIT_TAG_EXIT: '128' };
      const { code, calls } = paste(shell, env);
      expect(code).not.toBe(0);
      expect(calls).toContain(`git tag -a v1.2.3 ${SHA} -m devkit v1.2.3`);
      expect(calls.some((c) => c.startsWith('git push'))).toBe(false);
    });

    it('passes a workflow name with a space, quote or $ to gh verbatim', () => {
      const workflow = "it's $HOME ci.yml";
      const lines = tagRecipe({
        releaseBranch: 'release/v1.2.3',
        tag: 'v1.2.3',
        workflow,
        baseBranch: 'main',
      });
      const quiet = paste(shell, { MERGE_SHA: SHA, RUNS: '[]', WATCH_EXIT: '0' }, lines);
      expect(quiet.calls[1]).toContain(`--workflow ${workflow} --branch main --event push`);
      expect(quiet.out).toContain(`no push run of ${workflow} on main for ${SHA} yet`);
    });

    it('the --ci-override fallback tags the merged commit without reading CI, and only once merged', () => {
      const line = [overrideTagLine({ releaseBranch: 'release/v1.2.3', tag: 'v1.2.3' })];
      const merged = paste(shell, { MERGE_SHA: SHA, RUNS: '[]', WATCH_EXIT: '1' }, line);
      expect(merged.code).toBe(0);
      expect(merged.calls.some((c) => c.startsWith('gh run'))).toBe(false);
      expect(merged.calls).toContain(`git tag -a v1.2.3 ${SHA} -m devkit v1.2.3`);
      expect(merged.calls).toContain('git push origin v1.2.3');
      const open = paste(shell, { MERGE_SHA: '', RUNS: '[]', WATCH_EXIT: '0' }, line);
      expect(open.code).not.toBe(0);
      expect(open.calls.some((c) => c.startsWith('git'))).toBe(false);
    });

    it('stops before reading CI when the release PR is not merged', () => {
      const { code, out, calls } = paste(shell, { MERGE_SHA: '', RUNS: RAN, WATCH_EXIT: '0' });
      expect(code).not.toBe(0);
      expect(out).toContain('release/v1.2.3 is not merged');
      expect(calls.some((c) => c.startsWith('gh run') || c.startsWith('git'))).toBe(false);
    });
  });
});
