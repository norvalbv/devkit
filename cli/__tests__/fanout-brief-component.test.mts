/** The pre-write fan-out advisory is owned by the fanout guard, not the agentHooks bundle: it is
 * installed with the guard (on by default) and removed with it. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HOOK_REGISTRATIONS } from '../lib/install/hook-registration-ledger/registrations.mts';
import {
  FANOUT_BRIEF_HOOK,
  hookScriptsFor,
} from '../lib/install/hook-registration-ledger/selection.mts';
import { tmpRepos } from './_helpers.mts';

const { tmpRepo, devkit, cleanup } = tmpRepos('fanout-brief-');
afterEach(cleanup);

const hookPath = (root: string) => join(root, '.claude', 'hooks', FANOUT_BRIEF_HOOK);
const preToolUse = (root: string): string[] =>
  (
    JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8')).hooks?.PreToolUse ?? []
  ).flatMap((m: { matcher?: string; hooks: { command: string }[] }) =>
    m.hooks.map((h) => `${m.matcher ?? ''}::${h.command}`),
  );

describe('fanout-brief ownership', () => {
  const base = {
    agentHooks: false,
    decisions: false,
    fallow: false,
    adhd: false,
    priorArtGate: false,
  };

  it('is owned by the fanout guard, independently of the agentHooks bundle', () => {
    expect(hookScriptsFor({ ...base, agentHooks: true })).not.toContain(FANOUT_BRIEF_HOOK);
    expect(hookScriptsFor({ ...base, fanout: true })).toEqual([FANOUT_BRIEF_HOOK]);
  });

  it('registers on Write only, with no Cursor mirror', () => {
    const [registration] = HOOK_REGISTRATIONS.fanout ?? [];
    expect(registration).toMatchObject({ event: 'PreToolUse', matcher: 'Write' });
    expect(registration?.cursorEvent).toBeUndefined();
  });
});

describe('devkit init and the fanout guard', () => {
  it('installs the hook and its registration with the default guards', () => {
    const root = tmpRepo();
    expect(devkit(root, 'init', '--stack', 'generic', '--yes').status).toBe(0);
    expect(existsSync(hookPath(root))).toBe(true);
    expect(preToolUse(root)).toContainEqual(expect.stringMatching(/^Write::.*fanout-brief\.mjs/));
  });

  it('removes the hook and its registration when the fanout guard is deselected', () => {
    const root = tmpRepo();
    devkit(root, 'init', '--stack', 'generic', '--yes');
    devkit(root, 'init', '--stack', 'generic', '--yes', '--guards', 'size,dup,decisions');
    expect(existsSync(hookPath(root))).toBe(false);
    expect(preToolUse(root).join('\n')).not.toContain(FANOUT_BRIEF_HOOK);
  });
});
