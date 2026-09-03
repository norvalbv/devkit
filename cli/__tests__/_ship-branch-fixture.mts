import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect } from 'vitest';
import {
  testExecFileSync as execFileSync,
  hasAnyCommand,
  testSpawnSync as spawnSync,
} from './_helpers.mts';

export const scriptPath = fileURLToPath(new URL('../lib/ship/ship-branch.sh', import.meta.url));
export const reshipScript = fileURLToPath(new URL('../lib/ship/reship.sh', import.meta.url));
export const linkGateConfigsScript = fileURLToPath(
  new URL('../lib/ship/link-gate-configs.sh', import.meta.url),
);
export const packagedApiSecurityAgent = fileURLToPath(
  new URL('../../agents/api-security-reviewer.md', import.meta.url),
);
export const packagedApiSecurityChecklist = fileURLToPath(
  new URL('../../skills/api-security/scripts/checklist.mjs', import.meta.url),
);
export const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
export const DETACHED_RE = /detached HEAD/;
export const DIR_RE = /directory path not allowed/;
export const FLAG_RE = /unknown flag/;
export const NOTHING_RE = /nothing to commit: no changes in/;
export const GATE_RAN_RE = /GATE_RAN/;
export const DELETED_BRANCH_RE = /Deleted branch/;
export const EPHEMERAL_WT_RE = /devkit-ship-/;
const REPO_RE = /REPO=(.*)/;
const BASE_REF_RE = /BASE_REF=(.*)/;
export const WT_RE = /worktree kept at (.+?)(?: \(branch|\. Remove)/;
export const NOTE_RE = /note\.txt/;
export const EXEC_MODE_RE = /^100755/;
export const dirs = [];
export const hasGh = hasAnyCommand('gh');

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

export function buildAndRun(
  branch,
  origin,
  {
    detached = false,
    mkdir,
    pathArg = 'dummy-path',
    extraArgs = [],
    argv,
    script = scriptPath,
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'shipres-'));
  dirs.push(dir);
  const git = (args) =>
    execFileSync('git', args, { cwd: dir, stdio: 'ignore', env: { ...process.env, ...GIT_ENV } });
  git(['init', '-q', '-b', branch]);
  git(['config', 'user.email', 'a@b.c']);
  git(['config', 'user.name', 'a']);
  git(['commit', '-q', '--allow-empty', '-m', 'base']);
  git(['remote', 'add', 'origin', origin]);
  if (mkdir) mkdirSync(join(dir, mkdir), { recursive: true });
  if (detached) git(['checkout', '-q', '--detach']);

  return spawnSync(
    '/bin/bash',
    [script, ...(argv ?? ['feat/__resolve_test__', 'title', ...extraArgs, pathArg])],
    {
      cwd: dir,
      input: '',
      encoding: 'utf8',
      env: { ...process.env, ...GIT_ENV, SHIP_DRY_RUN: '1', SHIP_RESOLVE_ONLY: '1' },
    },
  );
}

export function resolve(branch, origin, opts) {
  const r = buildAndRun(branch, origin, opts);
  expect(r.status, `script must exit 0 (stderr: ${r.stderr})`).toBe(0);
  return {
    repo: REPO_RE.exec(r.stdout)?.[1],
    baseRef: BASE_REF_RE.exec(r.stdout)?.[1],
  };
}

