#!/usr/bin/env node
/** Report the judges' provider before the deterministic chain is paid (sc-2538). ADVISORY — never
 *  blocks, reports per MODEL. Why: docs/decisions/judge-outage-classified-not-blocked.md. */
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveGuardConfig } from '../../../../gate-engine/config.mts';
import { readCodexRateLimits } from '../../../../gate-engine/judge/codex/rate-limits.mts';
import { isCodexModel, judgeBinForModel } from '../../../../gate-engine/judge/codex/result.mts';
import { formatResetDelta } from '../../../../gate-engine/judge/outage/classify.mts';
import { claudeLoggedOut, codexLoggedOut } from '../../doctor/judge/judge-auth.mts';
import { binResolvable, resolvedJudgeModels } from '../../doctor/judge/judge-family.mts';
import { readJson } from '../../fs-helpers.mts';

/** The three roles, in the order a cascade reaches them, for a report that reads like the run. */
const ROLES = ['review', 'escalation', 'correctness'] as const;

type Reachability = 'ok' | 'absent' | 'unauthenticated' | 'rate-limited' | 'unknown';

interface ModelStatus {
  role: (typeof ROLES)[number];
  model: string;
  bin: string;
  state: Reachability;
  /** Filled only for `rate-limited`, and only when the provider named a reset. */
  resetsAt?: number;
  /** Window consumption, when the provider reported it — the early warning a lock does not give. */
  usedPercent?: number;
  /** The window that percentage is measured over, so "80% used" carries its own urgency. */
  windowMins?: number;
}

interface DevkitConfig {
  components?: { guards?: string[] };
}

/** Is the reviewer gate even selected? A repo that runs no judges must be byte-identical to
 *  before. Mirrors the `reviewSelected` gating in cli/lib/doctor/guard-config-checks.mts. */
export function reviewGuardSelected(root: string): boolean {
  try {
    return (
      readJson<DevkitConfig>(join(root, '.devkit', 'config.json'))?.components?.guards?.includes(
        'review',
      ) === true
    );
  } catch {
    // An unparseable or absent recorded selection is not evidence either way. Staying silent is the
    // advisory-safe reading: this check may never be the reason anything changes.
    return false;
  }
}

export interface PreflightDeps {
  resolvable: (name: 'codex' | 'claude', cwd: string) => boolean;
  codexOut: () => boolean;
  claudeOut: () => boolean;
  rateLimits: () => Promise<Awaited<ReturnType<typeof readCodexRateLimits>>>;
}

const DEFAULT_DEPS: PreflightDeps = {
  resolvable: binResolvable,
  codexOut: () => codexLoggedOut(),
  claudeOut: () => claudeLoggedOut(),
  rateLimits: () => readCodexRateLimits(),
};

/** Classify every resolved judge model, cheapest check first. The rate-limit RPC runs at most ONCE
 *  per report even with three codex roles, because they share one account. */
export async function judgeReachability(
  root: string,
  deps: PreflightDeps = DEFAULT_DEPS,
): Promise<ModelStatus[]> {
  const cfg = resolveGuardConfig(root);
  const models = resolvedJudgeModels(cfg);
  const statuses: ModelStatus[] = [];

  // Resolved once per provider, not per model: three roles on one subscription share one answer,
  // and asking three times would triple the latency of the thing meant to save time.
  let codexLimits: Awaited<ReturnType<typeof readCodexRateLimits>> | undefined;
  const codexNeeded = models.some((m) => isCodexModel(m));
  const codexPresent = codexNeeded && deps.resolvable('codex', root);
  const codexDark = codexPresent && deps.codexOut();
  if (codexPresent && !codexDark) codexLimits = await deps.rateLimits();
  const claudeNeeded = models.some((m) => !isCodexModel(m));
  const claudePresent = claudeNeeded && deps.resolvable('claude', root);
  const claudeDark = claudePresent && deps.claudeOut();

  for (const [i, model] of models.entries()) {
    const bin = judgeBinForModel(model);
    const status: ModelStatus = { role: ROLES[i], model, bin, state: 'unknown' };
    if (isCodexModel(model)) {
      if (!codexPresent) status.state = 'absent';
      else if (codexDark) status.state = 'unauthenticated';
      else if (codexLimits?.reached) status.state = 'rate-limited';
      else if (codexLimits) status.state = 'ok';
      // else: the RPC said nothing this version understands — 'unknown', reported as such.
      if (codexLimits?.resetsAt !== undefined) status.resetsAt = codexLimits.resetsAt;
      if (codexLimits?.usedPercent !== undefined) status.usedPercent = codexLimits.usedPercent;
      if (codexLimits?.windowDurationMins !== undefined)
        status.windowMins = codexLimits.windowDurationMins;
    } else if (!claudePresent) status.state = 'absent';
    else if (claudeDark) status.state = 'unauthenticated';
    else {
      // No cheap claude quota query exists (anthropics/claude-code#40395 is open), so binary +
      // auth is the whole truth: "reachable" claims nothing about remaining headroom.
      status.state = 'ok';
    }
    statuses.push(status);
  }
  return statuses;
}

