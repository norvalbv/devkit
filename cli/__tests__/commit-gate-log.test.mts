import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCommitMsgHook } from '../lib/husky/commit-msg-block.mts';
import {
  buildCommitGateLogFragment,
  buildPreCommitExit,
  COMMIT_GATE_LOG_GLOB,
  exitDispatchTrap,
} from '../lib/husky/gate-policy/commit-gate-log.mts';
import { buildFullHook, buildOverlayHook } from '../lib/husky/husky-block.mts';
import { DEVKIT_CACHE_IGNORES } from '../lib/install/gitignore-cache.mts';

// sc-2755: a plain `git commit` persists its gate output. Every case drives a REAL `git commit`
// (core.hooksPath → generated hooks) unless it needs the hook's own exit code, which git hides.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      chmodSync(join(d, 'repo', '.devkit'), 0o755);
    } catch {
      // only the read-only case changes modes
    }
    rmSync(d, { recursive: true, force: true });
  }
});

const hasDash = existsSync('/bin/dash');
// A real terminal for the follower path: BSD script takes the command as argv, util-linux as -c.
const scriptArgs = (cmd: string[]) =>
  process.platform === 'darwin'
    ? ['-q', '/dev/null', ...cmd]
    : ['-qec', cmd.map((a) => `'${a.replaceAll("'", "'\\''")}'`).join(' '), '/dev/null'];
const hasScript =
  spawnSync('script', scriptArgs(['true']), { stdio: 'ignore', timeout: 10_000 }).status === 0;
const isRoot = process.getuid?.() === 0;

// Inherited DEVKIT_/GUARD_/GIT_ state (a test run inside a ship or a hook) would flip the skip
// conditions under test, so the child env is rebuilt from a clean slate.
function cleanEnv(extra: Record<string, string> = {}) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^(DEVKIT_|GUARD_|GIT_|CLAUDE_CODE_SESSION_ID)/.test(k)) continue;
    env[k] = v;
  }
  return {
    ...env,
    GIT_AUTHOR_NAME: 'T',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 'T',
    GIT_COMMITTER_EMAIL: 't@example.com',
    ...extra,
  };
}

// A gate body whose output and exit come from env knobs: an advisory line, then a verdict.
const GATE_BODY = `echo "ADVISORY: parallel judge note (stdout)"
echo "ADVISORY: parallel judge warning (stderr)" >&2
if [ "\${GATE_RC:-0}" -ne 0 ]; then
    echo "BLOCKING: the gate's remediation" >&2
    exit "$GATE_RC"
fi
echo "GATES-PASSED"`;

function preCommitHook(body = GATE_BODY) {
  return `#!/bin/sh\n${buildPreCommitExit(true)}\n${body}\nexit 0\n`;
}

function setup({
  preCommit = preCommitHook(),
  commitMsg,
  branch = 'main',
}: { preCommit?: string; commitMsg?: string; branch?: string } = {}) {
  // realpath: git reports the toplevel resolved (/private/var on macOS), and so does the log path.
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'dk-gate-log-')));
  dirs.push(base);
  const repo = join(base, 'repo');
  const hooks = join(base, 'hooks');
  mkdirSync(repo);
  mkdirSync(hooks);
  execFileSync('git', ['init', '-q', '-b', branch], { cwd: repo });
  writeFileSync(join(hooks, 'pre-commit'), preCommit);
  chmodSync(join(hooks, 'pre-commit'), 0o755);
  if (commitMsg) {
    writeFileSync(join(hooks, 'commit-msg'), commitMsg);
    chmodSync(join(hooks, 'commit-msg'), 0o755);
  }
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  execFileSync('git', ['add', 'a.txt'], { cwd: repo });
  return { base, repo, hooks, events: join(base, 'events.jsonl') };
}

