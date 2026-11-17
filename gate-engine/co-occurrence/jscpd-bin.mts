/**
 * jscpd binary resolution — extracted from clone-detector so it can be shared WITHOUT dragging
 * clone-detector's import-time side effects (it runs `resolveGuardConfig(process.cwd())` and resolves
 * the bin at module top level). The prefix-cache config-fingerprint imports this to fold the SAME bin
 * resolution the clone gate uses into the cache key — so "jscpd newly present / upgraded" invalidates
 * a prior PASS. This module is pure: no top-level config read, no process.cwd(), no side effects.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// devkit's own root (gate-engine/co-occurrence → ../.. → devkit root), for the bundled-jscpd probe.
// Keyed to THIS package's location (import.meta.url) — the one sanctioned use, since it addresses
// devkit's OWN vendored binary, not consumer data (W-3).
export const JSCPD_OWN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// The bare-PATH terminal `resolveJscpdBin` falls back to (a global jscpd, execvp-resolved). Callers
// that stat the resolved path must treat this token specially — `statSync('jscpd')` is cwd-relative
// and throws ENOENT.
export const JSCPD_PATH_TERMINAL = 'jscpd';

/**
 * Resolve the jscpd binary. Order:
 *   JSCPD_BIN env (verbatim — used even if it doesn't exist, so a test can force the fail-open path)
 *   → devkit-own / hoist / consumer `.bin/jscpd`
 *   → bare `'jscpd'` (execFileSync PATH-resolves a GLOBAL install via execvp — house idiom, cf. the
 *     git/gh/claude spawns; a truly-missing binary throws ENOENT → the caller fails OPEN).
 * `'jscpd'` is the `??` terminal, never a `.find` candidate — `exists('jscpd')` is cwd-relative and
 * would misfire on a stray file. `exists` is injectable so the order can be unit-tested without fs.
 */
export function resolveJscpdBin({
  env,
  exists = existsSync,
  ownRoot,
  repoRoot,
}: {
  env?: string;
  exists?: (p: string) => boolean;
  ownRoot: string;
  repoRoot: string;
}): string {
  return (
    env ??
    [
      resolve(ownRoot, 'node_modules', '.bin', 'jscpd'), // devkit dogfood tree
      resolve(ownRoot, '..', '..', '.bin', 'jscpd'), // consumed/global: hoist root beside @norvalbv/devkit
      resolve(repoRoot, 'node_modules', '.bin', 'jscpd'), // consumer's own (package mode)
    ].find((p) => exists(p)) ??
    JSCPD_PATH_TERMINAL
  );
}

/**
 * Null when `bin` is the jscpd version devkit pins, else the remedy line. Exact, because similarity
 * scores move between releases; throws when the binary cannot run at all.
 */
export function jscpdVersionMismatch(bin: string, ownRoot: string = JSCPD_OWN_ROOT): string | null {
  const pkg = JSON.parse(readFileSync(resolve(ownRoot, 'package.json'), 'utf8'));
  const want: string = pkg.optionalDependencies.jscpd;
  const out = execFileSync(bin, ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const got = out.trim().split(/\s+/).at(-1);
  if (got === want) return null;
  return `devkit expects jscpd ${want} but ${bin} reports ${got || 'no version'}: reinstall devkit, or upgrade or remove a stray global jscpd.`;
}
