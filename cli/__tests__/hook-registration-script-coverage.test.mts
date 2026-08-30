/**
 * Every hook COMMAND devkit registers must resolve to a hook SCRIPT devkit installs.
 *
 * Forward direction only, deliberately: a bundled script with NO registration is legitimate —
 * session-edits-lib.sh is a shared library the agentHooks scripts source. Asserting the reverse
 * would fail on it.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runSelfHostDoctor } from '../lib/doctor/self-host-doctor.mts';
import { agentAssetDir } from '../lib/install/agent-assets/agent-assets.mts';
import { SUPPORTED_AGENT_PROVIDERS } from '../lib/install/agent-assets/agent-providers.mts';
import { hookRegistrationDestination } from '../lib/install/hook-registration-ledger/codec.mts';
import { HOOK_REGISTRATIONS } from '../lib/install/hook-registration-ledger/registrations.mts';
import {
  DECISION_EDIT_HOOK,
  DECISION_SCOPE_BRIEF_HOOK,
  hookScriptsFor,
} from '../lib/install/hook-registration-ledger/selection.mts';
import { readConfig, tmpRepos } from './_helpers.mts';

/** Components that contribute hook SCRIPTS, keyed by their hookScriptsFor flag. */
const SCRIPT_OWNING_COMPONENTS = [
  'agentHooks',
  'decisions',
  'fallow',
  'adhd',
  'priorArtGate',
] as const;

/** A selection with exactly ONE component on — notably agentHooks OFF for every other component. */
const only = (component: string) => ({
  agentHooks: component === 'agentHooks',
  decisions: component === 'decisions',
  fallow: component === 'fallow',
  adhd: component === 'adhd',
  priorArtGate: component === 'priorArtGate',
});

/** The hook-dir script a registration command invokes, or null for an engine-bin command. */
const scriptOf = (command: string) =>
  /\$CLAUDE_PROJECT_DIR\/?"?\/?\.claude\/hooks\/([\w.-]+)/.exec(command)?.[1] ?? null;

describe('hook registrations resolve to installable scripts', () => {
  for (const component of SCRIPT_OWNING_COMPONENTS) {
    it(`installs every script the ${component} component registers`, () => {
      const scripts = hookScriptsFor(only(component));
      const registered = (HOOK_REGISTRATIONS[component] ?? [])
        .map((registration) => scriptOf(registration.command))
        .filter((name): name is string => name !== null);
      expect(registered.length).toBeGreaterThan(0);
      for (const name of registered) expect(scripts).toContain(name);
    });
  }

  it('leaves no registration unowned once every script-owning component is selected', () => {
    const scripts = hookScriptsFor({
      agentHooks: true,
      decisions: true,
      fallow: true,
      adhd: true,
      priorArtGate: true,
    });
    const dangling = Object.values(HOOK_REGISTRATIONS)
      .flat()
      .map((registration) => scriptOf(registration.command))
      .filter((name): name is string => name !== null && !scripts.includes(name));
    expect(dangling).toEqual([]);
  });

  it('binds both decisions scripts to the guard, not to the agentHooks bundle', () => {
    const base = { agentHooks: false, fallow: false, adhd: false, priorArtGate: false };
    const owned = [DECISION_EDIT_HOOK, DECISION_SCOPE_BRIEF_HOOK];
    // Selecting the guard is sufficient — the brief must not need the agent-hook bundle.
    expect(hookScriptsFor({ ...base, decisions: true }).sort()).toEqual([...owned].sort());
    // …and the bundle alone must not drag in a script only the guard registers, or `desired`
    // reconciliation would install a hook no registration ever invokes.
    for (const hook of owned)
      expect(hookScriptsFor({ ...base, agentHooks: true, decisions: false })).not.toContain(hook);
  });
});

const { tmpRepo, devkit, cleanup } = tmpRepos('hook-coverage-');
afterEach(cleanup);

/** Every `<provider>/hooks/<script>` path a provider's own hook config names. */
function referencedScripts(root: string, provider: string): string[] {
  const config = join(root, hookRegistrationDestination(provider, 'shared'));
  if (!existsSync(config)) return [];
  const dir = agentAssetDir(provider, 'hooks');
  const pattern = new RegExp(`${dir.replace('.', '\\.')}/([\\w.-]+)`, 'g');
  return [...readFileSync(config, 'utf8').matchAll(pattern)].map((match) => match[1]);
}

