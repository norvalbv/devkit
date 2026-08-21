/**
 * Edge cases for the projection drift reader. The happy path is pinned against devkit's OWN
 * committed tree in `cli/__tests__/self-host.test.mts`; everything here is a shape that repo cannot
 * produce — an unconfigured surface, a never-synced dir, a symlinked projection, a codex target.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { projectedLogicals, projectionDrift } from './projection-parity.mts';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'devkit-projection-parity-'));
  roots.push(root);
  return root;
}

function write(root: string, rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/** A source skill plus a byte-identical `.claude` projection of it — the clean baseline. */
function seedSkills(root: string): void {
  write(root, 'skills/alpha/SKILL.md', '# alpha\n');
  write(root, 'skills/alpha/references/notes.md', 'notes\n');
  write(root, '.claude/skills/alpha/SKILL.md', '# alpha\n');
  write(root, '.claude/skills/alpha/references/notes.md', 'notes\n');
}

const skillsInput = (root: string, targets: readonly string[] = ['claude']) =>
  ({ root, kind: 'skills', srcDir: 'skills', targets }) as const;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('projectionDrift', () => {
  it('reports nothing when every projected file matches its source byte for byte', () => {
    const root = tempRoot();
    seedSkills(root);
    expect(projectionDrift(skillsInput(root))).toEqual([]);
  });

  // The one outcome a drift guard must never produce. Before this was pinned, a config with no
  // agentTargets made the loop body unreachable, so the check passed green while comparing nothing.
  it('reports `unchecked` rather than passing vacuously when no targets are configured', () => {
    const root = tempRoot();
    seedSkills(root);
    const drift = projectionDrift(skillsInput(root, []));
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatch(/^unchecked skills\/ — no agentTargets configured/);
  });

  it('reports every source file as missing when the target dir was never synced', () => {
    const root = tempRoot();
    write(root, 'skills/alpha/SKILL.md', '# alpha\n');
    write(root, 'skills/alpha/references/notes.md', 'notes\n');
    expect(projectionDrift(skillsInput(root)).sort()).toEqual([
      'missing .claude/skills/alpha/SKILL.md',
      'missing .claude/skills/alpha/references/notes.md',
    ]);
  });

  it('separates a stale projection from an orphan, since only one is fixable by re-running sync', () => {
    const root = tempRoot();
    seedSkills(root);
    write(root, '.claude/skills/alpha/SKILL.md', '# alpha (hand-edited)\n');
    write(root, '.claude/skills/alpha/scripts/gone.mjs', 'deleted from source\n');
    expect(projectionDrift(skillsInput(root)).sort()).toEqual([
      'orphan .claude/skills/alpha/scripts/gone.mjs',
      'stale .claude/skills/alpha/SKILL.md',
    ]);
  });

  // `walk` is lstat-shaped, so a symlink-to-directory is emitted as a leaf and `readFileSync` on it
  // throws EISDIR. The guard has to survive a malformed projection and report it — a crash here
  // tells the reader nothing about which file is wrong.
  it('reports a symlinked projection file as stale instead of crashing on EISDIR', () => {
    const root = tempRoot();
    seedSkills(root);
    rmSync(join(root, '.claude/skills/alpha/SKILL.md'));
    symlinkSync(join(root, 'skills/alpha/references'), join(root, '.claude/skills/alpha/SKILL.md'));
    expect(projectionDrift(skillsInput(root))).toEqual(['stale .claude/skills/alpha/SKILL.md']);
  });

  it('checks every configured target, not just the first', () => {
    const root = tempRoot();
    seedSkills(root);
    write(root, '.cursor/skills/alpha/SKILL.md', '# alpha\n');
    write(root, '.cursor/skills/alpha/references/notes.md', 'stale in cursor only\n');
    expect(projectionDrift(skillsInput(root, ['claude', 'cursor']))).toEqual([
      'stale .cursor/skills/alpha/references/notes.md',
    ]);
  });

  // codex relocates skills to `.agents/skills` and renames agents to `.toml`. Nothing in devkit's
  // own repo exercises it (agentTargets is claude+cursor), so without this the routing is untested.
  it('routes a codex target to .agents/skills rather than .codex/skills', () => {
    const root = tempRoot();
    seedSkills(root);
    expect(projectionDrift(skillsInput(root, ['codex'])).sort()).toEqual([
      'missing .agents/skills/alpha/SKILL.md',
      'missing .agents/skills/alpha/references/notes.md',
    ]);
    write(root, '.agents/skills/alpha/SKILL.md', '# alpha\n');
    write(root, '.agents/skills/alpha/references/notes.md', 'notes\n');
    expect(projectionDrift(skillsInput(root, ['codex']))).toEqual([]);
  });

  it('compares a codex agent against its .toml projection, not the source markdown', () => {
    const root = tempRoot();
    write(root, 'agents/reviewer.md', '---\nname: reviewer\ndescription: "r"\n---\n\nBody\n');
    const drift = projectionDrift({ root, kind: 'agents', srcDir: 'agents', targets: ['codex'] });
    expect(drift).toEqual(['missing .codex/agents/reviewer.toml']);
  });
});

describe('projectedLogicals', () => {
  // The selection filter is shared with the writer so the two cannot disagree about what ships.
  // `decisions` is gated on its guard; a repo without it must not see the skill as missing.
  it('drops the decisions skill unless the decisions guard is selected', () => {
    const root = tempRoot();
    write(root, 'skills/alpha/SKILL.md', '# alpha\n');
    write(root, 'skills/decisions/SKILL.md', '# decisions\n');
    const input = { root, kind: 'skills', srcDir: 'skills', targets: ['claude'] } as const;

    expect(projectedLogicals(input)).toEqual(['alpha/SKILL.md']);
    expect(projectedLogicals({ ...input, selection: { guards: ['decisions'] } }).sort()).toEqual([
      'alpha/SKILL.md',
      'decisions/SKILL.md',
    ]);
  });

  it('never projects the vendored i-have-adhd skill onto an agent surface', () => {
    const root = tempRoot();
    write(root, 'skills/alpha/SKILL.md', '# alpha\n');
    write(root, 'skills/i-have-adhd/SKILL.md', '# adhd\n');
    const input = { root, kind: 'skills', srcDir: 'skills', targets: ['claude'] } as const;

    expect(projectedLogicals({ ...input, selection: { guards: ['decisions'] } })).toEqual([
      'alpha/SKILL.md',
    ]);
  });

  it('takes only top-level .md files for agents, ignoring nested dirs and other extensions', () => {
    const root = tempRoot();
    write(root, 'agents/reviewer.md', 'a\n');
    write(root, 'agents/notes.txt', 'b\n');
    write(root, 'agents/nested/inner.md', 'c\n');
    expect(
      projectedLogicals({ root, kind: 'agents', srcDir: 'agents', targets: ['claude'] }),
    ).toEqual(['reviewer.md']);
  });
});
