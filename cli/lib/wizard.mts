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
import {
  AGENT_TARGETS,
  COMPONENTS,
  DEFAULT_REVIEW_DECISIONS_DIR,
  GUARD_OPTIONS,
  RECOMMENDED_GUARD_IDS,
  type ReviewProfile,
  type Selection,
} from './components.mts';

// The wizard builds its selection incrementally by component id — a mix of the known Selection
// keys (booleans + guards/agentTargets arrays) written via dynamic id lookup. This captures that
// dynamic-keyed shape without loosening the known Selection fields.
type WizardSelection = Partial<Selection> & Record<string, boolean | string[] | undefined>;

// The minimal shape componentOption reads off a component / opt-in row.
interface PickerOption {
  id: string;
  label: string;
  hint: string;
}

// The components that sync into an agent surface (.claude / .cursor). Drives whether the wizard
// asks the surface picker at all — no point choosing surfaces if none of these are selected.
const AGENT_SURFACE_COMPONENTS = ['skills', 'agents', 'agentHooks', 'searchSteering'];

// Components OFFERED in OVERLAY mode (no package): the agent-half + the biome extend. Excludes
// tsconfig/structure (need package/plugin resolution), searchSteering (its hooks reference a
// node_modules path), search-code, and husky (the local hook is always on, not optional).
const OVERLAY_PICKABLE = new Set(['biome', 'skills', 'agents', 'agentHooks']);

const STACKS = ['electron', 'react-app', 'component-lib', 'next', 'node-service', 'generic'];

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

// The line-growth block rides the guards multiselect as this pseudo-id, then is split back into
// selection.lineGrowth (it's a guard.config.json knob, not a husky guard fragment).
const LINE_GROWTH_ID = 'line-growth';

// Abort the wizard the moment clack reports a cancel (Ctrl-C / Esc). A TS type guard, so a
// non-cancelled value narrows to its real type after `if (bail(x)) return null`.
function bail(value: unknown): value is symbol {
  if (isCancel(value)) {
    cancel('Aborted — nothing written.');
    return true;
  }
  return false;
}

