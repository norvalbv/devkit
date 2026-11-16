import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import syncAgents from '../commands/sync/sync-agents.mts';
import syncHooks from '../commands/sync/sync-hooks.mts';
import syncSkills from '../commands/sync/sync-skills.mts';
import type { Selection } from '../lib/components.mts';
import { readAgentAssetManifest } from '../lib/install/agent-asset-manifest/reader.mts';
import { rootRegistry } from './_helpers.mts';

const { mkTmp, cleanup } = rootRegistry();
afterEach(cleanup);

const cases = [
  {
    label: 'skills',
    run: syncSkills,
    present: '.claude/skills/brainstorming/SKILL.md',
    absent: ['.agents/skills', '.cursor/skills'],
  },
  {
    label: 'agents',
    run: syncAgents,
    present: '.claude/agents/feature-critique.md',
    absent: ['.codex/agents', '.cursor/agents'],
  },
  {
    label: 'hooks',
    run: syncHooks,
    present: '.claude/hooks/decision-stop-check.sh',
    absent: ['.codex/hooks', '.cursor/hooks'],
  },
];

describe.each(cases)('sync-$label monorepo targets', ({ run, present, absent }) => {
  it('reads package-local config while writing repo-wide assets', () => {
    const root = mkTmp('sync-targets-');
    execFileSync('git', ['init', '-q'], { cwd: root });
    const pkg = join(root, 'packages', 'app');
    mkdirSync(join(pkg, '.devkit'), { recursive: true });
    writeFileSync(
      join(pkg, '.devkit', 'config.json'),
      JSON.stringify({ components: { agentTargets: ['claude'], agentHooks: true } }),
    );

    expect(run([], pkg)).toBe(0);
    expect(existsSync(join(root, present))).toBe(true);
    for (const rel of absent) expect(existsSync(join(root, rel))).toBe(false);
  });
});

const ADHD = ['adhd-session-start.mjs', 'adhd-prompt-anchor.mjs'];
const BUNDLE = ['lint-check.sh', 'decision-stop-check.sh'];
const manifestPath = (root: string) => join(root, '.devkit', 'agent-hooks-manifest.json');
const ownedHooks = (root: string) =>
  Object.keys(readAgentAssetManifest(manifestPath(root), 'hooks')?.manifest.files ?? {});

function writeHookConfig(root: string, targets: string[], components: Partial<Selection>): void {
  mkdirSync(join(root, '.devkit'), { recursive: true });
  writeFileSync(
    join(root, '.devkit', 'config.json'),
    JSON.stringify({ components: { agentTargets: targets, ...components } }),
  );
}

function hookRepo(targets: string[]): string {
  const root = mkTmp('sync-hooks-selection-');
  execFileSync('git', ['init', '-q'], { cwd: root });
  for (const target of targets) mkdirSync(join(root, `.${target}`), { recursive: true });
  return root;
}

// claude alone takes the legacy manifest writer; codex forces the provider-native lifecycle.
describe.each([
  { lifecycle: 'legacy', targets: ['claude'] },
  { lifecycle: 'provider-native', targets: ['claude', 'codex'] },
])('sync-hooks installs only the recorded selection ($lifecycle)', ({ targets }) => {
  const hooks = (root: string, name: string) =>
    targets.map((target) => join(root, `.${target}`, 'hooks', name));

  const expectOnlyAdhd = (root: string) => {
    for (const path of ADHD.flatMap((name) => hooks(root, name)))
      expect(existsSync(path)).toBe(true);
    for (const path of BUNDLE.flatMap((name) => hooks(root, name)))
      expect(existsSync(path)).toBe(false);
  };

  it('leaves the agentHooks bundle out when agentHooks is not selected', () => {
    const root = hookRepo(targets);
    writeHookConfig(root, targets, { agentHooks: false, adhd: true });

    expect(syncHooks([], root)).toBe(0);

    expectOnlyAdhd(root);
    expect(ownedHooks(root).sort()).toEqual([...ADHD].sort());
  });

  it('prunes a bundle an earlier full sync installed once agentHooks is deselected', () => {
    const root = hookRepo(targets);
    writeHookConfig(root, targets, { agentHooks: true, adhd: true });
    expect(syncHooks([], root)).toBe(0);

    writeHookConfig(root, targets, { agentHooks: false, adhd: true });
    expect(syncHooks([], root)).toBe(0);

    expectOnlyAdhd(root);
    expect(ownedHooks(root).sort()).toEqual([...ADHD].sort());
  });
});

it('sync-hooks keeps a deselected hook script the user edited (legacy manifest)', () => {
  const root = hookRepo(['claude']);
  writeHookConfig(root, ['claude'], { agentHooks: true });
  expect(syncHooks([], root)).toBe(0);
  const edited = join(root, '.claude', 'hooks', 'knip-check.sh');
  appendFileSync(edited, '# local edit\n');

  writeHookConfig(root, ['claude'], { agentHooks: false });
  expect(syncHooks([], root)).toBe(0);

  expect(readFileSync(edited, 'utf8')).toContain('# local edit');
});

it('sync-hooks refuses to run without a recorded selection rather than prune owned hooks', () => {
  const root = hookRepo(['claude']);
  writeHookConfig(root, ['claude'], { adhd: true });
  expect(syncHooks([], root)).toBe(0);
  const pkg = join(root, 'packages', 'app');
  mkdirSync(pkg, { recursive: true });
  const manifestBefore = readFileSync(manifestPath(root), 'utf8');

  expect(syncHooks([], pkg)).toBe(1);

  for (const name of ADHD) expect(existsSync(join(root, '.claude', 'hooks', name))).toBe(true);
  expect(readFileSync(manifestPath(root), 'utf8')).toBe(manifestBefore);
});
