/** `devkit anti-slop` — explicit, deterministic shrink-only baseline operations. */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withLock } from '../../lib/atomic-write.mts';
import { AntiSlopCapabilityError } from '../../lib/install/anti-slop/base-capability.mts';
import {
  type AntiSlopBaseline,
  baselineFromGroups,
  baselineIncreases,
  compareBaseline,
  migrateBaselineRenames,
  pruneBaseline,
  readBaseline,
  writeBaseline,
} from '../../lib/install/anti-slop/baseline.mts';
import {
  ANTI_SLOP_BASELINE_LOCK_REL,
  ANTI_SLOP_BASELINE_REL,
} from '../../lib/install/anti-slop/constants.mts';
import type { FindingGroup } from '../../lib/install/anti-slop/diagnostics.mts';
import {
  type GitBaselineEnvelope,
  gitBaselineEnvelope,
  withBaseAntiSlopSnapshot,
  withStagedAntiSlopSnapshot,
} from '../../lib/install/anti-slop/git-snapshot.mts';
import {
  collectAntiSlopGroups,
  resolveAntiSlopScope,
} from '../../lib/install/anti-slop/runner.mts';

export const meta = {
  name: 'anti-slop',
  summary: 'Check vendored anti-slop rules with an explicit shrink-only baseline.',
  help: `devkit anti-slop — baseline-aware checks for Devkit's vendored Oxlint plugin.

Usage:
  devkit anti-slop create [--force] [paths...]   Explicitly snapshot current findings
  devkit anti-slop check [paths...]              Check working-tree findings (read-only)
  devkit anti-slop check --staged                Check the exact Git index against HEAD
  devkit anti-slop check --base <git-ref>         Full check + baseline monotonicity for CI
  devkit anti-slop inspect [--json]              Inspect baseline debt without linting
  devkit anti-slop prune [paths...]              Remove fixed debt; never add findings

Configure per-rule off/warn/error and scoped overrides in the repository Oxlint config. Paths default
to the repository root. Check and inspect never write. Create refuses an existing baseline unless
--force is explicit; prune refuses to write while new error-severity findings exist.`,
};

function baselineOrExplain(cwd: string): AntiSlopBaseline | null {
  const baseline = readBaseline(cwd);
  if (!baseline) {
    console.error(
      `anti-slop: ${ANTI_SLOP_BASELINE_REL} is missing; run \`devkit anti-slop create\` explicitly`,
    );
  }
  return baseline;
}

function count(groups: readonly { count: number }[]): number {
  return groups.reduce((sum, group) => sum + group.count, 0);
}

function capabilityReady(cwd: string): boolean {
  if (existsSync(join(cwd, '.devkit', 'anti-slop', 'manifest.json'))) return true;
  console.error('anti-slop: not installed — run `devkit init --anti-slop`');
  return false;
}

function printNew(groups: Array<FindingGroup & { additionalCount: number }>): void {
  for (const group of groups) {
    const tag = group.severity === 'error' ? 'ERROR' : 'WARN';
    console.log(
      `${tag} ${group.ruleId} ${group.file}:${group.line}:${group.column} (+${group.additionalCount})`,
    );
    console.log(`      ${group.diagnostic}`);
  }
}

function create(cwd: string, args: string[], force: boolean): number {
  if (!capabilityReady(cwd)) return 2;
  return withLock(join(cwd, ANTI_SLOP_BASELINE_LOCK_REL), () => {
    const path = join(cwd, ANTI_SLOP_BASELINE_REL);
    if (existsSync(path) && !force) {
      console.error(
        `anti-slop: ${ANTI_SLOP_BASELINE_REL} already exists; use prune, or --force to replace it explicitly`,
      );
      return 2;
    }
    const existing = existsSync(path) && args.length > 0 ? readBaseline(cwd) : null;
    const groups = collectAntiSlopGroups(cwd, args);
    const next = baselineFromGroups(groups);
    if (existing) {
      const scope = resolveAntiSlopScope(cwd, args);
      next.entries = [
        ...existing.entries.filter((entry) => !scope.includes(entry.file)),
        ...next.entries,
      ].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
    }
    writeBaseline(cwd, next);
    console.log(
      `anti-slop: created ${ANTI_SLOP_BASELINE_REL} with ${count(next.entries)} finding(s) in ${next.entries.length} fingerprint(s)`,
    );
    return 0;
  });
}

