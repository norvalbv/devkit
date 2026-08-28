import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { relIntentPath } from '../lib/ship/ship-intent.mts';
import { testExecFileSync as execFileSync, testSpawnSync as spawnSync } from './_helpers.mts';
import {
  createPreservedCommit,
  installHook,
  localBranchExists,
  publishEnvFor,
  remoteBranchExists,
  scriptPath,
  seedShipRepoLocalRemote,
} from './_ship-branch-fixture.mts';

const intentCli = fileURLToPath(new URL('../lib/ship/ship-intent.mts', import.meta.url));

/** seedShipRepoLocalRemote plus the one line every resume test needs: the manifest's own ignore
 *  (ship-intent write refuses to record a stageable copy of the PR body). */
function seedResumableRepo(opts = {}) {
  const seeded = seedShipRepoLocalRemote(opts);
  writeFileSync(join(seeded.dir, '.gitignore'), '.devkit/\n');
  return seeded;
}

function runShip(dir, env, argv, { input = '', extraEnv = {} } = {}) {
  return spawnSync('/bin/bash', [scriptPath, ...argv], {
    cwd: dir,
    input,
    encoding: 'utf8',
    env: { ...env, ...extraEnv },
  });
}

const intentFileOf = (dir, branch) => join(dir, relIntentPath(branch));

