import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { relIntentPath, writeIntent } from '../lib/ship/ship-intent.mts';
import { testExecFileSync, testSpawnSync } from './_helpers.mts';
import { bodyUpdateRepo, GIT_ENV, reshipScript, scriptPath } from './_ship-branch-fixture.mts';

// `devkit ship --pr` appends onto an existing PR's branch. A MERGED or CLOSED PR's branch reaches no
// base, so the append must refuse before gates and again before the push, never print success.

const ARGV = ['feat/pr', 'add v2', '--pr', '--no-qavis-publish', '--', 'a.ts'];
const MERGE_RE = /git fetch origin main && git merge origin\/main/;
const REMEDY_RE = /GUARD_SHIP_BASE_OK=1 devkit ship <new-branch> .+ --base main -- a\.ts/;
const marks = [];
afterAll(() => {
  for (const d of marks) rmSync(d, { recursive: true, force: true });
});

function gateMark() {
  const d = mkdtempSync(join(tmpdir(), 'reship-pr-state-mark-'));
  marks.push(d);
  return join(d, 'gate-ran');
}

function reship(dir, env, extra = {}, argv = ARGV) {
  return testSpawnSync('/bin/bash', [reshipScript, ...argv], {
    cwd: dir,
    input: 'body\n',
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV, ...env, ...extra },
  });
}

// The fixture installs a pre-commit hook, so a test's own commits run under the supervisor too.
function commit(dir, args) {
  testExecFileSync('git', ['-C', dir, 'commit', ...args], {
    env: { ...process.env, ...GIT_ENV },
    stdio: 'ignore',
  });
}

function fixture({ hookBody = '' } = {}) {
  const mark = gateMark();
  const repo = bodyUpdateRepo({ hookBody: `: > '${mark}'\n${hookBody}` });
  const tip = () => repo.g(['--git-dir', repo.bare, 'rev-parse', 'refs/heads/feat/pr']);
  return { ...repo, mark, tip };
}

