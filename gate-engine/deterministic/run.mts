#!/usr/bin/env node

/**
 * guard-deterministic — the SINGLE orchestrator for the deterministic gate set. It replaces the
 * DK_PREFIX_SKIP / DK_DET_FAILS init→append→aggregate shell protocol that every generated hook used
 * to hand-roll (package fragments, standalone lines, overlay reuse) — where a dropped init line read
 * empty and passed real failures as GREEN. The hook now calls this ONE bin, which:
 *   1. runs the deterministic-prefix check — on a cached all-green staged tree (ship only) it SKIPS
 *      every gate;
 *   2. else runs each SELECTED deterministic guard (size, fanout, dup, clone, coverage, anti-slop,
 *      comments) as a subprocess,
 *      capturing its exit code and applying the shared TRICHOTOMY — 1 = real failure (accumulate),
 *      2 = could-not-run (fail-open, continue), any other non-zero = unexpected (accumulate, named);
 *   3. NAMES every gate that opted out, on a green run as loudly as on a red one — a fail-open gate
 *      proved nothing, and its own stderr otherwise scrolls past at the weight of a gate that passed;
 *   4. AGGREGATES every failure into one report and returns 1, or records the prefix key and returns 0.
 *
 * One entry, one exit code, one aggregated report. Invoked once BY NAME (not `bunx guard-*` per
 * guard), so an unknown bin can't be silently fetched from a registry (npm-squat). Each guard runs
 * as `node <sibling module>` so the set resolves identically in package / standalone / overlay mode
 * without a bunx round-trip. The AI guards (decisions, review) are fail-fast and stay OUTSIDE this
 * orchestrator (the hook runs them after); Oxfmt keeps its own format fragment. Structure-lint and
 * repo-specific deterministic gates join the SET via flags, so their failures land in the same
 * aggregated report:
 *   --structure "<cmd>"   run <cmd> as the `structure-lint` gate. A `guard-structure …` command
 *                         runs as the sibling module with the full trichotomy (2 = fail-open);
 *                         any other command (electron's `bunx eslint src`, a repo's own
 *                         lint script) spawns via PATH and BLOCKS on every non-zero
 *                         code (eslint's exit 2 is a fatal config error, not an opt-out).
 *   --extra "<label>=<cmd>"  (repeatable) an arbitrary deterministic gate; non-zero blocks. A
 *                         repo declares more the same way in guard.config.json `extraGates`.
 *   --only "<id,id>"      restrict the built-in set (overrides .devkit/config.json selection) —
 *                         for repos whose gate set is declared in the hook, not a config.
 * Exit contract: 0 = clean or prefix-skip, 1 = one or more real failures.
 *
 * GUARD_DETERMINISTIC_STRICT=1 refuses the fail-open: a gate that opts out is accumulated as
 * `<label>(could-not-run)` and exits 1 like any other failure. Opt-in only — fail-open is the
 * shipped posture. It rejects only a REAL opt-out (a gate whose `failOpen2` says exit 2 means "I
 * chose not to run"); an `--extra` command's fatal exit 2 was never an opt-out and stays
 * `(unexpected:2)`. Exit stays 1, not the AI gates' 3: there is no outage here to distinguish from
 * a finding, only a local condition (no index, no jscpd) the repo can fix.
 */
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { coverageBypassed, deterministicStrict } from '../config.mts';
import { emitGateBypass, emitGateEvent, finishGateTiming } from '../judge/gate-events.mts';
import { markGateRun } from '../judge/run-context.mts';
import { reportOlderOverlayRunner } from '../overlay-mode.mts';
import {
  cachedDegradedNotes,
  type DegradedNote,
  describeCachedPrefix,
  prefixEntry,
  recordPrefix,
} from '../prefix-cache/prefix-cache.mts';
import { crashGuarded, type GateFailure, readGateReason, withReasonFiles } from './reason.mts';
import {
  bypassedSuffixes,
  commandGate,
  emitGateStep,
  extraGatesFor,
  gateTimeoutMs,
  GUARD_PREFIX_RE,
  reportCachedBypasses,
  runArgv,
  type ExtraGate,
  type Gate,
  structureBypassed,
  TIMED_OUT,
  timeoutReason,
} from './command-gates.mts';
import { type ParsedOpts, parseOpts } from './parse-opts.mts';
import { recheckLines, registryRecheck } from './recheck.mts';
import { COULD_NOT_RUN, DETERMINISTIC, gateModulePath } from './registry.mts';
import { z } from 'zod';
import { type FailedGate, reportFailures, reportOptedOut } from './report.mts';
import { canonicalIds, resolveSelection, reviewIds } from './selection.mts';