export function seedShipRepo({ hookBody = 'exit 0', origin = 'git@github.com:acme/app.git' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'shipwt-'));
  dirs.push(dir);
  const env = { ...process.env, ...GIT_ENV };
  const git = (args, opts = {}) =>
    execFileSync('git', args, { cwd: dir, env, encoding: 'utf8', ...opts });
  mkdirSync(join(dir, '.husky'), { recursive: true });
  writeFileSync(join(dir, '.husky/.keep'), '');
  // `devkit init` writes this line. ship-intent refuses to record an invocation whose file is not
  // ignored, and since sc-2414 an explicit `--pr` publication requires that record — so a fixture
  // without it exercises the refusal, not the path under test.
  writeFileSync(join(dir, '.gitignore'), '.devkit/ship-intent-*\n');
  for (const a of [
    ['init', '-q', '-b', 'work'],
    ['config', 'user.email', 'a@b.c'],
    ['config', 'user.name', 'a'],
    ['config', 'commit.gpgsign', 'false'],
    ['add', '.husky/.keep', '.gitignore'],
    ['commit', '-q', '-m', 'base'],
    ['config', 'core.hooksPath', '.husky/_'],
    ['remote', 'add', 'origin', origin],
  ])
    git(a, { stdio: 'ignore' });
  mkdirSync(join(dir, '.husky/_'), { recursive: true });
  writeFileSync(join(dir, '.husky/_/pre-commit'), `#!/bin/sh\n${hookBody}\n`);
  chmodSync(join(dir, '.husky/_/pre-commit'), 0o755);
  return { dir, env, git };
}

export function dropWorktree(git, stderr) {
  const wt = WT_RE.exec(stderr)?.[1];
  if (wt) {
    try {
      git(['worktree', 'remove', '--force', wt], { stdio: 'ignore' });
    } catch {
      /* best-effort */
    }
  }
}

export function reviewerTimeoutEnv(dir, env) {
  const bin = join(dir, 'timeout-supervisor-bin');
  const timedOut = join(dir, 'timeout-supervisor-fired');
  mkdirSync(bin);
  const node = join(bin, 'node');
  writeFileSync(
    node,
    [
      '#!/bin/bash',
      'if [[ $1 == *gate-supervisor.* && ! -e "$TEST_TIMEOUT_MARKER" ]]; then',
      '  : > "$TEST_TIMEOUT_MARKER"',
      '  echo "🔍 Reviewer gate (headless domain judges)..."',
      `  printf '%s' '{"running":["api-security-reviewer","commit-guard"],"completed":["api-security-reviewer"]}' > "$DEVKIT_REVIEW_PROGRESS"`,
      '  exit 124',
      'fi',
      'exec "$REAL_NODE" "$@"',
    ].join('\n'),
  );
  chmodSync(node, 0o755);
  return {
    ...env,
    PATH: `${bin}:${env.PATH ?? ''}`,
    REAL_NODE: process.execPath,
    TEST_TIMEOUT_MARKER: timedOut,
  };
}