/** The slice of `.devkit/agent-hooks-manifest.json` these fixtures rewrite. */
interface HookManifest {
  files: Record<string, string>;
  providers?: Record<string, { files: Record<string, string> }>;
}

/** Strip a hook script from disk AND from the manifest — the shape a 0.58.0 upgrade produced. */
function breakInstalledHook(root: string, script: string): void {
  for (const provider of SUPPORTED_AGENT_PROVIDERS)
    rmSync(join(root, agentAssetDir(provider, 'hooks'), script), { force: true });
  const manifestPath = join(root, '.devkit/agent-hooks-manifest.json');
  const manifest: HookManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  delete manifest.files[script];
  for (const projection of Object.values(manifest.providers ?? {})) delete projection.files[script];
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

describe('a default init leaves no dangling hook registration', () => {
  it('installs every script the written registrations name, on every provider', () => {
    const root = tmpRepo();
    expect(devkit(root, 'init', '--stack', 'generic', '--yes').status).toBe(0);

    let checked = 0;
    for (const provider of SUPPORTED_AGENT_PROVIDERS) {
      for (const script of referencedScripts(root, provider)) {
        checked += 1;
        expect(
          existsSync(join(root, agentAssetDir(provider, 'hooks'), script)),
          `${provider} registers ${script} but does not install it`,
        ).toBe(true);
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('reinstalls a hook script a prior version registered but never installed', () => {
    const root = tmpRepo();
    expect(devkit(root, 'init', '--stack', 'generic', '--yes').status).toBe(0);
    breakInstalledHook(root, 'decision-scope-brief.mjs');
    expect(existsSync(join(root, '.claude/hooks/decision-scope-brief.mjs'))).toBe(false);

    expect(devkit(root, 'init', '--stack', 'generic', '--yes').status).toBe(0);

    expect(existsSync(join(root, '.claude/hooks/decision-scope-brief.mjs'))).toBe(true);
    const manifest = JSON.parse(
      readFileSync(join(root, '.devkit/agent-hooks-manifest.json'), 'utf8'),
    );
    expect(Object.keys(manifest.files)).toContain('decision-scope-brief.mjs');
  });

  it('refuses to install either decisions script on a repo without the guard', () => {
    const root = tmpRepo();
    expect(devkit(root, 'init', '--stack', 'generic', '--yes').status).toBe(0);
    const configPath = join(root, '.devkit/config.json');
    const config = readConfig(root);
    config.components.guards = config.components.guards.filter(
      (guard: string) => guard !== 'decisions',
    );
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    const result = devkit(
      root,
      'sync-hooks',
      '--only',
      `${DECISION_EDIT_HOOK},${DECISION_SCOPE_BRIEF_HOOK}`,
    );

    expect(result.status).toBe(1);
    // Both are named: reporting only the first would send the reader round the loop twice.
    expect(result.stderr).toContain(DECISION_EDIT_HOOK);
    expect(result.stderr).toContain(DECISION_SCOPE_BRIEF_HOOK);
  });
});

describe('self-host doctor sees the agent-hook half', () => {
  /** Run the dogfood doctor in-process, capturing its advisory lines. */
  const selfHostDoctor = async (root: string) => {
    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.join(' '));
    });
    try {
      // Drop the committed hook so the generator comparison short-circuits: rebuilding the
      // self-host block needs devkit's own package.json bin map, which no fixture can stand in for.
      rmSync(join(root, '.husky/pre-commit'), { force: true });
      const code = await runSelfHostDoctor(root, readConfig(root), false);
      return { code, output: lines.join('\n') };
    } finally {
      log.mockRestore();
    }
  };

  it('reports a missing hook script without changing the exit code', async () => {
    const root = tmpRepo();
    expect(devkit(root, 'init', '--stack', 'generic', '--yes').status).toBe(0);

    const healthy = await selfHostDoctor(root);
    expect(healthy.output).toMatch(/agent-hooks:.*in sync/);
    expect(healthy.output).toContain('hook registrations:');

    rmSync(join(root, '.claude/hooks', DECISION_SCOPE_BRIEF_HOOK));
    const drifted = await selfHostDoctor(root);

    expect(drifted.output).toContain('drifted/absent');
    // Advisory: the dogfood verdict stays gated on hook + runner, exactly as the skills/agents
    // lines above it are. A hook script that vanished must be VISIBLE, not suddenly fatal.
    expect(drifted.code).toBe(healthy.code);
  });
});
