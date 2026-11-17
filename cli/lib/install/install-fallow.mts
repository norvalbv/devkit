/**
 * fallow install helper for the `devkit init` wizard. fallow is the free static-analysis
 * layer (dead-code, dupes, complexity health) the devkit gate set can lean on. This module
 * OWNS getting fallow onto a consumer's machine.
 *
 * It installs none of fallow's own hooks: a merge-base cannot express the staged set.
 *
 * Everything here is FAIL-OPEN: a missing package manager, an offline machine, or fallow
 * not being installed must never throw — the wizard keeps going and prints the manual
 * fallback. dryRun prints every external command and runs none of them.
 */

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { cmpSemver } from '../../../gate-engine/devkit-version.mts';

/**
 * Pinned fallow version. NEVER @latest — a floating tag makes the gate non-deterministic
 * and can drift below FALLOW_GATE_MIN_VERSION. 3.42.0 sits well above the default floor
 * (2.46.0), so a pinned install always satisfies the gate's version check. It is also the
 * minimum: `ensureFallow` keeps a fallow at or above it and never downgrades one.
 *
 * The floor here is >=3.4.2, not just "newer is nicer". Through 2.x, `fallow audit`
 * materialised its comparison base as a REGISTERED git worktree and its cleanup was not
 * scoped to the entry it owned — so a long-running audit (a devkit ship's gate chain runs
 * for minutes) could reset the SHIP worktree's HEAD to the audit's own base, and the
 * commit then died on its finalize ref-update with
 * `fatal: cannot lock ref 'HEAD': is at <base> but expected <ship base>`, having passed
 * every gate. fallow 3.4.2 unregisters the snapshot immediately and restricts "Git
 * administration cleanup ... to the current repository's verified worktree entry"; 3.6.0
 * holds the reuse lock for the audit lifetime so a concurrent cleanup or a different-base
 * rebuild cannot pull files out from under a running audit. 3.4.2 also auto-deregisters
 * the worktree entries leaked by earlier versions on the next audit.
 *
 * fallow 3.0.0 is a platform milestone, NOT a breaking change: CLI flags, config, and the
 * `audit --format json` contract the staged gate reads are unchanged across the major.
 */
export const FALLOW_PINNED_VERSION = '3.42.0';

// Shared shape for every command helper's options object (the destructured `opts` arg).
interface FallowCommandOptions {
  cwd?: string;
  dryRun?: boolean;
}

// `run`'s superset: adds `capture` (piped+utf8 for version probes vs inherited stdio).
interface RunOptions extends FallowCommandOptions {
  capture?: boolean;
}

// A single spawn's normalised result: exit status (null = spawn error, e.g. ENOENT) + captured stdout.
interface RunResult {
  status: number | null;
  stdout: string;
}

// ensureFallow's outcome: whether a usable fallow is on PATH now, plus the progress line to print.
interface FallowEnsureResult {
  ok: boolean;
  message: string;
}

/**
 * Single spawn seam. Every external command in this module funnels through here so dryRun
 * print-and-skip and the test mock have ONE place to intercept. Inherits stdio by default
 * so install progress/output is visible; `capture` flips to piped+utf8 for version probes.
 * Never throws — a spawn error (ENOENT for a missing binary) comes back as status:null.
 */
function run(
  cmd: string,
  args: string[],
  { cwd, dryRun, capture = false }: RunOptions = {},
): RunResult {
  if (dryRun) {
    console.log(`[dry-run] ${cmd} ${args.join(' ')}`);
    return { status: 0, stdout: '' };
  }
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? '' };
}

// Match a "fallow X.Y.Z" probe line, capturing only the numeric core: a prerelease suffix
// would make cmpSemver NaN and read a newer fallow as older.
const VERSION_RE = /fallow\s+(\d+\.\d+\.\d+)/;

// Parse a version probe into the bare version, or null if it didn't match.
function parseVersion(stdout: string): string | null {
  const m = VERSION_RE.exec(stdout);
  return m ? m[1] : null;
}

/**
 * Is fallow on PATH? PATH only: the hook's `command -v fallow`, `fallow init` and the
 * baseline saves all resolve PATH, so an npx-only copy would leave the gate skipping.
 */
