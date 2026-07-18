import { execFileSync, spawnSync } from 'node:child_process';
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
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import cleanCmd from '../commands/clean.mts';
import {
  globalHookInstalled,
  globalInitPath,
  installGlobalHook,
  removeGlobalHook,
} from '../lib/overlay-global-hook.mts';

// The opt-in global husky init.sh shim that gates a PLAIN `git commit` after husky reclaims
// core.hooksPath. Two concerns: the marker-block writer/remover (hermetic, XDG → temp), and the
// shim's runtime dispatch (sourced like husky's _/h, with a controlled $0 + cwd).

vi.setConfig({ testTimeout: 30_000 });

const GENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const dirs = [];
const origXdg = process.env.XDG_CONFIG_HOME;

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = origXdg;
});

/** Point XDG_CONFIG_HOME at a fresh temp dir so globalInitPath() → <tmp>/husky/init.sh. */
function freshXdg() {
  const d = mkdtempSync(join(tmpdir(), 'dk-xdg-'));
  dirs.push(d);
  process.env.XDG_CONFIG_HOME = d;
  return globalInitPath();
}

beforeEach(() => {
  freshXdg();
});

const read = (f) => readFileSync(f, 'utf8');

describe('installGlobalHook / removeGlobalHook — the marker-block writer', () => {
  it('creates init.sh with exactly one devkit block (EC11 create)', () => {
    const f = globalInitPath();
    installGlobalHook({});
    expect(globalHookInstalled()).toBe(true);
    const body = read(f);
    expect(body.match(/devkit overlay global pre-commit gate/g)?.length).toBe(2); // start + end marker
    expect(body).toContain('DEVKIT_VIA_HUSKY_INIT=1');
    expect(body).toContain('git rev-parse --show-toplevel');
  });

  it('is idempotent — re-install is byte-stable, one block (EC9)', () => {
    const f = globalInitPath();
    installGlobalHook({});
    const once = read(f);
    installGlobalHook({});
    expect(read(f)).toBe(once);
    expect(read(f).match(/>>> devkit overlay global pre-commit gate >>>/g)?.length).toBe(1);
  });

  it('appends onto a pre-existing user init.sh (no trailing newline) without clobbering it (EC8)', () => {
    const f = globalInitPath();
    mkdirSync(join(f, '..'), { recursive: true });
    writeFileSync(f, '# my own init\nexport FOO=1'); // no trailing newline
    installGlobalHook({});
    const body = read(f);
    expect(body).toContain('# my own init');
    expect(body).toContain('export FOO=1');
    expect(body).toContain('>>> devkit overlay global pre-commit gate >>>');
  });

  it('remove strips only the devkit block, keeping user content before AND after (EC10)', () => {
    const f = globalInitPath();
    mkdirSync(join(f, '..'), { recursive: true });
    writeFileSync(f, '# BEFORE\n');
    installGlobalHook({}); // → BEFORE + block
    writeFileSync(f, `${read(f).replace(/\n+$/, '')}\n\n# AFTER\n`); // block now in the middle
    removeGlobalHook({});
    const body = read(f);
    expect(existsSync(f)).toBe(true);
    expect(body).toContain('# BEFORE');
    expect(body).toContain('# AFTER');
    expect(body).not.toContain('devkit overlay global pre-commit gate');
  });

  it('remove unlinks a devkit-only init.sh (EC11 remove)', () => {
    const f = globalInitPath();
    installGlobalHook({});
    removeGlobalHook({});
    expect(existsSync(f)).toBe(false);
  });

  it('remove is a no-op on a foreign init.sh (never touches a file without our marker)', () => {
    const f = globalInitPath();
    mkdirSync(join(f, '..'), { recursive: true });
    writeFileSync(f, '# someone elses init\n');
    removeGlobalHook({});
    expect(read(f)).toBe('# someone elses init\n');
  });

  it('dry-run writes nothing', () => {
    const f = globalInitPath();
    installGlobalHook({ dryRun: true });
    expect(existsSync(f)).toBe(false);
  });
});

