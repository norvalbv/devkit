/**
 * Non-devkit asset collision handling: a consumer's OWN skill/agent under a devkit-bundled name is
 * PRESERVED on install (never clobbered) unless overridden (--force / the interactive picker), and
 * is never deleted by clean's no-manifest fallback. devkit's own copies (manifest-owned, or
 * byte-identical to the bundle) keep overwriting so a tag bump still propagates.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyInit } from '../commands/init.mts';
import { detectAgentConflicts, syncAgents } from '../commands/sync/sync-agents.mts';
import { detectSkillConflicts, syncSkills } from '../commands/sync/sync-skills.mts';
import { defaultSelection } from '../lib/components.mts';
import { detectHookConflicts, syncHookScripts } from '../lib/install/install-hooks.mts';
import { matchesBundle, removeSkills } from '../lib/sync-manifest.mts';
import { tmpRepos } from './_helpers.mts';

const { tmpRepo, cleanup } = tmpRepos('conflict-');
const initGit = (root) => execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });

// applyInit + the clean fallback shell out to git (detectGitRoot, isTracked per bundled name); under
// the full suite's parallel load that subprocess contention can starve the default 5s timeout. Give
// ample headroom (assertions unchanged) — same rationale as overlay.test.mjs.
vi.setConfig({ testTimeout: 20000 });

// A minimal selection: just sync skills (or agents) to the Claude surface — no biome/tsconfig/husky/
// guards/structure/fallow noise, so applyInit exercises only the agent-surface path under test.
const only = (overrides) => ({
  ...defaultSelection(),
  biome: false,
  tsconfig: false,
  husky: false,
  structure: false,
  guards: [],
  agents: false,
  skills: false,
  agentTargets: ['claude'],
  ...overrides,
});

const SKILL = (root) => join(root, '.claude', 'skills', 'brainstorming', 'SKILL.md');
const seedSkill = (root, body) => {
  mkdirSync(join(root, '.claude', 'skills', 'brainstorming'), { recursive: true });
  writeFileSync(SKILL(root), body);
};
const skillsManifest = (root) =>
  JSON.parse(readFileSync(join(root, '.devkit', 'skills-manifest.json'), 'utf8'));
const ownsBrainstorming = (root) =>
  Object.keys(skillsManifest(root).files).some((k) => k.startsWith('brainstorming/'));

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

const legacyWriters = [
  {
    label: 'skills',
    kind: 'skills',
    manifest: 'skills-manifest.json',
    outputDir: 'skills',
    codexOutput: '.agents/skills/brainstorming/SKILL.md',
    run: (root, targets) => syncSkills([], root, targets),
  },
  {
    label: 'agents',
    kind: 'agents',
    manifest: 'agents-manifest.json',
    outputDir: 'agents',
    codexOutput: '.codex/agents/testing-agent.toml',
    run: (root, targets) => syncAgents([], root, targets),
  },
  {
    label: 'agent hooks',
    kind: 'hooks',
    manifest: 'agent-hooks-manifest.json',
    outputDir: 'hooks',
    codexOutput: '.codex/hooks/lint-check.sh',
    run: (root, targets) => syncHookScripts(root, { targets }),
  },
];

describe.each(legacyWriters)('$label writer compatibility preflight', (writer) => {
  it.each([
    ['invalid manifest', '{', ['claude'], /valid JSON/],
    [
      'path-like target',
      null,
      ['/../../tmp/quarantine-pwn'],
      /cannot target|Unsupported agent provider/,
    ],
    ['empty target', null, [''], /cannot target|Unsupported agent provider/],
  ])('refuses %s before mutation', (_name, manifest, targets, error) => {
    const root = tmpRepo();
    const manifestPath = join(root, '.devkit', writer.manifest);
    if (manifest !== null) {
      mkdirSync(join(root, '.devkit'), { recursive: true });
      writeFileSync(manifestPath, manifest);
    }

    expect(() => writer.run(root, targets)).toThrow(error);
    expect(existsSync(join(root, '.claude', writer.outputDir))).toBe(false);
    expect(existsSync(join(root, '.codex', writer.outputDir))).toBe(false);
    if (manifest === null) expect(existsSync(manifestPath)).toBe(false);
    else expect(readFileSync(manifestPath, 'utf8')).toBe(manifest);
  });

  it('accepts an existing v2 manifest and republishes it after syncing', () => {
    const root = tmpRepo();
    const manifestPath = join(root, '.devkit', writer.manifest);
    mkdirSync(join(root, '.devkit'), { recursive: true });
    writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 2,
        kind: writer.kind,
        devkitRef: null,
        generatedAt: '2026-07-22T00:00:00.000Z',
        files: {},
        providers: {},
      }),
    );

    writer.run(root, ['claude']);

    expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toMatchObject({
      schemaVersion: 2,
      kind: writer.kind,
    });
    expect(existsSync(join(root, '.claude', writer.outputDir))).toBe(true);
  });

  it('writes Codex provider-native output and a v2 manifest', () => {
    const root = tmpRepo();

    writer.run(root, ['codex']);

    expect(existsSync(join(root, writer.codexOutput))).toBe(true);
    expect(JSON.parse(readFileSync(join(root, '.devkit', writer.manifest), 'utf8'))).toMatchObject({
      schemaVersion: 2,
      kind: writer.kind,
      providers: { codex: { files: expect.any(Object) } },
    });
  });
});

it('v2 teardown removes only recorded outputs and preserves an unowned file', () => {
  const root = tmpRepo();
  seedSkill(root, '# keep me\n');
  const manifestPath = join(root, '.devkit', 'skills-manifest.json');
  const manifest = JSON.stringify({
    schemaVersion: 2,
    kind: 'skills',
    devkitRef: null,
    generatedAt: '2026-07-22T00:00:00.000Z',
    files: {},
    providers: {},
  });
  mkdirSync(join(root, '.devkit'), { recursive: true });
  writeFileSync(manifestPath, manifest);

  expect(() => removeSkills(root, false, ['claude'])).not.toThrow();
  expect(readFileSync(SKILL(root), 'utf8')).toBe('# keep me\n');
  expect(existsSync(manifestPath)).toBe(false);
});

describe('install preserves a non-devkit collision by default', () => {
  it('keeps the user’s own same-named skill, omits it from the manifest, syncs the rest', async () => {
    const root = tmpRepo();
    seedSkill(root, '# mine\n');

    await applyInit(root, {
      stack: 'generic',
      selection: only({ skills: true }),
      interactive: false,
    });

    expect(readFileSync(SKILL(root), 'utf8')).toBe('# mine\n'); // untouched
    expect(ownsBrainstorming(root)).toBe(false); // not claimed in the manifest
    // an unrelated devkit skill was still synced + recorded
    expect(existsSync(join(root, '.claude', 'skills', 'commit-guard'))).toBe(true);
    expect(Object.keys(skillsManifest(root).files).length).toBeGreaterThan(0);
  });

  it('--force (force:true) overrides the collision: overwrites + records it', async () => {
    const root = tmpRepo();
    seedSkill(root, '# mine\n');

    await applyInit(root, {
      stack: 'generic',
      selection: only({ skills: true }),
      interactive: false,
      force: true,
    });

    expect(readFileSync(SKILL(root), 'utf8')).not.toBe('# mine\n'); // overwritten with devkit's
    expect(ownsBrainstorming(root)).toBe(true); // adopted into the manifest
  });

  it('preserves a non-devkit AGENT collision; --force overrides', async () => {
    const root = tmpRepo();
    const agent = join(root, '.claude', 'agents', 'testing-agent.md');
    mkdirSync(join(root, '.claude', 'agents'), { recursive: true });
    writeFileSync(agent, '# mine\n');

    await applyInit(root, {
      stack: 'generic',
      selection: only({ agents: true }),
      interactive: false,
    });
    expect(readFileSync(agent, 'utf8')).toBe('# mine\n');
    const m = JSON.parse(readFileSync(join(root, '.devkit', 'agents-manifest.json'), 'utf8'));
    expect(Object.keys(m.files)).not.toContain('testing-agent.md');

    await applyInit(root, {
      stack: 'generic',
      selection: only({ agents: true }),
      interactive: false,
      force: true,
    });
    expect(readFileSync(agent, 'utf8')).not.toBe('# mine\n');
    const m2 = JSON.parse(readFileSync(join(root, '.devkit', 'agents-manifest.json'), 'utf8'));
    expect(Object.keys(m2.files)).toContain('testing-agent.md');
  });
});

describe('install keeps overwriting devkit-owned content (version-bump propagation intact)', () => {
  it('a manifest-owned skill that drifted locally is overwritten back (NOT treated as a conflict)', async () => {
    const root = tmpRepo();
    await applyInit(root, {
      stack: 'generic',
      selection: only({ skills: true }),
      interactive: false,
    });
    expect(ownsBrainstorming(root)).toBe(true);
    const devkitBody = readFileSync(SKILL(root), 'utf8');

    writeFileSync(SKILL(root), '# locally edited\n'); // drift on a devkit-OWNED file
    await applyInit(root, {
      stack: 'generic',
      selection: only({ skills: true }),
      interactive: false,
    });

    expect(readFileSync(SKILL(root), 'utf8')).toBe(devkitBody); // restored, no prompt
  });

  it('an UNmanifested copy that byte-matches the bundle is adopted, not frozen (H2/M1)', async () => {
    const root = tmpRepo();
    await applyInit(root, {
      stack: 'generic',
      selection: only({ skills: true }),
      interactive: false,
    });
    rmSync(join(root, '.devkit', 'skills-manifest.json')); // manifest gone, copies still match bundle

    await applyInit(root, {
      stack: 'generic',
      selection: only({ skills: true }),
      interactive: false,
    });

    expect(ownsBrainstorming(root)).toBe(true); // re-synced + re-recorded, not preserved
  });
});

describe('detect*Conflicts (the interactive picker source)', () => {
  it('returns a divergent user skill, but not a byte-identical/owned one', async () => {
    const root = tmpRepo();
    seedSkill(root, '# mine\n');
    expect(detectSkillConflicts(root, ['claude'])).toContain('brainstorming');

    // after a real sync, the on-disk copy matches the bundle + is manifest-owned → no longer a conflict
    await applyInit(root, {
      stack: 'generic',
      selection: only({ skills: true }),
      interactive: false,
      force: true,
    });
    expect(detectSkillConflicts(root, ['claude'])).not.toContain('brainstorming');
  });

  it('detectAgentConflicts returns a divergent user agent', () => {
    const root = tmpRepo();
    mkdirSync(join(root, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(root, '.claude', 'agents', 'testing-agent.md'), '# mine\n');
    expect(detectAgentConflicts(root, ['claude'])).toContain('testing-agent.md');
  });
});

describe('agent-hook scripts: preserve a non-devkit collision, --force overrides', () => {
  const HOOK = (root) => join(root, '.claude', 'hooks', 'lint-check.sh');
  const seedHook = (root) => {
    mkdirSync(join(root, '.claude', 'hooks'), { recursive: true });
    writeFileSync(HOOK(root), '# mine\n');
  };

  it('detects + preserves an untracked divergent user hook script by default', () => {
    const root = tmpRepo();
    seedHook(root);
    expect(detectHookConflicts(root, ['claude'])).toContain('lint-check.sh');

    syncHookScripts(root, { targets: ['claude'] });

    expect(readFileSync(HOOK(root), 'utf8')).toBe('# mine\n'); // untouched
    const m = JSON.parse(readFileSync(join(root, '.devkit', 'agent-hooks-manifest.json'), 'utf8'));
    expect(Object.keys(m.files)).not.toContain('lint-check.sh'); // not claimed
  });

  it('--force (override → true) overwrites + records the hook collision', () => {
    const root = tmpRepo();
    seedHook(root);

    syncHookScripts(root, { targets: ['claude'], override: () => true });

    expect(readFileSync(HOOK(root), 'utf8')).not.toBe('# mine\n'); // overwritten with devkit's
    const m = JSON.parse(readFileSync(join(root, '.devkit', 'agent-hooks-manifest.json'), 'utf8'));
    expect(Object.keys(m.files)).toContain('lint-check.sh'); // adopted
  });
});

describe('clean fallback never deletes a preserved user asset (C1)', () => {
  it('overlay clean removes a drifted asset that its legacy manifest still owns', () => {
    const root = tmpRepo();
    seedSkill(root, '# drifted after install\n');
    const manifest = join(root, '.devkit', 'skills-manifest.json');
    mkdirSync(join(root, '.devkit'), { recursive: true });
    writeFileSync(
      manifest,
      JSON.stringify({
        files: { 'brainstorming/SKILL.md': '0'.repeat(64) },
        targets: ['claude'],
      }),
    );

    removeSkills(root, false, ['claude'], true, () => false);

    expect(existsSync(join(root, '.claude', 'skills', 'brainstorming'))).toBe(false);
    expect(existsSync(manifest)).toBe(false);
  });

  it('keeps an untracked divergent user skill when the manifest is absent', () => {
    const root = tmpRepo();
    initGit(root);
    seedSkill(root, '# mine\n'); // user's own, never manifested

    removeSkills(root, false, ['claude']); // no manifest → bundled-name fallback

    expect(existsSync(SKILL(root))).toBe(true); // kept — diverges from the bundle
  });

  it('still removes a devkit stray (matches the bundle) when the manifest is absent', async () => {
    const root = tmpRepo();
    initGit(root);
    await applyInit(root, {
      stack: 'generic',
      selection: only({ skills: true }),
      interactive: false,
    });
    rmSync(join(root, '.devkit'), { recursive: true, force: true }); // manifest gone

    removeSkills(root, false, ['claude']);

    expect(existsSync(join(root, '.claude', 'skills', 'brainstorming'))).toBe(false); // stray removed
  });
});

describe('edge cases', () => {
  const NOTES = (root) => join(root, '.claude', 'skills', 'brainstorming', 'user-notes.md');

  it('a devkit skill dir with an EXTRA user file is treated as the user’s (preserve + detect)', async () => {
    const root = tmpRepo();
    // sync devkit's brainstorming verbatim (+ manifest), THEN the user drops a file inside it and the
    // manifest is lost — devkit's own files still byte-match the bundle, only the extra file diverges.
    await applyInit(root, {
      stack: 'generic',
      selection: only({ skills: true }),
      interactive: false,
    });
    writeFileSync(NOTES(root), '# my notes\n');
    rmSync(join(root, '.devkit', 'skills-manifest.json'));

    // the tree-compare must catch the EXTRA child (not just differing bytes) → flagged as the user's
    expect(detectSkillConflicts(root, ['claude'])).toContain('brainstorming');

    await applyInit(root, {
      stack: 'generic',
      selection: only({ skills: true }),
      interactive: false,
    });
    expect(existsSync(NOTES(root))).toBe(true); // the user's added file is preserved
    expect(ownsBrainstorming(root)).toBe(false); // not re-claimed into the manifest
  });

  it('is idempotent across re-runs when a collision is preserved (no manifest churn)', async () => {
    const root = tmpRepo();
    seedSkill(root, '# mine\n');
    await applyInit(root, {
      stack: 'generic',
      selection: only({ skills: true }),
      interactive: false,
    });
    const man1 = readFileSync(join(root, '.devkit', 'skills-manifest.json'), 'utf8');

    await applyInit(root, {
      stack: 'generic',
      selection: only({ skills: true }),
      interactive: false,
    });
    const man2 = readFileSync(join(root, '.devkit', 'skills-manifest.json'), 'utf8');

    expect(man2).toBe(man1); // byte-identical → stable generatedAt, no spurious diff
    expect(readFileSync(SKILL(root), 'utf8')).toBe('# mine\n'); // still preserved
  });

  it('a one-surface collision is preserved on BOTH surfaces; --force adopts to BOTH', async () => {
    const both = () => only({ skills: true, agentTargets: ['claude', 'cursor'] });
    const root = tmpRepo();
    seedSkill(root, '# mine\n'); // .claude only; .cursor has nothing

    await applyInit(root, { stack: 'generic', selection: both(), interactive: false });
    expect(readFileSync(SKILL(root), 'utf8')).toBe('# mine\n'); // claude preserved
    // whole-name unit: the collided name is withheld from the OTHER surface too (not split-brained)
    expect(existsSync(join(root, '.cursor', 'skills', 'brainstorming'))).toBe(false);

    await applyInit(root, { stack: 'generic', selection: both(), interactive: false, force: true });
    expect(readFileSync(SKILL(root), 'utf8')).not.toBe('# mine\n'); // claude adopted
    expect(existsSync(join(root, '.cursor', 'skills', 'brainstorming', 'SKILL.md'))).toBe(true); // cursor now gets it
  });

  it('clean fallback keeps a devkit-named dir the user added a file to (manifest absent)', async () => {
    const root = tmpRepo();
    initGit(root);
    await applyInit(root, {
      stack: 'generic',
      selection: only({ skills: true }),
      interactive: false,
    });
    writeFileSync(NOTES(root), '# mine\n'); // user customised devkit's dir
    rmSync(join(root, '.devkit'), { recursive: true, force: true }); // manifest gone

    removeSkills(root, false, ['claude']);

    expect(existsSync(join(root, '.claude', 'skills', 'brainstorming'))).toBe(true); // kept (diverges via extra file)
    expect(existsSync(NOTES(root))).toBe(true);
  });

  it('ownership is surface-aware: a name owned on .claude does NOT mask a divergent .cursor asset (C2)', async () => {
    const root = tmpRepo();
    const cursorSkill = join(root, '.cursor', 'skills', 'brainstorming', 'SKILL.md');
    // 1) devkit syncs to .claude only → manifest records targets ['claude'] + owns "brainstorming".
    await applyInit(root, {
      stack: 'generic',
      selection: only({ skills: true }),
      interactive: false,
    });
    expect(
      JSON.parse(readFileSync(join(root, '.devkit', 'skills-manifest.json'), 'utf8')).targets,
    ).toEqual(['claude']);

    // 2) the consumer later authors their OWN brainstorming on the .cursor surface.
    mkdirSync(join(root, '.cursor', 'skills', 'brainstorming'), { recursive: true });
    writeFileSync(cursorSkill, '# mine on cursor\n');
    // it's correctly flagged as the user's — NOT masked by the .claude manifest entry
    expect(detectSkillConflicts(root, ['cursor'])).toContain('brainstorming');

    // 3) re-run with BOTH surfaces → the .cursor asset must be preserved, not clobbered.
    await applyInit(root, {
      stack: 'generic',
      selection: only({ skills: true, agentTargets: ['claude', 'cursor'] }),
      interactive: false,
    });
    expect(readFileSync(cursorSkill, 'utf8')).toBe('# mine on cursor\n');
  });
});

describe('matchesBundle treats a symlink as a mismatch (C3)', () => {
  it('does not follow a file symlink into sha256 (a symlinked asset is never bundle-owned)', () => {
    const root = tmpRepo();
    // a fake bundle dir with one file + an on-disk copy that is a SYMLINK to byte-identical content
    const src = join(root, 'bundle');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'x.sh'), 'echo hi\n');
    mkdirSync(join(root, '.claude', 'hooks'), { recursive: true });
    writeFileSync(join(root, 'real-x.sh'), 'echo hi\n'); // identical bytes
    symlinkSync(join(root, 'real-x.sh'), join(root, '.claude', 'hooks', 'x.sh'));

    // byte-identical via the link, but a symlink is NOT a bundle-owned regular file → mismatch
    expect(matchesBundle(root, '.claude/hooks', 'x.sh', src)).toBe(false);
  });
});
