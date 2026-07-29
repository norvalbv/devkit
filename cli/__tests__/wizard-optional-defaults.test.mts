/**
 * Accepting the wizard's defaults on a RE-RUN must not silently drop an opt-in component the repo
 * already has.
 *
 * Opt-in components (i-have-adhd and any future OPTIONAL_COMPONENTS entry) are deliberately never
 * `recommended`, so nothing pre-ticks them on a FRESH install — that is the point. But the same
 * multiselect is what a re-run shows, and there the absence is destructive rather than neutral:
 * pressing Enter records `adhd: false`, and the next sync prunes the skill the user asked for.
 *
 * The mock here returns each prompt's own `initialValues`, which is exactly "the user pressed Enter".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const selectAnswers: Record<string, unknown> = {
  'Install mode': 'package',
  'Select your stack': 'generic',
  'Sync skills/agents/hooks to which agent surface(s)?': 'claude',
};

vi.mock('@clack/prompts', () => ({
  intro: () => {},
  outro: () => {},
  note: () => {},
  cancel: () => {},
  isCancel: () => false,
  select: async ({ message }: { message: string }) => selectAnswers[message],
  // Accept the defaults verbatim — the behaviour under test.
  multiselect: async ({ initialValues }: { initialValues?: unknown[] }) => initialValues ?? [],
  // `Apply?` must be true; every `Remove <id>?` must be false (its own initialValue).
  confirm: async ({ message, initialValue }: { message: string; initialValue?: boolean }) =>
    message === 'Apply?' ? true : (initialValue ?? false),
}));

import { runWizard } from '../lib/wizard.mts';

const opts = (installed: Set<string>, mode = 'package') => ({
  detectedStack: 'generic',
  detectedMode: mode,
  structureAvailable: false,
  installed,
});

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('wizard defaults — opt-in components on a re-run', () => {
  it('keeps an already-installed adhd component when the user accepts defaults', async () => {
    const result = await runWizard(opts(new Set(['skills', 'agents', 'husky', 'adhd'])));
    expect(result?.selection.adhd).toBe(true);
  });

  it('still leaves it OFF for a fresh repo that never had it', async () => {
    // The opt-in guarantee: a fresh install must not acquire it by accepting defaults.
    const result = await runWizard(opts(new Set()));
    expect(result?.selection.adhd).toBe(false);
  });

  it('does not offer to remove a component it just preserved', async () => {
    // Preserved in `selection` means it is not "deselected", so no removal prompt and no entry in
    // `remove` — otherwise the wizard would ask about undoing something the user never touched.
    const result = await runWizard(opts(new Set(['skills', 'agents', 'husky', 'adhd'])));
    expect(result?.remove ?? []).not.toContain('adhd');
  });

  it('applies the same rule in overlay mode', async () => {
    // Overlay runs its own multiselect branch — the fix has to be in both, not just the package one.
    const result = await runWizard(opts(new Set(['skills', 'adhd']), 'overlay'));
    expect(result?.selection.adhd).toBe(true);
  });
});