const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

// What `runDeterministic` accepts: every parsed field is optional, plus an injectable `exec`
// (tests pass a stub; production defaults to execFileSync).
interface RunDeterministicOpts extends Partial<ParsedOpts> {
  exec?: typeof execFileSync;
}

export function prefixCacheScope(scope?: string, effectiveIds?: string[]): string | undefined {
  const reviewMode = process.env.DEVKIT_RUN_MODE === 'review';
  const mergeBase = process.env.DEVKIT_REVIEW_MERGE_BASE;
  const runtime = process.env.DEVKIT_REVIEW_RUNTIME_FINGERPRINT;
  // `git write-tree` identifies only the final snapshot. Deterministic gates inspect the DIFF from
  // HEAD and execute ignored dependency/runtime bytes, so another merge-base or runtime is another
  // gate input. The public runner supplies both fingerprints. Lower-level callers stay isolated in
  // an explicit unmanaged scope instead of sharing ship keys.
  const reviewBase = mergeBase && OBJECT_ID.test(mergeBase) ? mergeBase : 'unmanaged';
  const reviewRuntime = runtime && OBJECT_ID.test(runtime) ? runtime : 'unmanaged';
  const base = reviewMode
    ? `${scope ?? 'devkit-guards'}:review:${canonicalIds(effectiveIds ?? reviewIds()).join(',')}:base:${reviewBase}:runtime:${reviewRuntime}`
    : scope;
  // The same hazard as the coverage salt below, in reverse: a NON-strict run where a gate opted out
  // records an all-green key that a LATER strict run of the identical staged tree would hit —
  // skipping every gate and returning green, so strict never sees the opt-out it exists to reject.
  // Salting keeps the two runs on different keys.
  //
  // This belongs here and not in gateConfigFingerprint (prefix-cache/config-fingerprint.mts), which
  // already stat-proxies the resolved index: that fingerprint covers CONFIG-shaped inputs (what the
  // gates read), while this scope covers RUN-shaped ones (how this invocation judges them). Strict
  // is an env knob on the run, so it salts the scope.
  const strictBase = deterministicStrict()
    ? `${base ?? 'devkit-guards'}:deterministic-strict`
    : base;
  // Same hazard the review salt above exists for, one gate down: a run with the coverage gate
  // bypassed records an all-green key that a LATER un-bypassed run of the identical staged tree
  // would hit — skipping the whole set, so coverage never runs and the one-off bypass has laundered
  // itself into a permanent false green. Salting keeps the two runs on different keys. (Cost: a
  // bypassed run cannot reuse a clean run's key either, so it re-runs the other gates. Same trade
  // the review salt makes — correctness over a cache hit.) `?? 'devkit-guards'` materialises the
  // default scope checkPrefix would otherwise supply internally, or the salt would be lost.
  const coverageBase = coverageBypassed()
    ? `${strictBase ?? 'devkit-guards'}:coverage-bypassed`
    : strictBase;
  // Structure commands are arbitrary (`guard-structure`, Electron's eslint invocation, devkit's
  // own package script), so the bypass lives at this orchestrator layer. Keep its cache namespace
  // apart from a normal run for the same anti-laundering reason as coverage above.
  const structureBase = structureBypassed()
    ? `${coverageBase ?? 'devkit-guards'}:structure-bypassed`
    : coverageBase;
  // Same hazard once more, for devkit's own command gates. Sorted and joined so two runs that
  // bypass the same set share a key regardless of the order the flags were exported in.
  const extraBypassed = bypassedSuffixes();
  const extraBase = extraBypassed.length
    ? `${structureBase ?? 'devkit-guards'}:${extraBypassed.join('+')}-bypassed`
    : structureBase;
  // devkit's release-only-dist command gate judges the tree against the PR base and exempts only a
  // release branch, so a tree's PASS under one base or branch must not authorize another.
  const prBase = process.env.DEVKIT_SHIP_PR_BASE_SHA;
  const prScope = prBase
    ? `${extraBase ?? 'devkit-guards'}:pr-base:${prBase}:branch:${process.env.DEVKIT_SHIP_BRANCH ?? ''}`
    : extraBase;
  // guard-structure judges edited-file debt against HEAD (the ship base), so a PASS is base-bound.
  const shipBase = process.env.DEVKIT_SHIP_BASE_SHA;
  return shipBase ? `${prScope ?? 'devkit-guards'}:ship-base:${shipBase}` : prScope;
}

