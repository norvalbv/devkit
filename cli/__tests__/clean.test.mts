import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tmpRepos } from './_helpers.mts';

const { tmpRepo, devkit, cleanup } = tmpRepos('clean-');
afterEach(cleanup);

describe('clean (package mode)', () => {
  it('removes the SYNCED skill files, not just the manifest', () => {
    const root = tmpRepo();
    expect(devkit(root, 'init', '--stack', 'generic', '--yes').status).toBe(0);
    // Fresh installs use every supported provider, including Codex's native roots/formats.
    const sample = '.claude/skills/brainstorming';
    expect(existsSync(join(root, sample)), 'skills synced by init').toBe(true);
    expect(existsSync(join(root, '.cursor/skills/brainstorming'))).toBe(true);
    expect(existsSync(join(root, '.claude/hooks/decision-edit-guard.mjs'))).toBe(true);
    expect(existsSync(join(root, '.agents/skills/brainstorming'))).toBe(true);
    expect(existsSync(join(root, '.codex/agents/feature-critique.toml'))).toBe(true);

    // Unmanifested consumer assets share the provider roots but are never devkit-owned.
    mkdirSync(join(root, '.agents/skills/team-skill'), { recursive: true });
    writeFileSync(join(root, '.agents/skills/team-skill/SKILL.md'), '# team skill\n');
    writeFileSync(join(root, '.codex/agents/team-agent.toml'), 'name = "team"\n');

    const c = devkit(root, 'clean', '--yes');
    expect(c.status).toBe(0);

    // the regression: clean used to drop only the manifest, leaving the synced files behind.
    expect(existsSync(join(root, sample)), '.claude skill removed').toBe(false);
    expect(existsSync(join(root, '.cursor/skills/brainstorming')), '.cursor skill removed').toBe(
      false,
    );
    expect(existsSync(join(root, '.agents/skills/brainstorming')), 'Codex skill removed').toBe(
      false,
    );
    expect(existsSync(join(root, '.codex/agents/feature-critique.toml'))).toBe(false);
    expect(existsSync(join(root, '.agents/skills/team-skill/SKILL.md'))).toBe(true);
    expect(existsSync(join(root, '.codex/agents/team-agent.toml'))).toBe(true);
    expect(existsSync(join(root, '.devkit/skills-manifest.json'))).toBe(false);
    expect(existsSync(join(root, '.claude/hooks/decision-edit-guard.mjs'))).toBe(false);
    expect(existsSync(join(root, '.devkit'))).toBe(false);
    expect(existsSync(join(root, 'guard.config.json'))).toBe(false);
  });

  it('--dry-run removes nothing', () => {
    const root = tmpRepo();
    devkit(root, 'init', '--stack', 'generic', '--yes');
    const c = devkit(root, 'clean', '--dry-run');
    expect(c.status).toBe(0);
    expect(existsSync(join(root, '.claude/skills/brainstorming'))).toBe(true);
    expect(existsSync(join(root, 'guard.config.json'))).toBe(true);
  });

  it('removes Oxc before anti-slop so a config collision cannot strand a partial clean', () => {
    const root = tmpRepo();
    expect(
      devkit(root, 'init', '--stack', 'generic', '--yes', '--anti-slop', '--no-husky').status,
    ).toBe(0);
    writeFileSync(join(root, 'oxlint.config.ts'), 'export default {};\n');

    const result = devkit(root, 'clean', '--yes');

    expect(result.status).toBe(0);
    expect(existsSync(join(root, '.devkit'))).toBe(false);
    expect(existsSync(join(root, 'oxlint.config.ts'))).toBe(true);
  });

  it('exposes Codex-only overlay remnants when their ownership records are gone', () => {
    const root = tmpRepo();
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    mkdirSync(join(root, '.agents/skills/brainstorming'), { recursive: true });
    mkdirSync(join(root, '.codex/agents'), { recursive: true });
    writeFileSync(join(root, '.agents/skills/brainstorming/SKILL.md'), '# unresolved\n');
    writeFileSync(join(root, '.codex/agents/feature-critique.toml'), 'name = "unresolved"\n');
    const exclude = join(root, '.git/info/exclude');
    writeFileSync(
      exclude,
      '# devkit overlay (local-only) — not committed\n.agents/skills/brainstorming/\n.codex/agents/feature-critique.toml\n',
    );

    const result = devkit(root, 'clean', '--yes');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('overlay leftovers found');
    expect(existsSync(join(root, '.agents/skills/brainstorming/SKILL.md'))).toBe(true);
    expect(existsSync(join(root, '.codex/agents/feature-critique.toml'))).toBe(true);
    expect(readFileSync(exclude, 'utf8')).not.toContain('devkit overlay');
  });
});