function commit(
  ctx: { repo: string; hooks: string; events: string; base: string },
  env: Record<string, string> = {},
) {
  const r = spawnSync('git', ['-c', `core.hooksPath=${ctx.hooks}`, 'commit', '-q', '-m', 'msg'], {
    cwd: ctx.repo,
    env: cleanEnv({ HOME: ctx.base, DEVKIT_GATE_EVENTS: ctx.events, ...env }),
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, stderr: r.stderr };
}

const logOf = (repo: string, name = 'main') =>
  join(repo, '.devkit', `last-commit-gates-${name}.log`);

describe('plain git commit gate log (sc-2755)', () => {
  it('writes the full output on PASS and prints the path in ship wording', () => {
    const ctx = setup();
    const r = commit(ctx);
    expect(r.status, r.out).toBe(0);
    const log = readFileSync(logOf(ctx.repo), 'utf8');
    expect(log).toMatch(/^=== devkit pre-commit gates · main · attempt commit-run-/);
    expect(log).toContain('ADVISORY: parallel judge note (stdout)');
    expect(log).toContain('ADVISORY: parallel judge warning (stderr)');
    expect(log).toContain('GATES-PASSED');
    // The reader still gets every byte (replayed), then the pointer.
    expect(r.stderr).toContain('ADVISORY: parallel judge warning (stderr)');
    expect(r.stderr).toContain(`✓ pre-commit gates ran — full output: ${logOf(ctx.repo)}`);
  });

  it('keeps the advisory output ABOVE the blocking finding on FAIL, and names the log last', () => {
    const ctx = setup();
    const r = commit(ctx, { GATE_RC: '1' });
    expect(r.status).not.toBe(0);
    const log = readFileSync(logOf(ctx.repo), 'utf8');
    expect(log.indexOf('ADVISORY: parallel judge note')).toBeGreaterThan(-1);
    expect(log.indexOf('ADVISORY: parallel judge note')).toBeLessThan(log.indexOf('BLOCKING:'));
    const tail = r.stderr.trimEnd().split('\n').slice(-2).join('\n');
    expect(tail).toContain(`🛑 pre-commit blocked. Full log: ${logOf(ctx.repo)}`);
    expect(tail).toContain('non-blocking findings above the blocking one');
    expect(r.stderr).not.toContain('✓ pre-commit gates ran');
  });

  it('truncates per attempt — a re-run never shows the previous attempt’s findings', () => {
    const ctx = setup();
    expect(commit(ctx, { GATE_RC: '1' }).status).not.toBe(0);
    expect(commit(ctx).status).toBe(0);
    const log = readFileSync(logOf(ctx.repo), 'utf8');
    expect(log).not.toContain('BLOCKING:');
    expect(log.match(/^=== devkit pre-commit gates/gm)).toHaveLength(1);
  });

  it.each([
    ['DEVKIT_SHIP_ID', { DEVKIT_SHIP_ID: 'ship-1' }],
    ['DEVKIT_REVIEW_ID', { DEVKIT_REVIEW_ID: 'rev-1' }],
    ['DEVKIT_RUN_MODE', { DEVKIT_RUN_MODE: 'review' }],
    ['DEVKIT_GATE_LOG=0', { DEVKIT_GATE_LOG: '0' }],
  ])('does not capture under %s (ship/review keep their own logs; 0 opts out)', (_n, env) => {
    const ctx = setup();
    const r = commit(ctx, env);
    expect(r.status, r.out).toBe(0);
    expect(existsSync(join(ctx.repo, '.devkit'))).toBe(false);
    expect(r.out).toContain('ADVISORY: parallel judge warning (stderr)');
    expect(r.out).not.toContain('full output:');
  });

  it('still writes the log with telemetry off — the two exit parts are gated independently', () => {
    const ctx = setup();
    const r = commit(ctx, { DEVKIT_NO_TELEMETRY: '1' });
    expect(r.status, r.out).toBe(0);
    expect(existsSync(logOf(ctx.repo))).toBe(true);
    expect(existsSync(ctx.events)).toBe(false);
  });

  it('runs BOTH exit parts through one trap: commit_result is still emitted beside the log', () => {
    const ctx = setup();
    expect(commit(ctx, { GATE_RC: '1' }).status).not.toBe(0);
    const row = JSON.parse(readFileSync(ctx.events, 'utf8').trim().split('\n').at(-1) ?? '');
    expect(row).toMatchObject({ type: 'commit_result', run_mode: 'commit', exit_code: 1 });
    // The header carries the same attempt id, so the log joins its telemetry row.
    expect(readFileSync(logOf(ctx.repo), 'utf8')).toContain(`attempt ${row.ship_id}`);
  });

  it.skipIf(isRoot)(
    'fails OPEN when .devkit is unwritable: the commit proceeds, output still shown',
    () => {
      const ctx = setup();
      mkdirSync(join(ctx.repo, '.devkit'));
      chmodSync(join(ctx.repo, '.devkit'), 0o555);
      const r = commit(ctx);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain('could not write the gate log');
      expect(r.out).toContain('GATES-PASSED');
      expect(r.out).not.toContain('full output:');
    },
  );

  it('names the log from the branch with / flattened, and from the short sha when detached', () => {
    const ctx = setup({ branch: 'feat/sc-1/x' });
    expect(commit(ctx).status).toBe(0);
    expect(existsSync(logOf(ctx.repo, 'feat-sc-1-x'))).toBe(true);

    execFileSync('git', ['checkout', '-q', '--detach'], { cwd: ctx.repo });
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: ctx.repo,
      encoding: 'utf8',
    }).trim();
    writeFileSync(join(ctx.repo, 'b.txt'), 'b\n');
    execFileSync('git', ['add', 'b.txt'], { cwd: ctx.repo });
    expect(commit(ctx).status).toBe(0);
    expect(existsSync(logOf(ctx.repo, sha))).toBe(true);
  });

  it('never offers the log to `git add -A` in a repo whose gitignore predates it', () => {
    const ctx = setup();
    expect(commit(ctx).status).toBe(0);
    expect(existsSync(logOf(ctx.repo))).toBe(true);
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: ctx.repo,
      encoding: 'utf8',
    });
    expect(status).toBe('');
  });

  it('leaves a consumer’s own .devkit/.gitignore untouched', () => {
    const ctx = setup();
    mkdirSync(join(ctx.repo, '.devkit'));
    writeFileSync(join(ctx.repo, '.devkit', '.gitignore'), 'theirs\n');
    expect(commit(ctx).status).toBe(0);
    expect(readFileSync(join(ctx.repo, '.devkit', '.gitignore'), 'utf8')).toBe('theirs\n');
  });

  it('is ignored by the repo’s gitignore and listed for consumers', () => {
    expect(DEVKIT_CACHE_IGNORES).toContain(COMMIT_GATE_LOG_GLOB);
    const root = join(import.meta.dirname, '..', '..');
    const r = spawnSync(
      'git',
      ['check-ignore', '-q', '--no-index', '.devkit/last-commit-gates-feat-x.log'],
      { cwd: root, timeout: 10_000 },
    );
    expect(r.status).toBe(0);
  });
});

