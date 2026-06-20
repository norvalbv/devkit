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
import { AGENT_TARGETS, COMPONENTS, GUARD_IDS, GUARD_OPTIONS } from './components.mjs';

// The components that sync into an agent surface (.claude / .cursor). Drives whether the wizard
// asks the surface picker at all — no point choosing surfaces if none of these are selected.
const AGENT_SURFACE_COMPONENTS = ['skills', 'agents', 'agentHooks', 'searchSteering'];

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

// search-code: same opt-in shape as fallow. Drops the per-repo opt-in config + points the dup
// matcher at the index. The engine itself is referenced, not vendored (off by default).
const SEARCHCODE_OPTION = {
  id: 'search-code',
  label: 'search-code',
  hint: 'opt this repo in to the semantic search index (optional, off by default)',
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

// The three install modes (the FIRST thing the wizard asks — it changes everything else).
const MODES = [
  {
    value: 'package',
    label: 'Package',
    hint: 'devkit as a dep; configs extend it — your own repos',
  },
  {
    value: 'standalone',
    label: 'Standalone',
    hint: 'global CLI, nothing in package.json — shared repos',
  },
  {
    value: 'overlay',
    label: 'Overlay',
    hint: "git-ignored + non-invasive — a repo you can't modify",
  },
];

/**
 * Drive the wizard. `installed` is the set of component ids already present (from the old
 * .devkit/config.json or on-disk detection) so we can offer removal. `structureAvailable`
 * gates the structure component (only offered when a template exists for the stack).
 *
 * @param {object} opts
 * @param {string} opts.detectedStack
 * @param {string} [opts.detectedMode] pre-selected mode (from --standalone/--overlay), default package
 * @param {boolean} opts.structureAvailable
 * @param {Set<string>} opts.installed component ids currently wired
 * @returns {Promise<{mode:string, stack:string, selection:object, remove:string[]}|null>} null on cancel
 */
export async function runWizard({
  detectedStack,
  detectedMode = 'package',
  structureAvailable,
  installed,
}) {
  intro('◆ devkit setup');

  // 1. Mode — package / standalone / overlay. Drives every later step.
  const mode = await select({
    message: 'Install mode',
    options: MODES,
    initialValue: detectedMode,
  });
  if (bail(mode)) return null;

  // 2. Stack — single-select, detection pre-highlighted so Enter accepts it.
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

  // 3. Components. Overlay auto-wires (guards + eslint/biome extend + local hook) — no picker.
  // Standalone omits structure-lint (no eslint flat-config plugin in a no-package setup).
  // Structure is only offered in PACKAGE mode where a template exists.
  const structAvail = mode === 'package' && structureAvailable;
  const selection = { guards: [] };
  if (mode === 'overlay') {
    Object.assign(selection, {
      biome: true, // drives the biome.devkit extend (only if the repo has a biome config)
      tsconfig: false,
      skills: false,
      agents: false,
      searchSteering: false,
      agentHooks: false,
      husky: true, // overlay always installs the local (git-ignored) hook
      structure: false,
      fallow: false,
      searchCode: false,
      agentTargets: [...AGENT_TARGETS], // unused (overlay syncs no agent files) — kept consistent
    });
  } else {
    const componentChoices = COMPONENT_OPTIONS.filter((c) => c.id !== 'structure' || structAvail);
    const picked = await multiselect({
      message: 'Select components to install',
      options: [
        ...componentChoices.map(componentOption),
        componentOption(FALLOW_OPTION),
        componentOption(SEARCHCODE_OPTION),
      ],
      initialValues: componentChoices.filter((c) => c.recommended).map((c) => c.id),
      required: false,
    });
    if (bail(picked)) return null;
    const chosen = new Set(picked);
    for (const c of COMPONENT_OPTIONS) selection[c.id] = chosen.has(c.id);
    selection.fallow = chosen.has('fallow');
    selection.searchCode = chosen.has('search-code');
    if (!structAvail) selection.structure = false;

    // Agent surface(s): only asked when something actually syncs into .claude/.cursor. A repo that
    // uses only one tool picks just that surface → no redundant copy in the other's dir. A single
    // SELECT (radio), not a multiselect: a multiselect pre-checking both made "Claude only" require
    // actively DESELECTing Cursor — easy to miss, so both got installed. Radio makes intent explicit.
    selection.agentTargets = [...AGENT_TARGETS];
    if (AGENT_SURFACE_COMPONENTS.some((id) => selection[id])) {
      const surface = await select({
        message: 'Sync skills/agents/hooks to which agent surface(s)?',
        options: [
          { value: 'both', label: 'Both', hint: '.claude/ + .cursor/' },
          { value: 'claude', label: 'Claude only', hint: '.claude/' },
          { value: 'cursor', label: 'Cursor only', hint: '.cursor/' },
        ],
        initialValue: 'both',
      });
      if (bail(surface)) return null;
      selection.agentTargets = surface === 'both' ? [...AGENT_TARGETS] : [surface];
    }
  }

  // 4. Guards — a dedicated multiselect when the hook is in (every mode runs them in the hook).
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

  // 5. Removal: package/standalone only (overlay is local-only — a re-run just overwrites).
  const remove = [];
  const deselected =
    mode === 'overlay'
      ? []
      : [...installed].filter((id) => {
          const stillSelected = id === 'guards' ? selection.guards.length > 0 : selection[id];
          return !stillSelected;
        });

  // 6. Summary — what will be installed + what (if anything) is up for removal.
  note(summarize(mode, selection, structAvail, deselected), `mode: ${mode} · stack: ${stack}`);

  // 7. Apply?
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

  return { mode, stack, selection, remove };
}

// Concise plan summary for the note(): a ✓/· line per component + a remove line.
function summarize(mode, selection, structureAvailable, deselected) {
  if (mode === 'overlay') {
    const g = selection.guards.length ? ` (${selection.guards.join(', ')})` : '';
    return [
      'overlay — everything git-ignored, nothing committed:',
      `✓ guards${g}`,
      '✓ eslint/biome overlay (extends the repo, staged files)',
      '✓ local hook → chains to the repo’s own',
    ].join('\n');
  }
  const lines = COMPONENTS.filter((c) => !(c.id === 'structure' && !structureAvailable)).map(
    (c) => {
      const on = c.id === 'guards' ? selection.guards.length > 0 : selection[c.id];
      const detail = c.id === 'guards' && on ? ` (${selection.guards.join(', ')})` : '';
      return `${on ? '✓' : '·'} ${c.label}${detail}`;
    },
  );
  lines.push(`${selection.fallow ? '✓' : '·'} ${FALLOW_OPTION.label}`);
  lines.push(`${selection.searchCode ? '✓' : '·'} ${SEARCHCODE_OPTION.label}`);
  if (AGENT_SURFACE_COMPONENTS.some((id) => selection[id])) {
    lines.push(`  agent surface(s): ${(selection.agentTargets ?? AGENT_TARGETS).join(', ')}`);
  }
  if (deselected.length) lines.push('', `will ask to remove: ${deselected.join(', ')}`);
  return lines.join('\n');
}
