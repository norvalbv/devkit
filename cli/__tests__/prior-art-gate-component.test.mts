/**
 * The `priorArtGate` component: the deny-once step-0 ordering hook (agents-hooks/prior-art-gate.mjs)
 * is opt-in, ships via the ordinary hook sync + registration ledger, and is removed by deselection.
 *
 * Two load-bearing properties. It stays OFF unless asked for — it denies harness tool calls, so an
 * unrequested install is a real defect, and `--yes` installs every recommended component, which makes
 * that exactly the case worth pinning. And it never projects to Cursor — the registrations carry no
 * cursorEvent because Cursor has no ExitPlanMode/Task.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultSelection } from '../lib/components.mts';
import {
  hookScriptsFor,
  PRIOR_ART_GATE_HOOK,
} from '../lib/install/hook-registration-ledger/selection.mts';
import { tmpRepos } from './_helpers.mts';

const { tmpRepo, devkit, cleanup } = tmpRepos('prior-art-gate-');

const hookPath = (root: string, surface = 'claude') =>
  join(root, `.${surface}`, 'hooks', PRIOR_ART_GATE_HOOK);
const readJson = (root: string, rel: string) => JSON.parse(readFileSync(join(root, rel), 'utf8'));
const claudeHookCommands = (root: string) =>
  JSON.stringify(readJson(root, '.claude/settings.json').hooks ?? {});

afterEach(cleanup);

describe('hookScriptsFor ownership', () => {
  const base = { agentHooks: false, decisions: false, fallow: false, adhd: false };

  it('owns its script independently of the agentHooks bundle', () => {
    expect(hookScriptsFor({ ...base, agentHooks: true, priorArtGate: false })).not.toContain(
      PRIOR_ART_GATE_HOOK,
    );
    expect(hookScriptsFor({ ...base, priorArtGate: true })).toEqual([PRIOR_ART_GATE_HOOK]);
  });

  it('is off in the --yes / non-TTY default selection', () => {
    expect(defaultSelection().priorArtGate).toBe(false);
  });
});

describe('devkit init --prior-art-gate', () => {
  it('is absent from a plain --yes install, and records the decision', () => {
    const root = tmpRepo();
    expect(devkit(root, 'init', '--stack', 'generic', '--yes').status).toBe(0);
    expect(existsSync(hookPath(root))).toBe(false);
    expect(claudeHookCommands(root)).not.toContain(PRIOR_ART_GATE_HOOK);
    // Recorded as false, not omitted — that is what stops `devkit upgrade` re-offering it.
    expect(readJson(root, '.devkit/config.json').components.priorArtGate).toBe(false);
  });

  it('--prior-art-gate installs the script and both registrations, Claude-only', () => {
    const root = tmpRepo();
    expect(devkit(root, 'init', '--stack', 'generic', '--yes', '--prior-art-gate').status).toBe(0);
    expect(existsSync(hookPath(root))).toBe(true);
    expect(readJson(root, '.devkit/config.json').components.priorArtGate).toBe(true);

    const hooks = readJson(root, '.claude/settings.json').hooks;
    const flat = (event: string) =>
      (hooks[event] ?? []).flatMap((m: { matcher?: string; hooks: { command: string }[] }) =>
        m.hooks.map((h) => `${m.matcher ?? ''}::${h.command}`),
      );
    expect(
      flat('PreToolUse').some(
        (entry: string) =>
          entry.startsWith('ExitPlanMode|Task|Agent::') && entry.includes(PRIOR_ART_GATE_HOOK),
      ),
    ).toBe(true);
    expect(
      flat('PostToolUse').some(
        (entry: string) => entry.startsWith('Task|Agent::') && entry.includes(PRIOR_ART_GATE_HOOK),
      ),
    ).toBe(true);

    // No Cursor projection: the registrations carry no cursorEvent.
    const cursorHooks = join(root, '.cursor', 'hooks.json');
    if (existsSync(cursorHooks))
      expect(readFileSync(cursorHooks, 'utf8')).not.toContain(PRIOR_ART_GATE_HOOK);

    // The ledger records both registrations for clean removal.
    const ledger = readFileSync(
      join(root, '.devkit', 'agent-hook-registrations-manifest.json'),
      'utf8',
    );
    expect(ledger).toContain('prior-art-gate:pre-plan');
    expect(ledger).toContain('prior-art-gate:post-task');
  });

  it('--no-prior-art-gate keeps it off even when --prior-art-gate is also passed', () => {
    const root = tmpRepo();
    devkit(root, 'init', '--stack', 'generic', '--yes', '--prior-art-gate', '--no-prior-art-gate');
    expect(existsSync(hookPath(root))).toBe(false);
    expect(readJson(root, '.devkit/config.json').components.priorArtGate).toBe(false);
  });

  it('removes the script and registrations when the component is later deselected', () => {
    const root = tmpRepo();
    devkit(root, 'init', '--stack', 'generic', '--yes', '--prior-art-gate');
    expect(existsSync(hookPath(root))).toBe(true);

    devkit(root, 'init', '--stack', 'generic', '--yes', '--no-prior-art-gate');
    expect(existsSync(hookPath(root))).toBe(false);
    expect(claudeHookCommands(root)).not.toContain(PRIOR_ART_GATE_HOOK);
    expect(readJson(root, '.devkit/config.json').components.priorArtGate).toBe(false);
  });
});
