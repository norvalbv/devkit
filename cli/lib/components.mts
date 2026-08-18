/**
 * The devkit component registry — the single source of truth for the *selectable* set
 * `devkit init` installs/removes. Both the interactive wizard and the flag parser resolve
 * to a `selection` shaped exactly like {@link defaultSelection}; the apply layer
 * (init.mjs) installs the truthy ones and removes the deselected-but-present ones.
 *
 * One home for: the component order/labels (wizard copy), the recommended defaults
 * (--yes / non-TTY), and the guard sub-gate set (the husky `# devkit-guards` lines).
 */

import {
  FRESH_DEFAULT_AGENT_PROVIDERS,
  normalizeAgentProviders,
} from './install/agent-assets/agent-providers.mts';

/** The recommended-on gate-engine sub-gates (the --yes / non-TTY default guard set). */
export const RECOMMENDED_GUARD_IDS = [
  'size',
  'fanout',
  'dup',
  'clone',
  'comments',
  'decisions',
  'qavis-advisory',
];

/**
 * Every selectable sub-gate inside the husky `# devkit-guards` block. Three are selectable-but-OFF
 * by default: `review` (the in-chain headless reviewer judges) spends real model budget on every
 * commit, `sentry` (the commit-msg Sentry-capture judge) only makes sense in a repo whose product
 * actually uses Sentry, and `coverage` needs a `test:run:coverage` provider the repo may not have —
 * a consumer opts in with `--guards …,review,sentry,coverage` or the wizard.
 */
export const GUARD_IDS = [...RECOMMENDED_GUARD_IDS, 'review', 'sentry', 'coverage'];

/** Guards that can execute in a pre-commit review (excludes commit-msg-only Sentry capture). */
export const REVIEWABLE_GUARD_IDS = GUARD_IDS.filter((guard) => guard !== 'sentry');

export const DEFAULT_REVIEW_DECISIONS_DIR = 'docs/decisions';

/** Local execution policy for `devkit review`; decision content stays in `decisionsDir`. */
export interface ReviewProfile {
  enabled: boolean;
  guards: string[];
  decisionsDir: string;
}

interface NormalizeReviewProfileOptions {
  enabledDefault?: boolean;
  available?: boolean;
}

export function normalizeReviewProfile(
  partial: Partial<ReviewProfile> | undefined,
  installedGuards: string[],
  { enabledDefault = false, available = true }: NormalizeReviewProfileOptions = {},
): ReviewProfile {
  const installed = installedGuards.filter((g) => REVIEWABLE_GUARD_IDS.includes(g));
  const requested = Array.isArray(partial?.guards) ? partial.guards : installed;
  return {
    enabled: available && (partial?.enabled ?? enabledDefault),
    guards: installed.filter((g) => requested.includes(g)),
    decisionsDir:
      typeof partial?.decisionsDir === 'string' && partial.decisionsDir.trim()
        ? partial.decisionsDir.trim()
        : DEFAULT_REVIEW_DECISIONS_DIR,
  };
}

/** Stacks whose structure rules are compiled from guard.config.json by devkit itself. */
export const CONFIG_DRIVEN_STRUCTURE = new Set(['react-app', 'component-lib']);

/** The structure-lint command emitted by init and checked by doctor/review preflight. */
export function structureCmdFor(stack: string): string {
  if (CONFIG_DRIVEN_STRUCTURE.has(stack)) return 'guard-structure gate';
  // The Electron preset's plugin derives its project root from its own __filename. Ship symlinks
  // node_modules into an ephemeral worktree, so preserve that logical path or the plugin silently
  // roots itself in the source checkout and skips every worktree file.
  return 'node --preserve-symlinks node_modules/eslint/bin/eslint.js src';
}

/**
 * Compatibility name for the agent surfaces the current projection layer can sync into. Provider
 * support/default policy now lives in agent-providers.mts.
 */