export function detectFallow({ cwd }: { cwd?: string } = {}): {
  available: boolean;
  version: string | null;
} {
  const { status, stdout } = run('fallow', ['--version'], { cwd, capture: true });
  const version = parseVersion(stdout);
  return status === 0 && version
    ? { available: true, version }
    : { available: false, version: null };
}

// The package-manager attempts, in priority order. cargo's crate is `fallow-cli` but the
// installed binary is `fallow` — pin the crate by --version, not an @-suffix.
function installAttempts() {
  return [
    { method: 'bun', cmd: 'bun', args: ['add', '-g', `fallow@${FALLOW_PINNED_VERSION}`] },
    { method: 'npm', cmd: 'npm', args: ['install', '-g', `fallow@${FALLOW_PINNED_VERSION}`] },
    {
      method: 'cargo',
      cmd: 'cargo',
      args: ['install', 'fallow-cli', '--version', FALLOW_PINNED_VERSION],
    },
  ];
}

// The exact manual commands to print when every automated attempt misses. No brew tap and
// no curl|sh installer exist for fallow — do not invent one.
function printManualSteps() {
  console.log('fallow could not be installed automatically. Install it manually with one of:');
  for (const a of installAttempts()) {
    console.log(`  ${a.cmd} ${a.args.join(' ')}`);
  }
}

/**
 * Install fallow, trying bun → npm → cargo and stopping at the first success. On a total
 * miss it prints the manual commands and returns ok:false — NEVER throws.
 *
 */
export function installFallow({ cwd, dryRun }: FallowCommandOptions = {}): {
  ok: boolean;
  method: string | null;
  message: string;
} {
  for (const a of installAttempts()) {
    const { status } = run(a.cmd, a.args, { cwd, dryRun });
    if (status === 0) {
      return {
        ok: true,
        method: a.method,
        message: `installed fallow@${FALLOW_PINNED_VERSION} via ${a.method}`,
      };
    }
  }
  printManualSteps();
  return { ok: false, method: null, message: 'no package manager could install fallow' };
}

/**
 * The one detect-then-install path for every install mode: keep a PATH fallow at or above the
 * pin, else install the pin.
 */
export function ensureFallow({ cwd, dryRun }: FallowCommandOptions = {}): FallowEnsureResult {
  const pin = FALLOW_PINNED_VERSION;
  if (dryRun) {
    return {
      ok: true,
      message: `[dry-run] fallow: keep an installed fallow >= ${pin}, else install fallow@${pin}`,
    };
  }
  const { version } = detectFallow({ cwd });
  if (version && cmpSemver(version, pin) >= 0) {
    return { ok: true, message: `using installed fallow ${version} (>= ${pin})` };
  }
  const r = installFallow({ cwd });
  return {
    ok: r.ok,
    message: `${version ? `fallow ${version} is below ${pin}` : 'fallow not found'}: ${r.message}`,
  };
}

/**
 * Resolve fallow for an OVERLAY install: keep an installed fallow at or above the pin, else
 * install it. Returns whether to wire the gate; fail-open — abort, never block.
 */
export function resolveOverlayFallow(cwd: string, dryRun: boolean): boolean {
  if (dryRun) {
    console.log('  [dry-run] fallow: keep an installed fallow >= pin, else install it → gate in hook');
    return true;
  }
  const r = ensureFallow({ cwd });
  console.log(`  ${r.ok ? '✓' : '!'} ${r.message}`);
  if (!r.ok) {
    console.log('  ! fallow not installed — skipping the fallow gate (install it above, re-run).');
    return false;
  }
  return true;
}

// CLI smoke entry: `node install-fallow.mjs [detect|install]`. Helps verify
// the helper by hand without the wizard.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const sub = process.argv[2] ?? 'detect';
  const cwd = process.cwd();
  if (sub === 'detect') console.log(JSON.stringify(detectFallow({ cwd })));
  else if (sub === 'install') console.log(JSON.stringify(installFallow({ cwd })));
  else console.error(`unknown subcommand: ${sub}`);
}
