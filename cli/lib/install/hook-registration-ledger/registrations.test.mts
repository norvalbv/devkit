/** The emitted command is frozen, not derived from `exports` at runtime — the ledger keys on exact
 * command equality. This file is the anchor that makes an exports rename fail HERE instead. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { packageDir, readJson } from '../../fs-helpers.mts';
import { HOOK_REGISTRATIONS, PKG, registrationsFor } from './registrations.mts';

// SAFETY: devkit's OWN committed package.json, whose `exports` map is what the assertions below
// check — a shape change fails them loudly rather than passing on a bad read.
const exportsMap = (
  readJson(join(packageDir(), 'package.json')) as { exports: Record<string, string> }
).exports;
const EXPORTED = {
  'search-steering:pre-bash': exportsMap['./gate-engine/search-tool/guard'],
  'search-steering:post-bash': exportsMap['./gate-engine/search-tool/counter'],
};

describe('engine-bin hook commands', () => {
  it.each(Object.entries(EXPORTED))(
    '%s points at the same file package.json exports',
    (id, sub) => {
      const registration = HOOK_REGISTRATIONS.searchSteering.find((r) => r.registrationId === id);
      expect(sub).toBeDefined();
      expect(registration?.scriptRel).toBe(sub.replace(/^\.\//, ''));
      expect(registration?.command).toBe(
        `node "$CLAUDE_PROJECT_DIR"/${PKG}/${registration?.scriptRel}`,
      );
    },
  );

  it('never emits a .mts operand under node_modules, where Node refuses to strip types', () => {
    for (const registration of registrationsFor(Object.keys(HOOK_REGISTRATIONS)))
      if (registration.scriptRel) {
        expect(registration.scriptRel).toMatch(/^dist\//);
        expect(registration.scriptRel.endsWith('.mts')).toBe(false);
      }
  });

  it('every scriptRel resolves inside devkit own package tree', () => {
    // dist/ is committed, so this holds in the source checkout too — and it is exactly the predicate
    // checkRegisteredHookTargets evaluates in a consumer.
    for (const registration of registrationsFor(Object.keys(HOOK_REGISTRATIONS)))
      if (registration.scriptRel)
        expect(existsSync(join(packageDir(), registration.scriptRel))).toBe(true);
  });
});