export const AGENT_TARGETS: string[] = [...FRESH_DEFAULT_AGENT_PROVIDERS];

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
  {
    id: 'skills',
    label: 'Agent skills',
    hint: 'sync to Claude, Codex, and Cursor',
    recommended: true,
  },
  {
    id: 'agents',
    label: 'Review agents',
    hint: 'review/testing subagents → Claude/Codex/Cursor agents',
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
    label: 'Agent hooks (Claude/Codex/Cursor)',
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
  {
    id: 'comments',
    label: 'comments',
    hint: 'challenge changed comments; explicit rationale gets independent Haiku review',
  },
  { id: 'decisions', label: 'decisions', hint: 'architectural-decision log gate' },
  { id: 'review', label: 'review', hint: 'in-chain reviewer judges (sonnet → opus; model spend)' },
  {
    id: 'sentry',
    label: 'sentry',
    hint: 'commit-msg judge: flags silent runtime error-classes lacking a Sentry capture (hard-block, diff-tier)',
  },
  {
    id: 'qavis-advisory',
    label: 'qavis-advisory',
    hint: 'nudge to run qavis QA on UI diffs (needs qavis on PATH + .qavis/recipe.json)',
  },
  {
    id: 'coverage',
    label: 'coverage',
    hint: 'coverage floor from guard.config.json (needs test:run:coverage + a coverage provider)',
  },
];

/**
 * A resolved component selection — the shape the wizard AND the flag parser both produce, and
 * that the apply layer (init) installs. Every field is present after {@link normalizeSelection}.
 */
export interface Selection {
  biome: boolean;
  tsconfig: boolean;
  skills: boolean;
  agents: boolean;
  searchSteering: boolean;
  agentHooks: boolean;
  husky: boolean;
  structure: boolean;
  fallow: boolean;
  /** Pinned Oxlint/Oxfmt runtime plus repository-local Oxc configuration. Opt-in. */
  oxc: boolean;
  searchCode: boolean;
  /**
   * The per-file line-growth block: when on, `maxLines` is written into guard.config.json so the
   * guard-size ratchet caps source files (existing giants grandfathered shrink-only). A config KNOB on
   * the `size` guard, not a husky fragment — the apply layer writes the cap iff `size` is also selected.
   */
  lineGrowth: boolean;
  /**
   * The vendored `i-have-adhd` output-style skill (cli/lib/install/vendored-skills.mts), delivered
   * to `.devkit/vendored-skills/` by its own installer (install/adhd-skill.mts). Independent of the
   * `skills` component, since it never writes to the agent skills dirs. Opt-in even under --yes: it
   * reshapes how the assistant writes, which is a personal preference.
   */
  adhd: boolean;
  /**
   * The deny-once step-0 ordering gate (agents-hooks/prior-art-gate.mjs): the first ExitPlanMode
   * or feature-critique dispatch in a session with no recorded prior-art run is denied once with
   * the skip predicate; retries pass. Opt-in even under --yes: it denies harness tool calls, which
   * a repo must choose (carve-out ruled in docs/decisions/devkit-gates-repo-not-harness.md).
   */
  priorArtGate: boolean;
  agentTargets: string[];
  guards: string[];
}

/** Recorded component flags whose truthy values count as installed on a config-backed repo. */
export const RECORDED_COMPONENT_IDS = [
  'biome',
  'tsconfig',
  'skills',
  'agents',
  'searchSteering',
  'agentHooks',
  'husky',
  'structure',
  'adhd',
  'priorArtGate',
  'oxc',
] as const satisfies readonly (keyof Selection)[];

/** The `Selection` keys that are plain on/off components (excludes the guards/agentTargets arrays). */
export type ComponentToggleId = {
  [K in keyof Selection]: Selection[K] extends boolean ? K : never;
}[keyof Selection];

/**
 * The all-recommended selection: every component on, every guard on. This is the EXACT
 * behaviour of `--yes` (and of a non-TTY run), preserving the pre-wizard default.
 * `structure` is recommended-on but only *applies* when the stack has a template — the
 * apply layer no-ops it otherwise (see init.mts `isStructure`). `fallow` is the one
 * recommended-OFF component (heavier third-party tool) — opt-in even under --yes.
 */
