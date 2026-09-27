#!/usr/bin/env node
/** sc-1934: refuse a ship whose linked devkit predates `.devkit/baselines` (canonical-only state).
 * Args: <worktree> <consumer-root> <node_modules>. Exit 0 ok, 1 mismatch, 2 could not run. */
import { join } from 'node:path';
import {
  BASELINE_READER_REMEDIATION,
  canonicalOnlyRatchetBaselinesInRepo,
  describeBaselineReaderMismatch,
  stalePinnedBaselineReader,
} from '../../doctor/pin/baseline-reader.mts';
import { readConfig } from '../../doctor/pin/runner-identity.mts';
import { readJson } from '../../fs-helpers.mts';

function run(args: string[]): number {
  const [worktree, root, nodeModules, ...extra] = args;
  if (!worktree || !root || !nodeModules || extra.length > 0) {
    throw new Error('usage: baseline-reader-preflight <worktree> <consumer-root> <node_modules>');
  }
  const installed = readJson<{ version?: string }>(
    join(nodeModules, '@norvalbv', 'devkit', 'package.json'),
  )?.version;
  const reader = stalePinnedBaselineReader(root, installed, readConfig(root));
  if (!reader.stale) return 0;
  // The worktree already holds the applied patch (`git apply --index` precedes this) and is the
  // exact tree the hook judges, so it is the one to scan — the live checkout can move underneath.
  const unread = canonicalOnlyRatchetBaselinesInRepo(worktree);
  if (unread.length === 0) return 0;
  process.stderr.write(
    `devkit ship: ${describeBaselineReaderMismatch(reader.installed, unread)}.\n` +
      `  The ship worktree runs ${join(nodeModules, '@norvalbv', 'devkit')}, as a plain commit would; its verdict would be wrong.\n` +
      `  Fix: ${BASELINE_READER_REMEDIATION}, then retry the same ship command.\n`,
  );
  return 1;
}

try {
  process.exitCode = run(process.argv.slice(2));
} catch (error) {
  process.stderr.write(
    `devkit ship: baseline reader preflight failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
}
