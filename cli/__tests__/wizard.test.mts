/**
 * Wizard agent-surface selection. Regression for: "I only selected claude but .cursor hooks also
 * got installed." The picker used to be a multiselect pre-checking BOTH surfaces, so choosing
 * Claude without DESELECTing Cursor left both on. It's now a single SELECT — "Claude only" maps to
 * exactly ['claude'], and the apply layer must then write nothing under .cursor/.codex/.agents.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SURFACE_Q = 'Sync skills/agents/hooks to which agent surface(s)?';
const answers = {};
const offered = {};
vi.mock('@clack/prompts', () => ({
  intro: () => {},
  outro: () => {},
  note: () => {},
  cancel: () => {},
  isCancel: () => false,
  select: async ({ message }) => answers[message],
  multiselect: async ({ message, initialValues }) => {
    offered[message] = initialValues;
    return answers[message];
  },
  confirm: async ({ message }) => answers[message],
}));

// Static imports (after the hoisted vi.mock) so the heavy init.mjs graph loads once, not per test.
import init, { applyInit } from '../commands/init.mts';
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
    ['codex', ['codex']],
    ['cursor', ['cursor']],
    ['claude-codex', ['claude', 'codex']],
    ['claude-cursor', ['claude', 'cursor']],
    ['codex-cursor', ['codex', 'cursor']],
    ['all', ['claude', 'codex', 'cursor']],
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
    expect(existsSync(join(root, '.codex'))).toBe(false);
    expect(existsSync(join(root, '.agents'))).toBe(false);
  });

  it('records an explicit local review guard profile when enabled', async () => {
    setAnswers('claude');
    Object.assign(answers, {
      'Select components to install': ['skills', 'agents', 'husky'],
      'Select gate guards': ['size', 'decisions'],
      'Enable devkit review?': true,
      'Select guards for devkit review': ['decisions'],
    });

    const r = await runWizard(WIZ_OPTS);

    expect(r.review).toEqual({
      enabled: true,
      guards: ['decisions'],
    });
  });

  it('does not offer or persist commit-msg-only guards in a review profile', async () => {
    setAnswers('claude');
    Object.assign(answers, {
      'Select components to install': ['skills', 'agents', 'husky'],
      'Select gate guards': ['decisions', 'sentry'],
      'Enable devkit review?': true,
      'Select guards for devkit review': ['decisions', 'sentry'],
    });

    const r = await runWizard(WIZ_OPTS);

    expect(r.review.guards).toEqual(['decisions']);
  });

  it('skips the review picker when no selected guard can run at pre-commit', async () => {
    setAnswers('claude');
    Object.assign(answers, {
      'Select components to install': ['skills', 'agents', 'husky'],
      'Select gate guards': ['sentry'],
      'Enable devkit review?': true,
      'Select guards for devkit review': undefined,
    });

    const r = await runWizard(WIZ_OPTS);

    expect(r.review).toEqual({
      enabled: true,
      guards: [],
    });
  });

  it('keeps review disabled when the effective selection has no Husky hook', async () => {
    setAnswers('claude');
    answers['Enable devkit review?'] = true;

    const r = await runWizard(WIZ_OPTS);

    expect(r.selection.husky).toBe(false);
    expect(r.review).toEqual({
      enabled: false,
      guards: [],
    });
  });

  it('devkit init hands the recorded guards to the wizard pre-check', async () => {
    // The wiring between init and runWizard: without it a re-run re-enables a declined review.
    const root = tmpRepo();
    mkdirSync(join(root, '.devkit'));
    const components = { husky: true, guards: ['size', 'sentry'], disabledGuards: ['review'] };
    writeFileSync(join(root, '.devkit', 'config.json'), JSON.stringify({ components }));
    setAnswers('claude');
    Object.assign(answers, { 'Select components to install': ['husky'], 'Apply?': false });
    const isTTY = process.stdout.isTTY;
    process.stdout.isTTY = true;
    try {
      expect(await init(['--stack', 'generic'], root)).toBe(0);
    } finally {
      process.stdout.isTTY = isTTY;
    }
    expect(offered['Select gate guards']).toContain('sentry');
    expect(offered['Select gate guards']).not.toContain('review');
  });
});
