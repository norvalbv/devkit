/**
 * The devkit component registry — the single source of truth for the *selectable* set
 * `devkit init` installs/removes. Both the interactive wizard and the flag parser resolve
 * to a `selection` shaped exactly like {@link defaultSelection}; the apply layer
 * (init.mjs) installs the truthy ones and removes the deselected-but-present ones.
 *
 * One home for: the component order/labels (wizard copy), the recommended defaults
 * (--yes / non-TTY), and the guard sub-gate set (the husky `# devkit-guards` lines).
 */
/** The recommended-on gate-engine sub-gates (the --yes / non-TTY default guard set). */
export const RECOMMENDED_GUARD_IDS = ['size', 'fanout', 'dup', 'clone', 'decisions'];
/**
 * Every selectable sub-gate inside the husky `# devkit-guards` block. `review` (the in-chain
 * headless reviewer judges) is selectable but OFF by default — it spends real model budget on
 * every commit, so a consumer opts in with `--guards …,review` or the wizard.
 */
export const GUARD_IDS = [...RECOMMENDED_GUARD_IDS, 'review'];
/**
 * The agent surfaces devkit can sync skills/agents/agent-hooks into: Claude (`.claude/`) and
 * Cursor (`.cursor/`). `selection.agentTargets` picks the subset to write to (default both) so a
 * repo that only uses one tool doesn't get a redundant copy in the other's dir. Surface `<name>`
 * maps to the `.<name>/` dir (claude → .claude, cursor → .cursor).
 */
export const AGENT_TARGETS = ['claude', 'cursor'];
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
    { id: 'review', label: 'review', hint: 'in-chain reviewer judges (sonnet → opus; model spend)' },
];
/**
 * The all-recommended selection: every component on, every guard on. This is the EXACT
 * behaviour of `--yes` (and of a non-TTY run), preserving the pre-wizard default.
 * `structure` is recommended-on but only *applies* when the stack has a template — the
 * apply layer no-ops it otherwise (see init.mts `isStructure`). `fallow` is the one
 * recommended-OFF component (heavier third-party tool) — opt-in even under --yes.
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
        agentTargets: [...AGENT_TARGETS],
        guards: [...RECOMMENDED_GUARD_IDS],
    };
}
/**
 * Enforce the OVERLAY invariants on a selection (from the wizard OR the --yes/flag path), so the
 * SAME constraints apply whichever way overlay was resolved. The viable choices — skills, agents,
 * agentHooks, biome, fallow, guards, agentTargets — pass through UNTOUCHED (overlay offers the same
 * opt-in choices as package for those). Forced: the local hook is always on; the components that
 * can't work without the package are off — `tsconfig`/`structure` (need package/plugin resolution),
 * `searchSteering` (its hooks reference node_modules/@norvalbv/devkit), `search-code` (referenced
 * external engine, not wired in overlay).
 *
 * @param sel a resolved selection (from selectionFromFlags or the wizard)
 */
export function applyOverlayConstraints(sel) {
    return {
        ...sel,
        tsconfig: false,
        structure: false,
        searchSteering: false,
        searchCode: false,
        husky: true,
    };
}
/** Normalise a (possibly partial) selection to a full one — missing keys take recommended defaults. */
export function normalizeSelection(partial = {}) {
    const base = defaultSelection();
    return {
        ...base,
        ...partial,
        agentTargets: partial.agentTargets
            ? partial.agentTargets.filter((t) => AGENT_TARGETS.includes(t))
            : base.agentTargets,
        guards: partial.guards ? partial.guards.filter((g) => GUARD_IDS.includes(g)) : base.guards,
    };
}