// Overlay's footprint is exclude LINES plus untracked files; clean must reverse both halves, or a
// later user file at that path stays silently invisible to git.
describe('clean (overlay mode) — anti-slop root files', () => {
  const overlayRepo = () => {
    const root = tmpRepo();
    const git = (...a: string[]) => execFileSync('git', a, { cwd: root, stdio: 'ignore' });
    git('init');
    git('config', 'user.email', 't@t.t');
    git('config', 'user.name', 't');
    writeFileSync(join(root, 'package.json'), '{ "name": "work" }\n');
    git('add', '-A');
    git('commit', '-qm', 'init');
    return root;
  };
  const exclude = (root: string) => readFileSync(join(root, '.git/info/exclude'), 'utf8');

  it('prunes the entry-config and baseline exclude lines, not just the files', () => {
    const root = overlayRepo();
    expect(
      devkit(root, 'init', '--overlay', '--stack', 'generic', '--yes', '--anti-slop').status,
    ).toBe(0);
    expect(exclude(root)).toContain('oxlint.devkit.json');
    expect(exclude(root)).toContain('.anti-slop-baseline.json');

    expect(devkit(root, 'clean', '--yes').status).toBe(0);

    expect(existsSync(join(root, 'oxlint.devkit.json'))).toBe(false);
    expect(existsSync(join(root, '.anti-slop-baseline.json'))).toBe(false);
    // The regression: the files went but their lines stayed, so a later user file at either path
    // would have been hidden from `git status` by an exclude block nothing owned any more.
    expect(exclude(root)).not.toContain('oxlint.devkit.json');
    expect(exclude(root)).not.toContain('.anti-slop-baseline.json');
    writeFileSync(join(root, 'oxlint.devkit.json'), '{}\n');
    writeFileSync(join(root, '.anti-slop-baseline.json'), '{}\n');
    const porcelain = execFileSync('git', ['status', '--porcelain'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(porcelain).toContain('oxlint.devkit.json');
    expect(porcelain).toContain('.anti-slop-baseline.json');
  });

  it('declines to delete a tracked overlay file and names the untracking remedy', () => {
    const root = overlayRepo();
    const git = (...a: string[]) => execFileSync('git', a, { cwd: root, stdio: 'ignore' });
    expect(
      devkit(root, 'init', '--overlay', '--stack', 'generic', '--yes', '--anti-slop').status,
    ).toBe(0);
    // The user force-adds it AFTER install, so the install-time refusal never saw it. devkit does
    // not own this repo: deleting committed content it cannot restore is the unrecoverable move.
    git('add', '-f', '.anti-slop-baseline.json');
    // --no-verify: overlay just pointed core.hooksPath at its own gate chain, which is not what
    // this test is about.
    git('commit', '-qm', 'track the baseline', '--no-verify');

    const result = devkit(root, 'clean', '--yes');

    expect(result.status).toBe(0);
    expect(existsSync(join(root, '.anti-slop-baseline.json'))).toBe(true);
    expect(result.stdout).toContain('kept tracked .anti-slop-baseline.json');
    expect(result.stdout).toContain('git rm --cached .anti-slop-baseline.json');
    // The untracked sibling is still removed — the guard is per-path, not a blanket bail-out.
    expect(existsSync(join(root, 'oxlint.devkit.json'))).toBe(false);
  });
});