function checkBaselineEnvelope(
  candidate: AntiSlopBaseline,
  envelope: GitBaselineEnvelope | null,
): number {
  if (!envelope?.base) return 0; // one-time bootstrap: the base commit has no baseline
  const staleRenames = candidate.entries.flatMap((entry) => {
    const nextFile = envelope.renames.get(entry.file);
    return nextFile ? [{ ...entry, nextFile }] : [];
  });
  if (staleRenames.length > 0) {
    for (const entry of staleRenames) {
      console.error(
        `BASELINE-RENAME ${entry.ruleId} ${entry.file} -> ${entry.nextFile} (${entry.count} adopted finding(s))`,
      );
    }
    console.error(
      'anti-slop: FAIL — persist renamed debt with `devkit anti-slop create --force`, then stage the baseline',
    );
    return 1;
  }
  const increases = baselineIncreases(envelope.base, candidate, envelope.renames);
  if (increases.length === 0) return 0;
  for (const entry of increases) {
    console.error(
      `BASELINE-GROWTH ${entry.ruleId} ${entry.file} (+${entry.additionalCount} adopted finding(s))`,
    );
  }
  console.error(
    'anti-slop: FAIL — the committed baseline may only shrink; fix the finding instead of adopting it',
  );
  return 1;
}

/** Name what the allowance forgave: it is transient, so silence would hide adopted debt. */
function reportInheritedForgiveness(
  before: ReadonlyArray<FindingGroup & { additionalCount: number }>,
  after: ReadonlyArray<FindingGroup & { additionalCount: number }>,
): void {
  // Keyed by fingerprint, the baseline's own identity: a location key collides when one rule
  // reports two messages at one span.
  const remaining = new Map(after.map((group) => [group.fingerprint, group.additionalCount]));
  const perRule = new Map<string, number>();
  for (const group of before) {
    const forgiven = group.additionalCount - (remaining.get(group.fingerprint) ?? 0);
    if (forgiven > 0) perRule.set(group.ruleId, (perRule.get(group.ruleId) ?? 0) + forgiven);
  }
  if (perRule.size === 0) return;
  const total = [...perRule.values()].reduce((sum, count) => sum + count, 0);
  const rules = [...perRule.keys()].sort((a, b) => a.localeCompare(b));
  console.log(
    `anti-slop: base allowance forgave ${total} inherited finding(s) across ${rules.length} rule(s): ${rules.join(', ')}`,
  );
}

