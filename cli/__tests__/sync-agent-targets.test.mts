import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import syncAgents from '../commands/sync/sync-agents.mts';
import syncHooks from '../commands/sync/sync-hooks.mts';
import syncSkills from '../commands/sync/sync-skills.mts';
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
      JSON.stringify({ components: { agentTargets: ['claude'] } }),
    );

    expect(run([], pkg)).toBe(0);
    expect(existsSync(join(root, present))).toBe(true);
    for (const rel of absent) expect(existsSync(join(root, rel))).toBe(false);
  });
});