describe('ship --resume: record on block, replay on retry', () => {
  it('a gate-blocked ship records its invocation; --resume replays it byte-identically', () => {
    const { dir, env, git } = seedResumableRepo({ hookBody: 'exit 1' });
    writeFileSync(join(dir, 'note.txt'), 'hello\n');
    const body = 'para one\n\npara two — with ünïcode\n';

    const blocked = runShip(dir, env, ['feat/replay', 'ship: replay me', '--', 'note.txt'], {
      input: body,
      extraEnv: { SHIP_DRY_RUN: '1' },
    });
    expect(blocked.status, blocked.stderr).not.toBe(0);
    expect(localBranchExists(git, 'feat/replay')).toBe(false); // branch reclaimed — only the record survives
    expect(existsSync(intentFileOf(dir, 'feat/replay'))).toBe(true);
    // The retry banner names the short form.
    expect(blocked.stderr).toContain('devkit ship --resume feat/replay');

    installHook(dir, 'exit 0'); // the operator fixed the cause
    const resumed = runShip(dir, env, ['--resume', 'feat/replay'], {
      extraEnv: { SHIP_DRY_RUN: '1' },
    });
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(resumed.stderr).toContain('Resuming recorded invocation for feat/replay');
    // The commit message is the recorded bytes — the same normalization `git commit` applies.
    // (trimEnd both sides: --format=%B appends its own terminating newline to the message.)
    expect(git(['log', '-1', '--format=%B', 'feat/replay']).trimEnd()).toBe(
      `ship: replay me\n\n${body.trimEnd()}`,
    );
    expect(git(['show', '--name-only', '--pretty=format:', 'feat/replay']).trim()).toBe('note.txt');
    git(['worktree', 'prune']); // dry-run keeps its worktree; drop it for the suite's cleanup
  });

  it('extra trailing paths merge into the recorded set (the add-a-file gate remedy)', () => {
    const { dir, env, git } = seedResumableRepo({ hookBody: 'exit 1' });
    writeFileSync(join(dir, 'note.txt'), 'hello\n');
    const blocked = runShip(dir, env, ['feat/add-path', 'x', '--', 'note.txt'], {
      input: 'b\n',
      extraEnv: { SHIP_DRY_RUN: '1' },
    });
    expect(blocked.status).not.toBe(0);

    installHook(dir, 'exit 0');
    writeFileSync(join(dir, 'extra.txt'), 'the remedy\n'); // e.g. a decisions record, a new test
    const resumed = runShip(dir, env, ['--resume', 'feat/add-path', '--', 'extra.txt'], {
      extraEnv: { SHIP_DRY_RUN: '1' },
    });
    expect(resumed.status, resumed.stderr).toBe(0);
    const shipped = git(['show', '--name-only', '--pretty=format:', 'feat/add-path'])
      .trim()
      .split('\n')
      .sort();
    expect(shipped).toEqual(['extra.txt', 'note.txt']);
    // ...and the record now carries the union, so the NEXT resume replays both.
    const record = JSON.parse(readFileSync(intentFileOf(dir, 'feat/add-path'), 'utf8'));
    expect(record.paths.sort()).toEqual(['extra.txt', 'note.txt']);
  });

  it('--resume rides the landed-commit resume path: receipt verified, zero gate re-runs, published', () => {
    const { dir, env, git, bare } = seedResumableRepo();
    // The record the failed attempt would have written, matching the preserved commit's bytes.
    execFileSync(
      'node',
      [
        intentCli,
        'write',
        '--root',
        dir,
        '--branch',
        'feat/landed',
        '--mode',
        'ship',
        '--title',
        'ship it',
        '--',
        'note.txt',
      ],
      { input: 'pr body', env: { ...env, DEVKIT_NO_TELEMETRY: '1' } },
    );
    const preserved = createPreservedCommit({
      dir,
      env,
      git,
      branch: 'feat/landed',
      tempPrefix: 'ship-resume-intent-',
    });
    git(['update-ref', 'refs/devkit/ship-receipts/feat/landed', preserved]);
    const { hookCount, publishEnv } = publishEnvFor(dir, env);

    const r = runShip(dir, publishEnv, ['--resume', 'feat/landed'], {
      extraEnv: { TEST_HOOK_COUNT: hookCount },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('Resuming preserved ship commit'); // the sc-1550 path, not a re-commit
    expect(existsSync(hookCount)).toBe(false); // zero gate re-runs — the receipt carried the proof
    expect(r.stdout).toContain('https://github.com/acme/app/pull/42');
    expect(remoteBranchExists(bare, 'feat/landed')).toBe(true);
    expect(existsSync(intentFileOf(dir, 'feat/landed'))).toBe(false); // spent on publish
  });

  it('a full success deletes the record; a second --resume then refuses by name', () => {
    const { dir, env, git } = seedResumableRepo();
    writeFileSync(join(dir, 'note.txt'), 'hello\n');
    const { hookCount, publishEnv } = publishEnvFor(dir, env);
    const r = runShip(dir, publishEnv, ['feat/spent', 'x', '--', 'note.txt'], {
      input: 'b\n',
      extraEnv: { TEST_HOOK_COUNT: hookCount },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(intentFileOf(dir, 'feat/spent'))).toBe(false);

    const again = runShip(dir, publishEnv, ['--resume', 'feat/spent']);
    expect(again.status).not.toBe(0);
    expect(again.stderr).toContain('no recorded ship invocation');
    expect(localBranchExists(git, 'feat/spent')).toBe(false);
  });

  it('--resume with no record refuses with the full-command instruction', () => {
    const { dir, env } = seedResumableRepo();
    const r = runShip(dir, env, ['--resume', 'feat/never-shipped']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('no recorded ship invocation');
    expect(r.stderr).toContain('full devkit ship command');
  });

  it('reship --resume with no delta releases the spent record instead of stranding it', () => {
    const { dir, env, git } = seedResumableRepo();
    writeFileSync(join(dir, 'note.txt'), 'hello\n');
    const { hookCount, publishEnv } = publishEnvFor(dir, env);
    const first = runShip(dir, publishEnv, ['feat/landed-kill', 'x', '--', 'note.txt'], {
      input: 'b\n',
      extraEnv: { TEST_HOOK_COUNT: hookCount },
    });
    expect(first.status, first.stderr).toBe(0);
    // The kill-after-push window: the push landed but the attempt died before releasing its
    // record. Reconstruct that state — a reship-mode record whose content is already on origin.
    execFileSync(
      'node',
      [
        intentCli,
        'write',
        '--root',
        dir,
        '--branch',
        'feat/landed-kill',
        '--mode',
        'reship',
        '--title',
        'x',
        '--',
        'note.txt',
      ],
      { input: 'b\n', env },
    );
    expect(existsSync(intentFileOf(dir, 'feat/landed-kill'))).toBe(true);
    const resumed = runShip(dir, publishEnv, ['--resume', 'feat/landed-kill']);
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(resumed.stderr).toContain('already on the remote; released the record');
    expect(existsSync(intentFileOf(dir, 'feat/landed-kill'))).toBe(false);
    git(['worktree', 'prune']);
  });
});

describe('ship --resume: overrides and refusals', () => {
  /** Block once so a record exists, then hand back dir/env/git with a passing hook. */
  function seedBlockedRecord(branch, { body = 'original body\n' } = {}) {
    const seeded = seedResumableRepo({ hookBody: 'exit 1' });
    writeFileSync(join(seeded.dir, 'note.txt'), 'hello\n');
    const blocked = runShip(seeded.dir, seeded.env, [branch, 'x', '--', 'note.txt'], {
      input: body,
      extraEnv: { SHIP_DRY_RUN: '1' },
    });
    expect(blocked.status).not.toBe(0);
    installHook(seeded.dir, 'exit 0');
    return seeded;
  }

  it('--body-file overrides the recorded body and re-records it for the next resume', () => {
    const { dir, env, git } = seedBlockedRecord('feat/amend');
    writeFileSync(join(dir, 'newbody.md'), 'amended body\n');
    const r = runShip(dir, env, ['--resume', 'feat/amend', '--body-file', 'newbody.md'], {
      extraEnv: { SHIP_DRY_RUN: '1' },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(git(['log', '-1', '--format=%b', 'feat/amend']).trim()).toBe('amended body');
    const record = JSON.parse(readFileSync(intentFileOf(dir, 'feat/amend'), 'utf8'));
    // Byte-exact including the file's trailing newline — git normalizes at commit time, not here.
    expect(Buffer.from(record.bodyB64, 'base64').toString()).toBe('amended body\n');
    git(['worktree', 'prune']);
  });

  it('--resume never reads stdin: an open-but-idle pipe cannot stall or blank the body', () => {
    const { dir, env, git } = seedBlockedRecord('feat/no-stdin', { body: 'recorded body\n' });
    // input: '' is a CLOSED empty stdin — the shape that used to read as a silently empty body.
    const r = runShip(dir, env, ['--resume', 'feat/no-stdin'], {
      extraEnv: { SHIP_DRY_RUN: '1' },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(git(['log', '-1', '--format=%b', 'feat/no-stdin']).trim()).toBe('recorded body');
    git(['worktree', 'prune']);
  });

  it('recorded reship mode cross-dispatches, and a marked re-dispatch refuses instead of looping', () => {
    const { dir, env } = seedResumableRepo();
    execFileSync(
      'node',
      [
        intentCli,
        'write',
        '--root',
        dir,
        '--branch',
        'feat/xmode',
        '--mode',
        'reship',
        '--title',
        't',
        '--',
        'note.txt',
      ],
      { input: 'b', env: { ...env, DEVKIT_NO_TELEMETRY: '1' } },
    );
    // ship-branch execs reship.sh, which dies at ITS precondition — proof the dispatch happened.
    const r = runShip(dir, env, ['--resume', 'feat/xmode']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('no remote branch origin/feat/xmode');

    // The one-shot marker turns a second hand-off into a named refusal, never a ping-pong.
    const looped = runShip(dir, env, ['--resume', 'feat/xmode'], {
      extraEnv: { DEVKIT_SHIP_RESUME_DISPATCHED: '1' },
    });
    expect(looped.status).not.toBe(0);
    expect(looped.stderr).toContain('dispatched in a loop');
  });

  it('rejects --base/--link/title changes under --resume, and a misplaced --resume', () => {
    const { dir, env } = seedBlockedRecord('feat/frozen');
    const rebase = runShip(dir, env, ['--resume', 'feat/frozen', '--base', 'main']);
    expect(rebase.status).not.toBe(0);
    expect(rebase.stderr).toContain('run the full devkit ship command');
    const misplaced = runShip(dir, env, ['feat/frozen', 'title', '--resume', '--', 'note.txt']);
    expect(misplaced.status).not.toBe(0);
    expect(misplaced.stderr).toContain('--resume must come FIRST');
  });
});

describe('ship --body-file and attempt telemetry', () => {
  it('--body-file authors the body once; --body + --body-file refuses; a missing file refuses', () => {
    const { dir, env, git } = seedResumableRepo();
    writeFileSync(join(dir, 'note.txt'), 'hello\n');
    writeFileSync(join(dir, 'body.md'), 'from a file\n\nsecond para\n');
    const r = runShip(
      dir,
      env,
      ['feat/bodyfile', 'x', '--body-file', 'body.md', '--', 'note.txt'],
      {
        extraEnv: { SHIP_DRY_RUN: '1' },
      },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(git(['log', '-1', '--format=%B', 'feat/bodyfile']).trimEnd()).toBe(
      'x\n\nfrom a file\n\nsecond para',
    );
    git(['worktree', 'prune']);

    const both = runShip(dir, env, [
      'feat/b2',
      'x',
      '--body',
      'a',
      '--body-file',
      'body.md',
      '--',
      'note.txt',
    ]);
    expect(both.status).not.toBe(0);
    expect(both.stderr).toContain('mutually exclusive');

    const missing = runShip(dir, env, ['feat/b3', 'x', '--body-file', 'nope.md', '--', 'note.txt']);
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain('no such file: nope.md');
  });

  it('telemetry: ship_intent + ship_attempt carry resumed/body_bytes across block and retry', () => {
    const { dir, env, git } = seedResumableRepo({ hookBody: 'exit 1' });
    const sink = join(dir, 'events.jsonl');
    writeFileSync(join(dir, 'note.txt'), 'hello\n');
    const body = '12345678\n'; // 9 bytes

    const blocked = runShip(dir, env, ['feat/tel', 'x', '--', 'note.txt'], {
      input: body,
      extraEnv: { SHIP_DRY_RUN: '1', DEVKIT_GATE_EVENTS: sink },
    });
    expect(blocked.status).not.toBe(0);
    installHook(dir, 'exit 0');
    const resumed = runShip(dir, env, ['--resume', 'feat/tel'], {
      extraEnv: { SHIP_DRY_RUN: '1', DEVKIT_GATE_EVENTS: sink },
    });
    expect(resumed.status, resumed.stderr).toBe(0);

    const events = readFileSync(sink, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const intents = events.filter((e) => e.type === 'ship_intent');
    const attempts = events.filter((e) => e.type === 'ship_attempt');
    expect(intents.map((e) => e.resumed)).toEqual([false, true]);
    // The node-side event carries what shell printf never could: the body itself + the command.
    // ($(<heredoc) strips the trailing newline before the body is recorded — 8 of the 9 bytes.)
    expect(intents[0].pr_body).toBe(body.trimEnd());
    expect(intents[0].command).toContain('devkit ship feat/tel');
    expect(intents[0].ship_id).toBeTruthy();
    expect(attempts.map((e) => e.resumed)).toEqual([false, true]);
    // $(<file)/heredoc normalization strips the trailing newline before the attempt measures it.
    for (const a of attempts) expect(a.body_bytes).toBe(8);
    // One ship_id per attempt, shared by its intent + attempt rows.
    expect(intents[0].ship_id).toBe(attempts[0].ship_id);
    expect(intents[1].ship_id).toBe(attempts[1].ship_id);
    expect(attempts[0].ship_id).not.toBe(attempts[1].ship_id);
    git(['worktree', 'prune']);
  });
});
