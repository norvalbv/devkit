import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sha256 } from '../lib/fs-helpers.mts';
import { VENDORED_SKILLS } from '../lib/install/vendored-skills.mts';

// Source tree, not packageDir(): the pin describes what is CHECKED IN under skills/, and this test
// must fail on an edit to the source even before a dist build runs.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('vendored third-party skills', () => {
  it('has at least one pin to check (guards against a vacuous pass)', () => {
    expect(VENDORED_SKILLS.length).toBeGreaterThan(0);
  });

  for (const skill of VENDORED_SKILLS) {
    describe(skill.name, () => {
      const dir = join(repoRoot, 'skills', skill.name);

      it('vendored SKILL.md matches the pinned content hash', () => {
        const file = join(dir, 'SKILL.md');
        expect(existsSync(file), `${file} is missing`).toBe(true);
        // A mismatch means either a local edit or a half-finished upstream bump. Re-vendor with
        // `node scripts/sync-vendored-skills.mjs --update <sha>` rather than editing the pin by hand.
        expect(sha256(file)).toBe(skill.sha256);
      });

      it('ships the upstream licence beside the skill', () => {
        // syncSkills copies this dir into consumer repos, so the copyright notice has to travel
        // with it (MIT §"included in all copies"). Kept as a sibling file so SKILL.md stays
        // byte-identical to upstream and the hash above remains an exact upstream comparison.
        const licence = join(dir, 'LICENSE');
        expect(existsSync(licence), `${licence} is missing`).toBe(true);
        const text = readFileSync(licence, 'utf8');
        expect(text).toContain(skill.license);
        expect(text).toContain(skill.holder);
      });

      it('pins a full 40-character commit SHA', () => {
        // An abbreviated SHA is ambiguous over time and breaks the raw.githubusercontent fetch
        // that scripts/sync-vendored-skills.mjs uses to re-verify the pin.
        expect(skill.commit).toMatch(/^[0-9a-f]{40}$/);
      });
    });
  }
});