describe('on a terminal the output streams live, once', () => {
  it.skipIf(!hasScript)(
    'mirrors through a follower, prints each line once, and leaves no tail behind',
    () => {
      const ctx = setup();
      const r = spawnSync(
        'script',
        scriptArgs(['git', '-c', `core.hooksPath=${ctx.hooks}`, 'commit', '-q', '-m', 'msg']),
        {
          cwd: ctx.repo,
          env: cleanEnv({ HOME: ctx.base, DEVKIT_NO_TELEMETRY: '1' }),
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 60_000,
        },
      );
      const out = `${r.stdout}${r.stderr}`;
      expect(r.status, out).toBe(0);
      expect(out.split('ADVISORY: parallel judge warning (stderr)').length - 1).toBe(1);
      expect(out).toContain('GATES-PASSED');
      expect(out).toContain('✓ pre-commit gates ran — full output:');
      expect(out.indexOf('GATES-PASSED')).toBeLessThan(out.indexOf('full output:'));
      const ps = spawnSync('ps', ['-axo', 'command'], { encoding: 'utf8', timeout: 10_000 }).stdout;
      expect(ps).not.toContain(logOf(ctx.repo));
    },
  );
});

describe('commit-msg joins the same attempt’s log', () => {
  const msgHook = (rcVar: string) =>
    `#!/bin/sh\n${buildCommitGateLogFragment('commit-msg')}\n${exitDispatchTrap(['__dk_gate_log_finish'])}\necho "MSG-JUDGE: verdict"\nexit "\${${rcVar}:-0}"\n`;

  it('appends to pre-commit’s log and names it when the message judge blocks', () => {
    const ctx = setup({ commitMsg: msgHook('MSG_RC') });
    const r = commit(ctx, { MSG_RC: '1' });
    expect(r.status).not.toBe(0);
    const log = readFileSync(logOf(ctx.repo), 'utf8');
    expect(log).toContain('GATES-PASSED');
    expect(log).toContain('=== devkit commit-msg gates');
    expect(log.indexOf('GATES-PASSED')).toBeLessThan(log.indexOf('MSG-JUDGE: verdict'));
    expect(r.stderr.trimEnd().split('\n').slice(-2).join('\n')).toContain(
      `🛑 commit-msg blocked. Full log: ${logOf(ctx.repo)}`,
    );
    // The handoff is consumed — it cannot glue a later attempt onto this one.
    const gitDir = join(ctx.repo, '.git');
    expect(existsSync(join(gitDir, 'devkit-gate-log'))).toBe(false);
  });

  it('starts FRESH when pre-commit left no handoff (blocked earlier, or --no-verify’d before)', () => {
    const ctx = setup({ commitMsg: msgHook('MSG_RC') });
    expect(commit(ctx, { GATE_RC: '1' }).status).not.toBe(0); // pre-commit blocks: no handoff kept
    expect(existsSync(join(ctx.repo, '.git', 'devkit-gate-log'))).toBe(false);
    // Only the message hook runs now (pre-commit capture off) — it must not append to the stale log.
    writeFileSync(join(ctx.hooks, 'pre-commit'), '#!/bin/sh\nexit 0\n');
    expect(commit(ctx).status).toBe(0);
    const log = readFileSync(logOf(ctx.repo), 'utf8');
    expect(log).not.toContain('BLOCKING:');
    expect(log).toMatch(/^=== devkit commit-msg gates/);
  });

  it('the generated commit-msg hook still clears the telemetry handoff through the shared trap', () => {
    const hook = buildCommitMsgHook({ guards: ['review'] });
    expect(hook).toContain(
      `trap '__dk_x=$?; __dk_gl_rc=$__dk_x; command -v __dk_clear_commit_state >/dev/null 2>&1 && { __dk_clear_commit_state "$__dk_x" || :; }; command -v __dk_gate_log_finish`,
    );
    expect(hook.match(/^trap /gm)).toHaveLength(1);
  });
});

