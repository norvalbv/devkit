import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildFullHook } from '../lib/husky/husky-block.mts';
import { ALL_GUARDS, cleanupHomes, hasDash, homes, runHook } from './_husky-hook-harness.mts';

// The hook's SHELL contract: commit/ship fail fast, review/dry-gates defer per lane, and it all
// survives dash + a hook path with spaces. The orchestrator's own aggregation is tested in run.test.mjs.

afterEach(cleanupHomes);

describe('assembled hook execution (stubbed bins, sh -e)', () => {
  it('package mode blocks when the pinned local bin is missing instead of using a global decoy', () => {
    const r = runHook(
      {},
      { biome: false, guards: ['size'] },
      {
        missingLocalBins: ['guard-deterministic'],
      },
    );
    expect(r.status).toBe(1);
    expect(r.calls).not.toContain('guard-deterministic');
  });

  it('a deterministic failure blocks the hook (exit 1) and the AI gates never run', () => {
    const r = runHook({ DET_RC: '1' });
    expect(r.status).toBe(1);
    expect(r.calls).toContain('guard-deterministic');
    // Ordinary commit/ship keeps the cost-saving fail-fast policy.
    expect(r.calls).not.toContain('guard-comments');
    expect(r.calls).not.toContain('guard-decisions');
    expect(r.calls).not.toContain('guard-review');
  });

  it.each(['package', 'standalone'])(
    '%s anti-slop-only selection runs the real deterministic gate before review',
    (builder) => {
      const r = runHook(
        {},
        { biome: false, guards: ['review'], antiSlop: true },
        { builder, realDeterministic: true, dirPrefix: 'dk hook exec with spaces ' },
      );
      expect(r.status).toBe(1);
      expect(r.calls).toContain('guard-deterministic');
      expect(r.calls).not.toContain('guard-review');
    },
  );

  it('review remembers deterministic failure, runs the selected reviewer, then returns 1', () => {
    const r = runHook({
      DET_RC: '1',
      DEVKIT_RUN_MODE: 'review',
      DEVKIT_REVIEW_GUARDS: 'size,review',
    });
    expect(r.status).toBe(1);
    expect(r.calls).toContain('guard-deterministic');
    expect(r.calls).toContain('guard-review --gate');
  });

  it('dry-gates remembers deterministic failure and skips expensive gates', () => {
    const r = runHook({
      DET_RC: '1',
      DEVKIT_RUN_MODE: 'dry-gates',
      DEVKIT_REVIEW_GUARDS: 'comments',
    });
    expect(r.status).toBe(1);
    expect(r.calls).toContain('guard-deterministic');
    // sc-2753: the comment budget runs inside guard-deterministic, never as its own hook step.
    expect(r.calls).not.toContain('guard-comments');
    expect(r.calls).not.toContain('guard-decisions');
    expect(r.calls).not.toContain('guard-review');
    expect(r.calls).not.toContain('guard-qavis-advisory');
  });

  it('dry-gates with reviewers runs the fleet after a deterministic failure, never decisions or Qavis', () => {
    const r = runHook({
      DET_RC: '1',
      DEVKIT_RUN_MODE: 'dry-gates',
      DEVKIT_REVIEW_GUARDS: 'comments,review',
    });
    expect(r.status).toBe(1);
    expect(r.calls).toContain('guard-deterministic');
    expect(r.calls).toContain('guard-review --gate');
    expect(r.calls).not.toContain('guard-decisions');
    expect(r.calls).not.toContain('guard-qavis-advisory');
  });

  it('dry-gates with reviewers never arms the completeness judge, even with a message file present', () => {
    // The rehearsal has no commit message of its own; a leaked one would charge (and could block
    // on) a judge keyed to a message this run never commits.
    const r = runHook(
      { DEVKIT_RUN_MODE: 'dry-gates', DEVKIT_REVIEW_GUARDS: 'comments,review' },
      undefined,
      { shipMsg: true },
    );
    expect(r.status).toBe(0);
    expect(r.calls).toContain('guard-review --gate');
    expect(r.calls).not.toContain('guard-review completeness');
  });

  it('reviewer-only profile reaches the reviewer and stays green when deterministic selects none', () => {
    const r = runHook({ DEVKIT_RUN_MODE: 'review', DEVKIT_REVIEW_GUARDS: 'review' });
    expect(r.status).toBe(0);
    expect(r.calls).toContain('guard-deterministic');
    expect(r.calls).toContain('guard-review --gate');
  });

  it('initializes remembered status per block instead of trusting an inherited shell value', () => {
    const r = runHook({
      DEVKIT_RUN_MODE: 'review',
      DEVKIT_REVIEW_GUARDS: 'size,review',
      dk_review_failed: '1',
    });
    expect(r.status).toBe(0);
    expect(r.calls).toContain('guard-review --gate');
  });

  it('review runs every selected gate after deterministic and decision failures, then blocks once', () => {
    const r = runHook({
      DET_RC: '1',
      DEC_RC: '1',
      DEVKIT_RUN_MODE: 'review',
      DEVKIT_REVIEW_GUARDS: 'size,decisions,review',
    });
    expect(r.status).toBe(1);
    expect(r.calls).toContain('guard-decisions');
    expect(r.calls).toContain('guard-review --gate');
  });

  it('standalone review defers an installed deterministic failure until after the reviewer', () => {
    const r = runHook(
      { DET_RC: '1', DEVKIT_RUN_MODE: 'review', DEVKIT_REVIEW_GUARDS: 'size,review' },
      undefined,
      { builder: 'standalone' },
    );
    expect(r.status).toBe(1);
    expect(r.calls).toContain('guard-deterministic');
    expect(r.calls).toContain('guard-review --gate');
  });

  it('standalone without a global devkit skips its whole block (the documented fail-open)', () => {
    const r = runHook({ REVIEW_RC: '1' }, undefined, {
      builder: 'standalone',
      missingBins: ['guard-deterministic'],
    });
    expect(r.status).toBe(0);
    expect(r.calls).toBe('');
  });

  it('overlay without a global devkit blocks before any gate', () => {
    const r = runHook({}, undefined, { builder: 'overlay', missingBins: ['guard-deterministic'] });
    expect(r.status).toBe(1);
    expect(r.calls).toBe('');
  });

  it('overlay review runs AI and baseline diagnostics before finalizing deterministic failure', () => {
    const r = runHook(
      { DET_RC: '1', DEVKIT_RUN_MODE: 'review', DEVKIT_REVIEW_GUARDS: 'size,review' },
      undefined,
      { builder: 'overlay' },
    );
    expect(r.status).toBe(1);
    expect(r.calls).toContain('guard-review --gate');
    expect(r.calls).toContain('baseline');
    expect(r.calls.indexOf('guard-review --gate')).toBeLessThan(r.calls.indexOf('baseline'));
  });

  it('package-scoped review keeps the remembered status inside its failing subshell', () => {
    const r = runHook(
      { DET_RC: '1', DEVKIT_RUN_MODE: 'review', DEVKIT_REVIEW_GUARDS: 'size,review' },
      undefined,
      { pkgRel: 'pkg/a' },
    );
    expect(r.status).toBe(1);
    expect(r.calls).toContain('guard-review --gate');
  });

  it('a clean deterministic run lets the AI gates run', () => {
    const r = runHook({ DET_RC: '0' });
    expect(r.status).toBe(0);
    expect(r.calls).toContain('guard-deterministic');
    expect(r.calls).toContain('guard-decisions');
    expect(r.calls).toContain('guard-review');
  });

  it('review mode runs only AI gates in the explicit review allowlist', () => {
    const r = runHook({ DEVKIT_RUN_MODE: 'review', DEVKIT_REVIEW_GUARDS: 'decisions' });
    expect(r.status).toBe(0);
    expect(r.calls).toContain('guard-deterministic');
    expect(r.calls).toContain('guard-decisions');
    expect(r.calls).not.toContain('guard-review');
  });

  it('trims review allowlist entries consistently with the deterministic parser', () => {
    const r = runHook({
      DEVKIT_RUN_MODE: 'review',
      DEVKIT_REVIEW_GUARDS: ' decisions , review ',
    });
    expect(r.status).toBe(0);
    expect(r.calls).toContain('guard-decisions');
    expect(r.calls).toContain('guard-review');
  });

  it('passes the resolved structure command through to the orchestrator', () => {
    const r = runHook(
      { DET_RC: '0' },
      {
        biome: false,
        guards: ALL_GUARDS,
        structureCmd: 'guard-structure gate',
      },
    );
    expect(r.status).toBe(0);
    expect(r.calls).toContain('guard-deterministic --hook');
    expect(r.calls).toContain('--structure guard-structure gate');
  });

  it('guard-review exit 3 (strict fail-closed) blocks with the outage remedy, not a violation banner', () => {
    const r = runHook({ REVIEW_RC: '3' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('strict ship mode failed closed');
    expect(r.stdout).toContain('Follow the Remedy named above');
    expect(r.stdout).not.toContain('auth/quota'); // sc-3400: the cause is named per reviewer
    expect(r.stdout).not.toMatch(/check [`]?claude/i);
    expect(r.stdout).not.toContain('escalation-confirmed');
  });

  it('guard-review exit 2 (non-strict inconclusive) fails open', () => {
    expect(runHook({ REVIEW_RC: '2' }).status).toBe(0);
  });

  it('guard-decisions exit 3 (strict fail-closed) blocks with the outage remedy', () => {
    const r = runHook({ DEC_RC: '3' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('strict ship mode failed closed');
    expect(r.stdout).not.toContain('Record the decision target');
  });

  // sc-2753: an installed guard-comments bin is never the hook's own step any more — a stale
  // failing bin must not block, because the orchestrator owns the comment budget now.
  it.each(['package', 'standalone', 'overlay'])(
    '%s hook never calls guard-comments directly, even when that bin would block',
    (builder) => {
      const r = runHook({ COMMENTS_RC: '1' }, undefined, { builder });
      expect(r.status).toBe(0);
      expect(r.calls).toContain('guard-deterministic');
      expect(r.calls).not.toContain('guard-comments');
    },
  );

  it.each(['package', 'standalone', 'overlay'])(
    '%s comments-only selection still emits the deterministic orchestrator',
    (builder) => {
      const r = runHook({ DET_RC: '1' }, { biome: false, guards: ['comments'] }, { builder });
      expect(r.status).toBe(1);
      expect(r.calls).toContain('guard-deterministic');
    },
  );
});

describe('parallel completeness prewarm (ship message file present)', () => {
  it('no DEVKIT_COMMIT_MSG_FILE → completeness never launched (interactive commits unchanged)', () => {
    const r = runHook();
    expect(r.status).toBe(0);
    expect(r.calls).toContain('guard-review --gate');
    expect(r.calls).not.toContain('guard-review completeness');
  });

  it.each(['package', 'standalone', 'overlay'])(
    '%s: with the ship message file, completeness runs alongside the fleet and a clean pair passes',
    (builder) => {
      const r = runHook({}, undefined, { shipMsg: true, builder });
      expect(r.status).toBe(0);
      expect(r.calls).toContain('guard-review completeness --gate');
      expect(r.calls).toContain('guard-review --gate');
    },
  );

  it('a confident completeness FAIL (exit 1) blocks the commit at pre-commit', () => {
    const r = runHook({ COMP_RC: '1' }, undefined, { shipMsg: true });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('Confirmed completeness gap');
  });

  it('completeness exit 3 (strict outage) fails closed with the remedy banner', () => {
    const r = runHook({ COMP_RC: '3' }, undefined, { shipMsg: true });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('strict ship mode failed closed');
    expect(r.stdout).toContain('Follow the judge CLI remedy printed above');
    expect(r.stdout).not.toMatch(/check [`]?claude/i);
  });

  it('completeness exit 4 (unreadable staged content) blocks and names the cause', () => {
    const r = runHook({ COMP_RC: '4' }, undefined, { shipMsg: true });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('NOT a gate rejection');
  });

  it('completeness exit 2 fails open', () => {
    expect(runHook({ COMP_RC: '2' }, undefined, { shipMsg: true }).status).toBe(0);
  });

  it('a fleet FAIL blocks as the fleet, never as the parallel completeness verdict', () => {
    const r = runHook({ REVIEW_RC: '1', COMP_RC: '1' }, undefined, { shipMsg: true });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('escalation-confirmed');
    // The completeness verdict must not BLOCK here — the fleet already owns this exit.
    expect(r.stdout).not.toContain('Confirmed completeness gap');
  });

  it("a completeness finding the fleet overtook is NARRATED, below the fleet's own remediation", () => {
    const r = runHook({ REVIEW_RC: '1', COMP_RC: '1', COMP_FIRST: '1' }, undefined, {
      shipMsg: true,
    });
    expect(r.status).toBe(1); // still the fleet's verdict — narration cannot change it
    expect(r.stdout).toContain('the completeness judge had ALREADY recorded a');
    // Below, not above: a tail-based read is the whole point.
    expect(r.stdout.indexOf('ALREADY recorded')).toBeGreaterThan(
      r.stdout.indexOf('escalation-confirmed'),
    );
  });

  it('narrates nothing for a completeness exit the reader cannot act on (3 = judge unavailable)', () => {
    // COMP_FIRST so this proves 3 is DELIBERATELY ignored, not that the judge happened to be
    // killed before reaching a verdict — the two are indistinguishable without the ordering.
    const r = runHook({ REVIEW_RC: '1', COMP_RC: '3', COMP_FIRST: '1' }, undefined, {
      shipMsg: true,
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('escalation-confirmed');
    expect(r.stdout).not.toContain('ALREADY recorded');
  });

  it('narrates nothing when the fleet passes — the crc dispatch owns that path unchanged', () => {
    const r = runHook({ COMP_RC: '1' }, undefined, { shipMsg: true });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('Confirmed completeness gap');
    expect(r.stdout).not.toContain('ALREADY recorded');
  });

  // The fragment is POSIX sh, and the narration adds a shell FUNCTION plus a `|| var=$?` capture
  // inside an errexit'd hook. Debian/Ubuntu run these under dash, where a bashism is a hard error
  // rather than a warning — prove it there instead of assuming.
  it.runIf(hasDash)('dash (Debian/Ubuntu /bin/sh): the finding still surfaces', () => {
    const r = runHook({ REVIEW_RC: '1', COMP_RC: '1', COMP_FIRST: '1' }, undefined, {
      shipMsg: true,
      shell: '/bin/dash',
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('escalation-confirmed');
    expect(r.stdout).toContain('ALREADY recorded');
  });

  it('review mode does NOT prewarm — it exports the same env for its reviewer intent file', () => {
    const r = runHook({ DEVKIT_RUN_MODE: 'review', DEVKIT_REVIEW_GUARDS: 'review' }, undefined, {
      shipMsg: true,
    });
    expect(r.status).toBe(0);
    expect(r.calls).toContain('guard-review --gate');
    expect(r.calls).not.toContain('guard-review completeness');
  });

  it('a message-file path that does not exist arms nothing (the -f guard, not just -n)', () => {
    const r = runHook({ DEVKIT_COMMIT_MSG_FILE: '/nonexistent/dk-msg.txt' });
    expect(r.status).toBe(0);
    expect(r.calls).not.toContain('guard-review completeness');
  });

  // The reap contract: the judge inherits git's stdout/stderr, so a hook that returns while a
  // signalled child is still winding down leaves the ship's capture reader on a pipe nobody will
  // close — commit-with-gate-capture.sh's R3 hang. Signalling alone is not enough; the harness
  // stub releases the pipe first so this asserts the HOOK waited, not that the pipe drained.
  it('a killed completeness judge is REAPED before the hook returns, not merely signalled', () => {
    const r = runHook({ REVIEW_RC: '1', COMP_SLOW_TERM: '1' }, undefined, { shipMsg: true });
    expect(r.status).toBe(1); // still the fleet's verdict
    expect(existsSync(join(r.home, 'comp-running'))).toBe(true); // the judge really did start
    // Written only by the TERM handler, after a delay: present iff the hook waited for it.
    expect(existsSync(join(r.home, 'comp-reaped'))).toBe(true);
    // 143 is a judge killed MID-judgement: it reached no verdict, so there is nothing honest to
    // report. A fabricated one is worse than silence.
    expect(r.stdout).not.toContain('ALREADY recorded');
  });

  it('the fleet failing CLOSED (exit 3) also kills and reaps — every block path, not just exit 1', () => {
    const r = runHook({ REVIEW_RC: '3', COMP_SLOW_TERM: '1' }, undefined, { shipMsg: true });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('strict ship mode failed closed');
    expect(existsSync(join(r.home, 'comp-reaped'))).toBe(true);
  });
});

describe('format re-stage step (real git)', () => {
  // The re-stage step runs `git add` on files it just re-read from `git diff --cached` — for a
  // release commit that force-added a gitignored `dist/` (`git add -f dist`), a plain `git add`
  // on those same paths refuses ("ignored by gitignore", non-zero exit), and `sh -e` aborts the
  // whole hook. Needs a REAL git repo (unlike the other tests here, which stub every external
  // call): `git diff --cached` / `git add` are real git, not something bunx dispatches.
  function initRepo() {
    const repo = mkdtempSync(join(tmpdir(), 'dk-hook-git-'));
    homes.push(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'a'], { cwd: repo });
    writeFileSync(join(repo, '.gitignore'), 'dist\n');
    // The step runs biome only where a biome CONFIG exists, so the default fixture is a repo that
    // genuinely formats with biome.
    writeFileSync(join(repo, 'biome.jsonc'), '{}\n');
    execFileSync('git', ['add', '.gitignore', 'biome.jsonc'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });
    return repo;
  }

  function runInRepo(repo, { biome = '#!/bin/sh\nexit 0\n' } = {}) {
    const home = mkdtempSync(join(tmpdir(), 'dk-hook-git-home-'));
    homes.push(home);
    const bin = join(home, '.bun', 'bin');
    const packageBin = join(repo, 'node_modules', '.bin');
    mkdirSync(bin, { recursive: true });
    mkdirSync(packageBin, { recursive: true });
    writeFileSync(join(bin, 'bun'), '#!/bin/sh\nprintf \'%s\\n\' "$PWD/node_modules/.bin"\n');
    chmodSync(join(bin, 'bun'), 0o755);
    if (biome !== null) {
      writeFileSync(join(packageBin, 'biome'), biome);
      chmodSync(join(packageBin, 'biome'), 0o755);
    }
    const hookPath = join(home, 'pre-commit');
    writeFileSync(hookPath, buildFullHook({ biome: true, guards: [] }));
    try {
      const stdout = execFileSync('sh', ['-e', hookPath], {
        cwd: repo,
        env: { ...process.env, HOME: home, PATH: '/usr/bin:/bin' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { status: 0, stdout };
    } catch (e) {
      return { status: e.status, stdout: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  }

  it('re-stages a force-added gitignored dist/ file without aborting the hook', () => {
    const repo = initRepo();
    mkdirSync(join(repo, 'dist'));
    writeFileSync(join(repo, 'dist', 'out.mjs'), 'export const x = 1;\n');
    execFileSync('git', ['add', '-f', 'dist/out.mjs'], { cwd: repo });

    const r = runInRepo(repo);

    expect(r.stdout).not.toContain('ignored by gitignore');
    expect(r.status).toBe(0);
    const staged = execFileSync('git', ['diff', '--cached', '--name-only'], {
      cwd: repo,
      encoding: 'utf8',
    });
    expect(staged).toContain('dist/out.mjs');
  });

  // sc-2524. Every branch announces itself: "matched nothing", "all excluded" and "no formatter on
  // disk" previously all printed nothing, so the step's silence read as a clean format.
  describe('outcome reporting', () => {
    function stageFile(repo, name, body = 'const a  =  1\n') {
      writeFileSync(join(repo, name), body);
      execFileSync('git', ['add', name], { cwd: repo });
    }

    // Records argv, so "ONE path or two?" is answered by what the formatter received.
    const ARGV_STUB =
      '#!/bin/sh\nfor a in "$@"; do echo "ARG[$a]" >> "$PWD/argv.log"; done\nexit 0\n';
    const argvOf = (repo) => readFileSync(join(repo, 'argv.log'), 'utf8');

    // The opt-out the config gate restores: a repo that never asked devkit to rewrite its bytes
    // must not have them rewritten, and must be told the step stood down rather than staying silent.
    it('formats nothing and says so when the repo has no biome config', () => {
      const repo = initRepo();
      rmSync(join(repo, 'biome.jsonc'));
      execFileSync('git', ['rm', '-q', '--cached', 'biome.jsonc'], { cwd: repo });
      stageFile(repo, 'a.mts');
      const r = runInRepo(repo, { biome: ARGV_STUB });
      expect(r.status, r.stdout).toBe(0);
      expect(r.stdout).toContain('🎨 No biome config here');
      expect(existsSync(join(repo, 'argv.log'))).toBe(false); // biome was never invoked
    });

    it('reports that nothing matched when no staged path is formattable', () => {
      const repo = initRepo();
      stageFile(repo, 'notes.txt', 'hello\n');
      const r = runInRepo(repo);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('🎨 biome: no staged formattable path');
    });

    it('names the paths it skipped when every eligible one carries unstaged edits', () => {
      const repo = initRepo();
      stageFile(repo, 'a.mts');
      writeFileSync(join(repo, 'a.mts'), 'const a = 2\n'); // dirty AFTER staging
      const r = runInRepo(repo);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('every eligible path also carries unstaged edits');
      expect(r.stdout).toContain('a.mts');
      // Indented so the listed path never looks like a stage anchor to ship's log scraper.
      expect(r.stdout).not.toMatch(/^a\.mts$/m);
    });

    // The PARTIAL case is the one that bites: "formatted 3" over a staged set of 5 reads as a
    // clean pass while two unformatted files ride into the commit.
    it('names the skipped paths when only SOME eligible ones carry unstaged edits', () => {
      const repo = initRepo();
      stageFile(repo, 'clean.mts');
      stageFile(repo, 'dirty.mts');
      writeFileSync(join(repo, 'dirty.mts'), 'const b = 9\n'); // dirty AFTER staging
      const r = runInRepo(repo);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('dirty.mts');
      expect(r.stdout).toContain('🎨 biome formatted and re-staged 1 staged file(s).');
    });

    // `echo | xargs` splits on whitespace: the formatter gets two paths that do not exist and
    // `git add` fatals on the pathspec, which `sh -e` turns into a failed commit.
    it('passes a staged path containing a space as ONE argument, and still re-stages it', () => {
      const repo = initRepo();
      stageFile(repo, 'my file.mts');
      const r = runInRepo(repo, { biome: ARGV_STUB });
      expect(r.status, r.stdout).toBe(0);
      expect(argvOf(repo)).toContain('ARG[my file.mts]');
      expect(argvOf(repo)).not.toContain('ARG[my]');
      expect(r.stdout).not.toContain('did not match any files');
    });

    // git quotes non-ASCII paths without `-z`: `café.mts` arrives as "caf\303\251.mts", trailing
    // quote included, so the extension filter never matches and the file is silently skipped.
    it('formats a staged path with non-ASCII characters, which git quotes by default', () => {
      const repo = initRepo();
      stageFile(repo, 'café.mts');
      const r = runInRepo(repo, { biome: ARGV_STUB });
      expect(r.status, r.stdout).toBe(0);
      expect(r.stdout).toContain('🎨 biome formatted and re-staged 1 staged file(s).');
      expect(argvOf(repo)).toContain('ARG[café.mts]');
    });

    it('reports the formatted count on success', () => {
      const repo = initRepo();
      stageFile(repo, 'a.mts');
      stageFile(repo, 'b.cts');
      const r = runInRepo(repo);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('🎨 biome formatted and re-staged 2 staged file(s).');
    });

    it('reports a missing Oxfmt and lets the commit continue', () => {
      const repo = initRepo();
      stageFile(repo, 'a.mts');
      const r = runInRepo(repo, { biome: null });
      expect(r.status).toBe(0); // best-effort: a formatter outage is never a commit outage
      expect(r.stdout).toContain('biome is not installed at');
      expect(r.stdout).toContain('left UNFORMATTED');
    });

    // Not presented as Oxfmt's exit code: xargs collapses 1-125 into one status of its own (1 on
    // BSD, 123 on GNU), so "Oxfmt exited 3" would be a lie on both platforms.
    it("reports a failing Oxfmt without blocking the commit, and does not misattribute xargs' code", () => {
      const repo = initRepo();
      stageFile(repo, 'a.mts');
      const r = runInRepo(repo, { biome: '#!/bin/sh\nexit 3\n' });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('🎨 biome failed over 1 staged file(s)');
      expect(r.stdout).toContain('may be UNFORMATTED');
      expect(r.stdout).not.toContain('biome exited 3');
    });
  });
});

describe('assembled hook — shell/OS variants', () => {
  it.runIf(hasDash)('dash (Debian/Ubuntu /bin/sh): det-gate blocking + AI ordering hold', () => {
    const opts = { shell: '/bin/dash' };
    const fail = runHook({ DET_RC: '1' }, { biome: false, guards: ALL_GUARDS }, opts);
    expect(fail.status).toBe(1);
    expect(fail.calls).not.toContain('guard-decisions');
    const clean = runHook({ DET_RC: '0' }, { biome: false, guards: ALL_GUARDS }, opts);
    expect(clean.status).toBe(0);
    expect(clean.calls).toContain('guard-review');
  });

  it('a hook path containing SPACES survives every "$0"-derived quoting seam', () => {
    // devkit itself lives under "Personal and learning/" — the harness dir gets a space too.
    const r = runHook(
      { DET_RC: '0' },
      { biome: false, guards: ALL_GUARDS },
      {
        dirPrefix: 'dk hook exec-',
      },
    );
    expect(r.status).toBe(0);
    expect(r.calls).toContain('guard-deterministic --hook');
  });
});

// ── commit-terminal telemetry ──────────────────────────────────────────────────────────────
// The hook is the only process that knows the whole chain's outcome, so it emits the
// `commit_result` terminal for the every-commit telemetry run (run-context.mts contract).
// These run the ASSEMBLED hook inside a real temp git repo so attempt identity and tree correlation
// are both exercised.
describe('commit-terminal telemetry (real temp git repo)', () => {
  function runHookInRepo(env = {}, selection = { biome: false, guards: ALL_GUARDS }) {
    const home = mkdtempSync(join(tmpdir(), 'dk-hook-terminal-'));
    homes.push(home);
    const repo = join(home, 'consumer-repo');
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'my-branch'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
    // An initial commit so `git rev-parse --abbrev-ref HEAD` resolves the branch NAME (an unborn
    // branch resolves to the literal "HEAD"; a real consumer repo always has commits).
    writeFileSync(join(repo, 'init.txt'), 'init\n');
    execFileSync('git', ['add', 'init.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });
    writeFileSync(join(repo, 'a.txt'), 'staged\n');
    execFileSync('git', ['add', 'a.txt'], { cwd: repo });
    const tree = execFileSync('git', ['write-tree'], { cwd: repo, encoding: 'utf8' }).trim();
    const bin = join(home, '.bun', 'bin');
    const packageBin = join(repo, 'node_modules', '.bin');
    mkdirSync(bin, { recursive: true });
    mkdirSync(packageBin, { recursive: true });
    writeFileSync(join(bin, 'bun'), '#!/bin/sh\nprintf \'%s\\n\' "$PWD/node_modules/.bin"\n');
    chmodSync(join(bin, 'bun'), 0o755);
    const localGateStub =
      // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional shell ${VAR:-default} expansion in the stub
      '#!/bin/sh\ntool="${0##*/}"\ncase "$tool" in\n  guard-deterministic) [ "${MUTATE_TREE:-0}" = 1 ] && { printf \'later\\n\' > telemetry-restaged.txt; git add telemetry-restaged.txt; }; printf \'%s\' "$DEVKIT_COMMIT_ID" > "$HOME/gate-id"; exit ${DET_RC:-0};;\n  *) exit 0;;\nesac\n';
    for (const gate of [
      'guard-deterministic',
      'guard-comments',
      'guard-decisions',
      'guard-review',
    ]) {
      writeFileSync(join(packageBin, gate), localGateStub);
      chmodSync(join(packageBin, gate), 0o755);
    }
    const hookPath = join(home, 'pre-commit');
    writeFileSync(hookPath, buildFullHook(selection));
    const sink = join(home, 'events.jsonl');
    let status = 0;
    // vitest.setup exports DEVKIT_NO_TELEMETRY=1 suite-wide (ordinary tests must never write a
    // developer's live telemetry) — strip it here: THESE tests point the sink at a temp file and
    // exist precisely to prove the capture, so inheriting the suite opt-out would no-op them.
    const hookEnv = { ...process.env, HOME: home, PATH: '/usr/bin:/bin', DEVKIT_GATE_EVENTS: sink };
    delete hookEnv.DEVKIT_NO_TELEMETRY;
    delete hookEnv.DEVKIT_REVIEW_ID;
    delete hookEnv.DEVKIT_SHIP_ID;
    Object.assign(hookEnv, env);
    try {
      execFileSync('sh', ['-e', hookPath], {
        cwd: repo,
        env: hookEnv,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      status = e.status;
    }
    let events = [];
    if (existsSync(sink))
      events = readFileSync(sink, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    const gateId = existsSync(join(home, 'gate-id'))
      ? readFileSync(join(home, 'gate-id'), 'utf8')
      : null;
    const commitStatePath = join(repo, '.git', 'devkit-commit-attempt');
    const commitState = existsSync(commitStatePath) ? readFileSync(commitStatePath, 'utf8') : null;
    return { status, events, tree, gateId, commitState };
  }

  function expectNoCommitTerminal(result: { status: number; events: Array<{ type?: string }> }) {
    expect(result.status).toBe(0);
    expect(result.events.filter((event) => event.type === 'commit_result')).toEqual([]);
  }

  it('a passing chain gives the gate and terminal one attempt id and retains the staged tree', () => {
    const r = runHookInRepo();
    expect(r.status).toBe(0);
    const terminals = r.events.filter((e) => e.type === 'commit_result');
    expect(terminals.length).toBe(1);
    const t = terminals[0];
    expect(t.ship_id).toMatch(/^commit-run-[A-Za-z0-9-]+$/);
    expect(r.gateId).toBe(t.ship_id);
    expect(t.commit_tree).toBe(r.tree);
    expect(r.commitState).toBe(`${t.ship_id}\n${r.tree}\n`);
    expect(t.run_mode).toBe('commit');
    expect(t.exit_code).toBe(0);
    expect(t.repo).toBe('consumer-repo');
    expect(t.branch).toBe('my-branch');
    expect(typeof t.duration_s).toBe('number');
    expect(t.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it.each([
    ['hook-sess-1', 'hook-sess-1'],
    ['', undefined],
    ['x"y z', undefined],
  ])(
    'commit_result parent_session_id for %j (a malformed id never tears the line)',
    (value, expected) => {
      const r = runHookInRepo({ CLAUDE_CODE_SESSION_ID: value });
      expect(r.status).toBe(0);
      const terminal = r.events.find((e) => e.type === 'commit_result');
      expect(terminal.parent_session_id).toBe(expected);
    },
  );

  it('two attempts with identical staged content receive distinct ids', () => {
    const first = runHookInRepo();
    const second = runHookInRepo();
    expect(second.tree).toBe(first.tree);
    expect(second.events[0].ship_id).not.toBe(first.events[0].ship_id);
  });

  it('refreshes the handoff tree after a gate restages content', () => {
    const r = runHookInRepo({ MUTATE_TREE: '1' });
    const terminal = r.events.find((event) => event.type === 'commit_result');
    expect(terminal.commit_tree).not.toBe(r.tree);
    expect(r.commitState).toBe(`${terminal.ship_id}\n${terminal.commit_tree}\n`);
  });

  it('a gate-blocked chain (deterministic exit 1) emits commit_result exit_code 1', () => {
    const r = runHookInRepo({ DET_RC: '1' });
    expect(r.status).toBe(1);
    const t = r.events.filter((e) => e.type === 'commit_result');
    expect(t.length).toBe(1);
    expect(t[0].exit_code).toBe(1);
    expect(r.commitState).toBeNull();
  });

  it('does not leave a handoff when no commit-msg judge is selected', () => {
    const r = runHookInRepo({}, { biome: false, guards: ['size'] });
    expect(r.status).toBe(0);
    expect(r.commitState).toBeNull();
  });

  it('inside a ship (DEVKIT_SHIP_ID set) the hook stays silent — ship_result is that terminal', () => {
    expectNoCommitTerminal(runHookInRepo({ DEVKIT_SHIP_ID: 'some-ship' }));
  });

  it('inside a review (DEVKIT_REVIEW_ID set) the hook stays silent — review events own that run', () => {
    expectNoCommitTerminal(
      runHookInRepo({
        DEVKIT_REVIEW_ID: 'some-review',
        DEVKIT_RUN_MODE: 'review',
        DEVKIT_REVIEW_GUARDS: '',
      }),
    );
  });

  it('DEVKIT_NO_TELEMETRY opts the terminal out with the capture itself', () => {
    expectNoCommitTerminal(runHookInRepo({ DEVKIT_NO_TELEMETRY: '1' }));
  });
});

// sc-3012: a judge that can demand an edit must never follow the qavis advisory, whose pass receipt
// any source fix voids. commit-msg's sentry replays this verdict from cache (check-sentry tests).
describe('ship: sentry is judged before the qavis advisory', () => {
  const SHIP = { biome: false, guards: ['review', 'sentry', 'qavis-advisory'] };

  it.each(['package', 'standalone', 'overlay'])(
    '%s: review → sentry on the ship message → qavis',
    (builder) => {
      const r = runHook({}, SHIP, { shipMsg: true, builder, dirPrefix: 'dk hook exec sentry ' });
      expect(r.status).toBe(0);
      const review = r.calls.indexOf('guard-review --gate');
      const sentry = r.calls.indexOf('guard-sentry --gate');
      expect(review).toBeGreaterThan(-1);
      expect(review).toBeLessThan(sentry);
      expect(sentry).toBeLessThan(r.calls.indexOf('guard-qavis-advisory --gate'));
      expect(r.calls).toContain('ship-msg.txt');
      expect(r.calls).toContain('guard-sentry-argc 2'); // a temp path with spaces stays ONE argument
    },
  );

  it('an interactive commit (no ship message) leaves sentry to commit-msg', () => {
    const r = runHook({}, SHIP);
    expect(r.status).toBe(0);
    expect(r.calls).not.toContain('guard-sentry');
    expect(r.calls).toContain('guard-qavis-advisory --gate');
  });

  it('a stale DEVKIT_COMMIT_MSG_FILE whose file is gone never arms it', () => {
    const r = runHook({ DEVKIT_COMMIT_MSG_FILE: '/nonexistent/devkit-ship-msg.txt' }, SHIP);
    expect(r.status).toBe(0);
    expect(r.calls).not.toContain('guard-sentry');
  });

  it('sentry not selected → pre-commit never calls it, even on a ship', () => {
    const r = runHook(
      {},
      { biome: false, guards: ['review', 'qavis-advisory'] },
      { shipMsg: true },
    );
    expect(r.status).toBe(0);
    expect(r.calls).not.toContain('guard-sentry');
  });

  it('a confident MONITOR block (exit 1) stops the hook before the advisory', () => {
    const r = runHook({ SENTRY_RC: '1' }, SHIP, { shipMsg: true });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('un-monitored runtime error-class');
    expect(r.calls).not.toContain('guard-qavis-advisory');
  });

  it('an unreadable staged set (exit 4) blocks without naming a defect, before the advisory', () => {
    const r = runHook({ SENTRY_RC: '4' }, SHIP, { shipMsg: true });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('NOT a gate rejection');
    expect(r.stdout).not.toContain('un-monitored runtime error-class');
    expect(r.calls).not.toContain('guard-qavis-advisory');
  });

  it('an exit outside the contract (3) blocks before the advisory instead of falling through', () => {
    const r = runHook({ SENTRY_RC: '3' }, SHIP, { shipMsg: true });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('unexpected exit 3');
    expect(r.calls).not.toContain('guard-qavis-advisory');
  });

  it('a fail-open sentry (exit 2) continues to the advisory', () => {
    const r = runHook({ SENTRY_RC: '2' }, SHIP, { shipMsg: true });
    expect(r.status).toBe(0);
    expect(r.calls).toContain('guard-qavis-advisory --gate');
  });

  it('a reviewer FAIL blocks first — sentry is never paid for on a doomed tree', () => {
    const r = runHook({ REVIEW_RC: '1' }, SHIP, { shipMsg: true });
    expect(r.status).toBe(1);
    expect(r.calls).not.toContain('guard-sentry');
  });

  it('devkit review exports the same message file but never runs the commit judge', () => {
    const r = runHook(
      { DEVKIT_RUN_MODE: 'review', DEVKIT_REVIEW_GUARDS: 'review,sentry,qavis-advisory' },
      SHIP,
      { shipMsg: true },
    );
    expect(r.calls).toContain('guard-review --gate');
    expect(r.calls).not.toContain('guard-sentry');
  });

  it('package mode: a missing pinned guard-sentry blocks instead of skipping silently', () => {
    const r = runHook({}, SHIP, { shipMsg: true, missingLocalBins: ['guard-sentry'] });
    expect(r.status).toBe(1);
    expect(r.calls).not.toContain('guard-qavis-advisory');
  });

  it.each(['standalone', 'overlay'])(
    '%s: a guard-sentry missing from the installed devkit blocks',
    (builder) => {
      const r = runHook({}, SHIP, { shipMsg: true, builder, missingBins: ['guard-sentry'] });
      expect(r.status).toBe(1);
      expect(r.calls).not.toContain('guard-qavis-advisory');
    },
  );

  it('monorepo package block: a sentry block propagates out of the package subshell', () => {
    const r = runHook({ SENTRY_RC: '1' }, SHIP, { shipMsg: true, pkgRel: 'pkg/a' });
    expect(r.status).toBe(1);
    expect(r.calls).toContain('guard-sentry --gate');
    expect(r.calls).not.toContain('guard-qavis-advisory');
  });
});

// sc-3020: cheap blocking staged gates run before the paid AI guards; review keeps its baselines
// after them (fallow-gate-owned-by-fallow, 2026-09-28 note).
describe('overlay staged gates run before the AI guards (sc-3020)', () => {
  const REVIEWED = { biome: false, guards: ['comments', 'decisions', 'review'] };
  // sc-2753: comments rides guard-deterministic, which already runs before fallow.
  const AI_CALLS = ['guard-decisions', 'guard-review'];
  // The overlay harness stubs `node` to log as `baseline`.
  const PRESERVED =
    'baseline --preserve-symlinks node_modules/eslint/bin/eslint.js -c eslint.config.devkit.mjs';
  const overlay = (extra = {}) => ({ builder: 'overlay', fallow: true, staged: true, ...extra });

  for (const mode of ['', 'ship', 'dry-gates']) {
    it(`a failing fallow audit blocks before any AI guard runs (mode=${mode || 'commit'})`, () => {
      // dry-gates selects only DEVKIT_REVIEW_GUARDS; comments,review models --with-reviewers.
      const env = { FALLOW_RC: '1', DEVKIT_RUN_MODE: mode };
      if (mode === 'dry-gates') env.DEVKIT_REVIEW_GUARDS = 'comments,review';
      const r = runHook(env, REVIEWED, overlay());
      expect(r.status).toBe(1);
      expect(r.calls).toContain('fallow audit --diff-stdin');
      for (const ai of AI_CALLS) expect(r.calls).not.toContain(ai);
    });
  }

  it('a passing fallow audit runs first, then every AI guard', () => {
    const r = runHook({}, REVIEWED, overlay());
    expect(r.status).toBe(0);
    const fallowAt = r.calls.indexOf('fallow audit');
    expect(fallowAt).toBeGreaterThanOrEqual(0);
    for (const ai of AI_CALLS) expect(r.calls.indexOf(ai)).toBeGreaterThan(fallowAt);
  });

  it('the deterministic orchestrator still runs before fallow, and its failure skips fallow', () => {
    const passing = runHook({}, { biome: false, guards: ['size', 'review'] }, overlay());
    expect(passing.calls.indexOf('guard-deterministic')).toBeLessThan(
      passing.calls.indexOf('fallow audit'),
    );
    const failing = runHook(
      { DET_RC: '1' },
      { biome: false, guards: ['size', 'review'] },
      overlay(),
    );
    expect(failing.status).toBe(1);
    expect(failing.calls).not.toContain('fallow');
    expect(failing.calls).not.toContain('guard-review');
  });

  it('blocks before the AI guards when no deterministic guard is selected (helpers still defined)', () => {
    const r = runHook({ FALLOW_RC: '1' }, { biome: false, guards: ['review'] }, overlay());
    expect(r.status).toBe(1);
    expect(r.calls).toContain('fallow audit');
    expect(r.calls).not.toContain('guard-review');
  });

  it('a failing eslint overlay blocks before any AI guard runs', () => {
    const r = runHook(
      { ESLINT_RC: '1' },
      REVIEWED,
      overlay({ fallow: false, eslintOverlay: true }),
    );
    expect(r.status).toBe(1);
    expect(r.calls).toContain('eslint -c eslint.config.devkit.mjs');
    for (const ai of AI_CALLS) expect(r.calls).not.toContain(ai);
  });

  // A plugin that roots at its own real path judges the caller's checkout through a linked
  // node_modules, so the staged step must run eslint with the link preserved.
  it.each([
    ['a real node_modules', undefined, 'eslint -c eslint.config.devkit.mjs'],
    ['a linked node_modules', {}, PRESERVED],
    ['a linked pnpm layout', { store: '.pnpm' }, 'eslint -c eslint.config.devkit.mjs'],
    ['a linked bun isolated layout', { store: '.bun' }, 'eslint -c eslint.config.devkit.mjs'],
    ['a linked install without eslint.js', { entry: false }, 'eslint -c eslint.config.devkit.mjs'],
  ])('the eslint overlay preserves symlinks only where it is safe: %s', (_name, linked, call) => {
    const r = runHook(
      {},
      REVIEWED,
      overlay({ fallow: false, eslintOverlay: true, linkedNodeModules: linked }),
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).toContain(`${call} src/staged.ts`);
    expect(r.calls.includes('--preserve-symlinks')).toBe(call === PRESERVED);
  });

  it('an eslint overlay whose repo binary is missing says so instead of skipping silently', () => {
    const r = runHook(
      {},
      REVIEWED,
      overlay({ fallow: false, eslintOverlay: true, missingLocalBins: ['eslint'] }),
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      'devkit eslint overlay: skipped — node_modules/.bin/eslint not found',
    );
    expect(r.calls).not.toContain('eslint -c');
    expect(r.calls).toContain('guard-review --gate');
  });

  it('a monorepo package subshell propagates the fallow block before the AI guards', () => {
    const r = runHook({ FALLOW_RC: '1' }, REVIEWED, overlay({ pkgRel: 'pkg/a' }));
    expect(r.status).toBe(1);
    expect(r.calls).toContain('fallow audit');
    for (const ai of AI_CALLS) expect(r.calls).not.toContain(ai);
  });

  it('fallow absent stays fail-open: the AI guards still run and the commit passes', () => {
    const r = runHook({}, REVIEWED, overlay({ fallow: false }));
    expect(r.status).toBe(0);
    expect(r.calls).not.toContain('fallow');
    expect(r.calls).toContain('guard-review --gate');
  });

  it('review mode keeps the fallow baseline after the reviewer and never runs the staged audit', () => {
    const r = runHook(
      { DEVKIT_RUN_MODE: 'review', DEVKIT_REVIEW_GUARDS: 'review', FALLOW_RC: '1' },
      REVIEWED,
      overlay(),
    );
    expect(r.calls).not.toContain('fallow audit');
    expect(r.calls).toContain('guard-review --gate');
    // The node stub logs `baseline <helper path> <gate> <baseline dir>`.
    const baselineFallow = r.calls.search(/^baseline \S+ fallow /m);
    expect(baselineFallow).toBeGreaterThan(r.calls.indexOf('guard-review --gate'));
  });

  it.skipIf(!hasDash)('the reordered overlay stays POSIX: dash blocks on fallow before AI', () => {
    const r = runHook({ FALLOW_RC: '1' }, REVIEWED, overlay({ shell: 'dash' }));
    expect(r.status).toBe(1);
    expect(r.calls).toContain('fallow audit');
    expect(r.calls).not.toContain('guard-review');
  });
});

// sc-2695: an overlay lint block names ship's --dry-gates rehearsal from its OWN failure arm (the
// shell banner attributes nothing), and only when a new ship exported the command.
describe('overlay lint blocks name the ship --dry-gates rehearsal (sc-2695)', () => {
  const REVIEWED = { biome: false, guards: ['comments', 'decisions', 'review'] };
  const CMD = "devkit ship feat/x 'add thing' --dry-gates --base main -- src/staged.ts";
  const LEAD = "Ship's exact staging, no judges:";
  const overlay = (extra = {}) => ({ builder: 'overlay', fallow: false, staged: true, ...extra });
  // A plain commit replays its gate log on stdout at exit; a ship keeps the hook's own stderr.
  const ARMS = [
    ['eslint', { ESLINT_RC: '1' }, { eslintOverlay: true }],
    ['biome', { BIOME_RC: '1' }, { biomeOverlay: true }],
    ['fallow', { FALLOW_RC: '1' }, { fallow: true }],
  ];

  for (const [arm, rc, fixture] of ARMS) {
    it(`a failing ${arm} overlay prints the command verbatim, after its own run`, () => {
      const r = runHook({ ...rc, DEVKIT_SHIP_DRY_GATES_CMD: CMD }, REVIEWED, overlay(fixture));
      expect(r.status).toBe(1);
      expect(r.calls).toContain(arm);
      expect(`${r.stdout}${r.stderr}`).toContain(LEAD);
      expect(`${r.stdout}${r.stderr}`).toContain(`     ${CMD}\n`);
      expect(r.calls).not.toContain('guard-review');
    });

    it(`a failing ${arm} overlay prints nothing extra when no ship exported a command`, () => {
      const r = runHook(rc, REVIEWED, overlay(fixture));
      expect(r.status).toBe(1);
      expect(`${r.stdout}${r.stderr}`).not.toContain(LEAD);
    });
  }

  it('an exported-but-empty command (the helper failed) prints no dangling lead', () => {
    const r = runHook(
      { ESLINT_RC: '1', DEVKIT_SHIP_DRY_GATES_CMD: '' },
      REVIEWED,
      overlay({ eslintOverlay: true }),
    );
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).not.toContain(LEAD);
  });

  it('prints a hostile title/path byte-for-byte and never evaluates it', () => {
    // A title is user text; the hook must echo the pre-quoted command, not re-run its expansions.
    const hostile = `devkit ship x '$(touch pwned) \`touch pwned2\` $HOME "q"' --dry-gates -- 'a b.ts'`;
    const r = runHook(
      { ESLINT_RC: '1', DEVKIT_SHIP_DRY_GATES_CMD: hostile },
      REVIEWED,
      overlay({ eslintOverlay: true }),
    );
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toContain(`     ${hostile}\n`);
    expect(existsSync(join(r.home, 'pwned'))).toBe(false);
    expect(existsSync(join(r.home, 'pwned2'))).toBe(false);
  });

  it('a reviewer block never names the rehearsal — --dry-gates cannot reproduce it', () => {
    const r = runHook(
      { REVIEW_RC: '1', DEVKIT_SHIP_DRY_GATES_CMD: CMD },
      REVIEWED,
      overlay({ fallow: true }),
    );
    expect(r.status).toBe(1);
    expect(r.calls).toContain('guard-review --gate');
    expect(`${r.stdout}${r.stderr}`).not.toContain(CMD);
  });

  it('a monorepo package subshell still prints the hint and propagates the block', () => {
    const r = runHook(
      { FALLOW_RC: '1', DEVKIT_SHIP_DRY_GATES_CMD: CMD },
      REVIEWED,
      overlay({ fallow: true, pkgRel: 'pkg/a' }),
    );
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toContain(`     ${CMD}\n`);
    expect(r.calls).not.toContain('guard-review');
  });

  it.skipIf(!hasDash)('stays POSIX: dash prints the hint and blocks on a failing overlay', () => {
    const r = runHook(
      { ESLINT_RC: '1', DEVKIT_SHIP_DRY_GATES_CMD: CMD },
      REVIEWED,
      overlay({ eslintOverlay: true, shell: 'dash' }),
    );
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toContain(`     ${CMD}\n`);
  });

  it.skipIf(!hasDash)("dash's echo would expand backslashes — the command still prints raw", () => {
    const raw = "devkit ship x 'fix a\\nb \\c tail' --dry-gates -- a.ts";
    const r = runHook(
      { ESLINT_RC: '1', DEVKIT_SHIP_DRY_GATES_CMD: raw },
      REVIEWED,
      overlay({ eslintOverlay: true, shell: 'dash' }),
    );
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toContain(`     ${raw}\n`);
  });
});

// Package and standalone hooks carry the staged audit; it blocks only on a finding.
describe.each(['package', 'standalone'])('staged fallow gate (%s hook)', (builder) => {
  const SEL = { biome: false, guards: ['review'], fallow: true };
  const run = (env = {}, opts = {}) =>
    runHook(env, SEL, { builder, fallow: true, staged: true, ...opts });

  it('blocks on a fail verdict (exit 1) before the AI guards run', () => {
    const r = run({ FALLOW_RC: '1' });
    expect(r.status).toBe(1);
    expect(r.calls).toContain('fallow audit --diff-stdin');
    expect(r.calls).not.toContain('guard-review');
  });

  it('does not block when fallow errors (exit 2: no detectable base branch, bad config)', () => {
    const r = run({ FALLOW_RC: '2' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('fallow exited 2 without a verdict');
    expect(r.calls).toContain('guard-review');
  });

  it('skips the audit when nothing is staged', () => {
    const r = run({ FALLOW_RC: '1' }, { staged: 'empty' });
    expect(r.status).toBe(0);
    expect(r.calls).not.toContain('fallow');
  });

  it("skips the audit above fallow's 10 MiB stdin cap, where it would report the whole project", () => {
    const r = run({ FALLOW_RC: '1' }, { staged: 'huge' });
    expect(r.status).toBe(0);
    expect(r.calls).not.toContain('fallow');
    expect(r.stdout).toContain('audit skipped');
  });

  // fallow's own cap message: "--diff-stdin is at least 10485761 bytes (cap 10485760)".
  it('audits a diff of exactly 10485760 bytes and skips one byte more', () => {
    expect(run({ FALLOW_RC: '1' }, { staged: 10485760 }).calls).toContain('fallow audit');
    expect(run({ FALLOW_RC: '1' }, { staged: 10485761 }).calls).not.toContain('fallow');
  });

  it('skips the audit in review mode and when fallow is not installed', () => {
    expect(run({ FALLOW_RC: '1', DEVKIT_RUN_MODE: 'review' }).calls).not.toContain('fallow');
    const absent = run({ FALLOW_RC: '1' }, { fallow: false });
    expect(absent.status).toBe(0);
    expect(absent.calls).toContain('guard-review');
  });

  // git exports GIT_INDEX_FILE relative to the repo top; the package subshell must still read it.
  it.each([
    {},
    { GIT_INDEX_FILE: '.git/index' },
    { GIT_DIR: '.git', GIT_INDEX_FILE: '.git/index' },
  ])(
    'audits the commit index from a monorepo package subshell and propagates its block (%o)',
    (env) => {
      const r = run({ FALLOW_RC: '1', ...env }, { pkgRel: 'packages/app' });
      expect(r.status).toBe(1);
      expect(r.calls).toContain('fallow audit --diff-stdin');
      expect(r.calls).not.toContain('guard-review');
    },
  );

  it('skips, never blocks, when the staged diff cannot be captured', () => {
    const r = run({ FALLOW_RC: '1', GIT_INDEX_FILE: tmpdir() }); // an index path that is a directory
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('could not capture the staged diff');
    expect(r.calls).not.toContain('fallow');
  });

  it.skipIf(!hasDash)('runs under dash', () => {
    expect(run({ FALLOW_RC: '2' }, { shell: '/bin/dash' }).status).toBe(0);
    expect(run({ FALLOW_RC: '1' }, { shell: '/bin/dash' }).status).toBe(1);
  });
});