function inheritedBaseAllowance(
  cwd: string,
  capabilityCwd: string | null,
  selected: AntiSlopBaseline,
  candidateGroups: readonly FindingGroup[],
  envelope: GitBaselineEnvelope | null,
): AntiSlopBaseline {
  if (!envelope?.base || !envelope.baseTree) return selected;
  const candidateNew = compareBaseline(selected, candidateGroups).newGroups;
  if (candidateNew.length === 0) return selected;

  const reverseRenames = new Map(
    [...envelope.renames].map(([basePath, candidatePath]) => [candidatePath, basePath]),
  );
  const basePaths = [
    ...new Set(
      candidateNew.flatMap((group) =>
        envelope.introducedPaths.has(group.file)
          ? []
          : [reverseRenames.get(group.file) ?? group.file],
      ),
    ),
  ];
  return withBaseAntiSlopSnapshot(
    envelope.baseCheckoutCwd ?? cwd,
    capabilityCwd ?? cwd,
    envelope.baseTree,
    basePaths,
    (snapshot) => {
      if (snapshot.paths.length === 0) return selected;
      let baseGroups: FindingGroup[];
      try {
        baseGroups = collectAntiSlopGroups(snapshot.cwd, snapshot.paths);
      } catch (error: unknown) {
        // Residual failure is the base tree's own consumer state. Skipping the allowance blames
        // MORE, never less, so degrade loudly instead of hiding the finding (sc-2084).
        if (!(error instanceof AntiSlopCapabilityError)) throw error;
        console.error(
          `anti-slop: inherited base allowance skipped — ${error.issue}; inherited findings may be reported as new`,
        );
        return selected;
      }
      const inherited = migrateBaselineRenames(baselineFromGroups(baseGroups), envelope.renames);
      const entries = new Map(selected.entries.map((entry) => [entry.fingerprint, entry]));
      for (const entry of inherited.entries) {
        const committed = entries.get(entry.fingerprint);
        if (!committed || entry.count > committed.count) entries.set(entry.fingerprint, entry);
      }
      return {
        ...selected,
        entries: [...entries.values()].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint)),
      };
    },
  );
}

function check(cwd: string, args: string[], envelope: GitBaselineEnvelope | null = null): number {
  const baseline = baselineOrExplain(cwd);
  if (!baseline) return 2;
  const envelopeStatus = checkBaselineEnvelope(baseline, envelope);
  if (envelopeStatus !== 0) return envelopeStatus;
  const scope = resolveAntiSlopScope(cwd, args);
  const selected: AntiSlopBaseline = {
    ...baseline,
    entries: baseline.entries.filter((entry) => scope.includes(entry.file)),
  };
  // The base comparison must judge the SAME capability the candidate was linted with; pinning it
  // inside that lint's own lock keeps a concurrent capability sync from swapping it underneath.
  const pin =
    envelope?.base && envelope.baseTree
      ? mkdtempSync(join(tmpdir(), 'devkit-anti-slop-capability-'))
      : null;
  try {
    const candidateGroups = collectAntiSlopGroups(cwd, args, pin ?? undefined);
    const allowance = inheritedBaseAllowance(cwd, pin, selected, candidateGroups, envelope);
    const comparison = compareBaseline(allowance, candidateGroups);
    printNew(comparison.newGroups);
    reportInheritedForgiveness(
      compareBaseline(selected, candidateGroups).newGroups,
      comparison.newGroups,
    );
    const errors = comparison.newGroups.filter((group) => group.severity === 'error');
    const warnings = comparison.newGroups.filter((group) => group.severity === 'warning');
    if (errors.length > 0) {
      console.error(
        `anti-slop: FAIL — ${errors.reduce((sum, group) => sum + group.additionalCount, 0)} new error finding(s); baseline unchanged`,
      );
      return 1;
    }
    console.log(
      `anti-slop: PASS — ${comparison.currentCount} current finding(s), ${comparison.resolvedCount} ready to prune${warnings.length ? `, ${warnings.length} warning fingerprint(s)` : ''}`,
    );
    return 0;
  } finally {
    if (pin) rmSync(pin, { recursive: true, force: true });
  }
}

