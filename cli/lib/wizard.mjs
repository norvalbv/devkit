/**
 * The interactive `devkit init` setup wizard (clack-driven). Runs only when stdout is a
 * TTY and the user didn't pass --yes. It's a PICKER-style flow — a stack `select`, a
 * single components `multiselect`, and a guards `multiselect` — not a chain of yes/no
 * confirms. It produces the same `{ stack, selection, remove }` plan `applyInit` consumes
 * (see components.mjs `defaultSelection`); all apply/IO lives in init.mjs — this module
 * only ASKS.
 *
 * Ctrl-C / Esc at any prompt aborts cleanly via clack's isCancel (nothing is written).
 */

import { cancel, confirm, intro, isCancel, multiselect, note, select } from '@clack/prompts';
import { COMPONENTS, GUARD_IDS, GUARD_OPTIONS } from './components.mjs';

const STACKS = ['electron', 'react-app', 'next', 'node-service', 'generic'];

// The picker components (everything except `guards`, which gets its own multiselect when
// husky is on). `structure` is filtered in at call time only when a template exists.
const COMPONENT_OPTIONS = COMPONENTS.filter((c) => c.id !== 'guards');

// fallow is an OPTIONAL, heavier third-party tool — offered in the same multiselect but
// DEFAULT OFF (never seeded into initialValues). Kept out of the COMPONENTS registry (which
// drives the all-on --yes defaults) precisely so it stays opt-in. The apply layer reads
// selection.fallow; doctor records components.fallow.
const FALLOW_OPTION = {
  id: 'fallow',
  label: 'fallow',
  hint: 'code-health audit + its own git hook (optional, off by default)',
};

// Abort the wizard the moment clack reports a cancel (Ctrl-C / Esc). A TS type guard, so a
// non-cancelled value narrows to its real type after `if (bail(x)) return null`.
/**
 * @param {unknown} value
 * @returns {value is symbol}
 */
function bail(value) {
  if (isCancel(value)) {
    cancel('Aborted — nothing written.');
    return true;
  }
  return false;
}

// Render one component as a checkbox row: "Label — hint".
function componentOption(c) {
  return { value: c.id, label: c.label, hint: c.hint };
}

/**
 * Drive the wizard. `installed` is the set of component ids already present (from the old
 * .devkit/config.json or on-disk detection) so we can offer removal. `structureAvailable`
 * gates the structure component (only offered when a template exists for the stack).
 *
 * @param {object} opts
 * @param {string} opts.detectedStack
 * @param {boolean} opts.structureAvailable
 * @param {Set<string>} opts.installed component ids currently wired
 * @returns {Promise<{stack:string, selection:object, remove:string[]}|null>} null on cancel
 */
export async function runWizard({ detectedStack, structureAvailable, installed }) {
  intro('◆ devkit setup');

  // 1. Stack — single-select, detection pre-highlighted so Enter accepts it.
  const stack = await select({
    message: 'Select your stack',
    options: STACKS.map((s) => ({
      value: s,
      label: s,
      hint: s === detectedStack ? 'detected' : undefined,
    })),
    initialValue: detectedStack,
  });
  if (bail(stack)) return null;

  // 2. Components — one checkbox list. Structure only appears when a template exists;
  // fallow is appended last and DEFAULT OFF (not in initialValues).
  const componentChoices = COMPONENT_OPTIONS.filter(
    (c) => c.id !== 'structure' || structureAvailable,
  );
  const picked = await multiselect({
    message: 'Select components to install',
    options: [...componentChoices.map(componentOption), componentOption(FALLOW_OPTION)],
    initialValues: componentChoices.filter((c) => c.recommended).map((c) => c.id),
    required: false,
  });
  if (bail(picked)) return null;
  const chosen = new Set(picked);

  // Build the selection map the apply layer consumes.
  const selection = { guards: [] };
  for (const c of COMPONENT_OPTIONS) {
    selection[c.id] = chosen.has(c.id);
  }
  selection.fallow = chosen.has('fallow');
  // Structure is always-false when there's no template for the stack.
  if (!structureAvailable) selection.structure = false;

  // 3. Guards — a dedicated multiselect, only when the husky hook is in (guards live in it).
  if (selection.husky) {
    const guards = await multiselect({
      message: 'Select gate guards',
      options: GUARD_OPTIONS.map((g) => ({ value: g.id, label: g.label, hint: g.hint })),
      initialValues: [...GUARD_IDS],
      required: false,
    });
    if (bail(guards)) return null;
    selection.guards = guards;
  }

  // 4. Removal: anything installed today but now unticked (default NO — non-destructive).
  const remove = [];
  const deselected = [...installed].filter((id) => {
    const stillSelected = id === 'guards' ? selection.guards.length > 0 : selection[id];
    return !stillSelected;
  });

  // 5. Summary — what will be installed + what (if anything) is up for removal.
  note(summarize(selection, structureAvailable, deselected), `stack: ${stack}`);

  // 6. Apply?
  const go = await confirm({ message: 'Apply?', initialValue: true });
  if (bail(go) || !go) {
    cancel('Aborted — nothing written.');
    return null;
  }

  // Per-component removal confirm (default NO) for each deselected-but-present component.
  for (const id of deselected) {
    const yes = await confirm({
      message: `Remove ${id}? (currently installed)`,
      initialValue: false,
    });
    if (bail(yes)) return null;
    if (yes) remove.push(id);
  }

  return { stack, selection, remove };
}

// Concise plan summary for the note(): a ✓/· line per component + a remove line.
function summarize(selection, structureAvailable, deselected) {
  const lines = COMPONENTS.filter((c) => !(c.id === 'structure' && !structureAvailable)).map(
    (c) => {
      const on = c.id === 'guards' ? selection.guards.length > 0 : selection[c.id];
      const detail = c.id === 'guards' && on ? ` (${selection.guards.join(', ')})` : '';
      return `${on ? '✓' : '·'} ${c.label}${detail}`;
    },
  );
  lines.push(`${selection.fallow ? '✓' : '·'} ${FALLOW_OPTION.label}`);
  if (deselected.length) lines.push('', `will ask to remove: ${deselected.join(', ')}`);
  return lines.join('\n');
}
