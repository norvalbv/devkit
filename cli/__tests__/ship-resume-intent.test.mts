import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { relIntentPath } from '../lib/ship/ship-intent.mts';
import { testExecFileSync as execFileSync, testSpawnSync as spawnSync } from './_helpers.mts';
import {
  createPreservedCommit,
  ghStub,
  installHook,
  localBranchExists,
  publishEnvFor,
  remoteBranchExists,
  scriptPath,
  seedShipRepoLocalRemote,
} from './_ship-branch-fixture.mts';

const intentCli = fileURLToPath(new URL('../lib/ship/ship-intent.mts', import.meta.url));

/** A hook that blocks the way a real gate does: the brief keys on the ATTRIBUTED blocked_gate, so
 *  a bare `exit 1` classifies as "unknown" and deliberately prints nothing. */
const GATE_FAIL_HOOK = "echo '\u2717 deterministic gates failed'\nexit 1";

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

  // sc-2299: the banner's path COUNT could not answer "did the gate read my copy of this file?" —
  // the listing is the answer, because anything absent from it is judged at its base content.
  it('the resume banner lists every briefed path, marking the ones this retry added', () => {
    const { dir, env, git } = seedResumableRepo({ hookBody: 'exit 1' });
    writeFileSync(join(dir, 'note.txt'), 'hello\n');
    writeFileSync(join(dir, 'with space.txt'), 'spaced\n'); // %q must keep it on ONE line
    const blocked = runShip(dir, env, ['feat/listed', 'x', '--', 'note.txt', 'with space.txt'], {
      input: 'b\n',
      extraEnv: { SHIP_DRY_RUN: '1' },
    });
    expect(blocked.status).not.toBe(0);

    installHook(dir, 'exit 0');
    writeFileSync(join(dir, 'extra.txt'), 'the remedy\n');
    const resumed = runShip(dir, env, ['--resume', 'feat/listed', '--', 'extra.txt'], {
      extraEnv: { SHIP_DRY_RUN: '1' },
    });
    expect(resumed.status, resumed.stderr).toBe(0);

    const lines = resumed.stderr.split('\n');
    const at = lines.findIndex((l) => l.includes('Resuming recorded invocation for feat/listed'));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(lines[at]).toContain('3 paths'); // the union: 2 recorded + 1 briefed by the retry
    // The listing is exactly the lines that follow the banner, one path each, count matching.
    const listed = [];
    for (let i = at + 1; i < lines.length && /^ {2,4}[+ ]/.test(lines[i]); i += 1)
      listed.push(lines[i]);
    expect(listed).toEqual([
      '    note.txt',
      '    with\\ space.txt', // %q quoting, still one line
      '  + extra.txt   (briefed by this retry)',
    ]);
    git(['worktree', 'prune']);
  });

  // The same brief, restated under the verdict: a blocked ship is read by tailing, far below the
  // banner. The second line is the invariant that explains a finding naming an UNBRIEFED file.
  it('a gate block restates the brief and names the base every other file is read at', () => {
    const { dir, env, git } = seedResumableRepo({ hookBody: GATE_FAIL_HOOK });
    writeFileSync(join(dir, 'note.txt'), 'hello\n');
    const baseShort = git(['rev-parse', '--short=7', 'HEAD']).trim();

    const blocked = runShip(dir, env, ['feat/brief-on-block', 'x', '--', 'note.txt'], {
      input: 'b\n',
      extraEnv: { SHIP_DRY_RUN: '1' },
    });
    expect(blocked.status).not.toBe(0);
    expect(blocked.stderr).toContain('ship: the gates judged 1 briefed path(s): note.txt');
    expect(blocked.stderr).toContain(
      `every OTHER file in the gate worktree is at base ${baseShort}`,
    );
    // An INITIAL ship has no listing to point at, and a ship-intent glob would splice a parallel
    // agent's branch paths into the very answer this line exists to make trustworthy.
    expect(blocked.stderr).not.toContain('Full brief');
    expect(blocked.stderr).not.toContain('ship-intent-*');
    git(['worktree', 'prune']);
  });

  // The classifier's catch-all also covers a commit-msg hook failing AFTER the gates passed, so an
  // unattributed non-zero exit must not be narrated as a gate verdict on the brief.
  it('an unattributed hook failure prints no gate brief', () => {
    const { dir, env, git } = seedResumableRepo({ hookBody: 'exit 1' });
    writeFileSync(join(dir, 'note.txt'), 'hello\n');
    const blocked = runShip(dir, env, ['feat/unattributed', 'x', '--', 'note.txt'], {
      input: 'b\n',
      extraEnv: { SHIP_DRY_RUN: '1' },
    });
    expect(blocked.status).not.toBe(0);
    expect(blocked.stderr).not.toContain('the gates judged');
    git(['worktree', 'prune']);
  });

  // A non-zero exit is not proof a gate judged anything: a killed chain exits 124 with no verdict,
  // so the brief must stay silent rather than misreport the timeout as one.
  it('a timed-out gate chain prints no gate brief, because no gate returned a verdict', () => {
    const { dir, env, git } = seedResumableRepo();
    writeFileSync(join(dir, 'note.txt'), 'hello\n');
    installHook(dir, 'sleep 30 &');

    const blocked = runShip(dir, env, ['feat/timeout-brief', 'x', '--', 'note.txt'], {
      input: 'b\n',
      extraEnv: { SHIP_DRY_RUN: '1', SHIP_COMMIT_TIMEOUT: '15' },
    });
    expect(blocked.status).toBe(124);
    expect(blocked.stderr).not.toContain('the gates judged');
    expect(blocked.stderr).not.toContain('is at base');
    git(['worktree', 'prune']);
  });

  // The positive half of the pointer: a RESUME does have a listing above, so it may point at one.
  it('only a resumed gate block points at the full listing above it', () => {
    const { dir, env, git } = seedResumableRepo({ hookBody: GATE_FAIL_HOOK });
    writeFileSync(join(dir, 'note.txt'), 'hello\n');
    const first = runShip(dir, env, ['feat/brief-pointer', 'x', '--', 'note.txt'], {
      input: 'b\n',
      extraEnv: { SHIP_DRY_RUN: '1' },
    });
    expect(first.status).not.toBe(0);
    expect(first.stderr).not.toContain('Full brief');

    // Same hook, so it blocks again — this time with a record, and therefore with a listing.
    const resumed = runShip(dir, env, ['--resume', 'feat/brief-pointer'], {
      extraEnv: { SHIP_DRY_RUN: '1' },
    });
    expect(resumed.status).not.toBe(0);
    expect(resumed.stderr).toContain(
      "Full brief: the 'Resuming recorded invocation' listing above.",
    );
    expect(resumed.stderr).not.toContain('ship-intent-*');
    git(['worktree', 'prune']);
  });

  // The cap is the one arithmetic in the terminus, and 5 is its boundary on both sides.
  it('the gate-block brief caps at five paths and counts the remainder exactly', () => {
    const { dir, env, git } = seedResumableRepo({ hookBody: GATE_FAIL_HOOK });
    const six = ['p1.txt', 'p2.txt', 'p3.txt', 'p4.txt', 'p5.txt', 'p6.txt'];
    for (const f of six) writeFileSync(join(dir, f), `${f}\n`);

    const over = runShip(dir, env, ['feat/cap-over', 'x', '--', ...six], {
      input: 'b\n',
      extraEnv: { SHIP_DRY_RUN: '1' },
    });
    expect(over.status).not.toBe(0);
    expect(over.stderr).toContain(
      'ship: the gates judged 6 briefed path(s): p1.txt p2.txt p3.txt p4.txt p5.txt (+1 more)',
    );
    expect(over.stderr).not.toContain('p6.txt (+'); // the 6th is counted, never listed

    // Exactly at the cap: all five listed, no remainder clause at all.
    const at = runShip(dir, env, ['feat/cap-at', 'x', '--', ...six.slice(0, 5)], {
      input: 'b\n',
      extraEnv: { SHIP_DRY_RUN: '1' },
    });
    expect(at.status).not.toBe(0);
    expect(at.stderr).toContain(
      'ship: the gates judged 5 briefed path(s): p1.txt p2.txt p3.txt p4.txt p5.txt',
    );
    expect(at.stderr).not.toMatch(/more\)/);
    git(['worktree', 'prune']);
  });

  // A retry that adds nothing is the COMMON resume, and it must mark nothing.
  it('a resume with no extra paths lists them all and marks none', () => {
    const { dir, env, git } = seedResumableRepo({ hookBody: 'exit 1' });
    writeFileSync(join(dir, 'note.txt'), 'hello\n');
    writeFileSync(join(dir, 'second.txt'), 'more\n');
    const blocked = runShip(dir, env, ['feat/no-extras', 'x', '--', 'note.txt', 'second.txt'], {
      input: 'b\n',
      extraEnv: { SHIP_DRY_RUN: '1' },
    });
    expect(blocked.status).not.toBe(0);

    installHook(dir, 'exit 0');
    const resumed = runShip(dir, env, ['--resume', 'feat/no-extras'], {
      extraEnv: { SHIP_DRY_RUN: '1' },
    });
    expect(resumed.status, resumed.stderr).toBe(0);

    const lines = resumed.stderr.split('\n');
    const at = lines.findIndex((l) =>
      l.includes('Resuming recorded invocation for feat/no-extras'),
    );
    const listed = [];
    for (let i = at + 1; i < lines.length && /^ {2,4}[+ ]/.test(lines[i]); i += 1)
      listed.push(lines[i]);
    expect(listed.sort()).toEqual(['    note.txt', '    second.txt']);
    expect(lines[at]).toContain('2 paths'); // the listing and the count agree
    git(['worktree', 'prune']);
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

  it('a gate-blocked --draft ship still opens a DRAFT when replayed by --resume', () => {
    const { dir, env, git } = seedResumableRepo({ hookBody: 'exit 1' });
    writeFileSync(join(dir, 'note.txt'), 'hello\n');

    const blocked = runShip(dir, env, [
      'feat/draft-resume',
      'draft me',
      '--draft',
      '--',
      'note.txt',
    ]);
    expect(blocked.status, blocked.stderr).not.toBe(0);
    // The bit is on disk, not merely in the blocked process's memory.
    const record = JSON.parse(readFileSync(intentFileOf(dir, 'feat/draft-resume'), 'utf8'));
    expect(record.draft).toBe(true);

    installHook(dir, 'exit 0'); // the operator fixed the cause
    const log = join(mkdtempSync(join(tmpdir(), 'gh-argv-')), 'argv.txt');
    const stubBin = ghStub(
      `printf '%s\\n' "$*" >> '${log}'; echo https://github.com/acme/app/pull/42`,
    );
    const resumed = runShip(dir, env, ['--resume', 'feat/draft-resume'], {
      extraEnv: { PATH: `${stubBin}:${env.PATH ?? process.env.PATH ?? ''}` },
    });

    expect(resumed.status, resumed.stderr).toBe(0);
    const create = readFileSync(log, 'utf8')
      .split('\n')
      .find((l) => l.startsWith('pr create'));
    expect(create, `no 'pr create' in gh argv log:\n${readFileSync(log, 'utf8')}`).toBeTruthy();
    expect(create).toContain('--draft');
    git(['worktree', 'prune']);
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

    // --ready must SURVIVE that hand-off. The parser sees it before the record reveals the mode, so
    // rejecting at parse time would make `--resume <reship-branch> --ready` unreachable.
    const ready = runShip(dir, env, ['--resume', 'feat/xmode', '--ready']);
    expect(ready.status).not.toBe(0);
    expect(ready.stderr).toContain('no remote branch origin/feat/xmode'); // reached reship.sh
    expect(ready.stderr).not.toContain('--ready applies to --pr');
  });

  // The other half: a recorded NEW ship never dispatches away, and there --ready has nothing to mark
  // ready — so the deferred flag must be answered once the mode is known.
  it('refuses --ready under --resume when the record is a new ship', () => {
    const { dir, env } = seedResumableRepo({ hookBody: 'exit 1' });
    writeFileSync(join(dir, 'note.txt'), 'hello\n');
    const blocked = runShip(dir, env, ['feat/ready-on-ship', 'x', '--', 'note.txt'], {
      input: 'b\n',
      extraEnv: { SHIP_DRY_RUN: '1' },
    });
    expect(blocked.status).not.toBe(0);

    const r = runShip(dir, env, ['--resume', 'feat/ready-on-ship', '--ready']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('--ready applies to --pr');
    expect(r.stderr).toContain('is a new ship');
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
