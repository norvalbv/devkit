import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tmpRepos } from './_helpers.mts';

// Regression: `devkit doctor` must notice a NEWLY BUNDLED agent/skill that a consumer's stale
// manifest doesn't list and that was never synced to disk — the exact miss that let a v0.31.3→v0.32.0
// bump silently omit `conventions-reviewer`. The per-file drift loop only iterates the manifest's own
// keys, so a just-added bundle entry is invisible to it; the completeness pass catches it.

const { tmpRepo, devkit, cleanup } = tmpRepos('doctor-complete-');
afterEach(cleanup);

const editManifest = (
  root: string,
  kind: 'agents' | 'skills',
  mutate: (files: Record<string, string>) => void,
) => {
  const p = join(root, '.devkit', `${kind}-manifest.json`);
  const m = JSON.parse(readFileSync(p, 'utf8')) as { files: Record<string, string> };
  mutate(m.files);
  writeFileSync(p, JSON.stringify(m, null, 2));
};
const agentsLine = (root: string) =>
  devkit(root, 'doctor')
    .stdout.split('\n')
    .find((l) => /\bagents:/.test(l)) ?? '';
const skillsLine = (root: string) =>
  devkit(root, 'doctor')
    .stdout.split('\n')
    .find((l) => /\bskills:/.test(l)) ?? '';

describe('doctor bundle-completeness (agents)', () => {
  it('a freshly-synced consumer reports agents OK', () => {
    const root = tmpRepo();
    expect(devkit(root, 'init', '--stack', 'generic', '--yes').status).toBe(0);
    expect(agentsLine(root)).toMatch(/OK/);
  });

  it('flags DRIFT when the bundle has an agent the manifest lacks AND it is absent on disk', () => {
    const root = tmpRepo();
    devkit(root, 'init', '--stack', 'generic', '--yes');
    editManifest(root, 'agents', (f) => delete f['conventions-reviewer.md']);
    rmSync(join(root, '.claude/agents/conventions-reviewer.md'));
    const line = agentsLine(root);
    expect(line).toMatch(/DRIFT/);
    expect(line).toContain('the manifest lacks');
    expect(line).toContain('conventions-reviewer.md');
  });

  it('does NOT flag a consumer-authored collision (bundled name absent from manifest but present on disk)', () => {
    const root = tmpRepo();
    devkit(root, 'init', '--stack', 'generic', '--yes');
    // Drop a manifest entry but KEEP the on-disk file — a preserved same-named consumer agent.
    editManifest(root, 'agents', (f) => delete f['correctness-reviewer.md']);
    expect(existsSync(join(root, '.claude/agents/correctness-reviewer.md'))).toBe(true);
    const line = agentsLine(root);
    expect(line).toMatch(/OK/);
    expect(line).not.toContain('the manifest lacks');
  });

  it('doctor --fix re-syncs the missing agent (file back + subsequent doctor OK)', () => {
    const root = tmpRepo();
    devkit(root, 'init', '--stack', 'generic', '--yes');
    editManifest(root, 'agents', (f) => delete f['conventions-reviewer.md']);
    rmSync(join(root, '.claude/agents/conventions-reviewer.md'));
    // (Overall exit may be 1 from unrelated drift in a bare fixture — assert the agents repair itself.)
    devkit(root, 'doctor', '--fix');
    expect(existsSync(join(root, '.claude/agents/conventions-reviewer.md'))).toBe(true);
    expect(agentsLine(root)).toMatch(/OK/);
  });
});

const huskyLine = (root: string) =>
  devkit(root, 'doctor')
    .stdout.split('\n')
    .find((l) => l.includes('.husky/pre-commit')) ?? '';

describe('doctor gate fragment verification (qavis-advisory)', () => {
  it('flags DRIFT when a SELECTED qavis gate is missing its husky fragment', () => {
    const root = tmpRepo();
    // --yes now selects qavis (recommended) → the block carries its `guard-qavis-advisory` fragment.
    expect(devkit(root, 'init', '--stack', 'generic', '--yes').status).toBe(0);
    const p = join(root, '.husky', 'pre-commit');
    // Strip just the qavis fragment (marker-to-marker) — every `guard-qavis-advisory` mention lives in it.
    const stripped = readFileSync(p, 'utf8').replace(
      /# devkit:guard-qavis-advisory[\s\S]*?# \/devkit:guard-qavis-advisory\n?/,
      '',
    );
    expect(stripped).not.toContain('guard-qavis-advisory');
    writeFileSync(p, stripped);

    const line = huskyLine(root);
    expect(line).toMatch(/DRIFT/);
    expect(line).toContain('qavis-advisory');
  });

  it('stays selection-aware: an UNSELECTED qavis (legacy repo) is not flagged as drift', () => {
    const root = tmpRepo();
    // A pre-qavis selection — qavis absent by design, so its absence in the block is correct, not drift.
    expect(
      devkit(
        root,
        'init',
        '--stack',
        'generic',
        '--yes',
        '--guards',
        'size,fanout,dup,clone,decisions',
      ).status,
    ).toBe(0);
    const line = huskyLine(root);
    expect(line).toMatch(/OK/);
    expect(line).not.toContain('qavis-advisory');
  });
});

describe('doctor bundle-completeness (skills, mirrored)', () => {
  it('flags DRIFT when the bundle has a skill dir the manifest lacks AND it is absent on disk', () => {
    const root = tmpRepo();
    devkit(root, 'init', '--stack', 'generic', '--yes');
    // Simulate a stale manifest that predates the `decisions` skill, and no synced copy on disk.
    editManifest(root, 'skills', (f) => {
      for (const k of Object.keys(f)) if (k.startsWith('decisions/')) delete f[k];
    });
    rmSync(join(root, '.claude/skills/decisions'), { recursive: true, force: true });
    const line = skillsLine(root);
    expect(line).toMatch(/DRIFT/);
    expect(line).toContain('the manifest lacks');
    expect(line).toContain('decisions');
  });
});