// runArgv returns a number for an exit, a string for a gate that never reached one (killed, no spawn).
const EXIT_CODE = z.number();

// What one run settled before any gate spawned: computed once, passed to every phase below.
interface RunPlan {
  cwd: string;
  reviewMode: boolean;
  effectiveIds: string[];
  extra: ExtraGate[];
  structure?: string;
  skip: boolean;
  bypassStructure: boolean;
  cachedPrefix: ReturnType<typeof prefixEntry>;
}

// The accumulated result of running the gates. `fails` and `failed` stay index-aligned per gate.
interface GateOutcome {
  fails: GateFailure[];
  failed: FailedGate[];
  rechecks: string[];
  skipped: string[];
  /** afterGreen gates not run because an earlier gate failed. */
  notRun: string[];
  /** Judgements passing registry gates withheld; cached with the PASS so a hit replays them. */
  degraded: DegradedNote[];
}

// A cache hit names the gates it did not re-run and every bypass; otherwise a structure bypass is loud.
function narrateRun(plan: RunPlan): void {
  const { skip, bypassStructure, effectiveIds } = plan;
  if (skip) {
    const extras = plan.extra.map((x) => x.label);
    const flags = reportCachedBypasses([...extras, ...effectiveIds]);
    if (bypassStructure) flags.unshift('GUARD_STRUCTURE_OK');
    if (effectiveIds.includes('coverage') && coverageBypassed()) flags.unshift('GUARD_COVERAGE_OK');
    const labels = plan.structure ? [...extras, 'structure-lint'] : extras;
    console.log(describeCachedPrefix(plan.cachedPrefix?.at, effectiveIds, labels, flags));
    for (const { judge, detail } of cachedDegradedNotes(plan.cachedPrefix)) {
      console.log(`  ↳ still withheld: ${detail}`);
      emitGateEvent({ type: 'gate_degraded', judge, cause: 'cached_prefix', detail });
    }
  } else if (bypassStructure) {
    console.log('⚠️  Structure lint BYPASSED for this run (GUARD_STRUCTURE_OK=1).');
    console.log('   Repository structure was NOT verified for this commit.');
  }
}

function registryGate(g: (typeof DETERMINISTIC)[number], cwd: string, reviewMode: boolean): Gate {
  const argv = ['node', gateModulePath(g), ...g.args];
  return {
    id: g.id,
    label: `guard-${g.id}`,
    failOpen2:
      !('failOpen2' in g) || (g.failOpen2 === 'review' ? reviewMode : g.failOpen2 !== false),
    ...crashGuarded(argv, 'rcLabels' in g ? g.rcLabels : undefined),
    ...registryRecheck(g, argv, cwd),
  };
}

// Registry gates, then `--extra`, then structure-lint. Coverage reads an artifact outside the cached
// key, so a cache hit still judges it afresh and runs nothing else.
function buildGates(plan: RunPlan): Gate[] {
  const { cwd, skip, effectiveIds } = plan;
  const ids = new Set(skip ? effectiveIds.filter((id) => id === 'coverage') : effectiveIds);
  const gates = DETERMINISTIC.filter((g) => ids.has(g.id)).map((g) =>
    registryGate(g, cwd, plan.reviewMode),
  );
  if (skip) return gates;
  for (const x of plan.extra.filter((g) => !g.afterGreen)) {
    gates.push(commandGate(x.label, cwd, x.cmd));
  }
  if (plan.structure && !plan.bypassStructure) {
    gates.push(commandGate('structure-lint', cwd, plan.structure));
  }
  // afterGreen gates are slow, and their verdict on an already-red tree is discarded by the fix.
  for (const x of plan.extra.filter((g) => g.afterGreen)) {
    gates.push({ ...commandGate(x.label, cwd, x.cmd), afterGreen: true });
  }
  return gates;
}

