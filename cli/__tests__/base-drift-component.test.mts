/**
 * The `baseDrift` component: the two base-drift advisories (agents-hooks/base-drift-session.mjs and
 * base-drift-brief.mjs) plus the lib they import are opt-in, ship via the ordinary hook sync +
 * registration ledger, and are removed by deselection.
 *
 * Three load-bearing properties. It stays OFF unless asked for — it is the first devkit pre-edit
 * surface that reaches the NETWORK, so an unrequested install is a real defect and `--yes` (which
 * installs every recommended component) is exactly the case worth pinning. Its shared lib must be
 * owned by this component and not by the agentHooks catch-all, or deselecting agent hooks would
 * prune a file two selected hooks import. And only the pre-edit half projects to Cursor: Cursor has
 * no SessionStart, so nativeProjection skips that registration.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultSelection } from '../lib/components.mts';
import {
  BASE_DRIFT_BRIEF_HOOK,
  BASE_DRIFT_LIB,
  BASE_DRIFT_SESSION_HOOK,
  hookScriptsFor,
} from '../lib/install/hook-registration-ledger/selection.mts';
import { tmpRepos } from './_helpers.mts';

const { tmpRepo, devkit, cleanup } = tmpRepos('base-drift-');

const OWNED = [BASE_DRIFT_SESSION_HOOK, BASE_DRIFT_BRIEF_HOOK, BASE_DRIFT_LIB];
const hookPath = (root: string, name: string, surface = 'claude') =>
  join(root, `.${surface}`, 'hooks', name);
const readJson = (root: string, rel: string) => JSON.parse(readFileSync(join(root, rel), 'utf8'));
const claudeHookCommands = (root: string) =>
  JSON.stringify(readJson(root, '.claude/settings.json').hooks ?? {});

afterEach(cleanup);

describe('hookScriptsFor ownership', () => {
  const base = {
    agentHooks: false,
    decisions: false,
    fallow: false,
    adhd: false,
    priorArtGate: false,
  };

  it('owns all three scripts independently of the agentHooks bundle', () => {
    // The bundle must not drag them in…
    const bundleOnly = hookScriptsFor({ ...base, agentHooks: true, baseDrift: false });
    for (const name of OWNED) expect(bundleOnly).not.toContain(name);
    // …and selecting the component alone must be sufficient for every one of them.
    expect(hookScriptsFor({ ...base, baseDrift: true }).sort()).toEqual([...OWNED].sort());
  });

  it('keeps the shared lib when agent hooks are deselected but base-drift is on', () => {
    // The lib is invoked by no registration, so the catch-all would otherwise own it — and pruning
    // it would leave two installed hooks importing a file that is gone.
    expect(hookScriptsFor({ ...base, agentHooks: false, baseDrift: true })).toContain(
      BASE_DRIFT_LIB,
    );
  });

  it('is off in the --yes / non-TTY default selection', () => {
    expect(defaultSelection().baseDrift).toBe(false);
  });
});

describe('devkit init --base-drift', () => {
  it('is absent from a plain --yes install, and records the decision', () => {
    const root = tmpRepo();
    expect(devkit(root, 'init', '--stack', 'generic', '--yes').status).toBe(0);
    for (const name of OWNED) expect(existsSync(hookPath(root, name))).toBe(false);
    expect(claudeHookCommands(root)).not.toContain(BASE_DRIFT_BRIEF_HOOK);
    // Recorded as false, not omitted — that is what stops `devkit upgrade` re-offering it.
    expect(readJson(root, '.devkit/config.json').components.baseDrift).toBe(false);
  });

  it('--base-drift installs all three scripts and both registrations', () => {
    const root = tmpRepo();
    expect(devkit(root, 'init', '--stack', 'generic', '--yes', '--base-drift').status).toBe(0);
    for (const name of OWNED) expect(existsSync(hookPath(root, name))).toBe(true);
    expect(readJson(root, '.devkit/config.json').components.baseDrift).toBe(true);

    const hooks = readJson(root, '.claude/settings.json').hooks;
    const flat = (event: string) =>
      (hooks[event] ?? []).flatMap((m: { matcher?: string; hooks: { command: string }[] }) =>
        m.hooks.map((h) => `${m.matcher ?? ''}::${h.command}`),
      );
    expect(
      flat('SessionStart').some(
        (entry: string) =>
          entry.startsWith('startup|resume|clear|compact::') &&
          entry.includes(BASE_DRIFT_SESSION_HOOK),
      ),
    ).toBe(true);
    expect(
      flat('PreToolUse').some(
        (entry: string) =>
          entry.startsWith('Edit|Write|MultiEdit::') && entry.includes(BASE_DRIFT_BRIEF_HOOK),
      ),
    ).toBe(true);

    const ledger = readFileSync(
      join(root, '.devkit', 'agent-hook-registrations-manifest.json'),
      'utf8',
    );
    expect(ledger).toContain('base-drift:session-start');
    expect(ledger).toContain('base-drift:pre-edit');
  });

  it('projects only the pre-edit half to Cursor, which has no SessionStart', () => {
    const root = tmpRepo();
    devkit(root, 'init', '--stack', 'generic', '--yes', '--base-drift');
    const cursorHooks = join(root, '.cursor', 'hooks.json');
    if (!existsSync(cursorHooks)) return;
    const raw = readFileSync(cursorHooks, 'utf8');
    expect(raw).toContain(BASE_DRIFT_BRIEF_HOOK);
    expect(raw).not.toContain(BASE_DRIFT_SESSION_HOOK);
  });

  it('--no-base-drift keeps it off even when --base-drift is also passed', () => {
    const root = tmpRepo();
    devkit(root, 'init', '--stack', 'generic', '--yes', '--base-drift', '--no-base-drift');
    for (const name of OWNED) expect(existsSync(hookPath(root, name))).toBe(false);
    expect(readJson(root, '.devkit/config.json').components.baseDrift).toBe(false);
  });

  it('removes the scripts and registrations when the component is later deselected', () => {
    const root = tmpRepo();
    devkit(root, 'init', '--stack', 'generic', '--yes', '--base-drift');
    expect(existsSync(hookPath(root, BASE_DRIFT_BRIEF_HOOK))).toBe(true);

    devkit(root, 'init', '--stack', 'generic', '--yes', '--no-base-drift');
    for (const name of OWNED) expect(existsSync(hookPath(root, name))).toBe(false);
    expect(claudeHookCommands(root)).not.toContain(BASE_DRIFT_BRIEF_HOOK);
    expect(readJson(root, '.devkit/config.json').components.baseDrift).toBe(false);
  });
});
