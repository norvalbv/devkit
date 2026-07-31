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