// Render one component as a checkbox row: "Label — hint".
function componentOption(c: PickerOption) {
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
interface RunWizardOpts {
  detectedStack: string;
  /** pre-selected mode (from --standalone/--overlay), default package */
  detectedMode?: string;
  structureAvailable: boolean;
  /** component ids currently wired (so we can offer removal) */
  installed: Set<string>;
  /** persisted review policy fields that the wizard does not expose */
  existingReview?: Partial<ReviewProfile>;
}

// The plan the wizard hands back to init (which normalises `selection` into a full Selection). The
// wizard builds `selection` incrementally so it is a Partial — overlay mode never sets every field.
interface WizardResult {
  mode: string;
  stack: string;
  selection: Partial<Selection>;
  remove: string[];
  review: ReviewProfile;
}

// Reason: flat clack wizard orchestration: sequential numbered steps (mode→stack→components→guards→removal→summary→apply) each guarded by `if (bail(x)) return null`; the branch COUNT is high but every branch is near-flat, and the untested-complexity is acceptable because this is an interactive TTY prompt flow exercised end-to-end, not unit-tested
// fallow-ignore-next-line complexity
export async function runWizard({
  detectedStack,
  detectedMode = 'package',
  structureAvailable,
  installed,
  existingReview,
}: RunWizardOpts): Promise<WizardResult | null> {
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

  // 3. Components. Overlay offers a picker too — but only the components VIABLE without the package
  // (the agent-half + biome extend + fallow); tsconfig/structure/searchSteering/search-code are
  // excluded (they need package/plugin resolution or a node_modules path) and the local hook is
  // always on (applyOverlayConstraints enforces this). Standalone omits structure-lint. Structure
  // is only offered in PACKAGE mode where a template exists.
  const structAvail = mode === 'package' && structureAvailable;
  // Built up incrementally (component flags + guards/agentTargets), so it's a Partial until the
  // apply layer normalises it — the wizard sets the fields the chosen mode touches.
  const selection: WizardSelection = { guards: [] };
  if (mode === 'overlay') {
    const choices = COMPONENT_OPTIONS.filter((c) => OVERLAY_PICKABLE.has(c.id));
    const picked = await multiselect({
      message: 'Select components to install (overlay — all git-ignored)',
      options: [...choices.map(componentOption), componentOption(FALLOW_OPTION)],
      initialValues: choices.filter((c) => c.recommended).map((c) => c.id),
      required: false,
    });
    if (bail(picked)) return null;
    const chosen = new Set(picked);
    for (const c of choices) selection[c.id] = chosen.has(c.id);
    selection.fallow = chosen.has('fallow');
    selection.husky = true; // overlay's local hook is the delivery mechanism — always on
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
  }

  // Agent surface(s): asked whenever something syncs into .claude/.cursor (every mode now does). A
  // repo that uses only one tool picks just that surface → no redundant copy in the other's dir. A
  // single SELECT (radio), not a multiselect: a multiselect pre-checking both made "Claude only"
  // require actively DESELECTing Cursor — easy to miss, so both got installed. Radio = explicit intent.
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

  // 4. Guards — a dedicated multiselect when the hook is in (every mode runs them in the hook). The
  // line-growth block rides this list as a checkbox (recommended-on) but is a CONFIG KNOB, not a guard
  // id: it's split back out into selection.lineGrowth so selection.guards stays pure guard ids.
  if (selection.husky) {
    const guards = await multiselect({
      message: 'Select gate guards',
      options: [
        ...GUARD_OPTIONS.map((g) => ({ value: g.id, label: g.label, hint: g.hint })),
        {
          value: LINE_GROWTH_ID,
          label: 'line-growth block',
          hint: 'cap files at 500 lines — current giants grandfathered, new growth blocked (needs size)',
        },
      ],
      initialValues: [...RECOMMENDED_GUARD_IDS, LINE_GROWTH_ID],
      required: false,
    });
    if (bail(guards)) return null;
    selection.lineGrowth = (guards as string[]).includes(LINE_GROWTH_ID);
    selection.guards = (guards as string[]).filter((g) => g !== LINE_GROWTH_ID);
  }

  // Review execution is a separate local policy from ordinary commit/ship guards. Opt-in here;
  // when enabled, make the positive allowlist explicit so future gates never enter cron reviews.
  const reviewEnabled = selection.husky
    ? await confirm({
        message: 'Enable devkit review?',
        initialValue: installed.has('devkit-review'),
      })
    : false;
  if (bail(reviewEnabled)) return null;
  let reviewGuards: string[] = [];
  if (reviewEnabled) {
    const options = GUARD_OPTIONS.filter((g) => selection.guards?.includes(g.id)).map((g) => ({
      value: g.id,
      label: g.label,
      hint: g.hint,
    }));
    if (options.length > 0) {
      const picked = await multiselect({
        message: 'Select guards for devkit review',
        options,
        initialValues: [...(selection.guards ?? [])],
        required: false,
      });
      if (bail(picked)) return null;
      reviewGuards = picked as string[];
    }
  }
  const review: ReviewProfile = {
    enabled: Boolean(reviewEnabled),
    guards: reviewGuards,
    decisionsDir: existingReview?.decisionsDir?.trim() || DEFAULT_REVIEW_DECISIONS_DIR,
  };

  // 5. Removal: package/standalone only (overlay is local-only — a re-run just overwrites).
  const remove = [];
  const deselected =
    mode === 'overlay'
      ? []
      : [...installed].filter((id) => {
          const stillSelected =
            id === 'devkit-review' ||
            (id === 'guards' ? (selection.guards ?? []).length > 0 : selection[id]);
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

  return { mode, stack, selection, remove, review };
}

// Concise plan summary for the note(): a ✓/· line per component + a remove line.
function summarize(
  mode: string,
  selection: WizardSelection,
  structureAvailable: boolean,
  deselected: string[],
) {
  const guards = selection.guards ?? [];
  if (mode === 'overlay') {
    const g = guards.length ? ` (${guards.join(', ')})` : '';
    const surfaces = (selection.agentTargets ?? AGENT_TARGETS).join(', ');
    const on = (id: string) => (selection[id] ? '✓' : '·');
    return [
      'overlay — everything git-ignored, nothing committed:',
      `✓ guards${g}`,
      '✓ local hook → chains to the repo’s own',
      `${on('biome')} biome overlay (extends the repo, staged files)`,
      `${on('skills')} skills · ${on('agents')} agents → ${surfaces} (skipping anything git tracks)`,
      `${on('agentHooks')} agent hooks → .claude/settings.local.json + .cursor/hooks.json (if untracked)`,
      `${on('fallow')} fallow gate (chained into the local hook; global install if missing, else skipped)`,
    ].join('\n');
  }
  const lines = COMPONENTS.filter((c) => !(c.id === 'structure' && !structureAvailable)).map(
    (c) => {
      const on = c.id === 'guards' ? guards.length > 0 : selection[c.id];
      const detail = c.id === 'guards' && on ? ` (${guards.join(', ')})` : '';
      return `${on ? '✓' : '·'} ${c.label}${detail}`;
    },
  );
  lines.push(`${selection.fallow ? '✓' : '·'} ${FALLOW_OPTION.label}`);
  lines.push(`${selection.searchCode ? '✓' : '·'} ${SEARCHCODE_OPTION.label}`);
  lines.push(`${selection.lineGrowth ? '✓' : '·'} line-growth block`);
  if (AGENT_SURFACE_COMPONENTS.some((id) => selection[id])) {
    lines.push(`  agent surface(s): ${(selection.agentTargets ?? AGENT_TARGETS).join(', ')}`);
  }
  if (deselected.length) lines.push('', `will ask to remove: ${deselected.join(', ')}`);
  return lines.join('\n');
}