describe('the hook’s own exit code and shell portability', () => {
  // git collapses every hook failure into "commit failed", so the code itself is read directly.
  function runDirect(shell: string, env: Record<string, string>) {
    const ctx = setup();
    const hookPath = join(ctx.hooks, 'pre-commit');
    const r = spawnSync(shell, ['-e', hookPath], {
      cwd: ctx.repo,
      env: cleanEnv({ HOME: ctx.base, DEVKIT_GATE_EVENTS: ctx.events, ...env }),
      encoding: 'utf8',
      timeout: 30_000,
    });
    return { ...r, ctx };
  }

  it.each([['sh'], ...(hasDash ? [['dash']] : [])])(
    '%s: preserves a non-1 gate exit code and still closes the log',
    (shell) => {
      const r = runDirect(shell, { GATE_RC: '3' });
      expect(r.status).toBe(3);
      expect(readFileSync(logOf(r.ctx.repo), 'utf8')).toContain('BLOCKING:');
      expect(r.stdout).toContain('🛑 pre-commit blocked. Full log:');
    },
  );

  it.each([['sh'], ...(hasDash ? [['dash']] : [])])(
    '%s: a gate that dies on `sh -e` (no explicit exit) is still captured and reported',
    (shell) => {
      const ctx = setup({ preCommit: preCommitHook('echo "BEFORE-FALSE"\nfalse\necho NEVER') });
      const r = spawnSync(shell, ['-e', join(ctx.hooks, 'pre-commit')], {
        cwd: ctx.repo,
        env: cleanEnv({ HOME: ctx.base, DEVKIT_NO_TELEMETRY: '1' }),
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(r.status).toBe(1);
      const log = readFileSync(logOf(ctx.repo), 'utf8');
      expect(log).toContain('BEFORE-FALSE');
      expect(log).not.toContain('NEVER');
      expect(r.stdout).toContain('🛑 pre-commit blocked.');
    },
  );
});

describe('generated builders wire the capture end to end', () => {
  // A minimal `bun` + gate stub so the REAL generated block runs under git.
  function stubBins(base: string) {
    const bin = join(base, 'bin');
    const pkgBin = join(base, 'pkgbin');
    mkdirSync(bin);
    mkdirSync(pkgBin);
    writeFileSync(join(bin, 'bun'), `#!/bin/sh\nprintf '%s\\n' "${pkgBin}"\n`);
    const gate = `#!/bin/sh\necho "STUB \${0##*/} $*"\nexit \${DEC_RC:-0}\n`;
    chmodSync(join(bin, 'bun'), 0o755);
    // guard-deterministic is how the global (overlay) block locates devkit's bin dir.
    for (const name of ['guard-decisions', 'guard-deterministic']) {
      for (const dir of [pkgBin, bin]) {
        writeFileSync(join(dir, name), gate);
        chmodSync(join(dir, name), 0o755);
      }
    }
    return bin;
  }

  it('the package hook captures a monorepo package block at the REPO ROOT, not the package', () => {
    const ctx = setup({ preCommit: buildFullHook({ biome: false, guards: ['decisions'] }, 'pkg') });
    mkdirSync(join(ctx.repo, 'pkg'));
    const bin = stubBins(ctx.base);
    const r = commit(ctx, { PATH: `${bin}:${process.env.PATH}`, DEC_RC: '1' });
    expect(r.status).not.toBe(0);
    expect(existsSync(join(ctx.repo, 'pkg', '.devkit'))).toBe(false);
    expect(readFileSync(logOf(ctx.repo), 'utf8')).toContain('STUB guard-decisions');
    expect(r.stderr).toContain(`Full log: ${logOf(ctx.repo)}`);
  });

  it('the overlay hook closes the log BEFORE exec-ing the repo’s own hook on pass', () => {
    const ctx = setup();
    const chained = join(ctx.hooks, 'repo-pre-commit');
    writeFileSync(chained, '#!/bin/sh\necho "REPO-OWN-HOOK ran ARGC=$#"\nexit 0\n');
    writeFileSync(
      join(ctx.hooks, 'pre-commit'),
      buildOverlayHook({ biome: false, guards: ['decisions'] }, chained),
    );
    chmodSync(join(ctx.hooks, 'pre-commit'), 0o755);
    const bin = stubBins(ctx.base);
    const r = commit(ctx, { PATH: `${bin}:${process.env.PATH}` });
    expect(r.status, r.out).toBe(0);
    const log = readFileSync(logOf(ctx.repo), 'utf8');
    expect(log).toContain('STUB guard-decisions');
    expect(log).not.toContain('REPO-OWN-HOOK');
    expect(r.stderr).toContain('✓ pre-commit gates ran — full output:');
    expect(r.stderr.indexOf('full output:')).toBeLessThan(r.stderr.indexOf('REPO-OWN-HOOK ran'));
    // bash (macOS /bin/sh) leaks a redirect-only `exec`'s function args into the caller: closing
    // the log must not hand the repo's hook a spurious "0".
    expect(r.stderr).toContain('REPO-OWN-HOOK ran ARGC=0');
  });
});