/** "7d" / "5h" — the window a percentage is measured over, in the unit it was configured in. */
function describeWindow(mins: number): string {
  if (mins % (24 * 60) === 0) return `${mins / (24 * 60)}d`;
  if (mins % 60 === 0) return `${mins / 60}h`;
  return `${mins}m`;
}

/** Render the report, in the style of `guard-size preflight`. The consequence and remedy appear
 *  only when something is wrong, phrased so an agent cannot read it as "retry and it will work". */
export function renderPreflight(statuses: ModelStatus[], now: number = Date.now()): string[] {
  if (statuses.length === 0) return [];
  const lines = ['guard-judge preflight — judge reachability, before the gate chain'];
  for (const s of statuses) {
    const detail: string[] = [];
    if (s.usedPercent !== undefined) {
      const window =
        s.windowMins === undefined ? 'window' : `${describeWindow(s.windowMins)} window`;
      detail.push(`${Math.round(s.usedPercent)}% of a ${window} used`);
    }
    if (s.state === 'rate-limited' && s.resetsAt !== undefined)
      detail.push(`resets in ${formatResetDelta(s.resetsAt, now)}`);
    const suffix = detail.length > 0 ? ` (${detail.join(', ')})` : '';
    const verdict =
      s.state === 'ok'
        ? 'reachable'
        : s.state === 'absent'
          ? `\`${s.bin}\` not installed or not on PATH`
          : s.state === 'unauthenticated'
            ? `\`${s.bin}\` not authenticated`
            : s.state === 'rate-limited'
              ? 'USAGE LIMIT REACHED'
              : 'not verified';
    lines.push(`  ${s.role}: ${s.model} via ${s.bin} — ${verdict}${suffix}`);
  }

  const blocked = statuses.filter((s) => s.state !== 'ok' && s.state !== 'unknown');
  if (blocked.length === 0) return lines;

  const locked = blocked.filter((s) => s.state === 'rate-limited');
  const reset = locked.find((s) => s.resetsAt !== undefined)?.resetsAt;
  lines.push(
    '⚠️  guard-judge preflight: the gates below will still run, but every reviewer that is not ' +
      'already cached will fail closed.',
  );
  // Avoids the word "transient" rather than negating it: an agent grepping for that label must
  // not find it here, since a six-day lock wearing it is why this line exists.
  if (locked.length > 0)
    lines.push(
      reset === undefined
        ? '   A usage limit does not clear on its own — re-running will not help.'
        : `   A usage limit does not clear on its own — re-running will not help for another ${formatResetDelta(reset, now)}.`,
    );
  // Naming the override, never taking it: a runtime cross-family swap moves spend to an unwatched
  // subscription and puts its verdicts outside the model-keyed cache salt (review-gate-in-chain).
  lines.push(
    '   To ship inside this window, move the judges to another family: `devkit doctor --fix` ' +
      'binds the claude family when codex is unresolvable, or set GUARD_REVIEW_MODEL / ' +
      'GUARD_REVIEW_ESCALATION_MODEL / GUARD_CORRECTNESS_MODEL to claude-family ids for this run.',
  );
  return lines;
}

async function main(argv: string[]): Promise<number> {
  const root = argv[0];
  if (!root) {
    console.error('usage: ship preflight judge <consumer-root>');
    return 2;
  }
  if (!reviewGuardSelected(root)) return 0;
  const statuses = await judgeReachability(root);
  for (const line of renderPreflight(statuses)) console.error(line);
  return 0;
}

// Entry only when this file IS the entry point: a substring test on argv[1] would also fire for
// this module's own test file, and the body below calls process.exit(). realpathSync, not resolve —
// a bin shim is a symlink, and cli/__tests__/bin-run-as-main.test.mts enforces that repo-wide.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2))
    // Nothing this module can hit is worth failing a ship over — an unexpected throw is the same
    // "could not run" as a timeout, and the shell maps 2 to a warn.
    .then((code) => process.exit(code))
    .catch(() => process.exit(2));
}
