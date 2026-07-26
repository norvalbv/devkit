import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findDrift, repoFiles, runDrift } from '../drift.mts';

/** A Target block with a Scope — the only shape drift cares about. */
const target = (slug: string, scope: string) => `---
slug: ${slug}
created: 2026-01-01
---

# ${slug}

## Target · 2026-01-01 — ${slug}

**Context:** forcing failure.
**Ruling:** the ruling.
**Consequences:**
- Positive: value.
- Negative: cost.
**Scope:** ${scope}
**Source:** manual
`;

describe('decision drift (scope no longer resolves)', () => {
  let root: string;
  let decisions: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dk-drift-'));
    decisions = join(root, 'docs', 'decisions');
    mkdirSync(decisions, { recursive: true });
    mkdirSync(join(root, 'src', 'live'), { recursive: true });
    writeFileSync(join(root, 'src', 'live', 'kept.mts'), 'export const a = 1;\n');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('reports an axis whose glob matches nothing, and stays silent for one that matches', () => {
    writeFileSync(join(decisions, 'alive.md'), target('alive', 'src/live/**'));
    writeFileSync(join(decisions, 'rotted.md'), target('rotted', 'src/moved-away/**'));

    const drifted = findDrift(root, decisions);
    expect(drifted.map((d) => d.slug)).toEqual(['rotted']);
    expect(drifted[0].globs).toEqual(['src/moved-away/**']);
  });

  // The real-world cause: the repo migrated .mjs -> .mts and every scope naming a .mjs file stopped
  // matching. The ruling is still correct and still readable; it is simply no longer enforced.
  it('catches the extension-migration case', () => {
    writeFileSync(join(decisions, 'migrated.md'), target('migrated', 'src/live/kept.mjs'));
    expect(findDrift(root, decisions).map((d) => d.slug)).toEqual(['migrated']);
  });

  // The other real cause, and the one that bit during this story: a file moved one directory down.
  it('catches the moved-file case, and goes green once the Scope is corrected', () => {
    const file = join(decisions, 'moved.md');
    writeFileSync(file, target('moved', 'src/kept.mts'));
    expect(findDrift(root, decisions)).toHaveLength(1);

    writeFileSync(file, target('moved', 'src/live/kept.mts')); // the fix a human would make
    expect(findDrift(root, decisions)).toEqual([]);
  });

  it('a partially-live scope list is NOT drift — the gate still fires on the live glob', () => {
    writeFileSync(join(decisions, 'partial.md'), target('partial', 'src/gone/**,src/live/**'));
    expect(findDrift(root, decisions)).toEqual([]);
  });

  it('an axis with no Scope is out of scope for this check, not drifted', () => {
    const noScope = target('unscoped', 'x').replace(/^\*\*Scope:\*\*.*$/m, '');
    writeFileSync(join(decisions, 'unscoped.md'), noScope);
    expect(findDrift(root, decisions)).toEqual([]);
  });

  // Fail-open on a tree we cannot read: reporting every axis as drifted because the walk found
  // nothing would be a wall of false positives, which is how a gate gets switched off.
  it('concludes nothing when there are no files to match against', () => {
    const empty = mkdtempSync(join(tmpdir(), 'dk-drift-empty-'));
    writeFileSync(join(decisions, 'rotted.md'), target('rotted', 'src/nope/**'));
    expect(findDrift(empty, decisions)).toEqual([]);
    rmSync(empty, { recursive: true, force: true });
  });

  it('skips node_modules so a scope matching only vendored code still counts as drifted', () => {
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'pkg', 'x.mts'), 'export const x = 1;\n');
    expect(repoFiles(root).some((f) => f.includes('node_modules'))).toBe(false);

    writeFileSync(join(decisions, 'vendored.md'), target('vendored', 'node_modules/**'));
    expect(findDrift(root, decisions).map((d) => d.slug)).toEqual(['vendored']);
  });

  it('runDrift exits 1 on drift and 0 when clean', () => {
    writeFileSync(join(decisions, 'alive.md'), target('alive', 'src/live/**'));
    expect(runDrift(root, decisions)).toBe(0);

    writeFileSync(join(decisions, 'rotted.md'), target('rotted', 'src/gone/**'));
    expect(runDrift(root, decisions)).toBe(1);
  });

  it('runDrift returns the could-not-run code for a missing root', () => {
    expect(runDrift(join(root, 'no-such-dir'), decisions)).toBe(2);
  });
});

// Scope globs are always authored repo-root-relative with forward slashes. A filesystem walk yields
// OS-native separators, so without normalization every scoped axis misreports as drifted on Windows.
describe('path separators', () => {
  it('emits forward-slash repo-relative paths regardless of platform', () => {
    const root = mkdtempSync(join(tmpdir(), 'dk-sep-'));
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    writeFileSync(join(root, 'a', 'b', 'c.mts'), 'export const c = 1;\n');

    const files = repoFiles(root);
    expect(files).toContain('a/b/c.mts');
    expect(files.some((f) => f.includes('\\'))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
});
