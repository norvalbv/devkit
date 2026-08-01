/**
 * The `adhd` component: the vendored i-have-adhd skill (cli/lib/install/vendored-skills.mts) is
 * opt-in, installs into devkit's OWN `.devkit/vendored-skills/` tree, and is removed by deselection
 * alone.
 *
 * Two load-bearing properties. It stays OFF unless asked for — it reshapes how the assistant writes,
 * so an unrequested install is a real defect, not a cosmetic one, and `--yes` installs every
 * recommended component, which makes that exactly the case worth pinning. And it never lands in
 * `.claude/skills/`, which belongs to the consumer's own hand-authored skills.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultSelection, skillNamesForSelection } from '../lib/components.mts';
import { sha256 } from '../lib/fs-helpers.mts';
import { ADHD_SKILL_DIR } from '../lib/install/adhd-skill.mts';
import { tmpRepos } from './_helpers.mts';

const { tmpRepo, devkit, cleanup } = tmpRepos('adhd-');
const SKILL = 'i-have-adhd';
/** Where the skill lives. */
const vendoredDir = (root: string) => join(root, ADHD_SKILL_DIR);
/** Where releases before the relocation put it — reclaiming this is the migration. */
const agentSkillDir = (root: string, surface = 'claude') =>
  join(root, `.${surface}`, 'skills', SKILL);
const readConfig = (root: string) =>
  JSON.parse(readFileSync(join(root, '.devkit', 'config.json'), 'utf8'));

afterEach(cleanup);

describe('skillNamesForSelection', () => {
  const all = ['brainstorming', 'decisions', SKILL];

  it('never admits the adhd skill — it does not ship via the agent skills sync', () => {
    // A constant exclusion rather than a flag: the skill has its own installer now, and this is also
    // what drives reclamation of the copy pre-relocation releases wrote into .claude/skills/.
    expect(skillNamesForSelection(all)).not.toContain(SKILL);
    expect(skillNamesForSelection(all, { guards: ['decisions'] })).not.toContain(SKILL);
  });

  it('leaves ungated skills alone', () => {
    expect(skillNamesForSelection(all)).toContain('brainstorming');
  });

  it('is off in the --yes / non-TTY default selection', () => {
    expect(defaultSelection().adhd).toBe(false);
  });
});

describe('devkit init --adhd', () => {
  it('is absent from a plain --yes install, and records the decision', () => {
    const root = tmpRepo();
    expect(devkit(root, 'init', '--stack', 'generic', '--yes').status).toBe(0);
    expect(existsSync(vendoredDir(root))).toBe(false);
    // Recorded as false, not omitted — that is what stops `devkit upgrade` re-offering it.
    expect(readConfig(root).components.adhd).toBe(false);
  });

  it('--adhd installs the skill and its licence, clear of the agent skills dirs', () => {
    const root = tmpRepo();
    expect(devkit(root, 'init', '--stack', 'generic', '--yes', '--adhd').status).toBe(0);
    expect(existsSync(join(vendoredDir(root), 'SKILL.md'))).toBe(true);
    // MIT requires the notice travel with the copy.
    expect(existsSync(join(vendoredDir(root), 'LICENSE'))).toBe(true);
    expect(readConfig(root).components.adhd).toBe(true);

    // The point of the relocation: absent from every surface's skills dir, and unclaimed by the
    // skills manifest (devkit must not report owning a file it no longer writes there).
    expect(existsSync(agentSkillDir(root))).toBe(false);
    expect(existsSync(agentSkillDir(root, 'cursor'))).toBe(false);
    const manifest = JSON.parse(
      readFileSync(join(root, '.devkit', 'skills-manifest.json'), 'utf8'),
    );
    expect(Object.keys(manifest.files).filter((f) => f.startsWith(SKILL))).toEqual([]);
  });

  it('--no-adhd keeps it off even when --adhd is also passed', () => {
    const root = tmpRepo();
    devkit(root, 'init', '--stack', 'generic', '--yes', '--adhd', '--no-adhd');
    expect(existsSync(vendoredDir(root))).toBe(false);
    expect(readConfig(root).components.adhd).toBe(false);
  });

  it('installs with the skills component off — it no longer rides that sync', () => {
    const root = tmpRepo();
    const r = devkit(root, 'init', '--stack', 'generic', '--yes', '--adhd', '--no-skills');
    expect(r.status).toBe(0);
    expect(existsSync(join(vendoredDir(root), 'SKILL.md'))).toBe(true);
    expect(readConfig(root).components.adhd).toBe(true);
  });

  it('reclaims the skill when the component is later deselected', () => {
    const root = tmpRepo();
    devkit(root, 'init', '--stack', 'generic', '--yes', '--adhd');
    expect(existsSync(vendoredDir(root))).toBe(true);

    devkit(root, 'init', '--stack', 'generic', '--yes', '--no-adhd');
    expect(existsSync(vendoredDir(root))).toBe(false);
    expect(readConfig(root).components.adhd).toBe(false);
  });
});

/**
 * Repos installed before the relocation carry the skill in their agent skills dirs AND in their
 * skills manifest. Removing it from `skillNamesForSelection` is what reclaims it — there is no
 * bespoke migration step. Both manifest schemas are exercised because they decode through different
 * paths, and the legacy one is what already-installed repos actually have on disk.
 */
describe('migrating a repo installed before the relocation', () => {
  /** Re-create the pre-relocation layout: skill on both surfaces, claimed by the manifest. */
  function seedLegacyLayout(root: string, legacySchema: boolean) {
    const dirs = ['claude', 'cursor'].map((s) => agentSkillDir(root, s));
    for (const dir of dirs) {
      mkdirSync(dir, { recursive: true });
      for (const f of ['SKILL.md', 'LICENSE'])
        writeFileSync(join(dir, f), readFileSync(join(vendoredDir(root), f), 'utf8'));
    }
    const manifestPath = join(root, '.devkit', 'skills-manifest.json');
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
    // Manifest membership is what proves devkit wrote these and may therefore reclaim them.
    const entries = Object.fromEntries(
      ['SKILL.md', 'LICENSE'].map((f) => [`${SKILL}/${f}`, sha256(join(dirs[0], f))]),
    );
    Object.assign(m.files, entries);
    const next = legacySchema
      ? {
          devkitRef: m.devkitRef,
          generatedAt: m.generatedAt,
          targets: ['claude', 'cursor'],
          files: m.files,
        }
      : m;
    // v2 additionally records a per-provider projection; a source with no projection is rejected.
    if (!legacySchema)
      for (const p of Object.keys(m.providers)) Object.assign(m.providers[p].files, entries);
    writeFileSync(manifestPath, JSON.stringify(next, null, 2));
    return dirs;
  }

  for (const [label, legacySchema] of [
    ['v2 manifest', false],
    ['legacy manifest', true],
  ] as const) {
    it(`reclaims the copies an older release wrote into the skills dirs (${label})`, () => {
      const root = tmpRepo();
      devkit(root, 'init', '--stack', 'generic', '--yes', '--adhd');
      const dirs = seedLegacyLayout(root, legacySchema);

      expect(devkit(root, 'init', '--stack', 'generic', '--yes', '--adhd').status).toBe(0);

      for (const dir of dirs) expect(existsSync(dir)).toBe(false);
      // The new location survives the migration that removed the old ones.
      expect(existsSync(join(vendoredDir(root), 'SKILL.md'))).toBe(true);
    });
  }
});
