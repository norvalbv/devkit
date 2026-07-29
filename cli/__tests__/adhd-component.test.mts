/**
 * The `adhd` component: the vendored i-have-adhd skill (cli/lib/install/vendored-skills.mts) is
 * opt-in, rides the skills sync, and is removed by deselection alone.
 *
 * The load-bearing property is that it stays OFF unless asked for — it reshapes how the assistant
 * writes, so an unrequested install is a real defect, not a cosmetic one. `--yes` installs every
 * recommended component, which makes it exactly the case worth pinning.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { syncSkills } from '../commands/sync/sync-skills.mts';
import { defaultSelection, skillNamesForSelection } from '../lib/components.mts';
import { tmpRepos } from './_helpers.mts';

const { tmpRepo, devkit, cleanup } = tmpRepos('adhd-');
const SKILL = 'i-have-adhd';
const skillDir = (root: string, surface = 'claude') => join(root, `.${surface}`, 'skills', SKILL);
const readConfig = (root: string) =>
  JSON.parse(readFileSync(join(root, '.devkit', 'config.json'), 'utf8'));

afterEach(cleanup);

describe('skillNamesForSelection', () => {
  const all = ['brainstorming', 'decisions', SKILL];

  it('omits the adhd skill unless the component is on', () => {
    expect(skillNamesForSelection(all, { adhd: false })).not.toContain(SKILL);
    expect(skillNamesForSelection(all, { adhd: true })).toContain(SKILL);
  });

  it('leaves ungated skills alone either way', () => {
    expect(skillNamesForSelection(all, { adhd: false })).toContain('brainstorming');
    expect(skillNamesForSelection(all, { adhd: true })).toContain('brainstorming');
  });

  it('defaults to off when given no selection at all', () => {
    // A caller that forgets to thread the flag must fail CLOSED — never ship an opt-in skill.
    expect(skillNamesForSelection(all)).not.toContain(SKILL);
  });

  it('is off in the --yes / non-TTY default selection', () => {
    expect(defaultSelection().adhd).toBe(false);
  });
});

describe('devkit init --adhd', () => {
  it('is absent from a plain --yes install, and records the decision', () => {
    const root = tmpRepo();
    expect(devkit(root, 'init', '--stack', 'generic', '--yes').status).toBe(0);
    expect(existsSync(skillDir(root))).toBe(false);
    // Recorded as false, not omitted — that is what stops `devkit upgrade` re-offering it.
    expect(readConfig(root).components.adhd).toBe(false);
  });

  it('--adhd syncs the skill and its licence, and records the opt-in', () => {
    const root = tmpRepo();
    expect(devkit(root, 'init', '--stack', 'generic', '--yes', '--adhd').status).toBe(0);
    expect(existsSync(join(skillDir(root), 'SKILL.md'))).toBe(true);
    // MIT requires the notice travel with the copy.
    expect(existsSync(join(skillDir(root), 'LICENSE'))).toBe(true);
    expect(readConfig(root).components.adhd).toBe(true);

    const manifest = JSON.parse(
      readFileSync(join(root, '.devkit', 'skills-manifest.json'), 'utf8'),
    );
    expect(Object.keys(manifest.files)).toContain(`${SKILL}/SKILL.md`);
    expect(Object.keys(manifest.files)).toContain(`${SKILL}/LICENSE`);
  });

  it('--no-adhd keeps it off even when --adhd is also passed', () => {
    const root = tmpRepo();
    devkit(root, 'init', '--stack', 'generic', '--yes', '--adhd', '--no-adhd');
    expect(existsSync(skillDir(root))).toBe(false);
    expect(readConfig(root).components.adhd).toBe(false);
  });

  it('reports that the skill has no surface when skills are deselected', () => {
    const root = tmpRepo();
    const r = devkit(root, 'init', '--stack', 'generic', '--yes', '--adhd', '--no-skills');
    expect(r.status).toBe(0);
    expect(`${r.stdout}`).toContain('Agent skills is off');
    expect(existsSync(skillDir(root))).toBe(false);
    // The selection is still honoured in the record — enabling skills later syncs it.
    expect(readConfig(root).components.adhd).toBe(true);
  });
});

describe('deselecting the adhd component', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('reclaims a pristine copy', () => {
    const root = tmpRepo();
    syncSkills([], root, ['claude'], { selection: { adhd: true } });
    expect(existsSync(skillDir(root))).toBe(true);

    syncSkills([], root, ['claude'], { selection: { adhd: false } });
    expect(existsSync(skillDir(root))).toBe(false);
  });

  it('keeps a copy the consumer edited', () => {
    // Same contract as every other devkit-owned skill: deselection never deletes consumer edits.
    const root = tmpRepo();
    syncSkills([], root, ['claude'], { selection: { adhd: true } });
    const file = join(skillDir(root), 'SKILL.md');
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n<!-- my tweak -->\n`);

    syncSkills([], root, ['claude'], { selection: { adhd: false } });

    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('<!-- my tweak -->');
  });

  it('keeps a copy the consumer added a file to', () => {
    const root = tmpRepo();
    syncSkills([], root, ['claude'], { selection: { adhd: true } });
    mkdirSync(join(skillDir(root), 'notes'), { recursive: true });
    writeFileSync(join(skillDir(root), 'notes', 'mine.md'), 'mine\n');

    syncSkills([], root, ['claude'], { selection: { adhd: false } });

    expect(existsSync(join(skillDir(root), 'notes', 'mine.md'))).toBe(true);
  });
});
