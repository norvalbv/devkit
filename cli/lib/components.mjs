/**
 * The devkit component registry — the single source of truth for the *selectable* set
 * `devkit init` installs/removes. Both the interactive wizard and the flag parser resolve
 * to a `selection` shaped exactly like {@link defaultSelection}; the apply layer
 * (init.mjs) installs the truthy ones and removes the deselected-but-present ones.
 *
 * One home for: the component order/labels (wizard copy), the recommended defaults
 * (--yes / non-TTY), and the guard sub-gate set (the husky `# devkit-guards` lines).
 */

/** The five gate-engine sub-gates that live inside the husky `# devkit-guards` block. */
export const GUARD_IDS = ['size', 'fanout', 'dup', 'clone', 'decisions'];

/**
 * The top-level components, in wizard order. `recommended` seeds the --yes / non-TTY
 * default and the wizard's per-component `confirm` initialValue. `structure` is the only
 * stack-gated one (offered iff a structure template exists — currently electron only).
 */
export const COMPONENTS = [
  { id: 'biome', label: 'Biome', hint: 'shared formatter + linter config', recommended: true },
  {
    id: 'tsconfig',
    label: 'TypeScript',
    hint: 'tsconfig extending the devkit base',
    recommended: true,
  },
  { id: 'skills', label: 'Agent skills', hint: 'sync to .claude + .cursor', recommended: true },
  {
    id: 'agents',
    label: 'Review agents',
    hint: 'review/testing subagents → .claude/.cursor agents',
    recommended: true,
  },
  {
    id: 'searchSteering',
    label: 'search-code steering hooks',
    hint: 'PreToolUse + PostToolUse: flag conceptual grep, steer to your semantic-search / graph tools',
    recommended: false,
  },
  {
    id: 'agentHooks',
    label: 'Agent hooks (Claude/Cursor)',
    hint: 'Stop/PostToolUse/UserPromptSubmit/PreCompact: decision nudge, rule recall, format-after-edit, QA, compaction',
    recommended: false,
  },
  { id: 'husky', label: 'Husky pre-commit', hint: 'the gate hook', recommended: true },
  {
    id: 'guards',
    label: 'Gate-engine guards',
    hint: 'size · fanout · dup · clone · decisions',
    recommended: true,
  },
  {
    id: 'structure',
    label: 'Structure lint',
    hint: 'eslint folder/import walls',
    recommended: true,
    stackGated: true,
  },
];

/** Per-guard copy for the wizard multiselect. */
export const GUARD_OPTIONS = [
  { id: 'size', label: 'size', hint: 'eslint-disable max-lines ratchet' },
  { id: 'fanout', label: 'fanout', hint: 'folder fan-out ratchet' },
  { id: 'dup', label: 'dup', hint: 'semantic duplication (search-code)' },
  { id: 'clone', label: 'clone', hint: 'verbatim copy-paste (jscpd)' },
  { id: 'decisions', label: 'decisions', hint: 'architectural-decision log gate' },
];

/**
 * The all-recommended selection: every component on, every guard on. This is the EXACT
 * behaviour of `--yes` (and of a non-TTY run), preserving the pre-wizard default.
 * `structure` is recommended-on but only *applies* when the stack has a template — the
 * apply layer no-ops it otherwise (see init.mjs `isStructure`). `fallow` is the one
 * recommended-OFF component (heavier third-party tool) — opt-in even under --yes.
 *
 * @returns {{biome:boolean,tsconfig:boolean,skills:boolean,agents:boolean,searchSteering:boolean,agentHooks:boolean,husky:boolean,structure:boolean,fallow:boolean,searchCode:boolean,guards:string[]}}
 */
export function defaultSelection() {
  return {
    biome: true,
    tsconfig: true,
    skills: true,
    agents: true,
    // searchSteering + agentHooks are opt-in (they register agent hooks): off even under --yes.
    searchSteering: false,
    agentHooks: false,
    husky: true,
    structure: true,
    fallow: false,
    searchCode: false,
    guards: [...GUARD_IDS],
  };
}

/** Normalise a (possibly partial) selection to a full one — missing keys take recommended defaults. */
export function normalizeSelection(partial = {}) {
  const base = defaultSelection();
  return {
    ...base,
    ...partial,
    guards: partial.guards ? partial.guards.filter((g) => GUARD_IDS.includes(g)) : base.guards,
  };
}