describe('reship — refuses a PR that is no longer open', () => {
  it('refuses a MERGED PR before any gate runs and pushes nothing', () => {
    const { dir, env, mark, tip } = fixture();
    const before = tip();
    writeFileSync(join(dir, 'a.ts'), 'v2\n');

    const r = reship(dir, env, { GH_PR_STATE: 'MERGED' });

    expect(r.status).not.toBe(0);
    expect(tip()).toBe(before);
    expect(existsSync(mark)).toBe(false);
    // Refused before the intent write, so `--resume` has nothing to replay into the same refusal.
    expect(existsSync(join(dir, relIntentPath('feat/pr')))).toBe(false);
    expect(r.stderr).toContain('PR #7 for origin/feat/pr is MERGED');
    expect(r.stderr).toMatch(MERGE_RE);
    expect(r.stderr).toMatch(REMEDY_RE);
    expect(r.stdout).not.toContain('pull/7');
  });

  it('refuses a CLOSED PR and names the reopen command', () => {
    const { dir, env, tip } = fixture();
    const before = tip();
    writeFileSync(join(dir, 'a.ts'), 'v2\n');

    const r = reship(dir, env, { GH_PR_STATE: 'CLOSED' });

    expect(r.status).not.toBe(0);
    expect(tip()).toBe(before);
    expect(r.stderr).toContain('gh pr reopen 7 --repo acme/app');
  });

  it('refuses a no-delta --pr run against a MERGED PR with the state, not "nothing to push"', () => {
    const { dir, env } = fixture();

    const r = reship(dir, env, { GH_PR_STATE: 'MERGED' });

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('is MERGED');
  });

  it('refuses at push time when the PR merged while gates ran', () => {
    const { dir, env, mark, tip } = fixture();
    const before = tip();
    writeFileSync(join(dir, 'a.ts'), 'v2\n');

    const r = reship(dir, env, { GH_PR_STATE: 'OPEN', GH_PR_STATE_AFTER: 'MERGED' });

    expect(r.status).not.toBe(0);
    expect(existsSync(mark)).toBe(true);
    expect(tip()).toBe(before);
    expect(r.stderr).toContain('is MERGED (it changed during gates)');
  });

  it('pushes onto an OPEN PR as before', () => {
    const { dir, env, tip } = fixture();
    const before = tip();
    writeFileSync(join(dir, 'a.ts'), 'v2\n');

    const r = reship(dir, env, { GH_PR_STATE: 'OPEN' });

    expect(r.status, r.stderr).toBe(0);
    expect(tip()).not.toBe(before);
    expect(r.stderr).not.toContain('ship --pr: PR');
  });

  it('continues with a note when gh cannot report the PR state', () => {
    const { dir, env, tip } = fixture();
    const before = tip();
    writeFileSync(join(dir, 'a.ts'), 'v2\n');

    const r = reship(dir, env);

    expect(r.status, r.stderr).toBe(0);
    expect(tip()).not.toBe(before);
    expect(r.stderr).toContain('could not verify PR state for origin/feat/pr; continuing');
  });

  it('prints a remedy that ships only the new delta after a squash merge', () => {
    const { bare, dir, env, g } = fixture();
    // origin/main holds `first`; feat/pr adds a feature commit that is then squash-merged into main
    // while origin/feat/pr stays on origin, the shape that makes a bare --base main refuse.
    g(['push', '-q', 'origin', 'HEAD:main']);
    writeFileSync(join(dir, 'a.ts'), 'v1-feature\n');
    commit(dir, ['-qam', 'feature']);
    g(['push', '-q', 'origin', 'HEAD:feat/pr']);
    const squash = g(['commit-tree', 'HEAD^{tree}', '-p', 'HEAD^', '-m', 'squash (#7)']);
    g(['push', '-q', 'origin', `${squash}:refs/heads/main`]);
    writeFileSync(join(dir, 'a.ts'), 'v2\n');

    const refused = reship(dir, env, { GH_PR_STATE: 'MERGED' });
    expect(refused.stderr).toMatch(MERGE_RE);
    expect(refused.stderr).toMatch(REMEDY_RE);

    // ship-branch reads owner/repo from the RESOLVED origin URL, so give the bare a GitHub-shaped path.
    const ghPath = join(gateMark(), '..', 'github.com', 'acme');
    mkdirSync(ghPath, { recursive: true });
    symlinkSync(bare, join(ghPath, 'app.git'));
    g(['config', '--unset-all', `url.${bare}.insteadOf`]);
    g(['remote', 'set-url', 'origin', join(ghPath, 'app.git')]);
    g(['fetch', '-q', 'origin', 'main']);
    testExecFileSync('git', ['-C', dir, 'merge', '-q', '--no-edit', 'origin/main'], {
      env: { ...process.env, ...GIT_ENV },
      stdio: 'ignore',
    });
    const r = testSpawnSync(
      '/bin/bash',
      [scriptPath, 'feat/next', 'add v2', '--base', 'main', '--', 'a.ts'],
      {
        cwd: dir,
        input: '',
        encoding: 'utf8',
        env: { ...process.env, ...GIT_ENV, ...env, GUARD_SHIP_BASE_OK: '1', SHIP_DRY_RUN: '1' },
      },
    );
    expect(r.status, r.stderr).toBe(0);
    const shipped = g(['rev-parse', 'refs/heads/feat/next']);
    expect(g(['rev-parse', `${shipped}^`])).toBe(squash);
    expect(g(['show', `${shipped}:a.ts`])).toBe('v2');
    expect(g(['diff', '--name-only', squash, shipped])).toBe('a.ts');
  });

  // The reported incident: a gate blocked the first --pr attempt, the PR merged, and the resumed
  // attempt then pushed onto the dead branch. --resume replays recorded paths and title, not argv.
  it('refuses a --resume whose PR merged after the blocked attempt', () => {
    const { dir, env, tip } = fixture({ hookBody: `[ -e '${gateMark()}.pass' ] || exit 1` });
    const before = tip();
    writeFileSync(join(dir, 'a.ts'), 'v2\n');
    const blocked = reship(dir, env, { GH_PR_STATE: 'OPEN' });
    expect(blocked.status).not.toBe(0);
    expect(existsSync(join(dir, relIntentPath('feat/pr')))).toBe(true);

    const r = reship(dir, env, { GH_PR_STATE: 'MERGED' }, ['--resume', 'feat/pr']);

    expect(r.status).not.toBe(0);
    expect(tip()).toBe(before);
    expect(r.stderr).toContain('PR #7 for origin/feat/pr is MERGED');
    expect(r.stderr).toMatch(REMEDY_RE);
  });

  it('quotes a title and path with spaces and quotes so the printed remedy parses back exactly', () => {
    const { dir, env, g } = fixture();
    writeFileSync(join(dir, "it's a.ts"), 'v1\n');
    g(['add', "it's a.ts"]);
    commit(dir, ['-qm', 'quoted path']);
    g(['push', '-q', 'origin', 'HEAD:feat/pr']);
    writeFileSync(join(dir, "it's a.ts"), 'v2\n');
    const title = 'don\'t "break" $HOME';

    const r = reship(dir, env, { GH_PR_STATE: 'MERGED' }, [
      'feat/pr',
      title,
      '--pr',
      '--',
      "it's a.ts",
    ]);

    const line = /devkit ship <new-branch> (.+)$/m.exec(r.stderr)?.[1];
    expect(line, r.stderr).toBeTruthy();
    const parsed = testSpawnSync('/bin/bash', ['-c', `printf '%s\\n' ${line}`], {
      encoding: 'utf8',
    });
    expect(parsed.stdout.split('\n').slice(0, -1)).toEqual([
      title,
      '--base',
      'main',
      '--',
      "it's a.ts",
    ]);
  });

  it('fails loudly when the PR merged between the pre-push read and the push', () => {
    const { dir, env, tip } = fixture();
    const before = tip();
    writeFileSync(join(dir, 'a.ts'), 'v2\n');

    const extra = { GH_PR_STATE: 'OPEN', GH_PR_STATE_AFTER: 'MERGED', GH_PR_FLIP_AT: '3' };
    const r = reship(dir, env, extra);

    expect(r.status).not.toBe(0);
    expect(tip()).not.toBe(before);
    expect(r.stderr).toContain('is MERGED (it closed as this run pushed)');
    expect(r.stderr).toContain(`${tip().slice(0, 7)} landed on origin/feat/pr — confirm`);
    expect(r.stdout).not.toContain('pull/7');
  });

  it("keeps the base right when the merged PR's head repository was deleted (empty TSV field)", () => {
    const { dir, env } = fixture();
    writeFileSync(join(dir, 'a.ts'), 'v2\n');

    const r = reship(dir, env, { GH_PR_STATE: 'MERGED', GH_PR_HEAD_REPO: '' });

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('never reaches main;');
    expect(r.stderr).toMatch(MERGE_RE);
    expect(r.stderr).toMatch(REMEDY_RE);
  });

  it('fails when the PR was CLOSED between the pre-push read and the push', () => {
    const { dir, env } = fixture();
    writeFileSync(join(dir, 'a.ts'), 'v2\n');

    const r = reship(dir, env, {
      GH_PR_STATE: 'OPEN',
      GH_PR_STATE_AFTER: 'CLOSED',
      GH_PR_FLIP_AT: '3',
    });

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('is CLOSED (it closed as this run pushed)');
    expect(r.stderr).toContain('gh pr reopen 7');
  });
});

