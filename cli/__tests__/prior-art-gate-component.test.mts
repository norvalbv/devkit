/**
 * The `priorArtGate` component: the deny-once step-0 ordering hook (agents-hooks/prior-art-gate.mjs)
 * is opt-in, ships via the ordinary hook sync + registration ledger, and is removed by deselection.
 *
 * Two load-bearing properties. It stays OFF unless asked for — it denies harness tool calls, so an
 * unrequested install is a real defect, and `--yes` installs every recommended component, which makes
 * that exactly the case worth pinning. And it never projects to Cursor — the registrations carry no
 * cursorEvent because Cursor has no prior-art subagent to satisfy the gate.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
const LEDGER = '.devkit/agent-hook-registrations-manifest.json';
const HOOK_DOCS = ['.claude/settings.json', '.codex/hooks.json'];
const PRE_EDIT_COMMAND = `${PRIOR_ART_GATE_HOOK}" edit`;
const PRE_BASH_COMMAND = `${PRIOR_ART_GATE_HOOK}" bash`;
/** Registrations added after the gate first shipped, keyed by the command suffix they install. */
const ADDED = {
  'prior-art-gate:pre-edit': PRE_EDIT_COMMAND,
  'prior-art-gate:pre-bash': PRE_BASH_COMMAND,
};

type HookGroup = { matcher?: string; hooks: { command: string }[] };

/** Rewind an install to the registry before pre-edit and pre-bash existed: handlers and rows go. */
function stripAdded(root: string): void {
  const added = Object.values(ADDED);
  for (const rel of HOOK_DOCS) {
    const doc = readJson(root, rel);
    doc.hooks.PreToolUse = doc.hooks.PreToolUse.map((group: HookGroup) => ({
      ...group,
      hooks: group.hooks.filter((hook) => !added.some((cmd) => hook.command.endsWith(cmd))),
    }));
    writeFileSync(join(root, rel), `${JSON.stringify(doc, null, 2)}\n`);
  }
  const ledger = readJson(root, LEDGER);
  ledger.entries = ledger.entries.filter(
    (entry: { registrationId: string }) => !Object.hasOwn(ADDED, entry.registrationId),
  );
  writeFileSync(join(root, LEDGER), `${JSON.stringify(ledger, null, 2)}\n`);
}

const installed = (root: string, rel: string, command: string) =>
  readJson(root, rel).hooks.PreToolUse.some((group: HookGroup) =>
    group.hooks.some((hook) => hook.command.endsWith(command)),
  );

/** Per added registration: which hook documents carry it, and which providers the ledger owns. */
const addedState = (root: string) =>
  Object.entries(ADDED).map(([id, command]) => ({
    id,
    docs: HOOK_DOCS.map((rel) => installed(root, rel, command)),
    ledger: readJson(root, LEDGER)
      .entries.filter((e: { registrationId: string }) => e.registrationId === id)
      .map((e: { provider: string }) => e.provider)
      .sort(),
  }));

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
      flat('PreToolUse').some(
        (entry: string) =>
          entry.startsWith('Edit|Write|MultiEdit::') && entry.endsWith(PRE_EDIT_COMMAND),
      ),
    ).toBe(true);
    expect(
      flat('PreToolUse').some(
        (entry: string) => entry.startsWith('Bash::') && entry.endsWith(PRE_BASH_COMMAND),
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
    expect(ledger).toContain('prior-art-gate:pre-edit');
    expect(ledger).toContain('prior-art-gate:pre-bash');
    expect(ledger).toContain('prior-art-gate:post-task');
  });

  it('an install from before pre-edit and pre-bash gains them on re-run, idempotently', () => {
    const root = tmpRepo();
    const init = () => devkit(root, 'init', '--stack', 'generic', '--yes', '--prior-art-gate');
    expect(init().status).toBe(0);
    stripAdded(root);
    // Absent everywhere, so the re-run must take the add path rather than adopting a leftover.
    expect(addedState(root).map(({ docs, ledger }) => [docs, ledger])).toEqual([
      [[false, false], []],
      [[false, false], []],
    ]);

    expect(init().status).toBe(0);
    // pre-bash is Claude-only: Codex reports shell as Bash but cannot record a prior-art run.
    expect(addedState(root)).toEqual([
      { id: 'prior-art-gate:pre-edit', docs: [true, true], ledger: ['claude', 'codex'] },
      { id: 'prior-art-gate:pre-bash', docs: [true, false], ledger: ['claude'] },
    ]);
    const snapshot = () =>
      [...HOOK_DOCS, LEDGER].map((rel) => readFileSync(join(root, rel), 'utf8'));
    const before = snapshot();
    expect(init().status).toBe(0);
    expect(snapshot()).toEqual(before);
  });

  it('--prior-art-gate with --no-claude deselects the gate with a notice (Claude-only hooks)', () => {
    const root = tmpRepo();
    const run = devkit(
      root,
      'init',
      '--stack',
      'generic',
      '--yes',
      '--prior-art-gate',
      '--no-claude',
    );
    expect(run.status).toBe(0);
    expect(`${run.stdout}${run.stderr}`).toContain('prior-art gate skipped');
    expect(existsSync(hookPath(root))).toBe(false);
    expect(readJson(root, '.devkit/config.json').components.priorArtGate).toBe(false);
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
