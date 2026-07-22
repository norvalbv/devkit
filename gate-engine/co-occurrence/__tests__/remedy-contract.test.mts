import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
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
    for (const m of ['remove', 'remove-clone', 'check', 'check-clone', 'list', 'prune']) {
      expect(MODES).toContain(m);
    }
  });

  // A bin is ALWAYS reached through a symlink — node_modules/.bin, or a global install's bin dir.
  // Both CLI-dispatching modules gate their dispatch on a run-as-main check, and a check that does
  // not realpath argv[1] compares the SHIM path against the real module path: false, so the bin
  // parses its args, dispatches nothing, and exits 0. That is a silently dead gate — `guard-clone
  // scan --gate` printed nothing and passed, and the approval remedy the gates print did nothing.
  // Only an invocation THROUGH a symlink reproduces it, so spawn one.
  describe('a bin invoked through its symlink shim actually dispatches', () => {
    const shimDir = mkdtempSync(join(tmpdir(), 'devkit-shim-'));
    afterAll(() => rmSync(shimDir, { recursive: true, force: true }));

    // Sibling suites stub JSCPD_BIN / CO_OCCURRENCE_ALLOWLIST on process.env and share this
    // worker, so hand the child an env with those cleared — this test is about dispatch, and an
    // inherited fixture path would fail it for an unrelated reason.
    const cleanEnv = (): NodeJS.ProcessEnv => {
      const env = { ...process.env };
      for (const k of ['JSCPD_BIN', 'CO_OCCURRENCE_ALLOWLIST', 'GUARD_ALLOWLIST_PATH'])
        delete env[k];
      return env;
    };

    const viaShim = (module: string, args: string[]): string => {
      const shim = join(shimDir, module.replace('.mts', ''));
      if (!existsSync(shim)) symlinkSync(resolve(here, '..', module), shim);
      return execFileSync(process.execPath, [shim, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        env: cleanEnv(),
        cwd: root,
      });
    };

    it('allowlist-cli lists through the shim', () => {
      expect(viaShim('allowlist-cli.mts', ['list'])).toMatch(/pair\(s\), .*clone\(s\)/);
    });

    it('clone-detector scans through the shim', () => {
      // `json` over a clone-free scratch dir: dispatch proves itself by emitting the (empty) JSON
      // array. If the run-as-main guard is wrong, stdout is empty and this fails.
      const scanDir = join(shimDir, 'scan');
      mkdirSync(scanDir, { recursive: true });
      writeFileSync(join(scanDir, 'a.ts'), 'export const a = 1;\n');
      expect(viaShim('clone-detector.mts', ['json', '--paths', scanDir])).toMatch(/\[/);
    });
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
