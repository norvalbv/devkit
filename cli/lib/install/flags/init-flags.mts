/**
 * `devkit init` flag parsing — the InitFlags shape, the argv parser, and the flags→Selection
 * resolution for the --yes / non-TTY path. Extracted from cli/commands/init.mts (which retains
 * the apply layer); review-policy flags stay in review-profile.mts and compose in here.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  defaultSelection,
  GUARD_IDS,
  normalizeSelection,
  type Selection,
  STRUCTURE_STACKS,
  unofferedComponents,
} from '../../components.mts';
import { detectGitRoot } from '../../detect-git-root.mts';
import { readJson } from '../../fs-helpers.mts';
import { resolveExistingAgentProviders } from '../agent-assets/agent-providers.mts';
import { parseReviewFlags, type ReviewFlagValues } from './review-profile.mts';

export interface InitFlags extends ReviewFlagValues {
  yes: boolean;
  dryRun: boolean;
  force: boolean;
  stack: string | null;
  removeDeselected: boolean;
  fallow: boolean;
  /** One-release compatibility signal for the retired no-op `--oxc` flag. */
  legacyOxc: boolean;
  antiSlop: boolean;
  searchSteering: boolean;
  agentHooks: boolean;
  searchCode: boolean;
  adhd: boolean;
  priorArtGate: boolean;
  standalone: boolean;
  overlay: boolean;
  baselinesOnly: boolean;
  no: Set<string>;
  guards: string[] | null;
  scanRoots: string[] | null;
  // Opt-in overlay-only flag; set lazily when --global-commit-gate is passed.
  globalCommitGate?: boolean;
}

const guardDisableFlag = (guard: string) => (guard === 'review' ? 'review-gate' : guard);

export function disabledGuardsFromFlags(flags: Pick<InitFlags, 'guards' | 'no'>): string[] {
  if (flags.no.has('guards')) return [...GUARD_IDS];
  return GUARD_IDS.filter(
    (guard) =>
      (flags.guards !== null && !flags.guards.includes(guard)) ||
      flags.no.has(guardDisableFlag(guard)),
  );
}

export function parseFlags(args: string[]): InitFlags {
  const flags: InitFlags = {
    yes: false,
    dryRun: false,
    force: false,
    stack: null,
    removeDeselected: false,
    fallow: false,
    legacyOxc: false,
    antiSlop: false,
    searchSteering: false,
    agentHooks: false,
    searchCode: false,
    adhd: false,
    priorArtGate: false,
    standalone: false,
    overlay: false,
    baselinesOnly: false,
    no: new Set(),
    guards: null,
    scanRoots: null,
    ...parseReviewFlags(args),
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--yes' || a === '-y') flags.yes = true;
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--force') flags.force = true;
    else if (a === '--remove-deselected') flags.removeDeselected = true;
    else if (a === '--fallow') flags.fallow = true;
    else if (a === '--oxc') flags.legacyOxc = true;
    else if (a === '--anti-slop') flags.antiSlop = true;
    else if (a === '--search-steering') flags.searchSteering = true;
    else if (a === '--agent-hooks') flags.agentHooks = true;
    else if (a === '--search-code') flags.searchCode = true;
    else if (a === '--adhd') flags.adhd = true;
    else if (a === '--prior-art-gate') flags.priorArtGate = true;
    else if (a === '--standalone') flags.standalone = true;
    else if (a === '--overlay') flags.overlay = true;
    else if (a === '--global-commit-gate') flags.globalCommitGate = true;
    else if (a === '--baselines-only') flags.baselinesOnly = true;
    else if (a === '--stack') flags.stack = args[++i];
    else if (a === '--guards') flags.guards = (args[++i] ?? '').split(',').map((g) => g.trim());
    // --scan-root <comma-list>: override guard.config.json scanRoots up front, so the freezes
    // + the react-app structureRoot grandfather a non-standard tree (e.g. services/webapp/src).
    else if (a === '--scan-root' || a === '--scan-roots')
      flags.scanRoots = (args[++i] ?? '')
        .split(',')
        .map((r) => r.trim())
        .filter(Boolean);
    else if (a.startsWith('--no-')) flags.no.add(a.slice('--no-'.length));
  }
  return flags;
}

