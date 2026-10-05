#!/usr/bin/env node
/** Emit the gate-input registry for shell callers:
 * `<root> [field] [--null] [--cache] [--local-cache] [--each-file] [--branch]`.
 * `<index.db> --usable-chunks` prints the index's usable chunk count, or nothing when it cannot tell.
 * A bad guard.config.json exits 1 after the fixed entries, so ship still links those. */
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { usableChunkCount } from '../../../gate-engine/co-occurrence/chunk-index.mts';
import { gateInputs } from '../../../gate-engine/deterministic/gate-inputs.mts';

const [root = process.cwd(), ...args] = process.argv.slice(2);
const field = args.find((arg) => !arg.startsWith('--'));
const end = args.includes('--null') ? '\0' : '\n';

// Read-only so probing never creates or touches an index; '' = missing, unreadable or foreign schema.
function usableChunks(dbPath: string): string {
  if (!existsSync(dbPath)) return '';
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    return String(usableChunkCount(db) ?? '');
  } catch {
    return '';
  } finally {
    db?.close();
  }
}

if (args.includes('--usable-chunks')) {
  process.stdout.write(`${usableChunks(root)}\n`);
} else {
  try {
    for (const input of gateInputs(root)) {
      if (field !== undefined && input.field !== field) continue;
      if (args.includes('--cache') && !input.cache) continue;
      if (args.includes('--local-cache') && !input.localCache) continue;
      if (args.includes('--each-file') && !input.eachFile) continue;
      if (args.includes('--branch') && input.share !== 'branch') continue;
      process.stdout.write(`${input.path}${end}`);
    }
  } catch (error) {
    // exitCode, not a throw: exiting naturally flushes the fixed entries already written to a pipe.
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