function inspect(cwd: string, json: boolean): number {
  const baseline = baselineOrExplain(cwd);
  if (!baseline) return 2;
  if (json) {
    console.log(JSON.stringify(baseline, null, 2));
    return 0;
  }
  const perRule = new Map<string, number>();
  for (const entry of baseline.entries)
    perRule.set(entry.ruleId, (perRule.get(entry.ruleId) ?? 0) + entry.count);
  console.log(
    `anti-slop baseline: ${baseline.entries.reduce((sum, entry) => sum + entry.count, 0)} finding(s), ${baseline.entries.length} fingerprint(s)`,
  );
  for (const [rule, findings] of [...perRule].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${String(findings).padStart(5)}  ${rule}`);
  }
  return 0;
}

function prune(cwd: string, args: string[]): number {
  if (!capabilityReady(cwd)) return 2;
  return withLock(join(cwd, ANTI_SLOP_BASELINE_LOCK_REL), () => {
    const baseline = baselineOrExplain(cwd);
    if (!baseline) return 2;
    const scope = resolveAntiSlopScope(cwd, args);
    const groups = collectAntiSlopGroups(cwd, args);
    const selected: AntiSlopBaseline = {
      ...baseline,
      entries: baseline.entries.filter((entry) => scope.includes(entry.file)),
    };
    const comparison = compareBaseline(selected, groups);
    printNew(comparison.newGroups);
    if (comparison.newGroups.some((group) => group.severity === 'error')) {
      console.error('anti-slop: prune refused — new error finding(s) exist; baseline unchanged');
      return 1;
    }
    const pruned = pruneBaseline(selected, groups);
    const next: AntiSlopBaseline = {
      ...baseline,
      entries: [
        ...baseline.entries.filter((entry) => !scope.includes(entry.file)),
        ...pruned.entries,
      ].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint)),
    };
    writeBaseline(cwd, next);
    console.log(
      `anti-slop: pruned ${comparison.resolvedCount} fixed finding(s); ${next.entries.reduce((sum, entry) => sum + entry.count, 0)} remain`,
    );
    return 0;
  });
}

export default function run(args: string[], cwd: string): number {
  const [operation, ...rest] = args;
  const separator = rest.indexOf('--');
  const options = separator >= 0 ? rest.slice(0, separator) : rest;
  const trailingPaths = separator >= 0 ? rest.slice(separator + 1) : [];
  const force = options.includes('--force');
  const json = options.includes('--json');
  const staged = options.includes('--staged');
  const baseIndex = options.indexOf('--base');
  const baseRef = baseIndex >= 0 ? options[baseIndex + 1] : undefined;
  if (baseIndex >= 0 && (!baseRef || baseRef.startsWith('-'))) {
    console.error('anti-slop: --base requires a Git ref');
    return 2;
  }
  const consumed = new Set<number>();
  if (baseIndex >= 0) {
    consumed.add(baseIndex);
    consumed.add(baseIndex + 1);
  }
  const paths = [
    ...options.filter(
      (arg, index) =>
        arg !== '--force' && arg !== '--json' && arg !== '--staged' && !consumed.has(index),
    ),
    ...(separator >= 0 ? ['--', ...trailingPaths] : []),
  ];
  if (force && operation !== 'create') {
    console.error('anti-slop: --force is accepted only by create');
    return 2;
  }
  if (json && operation !== 'inspect') {
    console.error('anti-slop: --json is accepted only by inspect');
    return 2;
  }
  if (staged && operation !== 'check') {
    console.error('anti-slop: --staged is accepted only by check');
    return 2;
  }
  if (baseRef && operation !== 'check') {
    console.error('anti-slop: --base is accepted only by check');
    return 2;
  }
  if (staged && (baseRef || paths.length > 0)) {
    console.error('anti-slop: --staged uses the complete Git index and accepts no paths or --base');
    return 2;
  }
  if (operation === 'create') return create(cwd, paths, force);
  if (operation === 'check' && staged) {
    return withStagedAntiSlopSnapshot(cwd, (snapshot) => {
      if (snapshot.skipped) {
        console.log('anti-slop: PASS — no relevant staged files or configuration changes');
        return 0;
      }
      return check(snapshot.cwd, snapshot.paths, snapshot);
    });
  }
  if (operation === 'check') {
    const envelope = baseRef ? gitBaselineEnvelope(cwd, baseRef) : null;
    return check(cwd, paths, envelope);
  }
  if (operation === 'inspect') {
    if (paths.length > 0 || force) {
      console.error('anti-slop inspect accepts only --json');
      return 2;
    }
    return inspect(cwd, json);
  }
  if (operation === 'prune') return prune(cwd, paths);
  console.error('devkit anti-slop: expected create, check, inspect, or prune');
  return 2;
}