export function selectionFromFlags(flags: InitFlags, recorded?: Partial<Selection>): Selection {
  const sel = recorded ? normalizeSelection(recorded) : defaultSelection();
  for (const id of ['biome', 'tsconfig', 'skills', 'agents', 'husky', 'structure'] as const) {
    if (flags.no.has(id)) sel[id] = false;
  }
  if (flags.no.has('guards')) sel.guards = [];
  else if (flags.guards) sel.guards = flags.guards.filter((g) => GUARD_IDS.includes(g));
  const disabledGuards = disabledGuardsFromFlags(flags);
  sel.guards = sel.guards.filter((guard) => !disabledGuards.includes(guard));
  // Line-growth block is recommended-on; --no-line-growth opts out under --yes / non-TTY.
  if (flags.no.has('line-growth')) sel.lineGrowth = false;
  // Opt-ins stay off on a fresh install, but a re-run preserves an existing opt-in unless this
  // invocation explicitly changes it. --no-* wins when both forms are present.
  if (flags.fallow) sel.fallow = true;
  if (flags.no.has('fallow')) sel.fallow = false;
  if (flags.antiSlop) sel.antiSlop = true;
  if (flags.no.has('anti-slop')) sel.antiSlop = false;
  if (flags.legacyOxc) console.warn('  • --oxc is no longer needed: Oxc is core Devkit tooling');
  if (flags.no.has('oxc')) console.warn('  ! --no-oxc is retired and ignored: Oxc is core');
  if (flags.searchSteering) sel.searchSteering = true;
  if (flags.no.has('search-steering')) sel.searchSteering = false;
  if (flags.agentHooks) sel.agentHooks = true;
  if (flags.no.has('agent-hooks')) sel.agentHooks = false;
  if (flags.searchCode) sel.searchCode = true;
  if (flags.no.has('search-code')) sel.searchCode = false;
  // The vendored i-have-adhd skill: opt-in even under --yes (an output-style preference).
  if (flags.adhd) sel.adhd = true;
  if (flags.no.has('adhd')) sel.adhd = false;
  // The prior-art gate denies harness tool calls: opt-in even under --yes.
  if (flags.priorArtGate) sel.priorArtGate = true;
  if (flags.no.has('prior-art-gate')) sel.priorArtGate = false;
  // Preserve recorded providers on a re-run; a fresh base still contains every default provider.
  sel.agentTargets = sel.agentTargets.filter((target) => !flags.no.has(target));
  // The gate's registrations are Claude-only: recording it enabled with no claude surface would
  // install nothing and leave dead config, so deselect it visibly instead.
  if (sel.priorArtGate && !sel.agentTargets.includes('claude')) {
    sel.priorArtGate = false;
    console.warn(
      '  ! prior-art gate skipped: its hooks are Claude-only and the claude surface is deselected',
    );
  }
  return sel;
}

interface RecordedInitConfig {
  stack?: string;
  overlay?: boolean;
  components?: Partial<Selection> & { disabledGuards?: string[] };
}

export interface ResolvedFlagSelection {
  selection: Selection;
  disabledGuards: string[];
  undecided: string[];
}

/** Resolve a non-interactive run as an explicit flag patch over the raw recorded component state. */
export function resolveFlagSelection(
  cwd: string,
  args: string[],
  flags: InitFlags,
): ResolvedFlagSelection {
  const recorded = readJson<RecordedInitConfig>(join(cwd, '.devkit', 'config.json'));
  const recordedComponents = recorded?.components ? { ...recorded.components } : undefined;
  if (recordedComponents && recordedComponents.agentTargets === undefined) {
    const { gitRoot } = detectGitRoot(cwd);
    recordedComponents.agentTargets = resolveExistingAgentProviders(gitRoot, undefined, [
      'skills',
      'agents',
    ]);
  }
  if (recorded?.overlay && recordedComponents && recordedComponents.biome === undefined) {
    recordedComponents.biome = existsSync(join(cwd, 'biome.devkit.jsonc'));
  }
  if (
    flags.stack &&
    recorded?.stack &&
    !STRUCTURE_STACKS.has(recorded.stack) &&
    STRUCTURE_STACKS.has(flags.stack) &&
    recordedComponents?.structure === false &&
    !flags.no.has('structure')
  ) {
    recordedComponents.structure = true;
  }
  let selection = selectionFromFlags(flags, recordedComponents);
  selection = recoverInterruptedCapabilitySelection(cwd, flags, selection);
  const disabledGuards = [
    ...(recorded?.components?.disabledGuards ?? []),
    ...disabledGuardsFromFlags(flags),
  ];
  // normalizeSelection fills absent optionals with false for the apply layer; keep raw absence
  // unless this invocation explicitly answers the optional component's positive/negative flag.
  const undecided = recorded?.components
    ? unofferedComponents(recorded.components)
        .filter(
          (component) =>
            !args.includes(component.flag) && !flags.no.has(component.flag.slice('--'.length)),
        )
        .map((component) => component.id)
    : [];
  return { selection, disabledGuards, undecided };
}

/** Recover managed capabilities published before an interrupted init wrote its component record. */
export function recoverInterruptedCapabilitySelection(
  cwd: string,
  flags: Pick<InitFlags, 'no'>,
  selection: Selection,
): Selection {
  const recorded = readJson(join(cwd, '.devkit', 'config.json')) as {
    components?: unknown;
  } | null;
  if (recorded?.components) return selection;

  if (
    existsSync(join(cwd, '.devkit', 'anti-slop', 'manifest.json')) &&
    !flags.no.has('anti-slop')
  ) {
    selection.antiSlop = true;
  }
  return selection;
}
