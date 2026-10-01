import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { testExecFileSync as execFileSync } from './_helpers.mts';

// The `reship --pr --base` rewrite fixture, shared by reship.test.mts and the pin-supervisor suite.
const GENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const dirs = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Existing PR off an old base plus a caller snapshot already resolved on today's main. The raw
 * origin stays GitHub-shaped for PR identity checks; url.insteadOf keeps every fetch/push hermetic. */
export function rewriteRepo({ extraPath = false, rename = false, objectFormat = 'sha1' } = {}) {
  const bare = mkdtempSync(join(tmpdir(), 'reship-rewrite-bare-'));
  const dir = mkdtempSync(join(tmpdir(), 'reship-rewrite-wt-'));
  const stubBin = mkdtempSync(join(tmpdir(), 'reship-rewrite-bin-'));
  const ghLog = join(stubBin, 'gh.log');
  const ghBody = join(stubBin, 'gh.body');
  const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], {
    encoding: 'utf8',
  }).trim();
  dirs.push(bare, dir, stubBin);
  const env = { ...process.env, ...GENV };
  const g = (a, o = {}) =>
    execFileSync('git', ['-C', dir, ...a], { env, encoding: 'utf8', ...o }).trim();
  const objectFormatArgs = objectFormat === 'sha256' ? ['--object-format=sha256'] : [];
  execFileSync('git', ['init', '-q', '--bare', ...objectFormatArgs, bare], { env });
  g(['init', '-q', '-b', 'main', ...objectFormatArgs]);
  g(['config', 'user.email', 'a@b.c']);
  g(['config', 'user.name', 'a']);
  g(['config', 'commit.gpgsign', 'false']);
  g(['remote', 'add', 'origin', 'git@github.com:acme/app.git']);
  g(['config', `url.${bare}.insteadOf`, 'git@github.com:acme/app.git']);
  mkdirSync(join(dir, '.husky/_'), { recursive: true });
  writeFileSync(join(dir, '.husky/.keep'), '');
  writeFileSync(join(dir, '.gitignore'), '.devkit/\n');
  writeFileSync(join(dir, 'conflict.txt'), 'base\n');
  if (rename) writeFileSync(join(dir, 'old.txt'), 'old\n');
  g(['add', '.gitignore', '.husky/.keep', 'conflict.txt', ...(rename ? ['old.txt'] : [])]);
  g(['commit', '-q', '-m', 'base']);
  g(['push', '-q', 'origin', 'main']);
  // What GitHub reports as the PR's baseRefOid: a snapshot from the last head push, NOT the live
  // base tip — main moves below and this value does not follow it (sc-2739).
  const oldBase = g(['rev-parse', 'HEAD']);

  g(['checkout', '-q', '-b', 'feature']);
  writeFileSync(join(dir, 'conflict.txt'), 'feature\n');
  if (extraPath) writeFileSync(join(dir, 'extra.txt'), 'feature extra\n');
  if (rename) {
    rmSync(join(dir, 'old.txt'));
    writeFileSync(join(dir, 'new.txt'), 'renamed\n');
  }
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'feature']);
  g(['push', '-q', 'origin', 'HEAD:feat/pr']);
  const oldPrTip = g(['rev-parse', 'HEAD']);

  g(['checkout', '-q', 'main']);
  writeFileSync(join(dir, 'conflict.txt'), 'main\n');
  g(['add', 'conflict.txt']);
  g(['commit', '-q', '-m', 'main moves']);
  g(['push', '-q', 'origin', 'main']);
  const mainTip = g(['rev-parse', 'HEAD']);

  // Equivalent to the completed local rebase in sc-2323: main is the ancestor and the caller has
  // already resolved the conflict. devkit's job is publication, not this history edit.
  g(['checkout', '-q', '-b', 'prepared']);
  writeFileSync(join(dir, 'conflict.txt'), 'main + feature\n');
  if (extraPath) writeFileSync(join(dir, 'extra.txt'), 'feature extra\n');
  if (rename) {
    rmSync(join(dir, 'old.txt'));
    writeFileSync(join(dir, 'new.txt'), 'renamed\n');
  }
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'resolved feature']);
  writeFileSync(join(dir, '.husky/_/pre-commit'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(dir, '.husky/_/pre-commit'), 0o755);
  g(['config', 'core.hooksPath', '.husky/_']);

  writeFileSync(
    join(stubBin, 'gh'),
    [
      '#!/bin/sh',
      'printf \'%s\\n\' "$*" >> "$GH_LOG"',
      'if [ "$1" = pr ] && [ "$2" = edit ]; then',
      '  if [ "${GH_EDIT_KILL_PARENT:-0}" -eq 1 ]; then kill -9 "$PPID"; exit 9; fi',
      '  cat > "$GH_BODY"',
      '  if [ -n "${GH_EDIT_PAUSE_MARKER:-}" ]; then',
      '    : > "$GH_EDIT_PAUSE_MARKER"',
      '    while [ ! -e "$GH_EDIT_PAUSE_RELEASE" ]; do sleep 0.02; done',
      '  fi',
      '  if [ -n "${GH_INTENT_LOCK:-}" ]; then',
      '    mkdir -p "$GH_INTENT_LOCK"',
      '    printf \'%s:held\' "$PPID" > "$GH_INTENT_LOCK/holder"',
      '  fi',
      '  exit "${GH_EDIT_STATUS:-0}"',
      'fi',
      'case " $* " in',
      "  *' --json url '*) printf '%s\\n' 'https://github.com/acme/app/pull/7'; exit 0 ;;",
      'esac',
      // PR_BASE_OID_FILE lets a gate hook change the reported snapshot mid-run.
      `base_oid=\${PR_BASE_OID:-${oldBase}}`,
      'if [ -n "${PR_BASE_OID_FILE:-}" ] && [ -f "$PR_BASE_OID_FILE" ]; then base_oid=$(cat "$PR_BASE_OID_FILE"); fi',
      // Like real gh, emit baseRefOid only when the caller asked for it.
      'base_col=""; case " $* " in *baseRefOid*) base_col="$base_oid\t" ;; esac',
      `printf "7\\tOPEN\\t%s\\t%s\\tacme/app\\t%s\\t\${base_col}https://github.com/acme/app/pull/7\\n" "\${PR_HEAD_REF_NAME:-feat/pr}" "\${PR_HEAD_OID:-${oldPrTip}}" "\${PR_BASE_REF_NAME:-main}"`,
      '',
    ].join('\n'),
  );
  chmodSync(join(stubBin, 'gh'), 0o755);
  writeFileSync(
    join(stubBin, 'git'),
    [
      '#!/bin/sh',
      'if [ "${KILL_BEFORE_REWRITE_PUSH:-0}" -eq 1 ]; then',
      '  case " $* " in',
      '    *" push --force-with-lease="*)',
      '      ship_pid=$(ps -o ppid= -p "$PPID" | tr -d " ")',
      '      kill -9 "$ship_pid"',
      '      exit 9',
      '      ;;',
      '  esac',
      'fi',
      // Emulates git's detached `gc --auto`: an unsuppressed fetch leaves an owned straggler (sc-3761).
      // AUTO_GC_IGNORES_CONFIG forces one anyway, i.e. any clean-but-leaky fetch.
      'case " $* " in',
      '  *" fetch "*)',
      // FETCH_FAIL_ARMED_BY: fail only fetches made after a gate hook creates that file.
      '    if [ -n "${FETCH_FAIL_ARMED_BY:-}" ] && [ ! -e "$FETCH_FAIL_ARMED_BY" ]; then :',
      '    elif [ -n "${FETCH_FAIL_STATUS:-}" ]; then',
      '      printf \'%s\\n\' "${FETCH_FAIL_STDERR:-fatal: Could not read from remote repository.}" >&2',
      '      exit "$FETCH_FAIL_STATUS"',
      '    fi',
      '    if [ -n "${AUTO_GC_STRAGGLER_PIDS:-}" ]; then',
      '      suppressed=0',
      '      case " $* " in *" gc.auto=0 "*" maintenance.auto=false "*) suppressed=1 ;; esac',
      '      if [ "$suppressed" -eq 0 ] || [ "${AUTO_GC_IGNORES_CONFIG:-0}" -eq 1 ]; then',
      `        node '${join(stubBin, 'auto-gc-straggler.mjs')}' "$AUTO_GC_STRAGGLER_PIDS"`,
      '      fi',
      '    fi',
      '    ;;',
      'esac',
      `exec '${realGit}' "$@"`,
      '',
    ].join('\n'),
  );
  chmodSync(join(stubBin, 'git'), 0o755);
  writeFileSync(
    join(stubBin, 'auto-gc-straggler.mjs'),
    [
      "import { spawn } from 'node:child_process';",
      "import { appendFileSync } from 'node:fs';",
      "const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });",
      'appendFileSync(process.argv[2], `${child.pid}\\n`);',
      'child.unref();',
      // A real fetch runs ~1s while gc detaches, so the supervisor's 250ms ownership sample sees
      // the straggler; one that exited sooner would slip past and never reproduce the reap.
      'setTimeout(() => {}, 600);',
      '',
    ].join('\n'),
  );
  return {
    bare,
    dir,
    env: { PATH: `${stubBin}:${process.env.PATH}`, GH_LOG: ghLog, GH_BODY: ghBody },
    g,
    mainTip,
    oldBase,
    oldPrTip,
    stubBin,
    ghLog,
    ghBody,
  };
}
