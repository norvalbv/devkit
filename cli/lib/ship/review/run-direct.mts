/** Symlink-safe direct-module CLI dispatch shared by review runtime helpers. */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Run a module's CLI callback only when this exact physical module is the process entrypoint. */
export function runDirectReviewCli(moduleUrl: string, run: (args: string[]) => void): void {
  const invokedPath = process.argv[1];
  if (!invokedPath || realpathSync(invokedPath) !== realpathSync(fileURLToPath(moduleUrl))) return;
  try {
    run(process.argv.slice(2));
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;
  }
}
