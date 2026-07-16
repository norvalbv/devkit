/**
 * Wizard agent-surface selection. Regression for: "I only selected claude but .cursor hooks also
 * got installed." The picker used to be a multiselect pre-checking BOTH surfaces, so choosing
 * Claude without DESELECTing Cursor left both on. It's now a single SELECT — "Claude only" maps to
 * exactly ['claude'], and the apply layer must then write nothing under .cursor.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SURFACE_Q = 'Sync skills/agents/hooks to which agent surface(s)?';
const answers = {};
vi.mock('@clack/prompts', () => ({
  intro: () => {},
  outro: () => {},
  note: () => {},
  cancel: () => {},
  isCancel: () => false,
  select: async ({ message }) => answers[message],
  multiselect: async ({ message }) => answers[message],
  confirm: async ({ message }) => answers[message],
}));

// Static imports (after the hoisted vi.mock) so the heavy init.mjs graph loads once, not per test.
import { applyInit } from '../commands/init.mts';
import { runWizard } from '../lib/wizard.mts';
import { tmpRepos } from './_helpers.mts';

const WIZ_OPTS = {
  detectedStack: 'generic',
  detectedMode: 'package',
  structureAvailable: false,
  installed: new Set(),
};
function setAnswers(surface) {
  Object.assign(answers, {
    'Install mode': 'package',
    'Select your stack': 'generic',
    'Select components to install': ['skills', 'agents'],
    [SURFACE_Q]: surface,
    'Select gate guards': [],
    'Enable devkit review?': false,
    'Apply?': true,
  });
}

const { tmpRepo, cleanup } = tmpRepos('wiz-');
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe('wizard agent-surface selection', () => {
  it.each([
    ['claude', ['claude']],
    ['cursor', ['cursor']],
    ['both', ['claude', 'cursor']],
  ])('select "%s" → agentTargets %j', async (surface, expected) => {
    setAnswers(surface);
    const r = await runWizard(WIZ_OPTS);
    expect(r.selection.agentTargets).toEqual(expected);
  });

  it('claude-only install writes .claude but NO .cursor (the reported bug)', async () => {
    setAnswers('claude');
    const r = await runWizard(WIZ_OPTS);
    const root = tmpRepo();
    await applyInit(root, { stack: 'generic', selection: r.selection, devkitRef: 'v0' });
    expect(existsSync(join(root, '.claude'))).toBe(true);
    expect(existsSync(join(root, '.cursor'))).toBe(false);
  });

  it('records an explicit local review guard profile when enabled', async () => {
    setAnswers('claude');
    Object.assign(answers, {
      'Select gate guards': ['size', 'decisions'],
      'Enable devkit review?': true,
      'Select guards for devkit review': ['decisions'],
    });

    const r = await runWizard(WIZ_OPTS);

    expect(r.review).toEqual({
      enabled: true,
      guards: ['decisions'],
      decisionsDir: 'docs/decisions',
    });
  });
});
