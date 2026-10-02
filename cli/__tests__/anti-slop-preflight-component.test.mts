/** The anti-slop preflight hook (sc-3469) is owned by the antiSlop component, not agentHooks, and is
 * installed, projected to Cursor, and removed with it. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ANTI_SLOP_PREFLIGHT_HOOK,
  hookScriptsFor,
} from '../lib/install/hook-registration-ledger/selection.mts';
import { HOOK_REGISTRATIONS } from '../lib/install/hook-registration-ledger/registrations.mts';
import { tmpRepos } from './_helpers.mts';

const { tmpRepo, devkit, cleanup } = tmpRepos('anti-slop-preflight-');
afterEach(cleanup);

const hookPath = (root: string) => join(root, '.claude', 'hooks', ANTI_SLOP_PREFLIGHT_HOOK);
const readJson = (root: string, rel: string) => JSON.parse(readFileSync(join(root, rel), 'utf8'));
const postToolUse = (root: string): string[] =>
  (readJson(root, '.claude/settings.json').hooks?.PostToolUse ?? []).flatMap(
    (m: { matcher?: string; hooks: { command: string }[] }) =>
      m.hooks.map((h) => `${m.matcher ?? ''}::${h.command}`),
  );

describe('hookScriptsFor ownership', () => {
  const base = {
    agentHooks: false,
    decisions: false,
    fallow: false,
    adhd: false,
    priorArtGate: false,
  };

  it('is owned by antiSlop, independently of the agentHooks bundle', () => {
    expect(hookScriptsFor({ ...base, agentHooks: true, antiSlop: false })).not.toContain(
      ANTI_SLOP_PREFLIGHT_HOOK,
    );
    expect(hookScriptsFor({ ...base, antiSlop: true })).toEqual([ANTI_SLOP_PREFLIGHT_HOOK]);
  });

  it('registers on the edit tools Claude uses, so the Cursor mirror maps it to afterFileEdit', () => {
    const [registration] = HOOK_REGISTRATIONS.antiSlop ?? [];
    expect(registration).toMatchObject({
      event: 'PostToolUse',
      matcher: 'Edit|Write|MultiEdit',
    });
    expect(registration?.command).toContain(ANTI_SLOP_PREFLIGHT_HOOK);
  });
});

describe('devkit init --anti-slop', () => {
  it('installs the script and its PostToolUse registration', () => {
    const root = tmpRepo();
    expect(devkit(root, 'init', '--stack', 'generic', '--yes', '--anti-slop').status).toBe(0);
    expect(existsSync(hookPath(root))).toBe(true);
    expect(
      postToolUse(root).some(
        (entry) =>
          entry.startsWith('Edit|Write|MultiEdit::') && entry.includes(ANTI_SLOP_PREFLIGHT_HOOK),
      ),
    ).toBe(true);
  });

  it('is absent without anti-slop, even with the agent-hook bundle on', () => {
    const root = tmpRepo();
    expect(devkit(root, 'init', '--stack', 'generic', '--yes').status).toBe(0);
    expect(existsSync(hookPath(root))).toBe(false);
    expect(postToolUse(root).join('\n')).not.toContain(ANTI_SLOP_PREFLIGHT_HOOK);
  });

  it('projects to Cursor as afterFileEdit when Cursor hooks are written', () => {
    const root = tmpRepo();
    devkit(root, 'init', '--stack', 'generic', '--yes', '--anti-slop');
    const cursorHooks = join(root, '.cursor', 'hooks.json');
    if (!existsSync(cursorHooks)) return;
    const hooks = readJson(root, '.cursor/hooks.json').hooks ?? {};
    expect(JSON.stringify(hooks.afterFileEdit ?? [])).toContain(ANTI_SLOP_PREFLIGHT_HOOK);
  });

  it('removes the script and registration when anti-slop is later deselected', () => {
    const root = tmpRepo();
    devkit(root, 'init', '--stack', 'generic', '--yes', '--anti-slop');
    expect(existsSync(hookPath(root))).toBe(true);
    devkit(root, 'init', '--stack', 'generic', '--yes', '--no-anti-slop');
    expect(existsSync(hookPath(root))).toBe(false);
    expect(postToolUse(root).join('\n')).not.toContain(ANTI_SLOP_PREFLIGHT_HOOK);
  });
});
