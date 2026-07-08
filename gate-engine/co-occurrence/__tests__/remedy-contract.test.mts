import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALLOWLIST_CLI, MODES } from '../allowlist-io.mts';

// Ticket 7 regression guard. The dup/clone gates print a ready-to-paste approval remedy
// (`guard-dup-allowlist add …` / `add-clone …`). This bug — a remedy naming a bin that was
// never shipped — can only recur if that printed name, the package `bin` map, and the CLI's
// actual verbs drift apart. Tie all three together with a STATIC test.
//
// It imports only from allowlist-io.mts (side-effect free) and reads source text — it never
// imports a detector, which would run its top-level dispatch (open the sqlite DB / resolve
// config) and `process.exit` this worker.

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  bin: Record<string, string>;
};
const src = (name: string) => readFileSync(resolve(here, '..', name), 'utf8');

describe('gate remedy ↔ shipped CLI contract', () => {
  it('the printed remedy bin is a real entry in package.json bin, targeting the CLI', () => {
    const target = pkg.bin[ALLOWLIST_CLI];
    expect(target, `${ALLOWLIST_CLI} must be a declared bin`).toBeTruthy();
    expect(target).toMatch(/allowlist-cli\.mjs$/);
    // The source the bin compiles from must exist (dist may be unbuilt at test time).
    expect(existsSync(resolve(here, '..', 'allowlist-cli.mts'))).toBe(true);
  });

  it('the verbs both gates print — add, add-clone — are modes the CLI dispatches', () => {
    expect(MODES).toContain('add'); // matcher gate remedy
    expect(MODES).toContain('add-clone'); // clone gate remedy
    // The full documented CRUD surface (skill + decay.mts) is present too.
    for (const m of ['remove', 'remove-clone', 'check', 'list', 'prune']) {
      expect(MODES).toContain(m);
    }
  });

  it('both detectors build their remedy from ALLOWLIST_CLI — no orphaned bunx literal', () => {
    for (const file of ['matcher.mts', 'clone-detector.mts']) {
      const text = src(file);
      expect(text, `${file} should reference the shared ALLOWLIST_CLI const`).toContain(
        'process.env.GUARD_ALLOWLIST_CLI || ALLOWLIST_CLI',
      );
      // The old, never-shipped default must be gone (bunx <name> 404s on a global install).
      expect(text, `${file} must not hardcode the phantom bunx remedy`).not.toContain(
        'bunx guard-dup-allowlist',
      );
    }
  });
});