export function defaultSelection(): Selection {
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
    // Toolchain migration is incremental: capability arrives only when explicitly selected.
    oxc: false,
    searchCode: false,
    // Recommended-on: a fresh repo has no giants (or they're grandfathered by init's freeze), so the
    // cap is pure upside. Deselectable in the wizard / via --no-line-growth.
    lineGrowth: true,
    // Output-style preference — never arrives uninvited. See Selection.adhd.
    adhd: false,
    // Denies harness tool calls — never arrives uninvited. See Selection.priorArtGate.
    priorArtGate: false,
    agentTargets: [...FRESH_DEFAULT_AGENT_PROVIDERS],
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
export function applyOverlayConstraints(sel: Selection): Selection {
  return {
    ...sel,
    tsconfig: false,
    structure: false,
    searchSteering: false,
    searchCode: false,
    oxc: false,
    husky: true,
  };
}

/** Normalise a (possibly partial) selection to a full one — missing keys take recommended defaults. */
export function normalizeSelection(partial: Partial<Selection> = {}): Selection {
  const base = defaultSelection();
  return {
    ...base,
    ...partial,
    agentTargets: Array.isArray(partial.agentTargets)
      ? normalizeAgentProviders(partial.agentTargets)
      : base.agentTargets,
    guards: partial.guards ? partial.guards.filter((g) => GUARD_IDS.includes(g)) : base.guards,
  };
}

/**
 * Bundled gates absent from a RECORDED selection, split by recommend-status. `normalizeSelection`
 * replays the recorded `guards` array verbatim, so a gate shipped after a repo's last install is
 * never in it; `upgrade` and `doctor` call this to reconcile the recorded set against the current
 * bundle (`GUARD_IDS`). Both lists are REPORTED, never applied: `upgrade` pre-checks `recommended`
 * in the wizard and prints both otherwise. Neither is auto-added — the recorded selection is
 * authoritative, because a consumer who removes a gate has a reason devkit cannot see (frink runs
 * `decisions` hand-placed after its free gates, so the managed copy is a duplicate LLM call), and
 * silently healing it back means the config says one thing while the hook does another.
 */
export function newBundledGates(recorded: string[]): { recommended: string[]; optIn: string[] } {
  const missing = GUARD_IDS.filter((g) => !recorded.includes(g));
  return {
    recommended: missing.filter((g) => RECOMMENDED_GUARD_IDS.includes(g)),
    optIn: missing.filter((g) => !RECOMMENDED_GUARD_IDS.includes(g)),
  };
}

/** The selection inputs that decide WHICH bundled skills a repo gets — see {@link skillNamesForSelection}. */
export interface SkillSelection {
  guards?: string[];
}

/**
 * Narrow the bundled skill set to the ones this repo's selection actually asked for. Everything
 * unnamed here ships unconditionally; a skill appears in this filter only when it is tied to a
 * component the consumer can decline:
 *   - `decisions` — companion to the `decisions` guard; useless without the gate that runs it.
 *   - `i-have-adhd` — NEVER synced here. It is vendored third-party content devkit owns and pins,
 *     so it ships to `.devkit/vendored-skills/` (install/adhd-skill.mts) instead of the consumer's
 *     `.claude/skills/`, which is where their OWN hand-authored skills live. The constant `false`
 *     is load-bearing twice over: it keeps the skill out of the agent surfaces, and it is what
 *     drives the reclamation below to delete the copy earlier releases wrote there.
 *
 * Lives here, beside the Selection it reads, because it has TWO consumers that must agree: the
 * writer (syncSkills, which decides what to copy) and the reader (doctor's checkAgentAssets, which
 * decides what SHOULD be there). They drifted apart once already — doctor kept its own inline copy
 * of the decisions rule — and a repo that declines a skill the reader still expects gets a false
 * DRIFT on every run.
 *
 * Deselecting a skill is also what makes syncSkills' manifest reclamation delete its directory, so
 * this filter is the removal path too — there is no separate uninstall step.
 */
export function skillNamesForSelection(
  allNames: string[],
  { guards = [] }: SkillSelection = {},
): string[] {
  return allNames.filter((name) => {
    if (name === 'decisions') return guards.includes('decisions');
    if (name === 'i-have-adhd') return false;
    return true;
  });
}

/** An opt-in add-on `upgrade` can offer once to a repo that predates it. */
export interface OptionalComponent {
  id: ComponentToggleId;
  /**
   * WHAT the consumer actually gets. `component` is devkit's internal word for a selection toggle;
   * it says nothing about the thing being installed, so every user-facing string is rendered from
   * this instead ("the i-have-adhd skill", not "the adhd component").
   */
  kind: 'skill' | 'hook' | 'tool';
  label: string;
  hint: string;
  /** The `devkit init` flag that enables it — printed in the non-TTY notice. */
  flag: string;
  /** devkit version that first shipped it (documentation for the reader of this table). */
  since: string;
}

/**
 * The opt-in ADD-ONS `devkit upgrade` offers ONCE to repos that predate them — currently skills.
 * The analog of {@link newBundledGates} for the non-gate half, and the reason a new opt-in add-on no
 * longer needs its own bespoke `upgrade` step (the line-growth block, step 3b, predates this).
 *
 * Each entry is a selectable `Selection` toggle — a "component" in devkit's internal vocabulary —
 * but that word describes the MECHANISM, not the thing. `kind` carries the thing, and all copy is
 * rendered from it, so a user is never told they are installing a "component".
 *
 * Only genuinely OPTIONAL entries belong here — never a recommended one. A recommended component
 * arrives through the ordinary init/upgrade refresh; this table is for what a repo must choose.
 */
export const OPTIONAL_COMPONENTS: OptionalComponent[] = [
  {
    id: 'adhd',
    kind: 'skill',
    label: 'i-have-adhd',
    hint: 'ADHD-friendly output style — a vendored MIT skill, always-on via a SessionStart hook',
    flag: '--adhd',
    since: '0.47.0',
  },
  {
    id: 'priorArtGate',
    kind: 'hook',
    label: 'prior-art gate',
    hint: 'deny-once PreToolUse gate: plans must run (or explicitly skip) step-0 prior-art',
    flag: '--prior-art-gate',
    since: '0.51.0',
  },
  {
    id: 'oxc',
    kind: 'tool',
    label: 'Oxc',
    hint: 'pinned Oxlint/Oxfmt runtime + repository config (optional, off by default)',
    flag: '--oxc',
    since: '0.52.0',
  },
];

/**
 * The optional components this repo has never been ASKED about — an ABSENT recorded key, not a
 * falsy one. That distinction is the whole mechanism: `applyInit` writes every component key on
 * every run, so a repo that answered — yes OR no — carries the key and is never asked again, while
 * a repo whose config predates the component has no key at all. No per-repo "offers made" state to
 * maintain, and a decline is durable (the same no-re-nag guarantee as upgrade's line-growth step).
 *
 * MUST be handed the RAW recorded `components` block. `normalizeSelection` fills defaults, which
 * would make every repo look like it had already declined.
 */
export function unofferedComponents(recorded: Partial<Selection> | undefined): OptionalComponent[] {
  return OPTIONAL_COMPONENTS.filter((c) => recorded?.[c.id] === undefined);
}

/**
 * Strip the components nobody was actually ASKED about from a `components` block about to be
 * written, so an absent key stays absent (see {@link unofferedComponents}). Only drops a key that
 * was already missing — once a repo has answered, its recorded value is preserved and rewritten.
 *
 * Every config writer must run this, not just the one that happens to prompt: `devkit upgrade`
 * refreshes package AND overlay repos through different writers, and a writer that skips it records
 * the normalized `false` as a decision nobody made, permanently suppressing the offer.
 */
export function dropUndecided<T extends Record<string, unknown>>(
  components: T,
  undecided: string[] = [],
  previous: Partial<Selection> | undefined,
): T {
  for (const id of undecided) {
    if (previous?.[id as ComponentToggleId] === undefined) delete components[id];
  }
  return components;
}