// The single push site, so a failure's verdict is decided where its exit code is read.
function recordFailure(
  out: GateOutcome,
  gate: Gate,
  suffix = '',
  verdict = suffix === '',
  reason: string[] = [],
): void {
  out.fails.push({ id: gate.id, label: `${gate.label}${suffix}`, reason });
  out.failed.push({ gate: gate.label.replace(GUARD_PREFIX_RE, ''), verdict });
  out.rechecks.push(...recheckLines(`${gate.label}${suffix}`, gate));
}

function runGates(
  cwd: string,
  gates: Gate[],
  exec: typeof execFileSync,
  reviewMode: boolean,
): GateOutcome {
  const out: GateOutcome = {
    fails: [],
    failed: [],
    rechecks: [],
    skipped: [],
    notRun: [],
    degraded: [],
  };
  const timeoutMs = gateTimeoutMs(cwd);
  withReasonFiles((fileFor) => {
    gates.forEach((gate, i) => {
      if (gate.afterGreen && out.fails.length > 0 && !reviewMode) {
        out.notRun.push(gate.label);
        return;
      }
      if (gate.notRun) console.log(`${gate.label}: ${gate.notRun}`);
      else if (!gate.argv) {
        recordFailure(out, gate, `(unrunnable: ${gate.unrunnable ?? 'empty command'})`, true);
      }
      if (!gate.argv) return;
      const reasonFile = fileFor(i);
      const startedAt = Date.now();
      console.log(`▶ deterministic: ${gate.label}`);
      const rc = runArgv(cwd, gate.argv, exec, reasonFile, timeoutMs, gate.label);
      const [nFailed, nSkipped] = [out.failed.length, out.skipped.length];
      const code = exitCodeOrBlock(out, gate, rc, timeoutMs, startedAt);
      if (code === null) return;
      const failRc = (suffix = '') =>
        recordFailure(out, gate, suffix, undefined, readGateReason(reasonFile));
      // failOpen2 belongs to the GATE (exit 2 = opt-out), strict to the RUN: so an `--extra`'s
      // fatal exit 2 (never an opt-out) stays `(unexpected:2)` under strict, not a skip.
      // `finally`, so an early return added to this classification still records the gate's step.
      try {
        if (code === 1) failRc();
        else if (gate.rcLabels && Object.hasOwn(gate.rcLabels, code)) failRc(gate.rcLabels[code]);
        else if (code === 2 && gate.failOpen2) {
          if (deterministicStrict()) failRc(COULD_NOT_RUN);
          else out.skipped.push(gate.label);
        } else if (code !== 0) failRc(`(unexpected:${code})`);
        else if (gate.id) noteDegraded(out, gate.id, reasonFile);
      } finally {
        emitGateStep(
          gate.label,
          code,
          startedAt,
          out.failed[nFailed],
          out.skipped.length > nSkipped,
        );
      }
    });
  });
  return out;
}

/** The gate's exit code, or null after recording a gate that never reached one (timed out, killed,
 * did not spawn): no rcLabel, opt-out or strict rule applies, so it blocks as could-not-run. */
function exitCodeOrBlock(
  out: GateOutcome,
  gate: Gate,
  rc: number | string,
  timeoutMs: number,
  startedAt: number,
): number | null {
  const exit = EXIT_CODE.safeParse(rc);
  if (exit.success) return exit.data;
  const failure = String(rc);
  const nFailed = out.failed.length;
  if (rc === TIMED_OUT) {
    recordFailure(out, gate, `(timed-out:${timeoutMs / 1000}s)`, false, timeoutReason(timeoutMs));
  } else {
    const next = failure.startsWith('killed:')
      ? 'Re-run it.'
      : `${gate.argv?.[0]} did not start: check that it exists, is executable and is on PATH.`;
    recordFailure(out, gate, `(${failure})`, false, [
      `${failure}: the gate never reached a verdict, so this is not a code finding. ${next}`,
    ]);
  }
  emitGateStep(gate.label, failure, startedAt, out.failed[nFailed], false);
  return null;
}

