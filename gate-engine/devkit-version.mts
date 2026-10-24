import { readFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = '@norvalbv/devkit';
export const LEGACY_DEVKIT_VERSION = '<0.47.2';

let cachedVersion: string | undefined;

/** The version of the devkit package that is executing this code. */
export function devkitVersion(): string {
  if (cachedVersion) return cachedVersion;

  let directory = dirname(fileURLToPath(import.meta.url));
  const filesystemRoot = parse(directory).root;
  while (directory !== filesystemRoot) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
        name?: unknown;
        version?: unknown;
      };
      if (
        manifest.name === PACKAGE_NAME &&
        typeof manifest.version === 'string' &&
        manifest.version.trim()
      ) {
        cachedVersion = manifest.version.trim();
        return cachedVersion;
      }
    } catch {
      // Keep walking: source and packaged dist place the manifest at different ancestors.
    }
    directory = dirname(directory);
  }

  // Telemetry must never break a gate. This bucket also matches how pre-attribution records are
  // presented downstream; a healthy source or packaged install always resolves its manifest above.
  cachedVersion = LEGACY_DEVKIT_VERSION;
  return cachedVersion;
}

/** -1 / 0 / 1 comparing two x.y.z strings numerically. */
export function cmpSemver(a: string, b: string): number {
  const pa = a.split('.');
  const pb = b.split('.');
  for (let i = 0; i < 3; i++) {
    // BigInt, not Number: past MAX_SAFE_INTEGER two distinct versions round equal, and "equal" is
    // the permissive answer everywhere (an older runner would read as in-sync).
    let left: bigint;
    let right: bigint;
    try {
      left = BigInt(pa[i] ?? '0');
      right = BigInt(pb[i] ?? '0');
    } catch {
      // NaN, not 0: `update` reads `cmpSemver(latest, current) <= 0` as "up to date", so 0 would
      // skip a real update while NaN fails the comparison and proceeds.
      return Number.NaN;
    }
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}
