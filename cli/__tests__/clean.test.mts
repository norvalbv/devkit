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