/** A passing registry gate's withheld note (its reason file on exit 0), kept for the prefix cache. */
function noteDegraded(out: GateOutcome, judge: string, reasonFile: string): void {
  const note = readGateReason(reasonFile).join(' ');
  if (note) out.degraded.push({ judge, detail: note });
}

// A green run records its prefix key, unless a gate opted out: a later hit would replay a verdict
// never reached. A cache hit is `partial` when coverage still ran, else `full`.
function finishRun(
  plan: RunPlan,
  startedAt: number,
  cache: { hookPath?: string; scope?: string },
  gates: Gate[],
  out: GateOutcome,
): number {
  const { skip, cachedPrefix } = plan;
  if (out.fails.length > 0) {
    reportFailures(out.fails, out.failed, out.rechecks, out.notRun);
    return finishGateTiming('deterministic', startedAt, 1, skip ? 'partial' : 'none');
  }
  if (!skip) {
    const durationMs = Date.now() - startedAt;
    if (out.skipped.length === 0)
      recordPrefix(plan.cwd, { ...cache, durationMs, degraded: out.degraded });
    return finishGateTiming('deterministic', startedAt, 0, 'none');
  }
  const cachedDuration =
    typeof cachedPrefix?.duration_ms === 'number' ? cachedPrefix.duration_ms : undefined;
  return finishGateTiming(
    'deterministic',
    startedAt,
    0,
    gates.length ? 'partial' : 'full',
    cachedDuration,
  );
}

/**
 * Orchestrate the deterministic set. `exec` is injectable for tests (defaults to execFileSync).
 * Returns the single exit code the hook propagates.
 */
export function runDeterministic(cwd = process.cwd(), opts: RunDeterministicOpts = {}) {
  const startedAt = Date.now();
  const extra = extraGatesFor(opts.extra ?? [], cwd);
  const selection = resolveSelection(cwd, opts.only);
  if (!selection || reportOlderOverlayRunner(cwd))
    return finishGateTiming('deterministic', startedAt, 1, 'none');
  const { reviewMode, effectiveIds } = selection;
  // A review may intentionally run a strict subset. Salt the prefix scope so that subset can never
  // authorize a later full ship/commit against the same staged tree.
  const cacheScope = prefixCacheScope(opts.scope, effectiveIds);
  // Deterministic-prefix cache (ship only — a no-op otherwise): a cached all-green staged tree skips
  // every gate. checkPrefix returns true = skip, false = run.
  const cachedPrefix = prefixEntry(cwd, { hookPath: opts.hookPath, scope: cacheScope });
  const skip = Boolean(cachedPrefix) && extra.every((x) => x.cmd);
  const bypassStructure = Boolean(opts.structure) && structureBypassed();
  // Before the cache short-circuit, so every bypassed ATTEMPT counts in telemetry as could_not_run,
  // a cached repeat included.
  if (bypassStructure) emitGateBypass('structure-lint', 'GUARD_STRUCTURE_OK');
  const plan: RunPlan = {
    cwd,
    reviewMode,
    effectiveIds,
    extra,
    structure: opts.structure,
    skip,
    bypassStructure,
    cachedPrefix,
  };
  narrateRun(plan);
  const gates = buildGates(plan);
  const out = runGates(cwd, gates, opts.exec ?? execFileSync, reviewMode);
  // Before the failure report: a GREEN run names its opt-outs too, as does review's verdict line.
  reportOptedOut(out.skipped);
  return finishRun(plan, startedAt, { hookPath: opts.hookPath, scope: cacheScope }, gates, out);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  markGateRun(process.argv.includes('--hook')); // a manual guard-deterministic run stays unmarked
  process.exit(runDeterministic(process.cwd(), parseOpts(process.argv.slice(2))));
}
