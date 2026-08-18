/** `devkit anti-slop` — explicit, deterministic shrink-only baseline operations. */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { withLock } from '../../lib/atomic-write.mts';
import {
  type AntiSlopBaseline,
  baselineFromGroups,
  compareBaseline,
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
  collectAntiSlopGroups,
  resolveAntiSlopScope,
} from '../../lib/install/anti-slop/runner.mts';

export const meta = {
  name: 'anti-slop',
  summary: 'Check vendored anti-slop rules with an explicit shrink-only baseline.',
  help: `devkit anti-slop — baseline-aware checks for Devkit's vendored Oxlint plugin.

Usage:
  devkit anti-slop create [--force] [paths...]   Explicitly snapshot current findings
  devkit anti-slop check [paths...]              Fail on new error-severity findings (read-only)
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

function check(cwd: string, args: string[]): number {
  const baseline = baselineOrExplain(cwd);
  if (!baseline) return 2;
  const scope = resolveAntiSlopScope(cwd, args);
  const selected: AntiSlopBaseline = {
    ...baseline,
    entries: baseline.entries.filter((entry) => scope.includes(entry.file)),
  };
  const comparison = compareBaseline(selected, collectAntiSlopGroups(cwd, args));
  printNew(comparison.newGroups);
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
  const paths = [
    ...options.filter((arg) => arg !== '--force' && arg !== '--json'),
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
  if (operation === 'create') return create(cwd, paths, force);
  if (operation === 'check') return check(cwd, paths);
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
