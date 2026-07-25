/**
 * Deselecting a skill must not delete a consumer's edits to it.
 *
 * `syncSkills` reconciles exactly: a skill devkit's manifest owns but the current selection no
 * longer wants is removed. Membership in that manifest records that devkit WROTE the skill once —
 * not that the tree is still devkit's. Pruning on membership alone therefore deletes whatever the
 * consumer has since made of it, while the WRITE path in the same file refuses that exact clobber
 * (findConflicts → "preserving non-devkit skill"). Same defect the hooks path carried (#209).
 *
 * `decisions` is the guard-gated skill (skillNamesForGuards), so dropping the `decisions` guard is
 * the real deselection a consumer performs. A skill is removed as a UNIT, so any edited or added
 * file has to protect the whole directory.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { syncSkills } from '../commands/sync/sync-skills.mts';
import { tmpRepos } from './_helpers.mts';

const { tmpRepo, cleanup } = tmpRepos('skillprune-');
const decisionsDir = (root: string) => join(root, '.claude', 'skills', 'decisions');

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe('syncSkills — pruning a deselected skill', () => {
  it('still prunes a deselected skill left pristine', () => {
    const root = tmpRepo();
    syncSkills([], root, ['claude'], { guards: ['decisions'] });
    expect(existsSync(decisionsDir(root))).toBe(true);

    syncSkills([], root, ['claude'], { guards: [] });
    expect(existsSync(decisionsDir(root))).toBe(false);
  });

  it('keeps a deselected skill whose file the consumer edited', () => {
    const root = tmpRepo();
    syncSkills([], root, ['claude'], { guards: ['decisions'] });
    const file = join(decisionsDir(root), 'SKILL.md');
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n<!-- consumer tweak -->\n`);

    syncSkills([], root, ['claude'], { guards: [] });

    expect(existsSync(decisionsDir(root))).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('<!-- consumer tweak -->');
  });

  it('keeps a deselected skill containing a symlink, without crashing the sync', () => {
    // readdirSync(withFileTypes) reports a symlink-to-DIRECTORY as a non-directory entry, so a
    // plain walk hands it to sha256 — which follows the link and throws EISDIR, aborting the whole
    // run instead of preserving the very skill the guard exists to protect.
    const root = tmpRepo();
    syncSkills([], root, ['claude'], { guards: ['decisions'] });
    // REPLACE a manifest-owned file with a link to a directory: the file count still matches, so
    // the scan reaches sha256 — which is where the EISDIR fires. An ADDED symlink would trip the
    // count check first and never exercise this path.
    const target = join(root, 'linked-notes');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'note.md'), 'notes\n');
    rmSync(join(decisionsDir(root), 'SKILL.md'));
    symlinkSync(target, join(decisionsDir(root), 'SKILL.md'));

    expect(() => syncSkills([], root, ['claude'], { guards: [] })).not.toThrow();
    expect(existsSync(decisionsDir(root))).toBe(true);
  });

  it('keeps a deselected skill the consumer added a file to', () => {
    const root = tmpRepo();
    syncSkills([], root, ['claude'], { guards: ['decisions'] });
    mkdirSync(join(decisionsDir(root), 'references'), { recursive: true });
    writeFileSync(join(decisionsDir(root), 'references', 'ours.md'), 'our notes\n');

    syncSkills([], root, ['claude'], { guards: [] });

    expect(existsSync(join(decisionsDir(root), 'references', 'ours.md'))).toBe(true);
  });
});