// Run the installed shim the way husky's _/h does: SOURCE init.sh from a script whose basename is
// the hook name, with cwd inside the repo. Asserts the real emitted block, not a re-implementation.
describe('global shim dispatch (sourced like husky _/h)', () => {
  /** A git repo with an overlay-style `.devkit/hooks/pre-commit` stub that records its invocation. */
  function overlaidRepo() {
    const root = mkdtempSync(join(tmpdir(), 'dk-shimrepo-'));
    dirs.push(root);
    execFileSync('git', ['-C', root, 'init', '-q'], { env: GENV });
    const hooks = join(root, '.devkit', 'hooks');
    mkdirSync(hooks, { recursive: true });
    const stub = join(hooks, 'pre-commit');
    // Records whether it ran + the gates-only env, then exits with $DK_STUB_EXIT (passed via env).
    writeFileSync(
      stub,
      '#!/bin/sh\nprintf \'VIA=%s\\n\' "$DEVKIT_VIA_HUSKY_INIT" > "$DK_MARKER"\nexit "$DK_STUB_EXIT"\n',
    );
    chmodSync(stub, 0o755);
    return root;
  }

  /** Drive the shim: a `<name>` script that sources the installed init.sh (so $0 basename = name). */
  function runShim({ hookName = 'pre-commit', cwd, env = {} }) {
    const driverDir = mkdtempSync(join(tmpdir(), 'dk-driver-'));
    dirs.push(driverDir);
    const driver = join(driverDir, hookName);
    writeFileSync(
      driver,
      `#!/bin/sh\n. "${globalInitPath()}"\nprintf '%s' "\${DEVKIT_PLAN_CRITIQUE_OBSERVED:-}" > "$DK_LATCH_MARKER"\nexit 0\n`,
    );
    const marker = join(driverDir, 'marker');
    const latchMarker = join(driverDir, 'latch-marker');
    const r = spawnSync('sh', [driver], {
      cwd,
      encoding: 'utf8',
      env: {
        ...GENV,
        DK_MARKER: marker,
        DK_LATCH_MARKER: latchMarker,
        DK_STUB_EXIT: '0',
        ...env,
      },
    });
    return {
      status: r.status,
      via: existsSync(marker) ? read(marker).trim() : null,
      observed: existsSync(latchMarker) ? read(latchMarker).trim() : null,
    };
  }

  it('runs the overlay gates with DEVKIT_VIA_HUSKY_INIT=1 on a pre-commit in an overlaid repo (EC5)', () => {
    const root = overlaidRepo();
    installGlobalHook({});
    const { status, via, observed } = runShim({ cwd: root });
    expect(status).toBe(0);
    expect(via).toBe('VIA=1');
    expect(observed).toBe('');
  });

  it('maps the overlay observation signal to a parent latch without failing the hook', () => {
    const root = overlaidRepo();
    installGlobalHook({});
    const { status, observed } = runShim({ cwd: root, env: { DK_STUB_EXIT: '88' } });
    expect(status).toBe(0);
    expect(observed).toBe('1');
  });

  it('propagates a failing gate (stub exit 1) to abort the commit (EC6)', () => {
    const root = overlaidRepo();
    installGlobalHook({});
    const { status, via } = runShim({ cwd: root, env: { DK_STUB_EXIT: '1' } });
    expect(via).toBe('VIA=1'); // it DID run
    expect(status).toBe(1); // and the sourced `exit 1` aborted the driver
  });

  it('is a no-op for a non-pre-commit hook (EC pre-push)', () => {
    const root = overlaidRepo();
    installGlobalHook({});
    const { status, via } = runShim({ hookName: 'pre-push', cwd: root });
    expect(status).toBe(0);
    expect(via).toBeNull();
  });

  it('honors HUSKY=0 — skips the gates (EC13)', () => {
    const root = overlaidRepo();
    installGlobalHook({});
    const { status, via } = runShim({ cwd: root, env: { HUSKY: '0' } });
    expect(status).toBe(0);
    expect(via).toBeNull();
  });

  it('resolves the repo root, not cwd — fires from a subdir (EC1/EC2)', () => {
    const root = overlaidRepo();
    installGlobalHook({});
    const sub = join(root, 'pkg', 'nested');
    mkdirSync(sub, { recursive: true });
    const { via } = runShim({ cwd: sub });
    expect(via).toBe('VIA=1'); // git rev-parse --show-toplevel found the root from the subdir
  });

  it('does NOT mis-fire on a stray .devkit/hooks in cwd when the repo root has none (EC3)', () => {
    const root = mkdtempSync(join(tmpdir(), 'dk-clean-'));
    dirs.push(root);
    execFileSync('git', ['-C', root, 'init', '-q'], { env: GENV }); // repo root: NO .devkit/hooks
    const sub = join(root, 'sub');
    mkdirSync(join(sub, '.devkit', 'hooks'), { recursive: true }); // a stray under cwd only
    const stray = join(sub, '.devkit', 'hooks', 'pre-commit');
    writeFileSync(stray, '#!/bin/sh\nprintf VIA=stray > "$DK_MARKER"\n');
    chmodSync(stray, 0o755);
    installGlobalHook({});
    const { via } = runShim({ cwd: sub });
    expect(via).toBeNull(); // resolved root has no .devkit/hooks → no run (cwd-relative would have mis-fired)
  });

  it('is a no-op in a non-overlaid repo (no .devkit/hooks) — package/non-devkit mode (EC package)', () => {
    const root = mkdtempSync(join(tmpdir(), 'dk-pkg-'));
    dirs.push(root);
    execFileSync('git', ['-C', root, 'init', '-q'], { env: GENV });
    installGlobalHook({});
    const { status, via } = runShim({ cwd: root });
    expect(status).toBe(0);
    expect(via).toBeNull();
  });
});

describe('devkit clean --global (CLI dispatch)', () => {
  it('removes the machine-global shim; plain clean (no flag) leaves it (EC12)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dk-cleanrepo-'));
    dirs.push(root); // no .devkit/config.json → per-repo clean has nothing to do
    installGlobalHook({});

    await cleanCmd(['--yes'], root); // per-repo clean WITHOUT --global must not touch the shim
    expect(globalHookInstalled()).toBe(true);

    await cleanCmd(['--global', '--yes'], root); // explicit → removes it
    expect(globalHookInstalled()).toBe(false);
  });
});