// A new ship onto an existing remote branch is refused; once that branch's PR is merged or closed,
// --pr would only refuse in turn, so the refusal names the new-branch remedy instead.
const NEW_SHIP_ARGV = ['feat/pr', 'add v2', '--base', 'main', '--no-qavis-publish', '--', 'a.ts'];

function newShip(dir, env, extra, argv = NEW_SHIP_ARGV) {
  return testSpawnSync('/bin/bash', [scriptPath, ...argv], {
    cwd: dir,
    input: 'body\n',
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV, ...env, ...extra },
  });
}

describe('new ship — an existing remote branch whose PR is no longer open', () => {
  it('names the MERGED state and the new-branch remedy, not --pr', () => {
    const { dir, env, mark, tip } = fixture();
    const before = tip();
    writeFileSync(join(dir, 'a.ts'), 'v2\n');

    const r = newShip(dir, env, { GH_PR_STATE: 'MERGED' });

    expect(r.status).not.toBe(0);
    expect(tip()).toBe(before);
    expect(existsSync(mark)).toBe(false);
    expect(r.stderr).toContain('remote branch already exists: origin/feat/pr');
    expect(r.stderr).toContain('its PR #7 is MERGED');
    expect(r.stderr).toMatch(MERGE_RE);
    expect(r.stderr).toMatch(REMEDY_RE);
    expect(r.stderr).not.toContain('--pr');
  });

  it('points a CLOSED PR reopen back at --pr', () => {
    const { dir, env } = fixture();
    writeFileSync(join(dir, 'a.ts'), 'v2\n');

    const r = newShip(dir, env, { GH_PR_STATE: 'CLOSED' });

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('gh pr reopen 7 --repo acme/app, then re-run with --pr');
  });

  it('keeps --from-branch in the remedy, whose paths are not yet derived', () => {
    const { dir, env } = fixture();

    const r = newShip(dir, env, { GH_PR_STATE: 'MERGED' }, [
      'feat/pr',
      'add v2',
      '--base',
      'main',
      '--from-branch',
    ]);

    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/devkit ship <new-branch> .+ --base main --from-branch\n/);
  });

  it("targets the ship's own default base, not the merged PR's", () => {
    const { dir, env } = fixture();
    writeFileSync(join(dir, 'a.ts'), 'v2\n');

    const r = newShip(dir, env, { GH_PR_STATE: 'MERGED' }, ['feat/pr', 'add v2', '--', 'a.ts']);

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('never reaches main');
    expect(r.stderr).toContain('git fetch origin work && git merge origin/work');
    expect(r.stderr).toMatch(/devkit ship <new-branch> .+ --base work -- a\.ts\n/);
  });

  it('quotes a briefed path holding a space so the remedy pastes as one argument', () => {
    const { dir, env } = fixture();
    writeFileSync(join(dir, 'my file.ts'), 'v2\n');

    const r = newShip(dir, env, { GH_PR_STATE: 'MERGED' }, [
      'feat/pr',
      'add v2',
      '--base',
      'main',
      '--',
      'my file.ts',
    ]);

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('--base main -- my\\ file.ts\n');
  });

  it('keeps a --from-branch resume remedy free of its recorded paths', () => {
    const { dir, env } = fixture();
    const intent = {
      root: dir,
      branch: 'feat/pr',
      mode: 'ship',
      sourceMode: 'branch',
      sourceAttemptId: 'attempt-a',
      title: 'add v2',
      base: 'main',
      links: [],
      noQavisPublish: false,
      updatePrBody: false,
      draft: false,
      resumed: false,
      mergePaths: false,
      body: Buffer.alloc(0),
    };
    expect(writeIntent(intent, ['a.ts'])).toBe(0);

    const r = newShip(dir, env, { GH_PR_STATE: 'MERGED' }, ['--resume', 'feat/pr']);

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('its PR #7 is MERGED');
    expect(r.stderr).toMatch(/--base main --from-branch\n/);
  });

  it.each([
    ['OPEN', { GH_PR_STATE: 'OPEN' }],
    ['unreadable', { GH_PR_STATE: 'MERGED', GH_VIEW_STATUS: '1' }],
  ])('keeps the re-run with --pr advice when the PR is %s', (_, extra) => {
    const { dir, env, mark } = fixture();
    writeFileSync(join(dir, 'a.ts'), 'v2\n');

    const r = newShip(dir, env, extra);

    expect(r.status).not.toBe(0);
    expect(existsSync(mark)).toBe(false);
    expect(r.stderr).toContain(
      "to add these changes to that branch's existing PR, re-run with --pr",
    );
    expect(r.stderr).not.toContain('devkit ship <new-branch>');
  });
});
