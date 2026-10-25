import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseJsonObject } from '../../../../gate-engine/config-json.mts';

// Set guard.config.json scanRoots from --scan-root before the freezes run. A JSON round-trip keeps
// every key, //-comment guidance included, in place; no-op when the file was never written.
export function applyScanRoots(cwd: string, scanRoots: string[] | null, dryRun: boolean) {
  if (!scanRoots?.length) return;
  const value = JSON.stringify(scanRoots);
  if (dryRun) {
    console.log(`  [dry-run] set guard.config.json scanRoots = ${value}`);
    return;
  }
  const path = join(cwd, 'guard.config.json');
  const cfg = existsSync(path)
    ? parseJsonObject<{ scanRoots?: string[] }>(readFileSync(path, 'utf8'), path)
    : null;
  if (!cfg) return;
  cfg.scanRoots = scanRoots;
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`);
  console.log(`  ✓ guard.config.json scanRoots = ${value}`);
}