export function seedShipRepoLocalRemote({ hookBody } = {}) {
  const ghRoot = mkdtempSync(join(tmpdir(), 'shipgh-'));
  dirs.push(ghRoot);
  const bare = join(ghRoot, 'github.com', 'acme', 'app.git');
  mkdirSync(join(ghRoot, 'github.com', 'acme'), { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', bare], { env: { ...process.env, ...GIT_ENV } });
  const opts = { origin: bare };
  if (hookBody) opts.hookBody = hookBody;
  const seeded = seedShipRepo(opts);
  // `work` on origin too. Ship refuses a PR base that is not a remote branch (a local-only base is
  // exactly sc-2261's bug), and every non-dry test here ships from `work` with no --base — so a bare
  // that lacks it is not a realistic new-ship starting state, it is the failure under test.
  seeded.git(['push', '-q', 'origin', 'work:work'], { stdio: 'ignore' });
  return { ...seeded, bare };
}

/** An `origin` bare with a `studio` branch plus a checked-out `finalized` branch whose note.txt change
 *  is ALREADY COMMITTED — the DK-1 repro state. Here, not in the --base suite, so siblings can use it. */
export function seedBaseRepo({ hookBody } = {}) {
  const seeded = seedShipRepoLocalRemote({ hookBody });
  const { dir, git, bare } = seeded;
  writeFileSync(join(dir, 'note.txt'), 'studio\n');
  git(['add', 'note.txt'], { stdio: 'ignore' });
  git(['commit', '-q', '-m', 'studio note'], { stdio: 'ignore' });
  git(['push', '-q', 'origin', 'work:studio'], { stdio: 'ignore' }); // the PR base, on origin
  git(['checkout', '-q', '-b', 'finalized'], { stdio: 'ignore' });
  writeFileSync(join(dir, 'note.txt'), 'finalized\n');
  git(['add', 'note.txt'], { stdio: 'ignore' });
  git(['commit', '-q', '-m', 'finalize'], { stdio: 'ignore' }); // committed → HEAD-based ship stages nothing
  const studioTip = execFileSync('git', ['-C', bare, 'rev-parse', 'studio'], {
    env: { ...process.env, ...GIT_ENV },
    encoding: 'utf8',
  }).trim();
  return { ...seeded, studioTip };
}

export function createPreservedCommit({ dir, env, git, branch, tempPrefix }) {
  const preservedWt = mkdtempSync(join(tmpdir(), tempPrefix));
  dirs.push(preservedWt);
  git(['worktree', 'add', '-q', '-b', branch, preservedWt]);
  writeFileSync(join(preservedWt, 'note.txt'), 'hi\n');
  execFileSync('git', ['add', 'note.txt'], { cwd: preservedWt, env });
  execFileSync('git', ['commit', '--no-verify', '-q', '-m', 'ship it', '-m', 'pr body'], {
    cwd: preservedWt,
    env,
  });
  git(['worktree', 'remove', '--force', preservedWt]);
  writeFileSync(join(dir, 'note.txt'), 'hi\n');
  return git(['rev-parse', branch]).trim();
}

/** A preserved commit shaped for the resume SCOPE checks (sc-2089). `briefed`/`deleted` reach the
 *  commit AND $ROOT; `gate*` reach only the commit, as a ratchet gate does inside the worktree. */
export function createScopedPreservedCommit({
  dir,
  env,
  git,
  branch,
  tracked = {},
  briefed = {},
  gateAuthored = {},
  gateDeleted = [],
  deleted = [],
}) {
  const write = (root, rel, body) => {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  for (const [rel, body] of Object.entries(tracked)) write(dir, rel, body);
  if (Object.keys(tracked).length > 0) {
    git(['add', '-A', '--', ...Object.keys(tracked)], { stdio: 'ignore' });
    git(['commit', '-q', '--no-verify', '-m', 'seed tracked'], { stdio: 'ignore' });
  }

  const preservedWt = mkdtempSync(join(tmpdir(), `ship-scope-${branch.replace(/\W/g, '-')}-`));
  dirs.push(preservedWt);
  git(['worktree', 'add', '-q', '-b', branch, preservedWt]);
  for (const [rel, body] of Object.entries({ ...briefed, ...gateAuthored }))
    write(preservedWt, rel, body);
  for (const rel of [...deleted, ...gateDeleted]) rmSync(join(preservedWt, rel), { force: true });
  execFileSync(
    'git',
    [
      'add',
      '-A',
      '--',
      ...Object.keys(briefed),
      ...Object.keys(gateAuthored),
      ...deleted,
      ...gateDeleted,
    ],
    { cwd: preservedWt, env },
  );
  execFileSync('git', ['commit', '--no-verify', '-q', '-m', 'ship it', '-m', 'pr body'], {
    cwd: preservedWt,
    env,
  });
  git(['worktree', 'remove', '--force', preservedWt]);

  for (const [rel, body] of Object.entries(briefed)) write(dir, rel, body);
  for (const rel of deleted) rmSync(join(dir, rel), { force: true });
  return git(['rev-parse', branch]).trim();
}

/** Mint the gate-adds record ship writes beside the receipt, in the exact `git diff -z` framing
 *  ship_record_gate_adds produces: every entry NUL-TERMINATED, including the last. */
export function mintGateAddsRecord(dir, env, git, branch, paths) {
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
    cwd: dir,
    env,
    encoding: 'utf8',
    input: paths.map((p) => `${p}\0`).join(''),
  }).trim();
  git(['update-ref', `refs/devkit/ship-gate-adds/${branch}`, blob]);
  return blob;
}

export function addOverlay(dir, overlayHook) {
  mkdirSync(join(dir, '.devkit/hooks'), { recursive: true });
  writeFileSync(
    join(dir, '.devkit/config.json'),
    `${JSON.stringify({ overlay: true }, null, 2)}\n`,
  );
  if (overlayHook !== null) {
    const pre = join(dir, '.devkit/hooks/pre-commit');
    writeFileSync(pre, `#!/bin/sh\n${overlayHook}\n`);
    chmodSync(pre, 0o755);
  }
}

export function seedReshipRepo() {
  const bare = mkdtempSync(join(tmpdir(), 'reshipbare-'));
  dirs.push(bare);
  execFileSync('git', ['init', '-q', '--bare', bare], { env: { ...process.env, ...GIT_ENV } });
  const seeded = seedShipRepo({ origin: bare });
  seeded.git(['push', '-q', 'origin', 'work:pr-open'], { stdio: 'ignore' });
  return { ...seeded, bare };
}

/** The hook exits 0 but leaks a pipe-holding child, so git lands the commit and the gate supervisor
 *  then returns 124 while reaping that descendant — the Story #1550 state, verbatim. */
export const LEAKING_HOOK = 'echo run >> "$TEST_HOOK_COUNT"\nsleep 30 &';

/** Swap the hook in AFTER seeding: a seeder's own commits would run LEAKING_HOOK with TEST_HOOK_COUNT
 *  unset, and the failed append fails the commit. */
export function installHook(dir, body) {
  const hook = join(dir, '.husky/_/pre-commit');
  writeFileSync(hook, `#!/bin/sh\n${body}\n`);
  chmodSync(hook, 0o755);
}

/** ghStub on PATH + a hook-run ledger. Publishing tests need both. */
export function publishEnvFor(dir, env) {
  const hookCount = join(dir, 'hook-count');
  return {
    hookCount,
    publishEnv: {
      ...env,
      PATH: `${ghStub('echo https://github.com/acme/app/pull/42')}:${env.PATH ?? process.env.PATH ?? ''}`,
      TEST_HOOK_COUNT: hookCount,
    },
  };
}

export function ghStub(prBody) {
  const stubBin = mkdtempSync(join(tmpdir(), 'ship-bin-'));
  dirs.push(stubBin);
  writeFileSync(
    join(stubBin, 'gh'),
    `#!/bin/sh\ncase "$1" in\n  pr) ${prBody} ;;\n  *) exit 0 ;;\nesac\n`,
  );
  chmodSync(join(stubBin, 'gh'), 0o755);
  return stubBin;
}

export function localBranchExists(git, br) {
  try {
    return Boolean(git(['rev-parse', '--verify', '--quiet', br], { stdio: 'pipe' }).trim());
  } catch {
    return false;
  }
}

export function manifestOf(dir) {
  return JSON.parse(readFileSync(join(dir, '.devkit/reconcile-manifest.json'), 'utf8'));
}

export function remoteBranchExists(bare, br) {
  try {
    return Boolean(
      execFileSync('git', ['-C', bare, 'rev-parse', '--verify', '--quiet', br], {
        env: { ...process.env, ...GIT_ENV },
        encoding: 'utf8',
      }).trim(),
    );
  } catch {
    return false;
  }
}

/** A GitHub-shaped append reship with real local Git transport and a recording gh boundary. */
export function bodyUpdateRepo({ hookBody = 'exit 0' } = {}) {
  const bare = mkdtempSync(join(tmpdir(), 'reship-body-bare-'));
  const dir = mkdtempSync(join(tmpdir(), 'reship-body-wt-'));
  const stubBin = mkdtempSync(join(tmpdir(), 'reship-body-bin-'));
  const ghLog = join(stubBin, 'gh.log');
  const ghBody = join(stubBin, 'gh.body');
  const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], {
    encoding: 'utf8',
  }).trim();
  dirs.push(bare, dir, stubBin);
  const env = { ...process.env, ...GIT_ENV };
  const g = (a, o = {}) =>
    execFileSync('git', ['-C', dir, ...a], { env, encoding: 'utf8', ...o }).trim();
  execFileSync('git', ['init', '-q', '--bare', bare], { env });
  g(['init', '-q', '-b', 'work']);
  g(['config', 'user.email', 'a@b.c']);
  g(['config', 'user.name', 'a']);
  g(['config', 'commit.gpgsign', 'false']);
  g(['remote', 'add', 'origin', 'git@github.com:acme/app.git']);
  g(['config', `url.${bare}.insteadOf`, 'git@github.com:acme/app.git']);
  mkdirSync(join(dir, '.husky/_'), { recursive: true });
  writeFileSync(join(dir, '.husky/.keep'), '');
  writeFileSync(join(dir, '.gitignore'), '.devkit/\n');
  writeFileSync(join(dir, 'a.ts'), 'v1\n');
  g(['add', '.gitignore', '.husky/.keep', 'a.ts']);
  g(['commit', '-q', '-m', 'first']);
  g(['push', '-q', 'origin', 'HEAD:feat/pr']);
  g(['config', 'core.hooksPath', '.husky/_']);
  writeFileSync(join(dir, '.husky/_/pre-commit'), `#!/bin/sh\n${hookBody}\n`);
  chmodSync(join(dir, '.husky/_/pre-commit'), 0o755);
  writeFileSync(
    join(stubBin, 'gh'),
    [
      '#!/bin/sh',
      'printf \'%s\\n\' "$*" >> "$GH_LOG"',
      'if [ "$1" = pr ] && [ "$2" = view ]; then',
      '  [ "${GH_VIEW_STATUS:-0}" -eq 0 ] || exit "$GH_VIEW_STATUS"',
      "  printf '%s\\n' 'https://github.com/acme/app/pull/7'",
      '  exit 0',
      'fi',
      'if [ "$1" = pr ] && [ "$2" = ready ]; then',
      '  exit "${GH_READY_STATUS:-0}"',
      'fi',
      'if [ "$1" = pr ] && [ "$2" = edit ]; then',
      '  if [ "${GH_EDIT_KILL_PARENT:-0}" -eq 1 ]; then kill -9 "$PPID"; exit 9; fi',
      '  cat > "$GH_BODY"',
      '  if [ -n "${GH_INTENT_LOCK:-}" ]; then',
      '    mkdir -p "$GH_INTENT_LOCK"',
      '    printf \'%s:held\' "$PPID" > "$GH_INTENT_LOCK/holder"',
      '  fi',
      '  exit "${GH_EDIT_STATUS:-0}"',
      'fi',
      'exit 1',
      '',
    ].join('\n'),
  );
  chmodSync(join(stubBin, 'gh'), 0o755);
  writeFileSync(
    join(stubBin, 'git'),
    [
      '#!/bin/sh',
      'if [ "${FAIL_AFTER_PUSH:-0}" -eq 1 ]; then',
      '  case " $* " in',
      `    *' push origin HEAD:feat/pr '*) '${realGit}' "$@" || exit $?; exit 9 ;;`,
      '  esac',
      'fi',
      `exec '${realGit}' "$@"`,
      '',
    ].join('\n'),
  );
  chmodSync(join(stubBin, 'git'), 0o755);
  return {
    bare,
    dir,
    env: { PATH: `${stubBin}:${process.env.PATH}`, GH_LOG: ghLog, GH_BODY: ghBody },
    g,
    ghLog,
    ghBody,
  };
}
