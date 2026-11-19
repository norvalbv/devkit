/** What a guard-dup scan could not judge (stale drops, unindexed files, unembedded chunks), printed
 * and recorded so a quiet run is never mistaken for a clean one. Never changes the exit code. */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type DroppedPair,
  freshnessNotice,
  type PendingChunk,
  pendingChunks,
  type SqlDb,
  type VerifiablePair,
} from '../chunk-index.mts';
import { indexIsInThisCheckout, SAMPLE, sampleFiles } from '../index-refresh.mts';
import { sourceMatchers } from '../../config.mts';
import { reasonDetail } from '../../deterministic/reason.mts';
import { emitGateEvent } from '../../judge/gate-events.mts';
import { underRoot } from '../../review/scope/policy.mts';

const TESTS_DIR = '__tests__/';

// Staged files the dup matcher could not compare (no usable chunk), named so a clean pass is honest.
export interface UnindexedScope {
  cwd: string;
  scanRoots: readonly string[];
  sourceExtensions: string[];
  includeTests: boolean;
}

/** Staged scan-root source files present on disk with no usable chunk in the index, sorted. */
export function unindexedStaged(
  changed: ReadonlySet<string>,
  indexed: ReadonlySet<string>,
  scope: UnindexedScope,
): string[] {
  const { isSource, isTest } = sourceMatchers(scope.sourceExtensions);
  return [...changed]
    .filter(
      (f) =>
        !indexed.has(f) &&
        isSource(f) &&
        (scope.includeTests || !(isTest(f) || f.includes(TESTS_DIR))) &&
        scope.scanRoots.some((root) => underRoot(f, root)) &&
        existsSync(resolve(scope.cwd, f)),
    )
    .sort();
}

/** The lines naming the uncompared files, with a remedy that depends on who owns the index. */
export function unindexedNotice(files: readonly string[], ownsIndex: boolean): string[] {
  if (files.length === 0) return [];
  return [
    `${files.length} staged file(s) have no usable (embedded) chunks in the index — not compared: ${sampleFiles(files)}`,
    ownsIndex
      ? '  Run `search-code index` to embed them; a file the indexer excludes or cannot chunk stays uncompared.'
      : '  The index is shared from another checkout and cannot cover files new on this branch.',
  ];
}

/** The clean-run line: honest about scope when the scan withheld any comparison. */
export const cleanLine = (withheld: boolean) =>
  `No new duplication ${withheld ? 'among the compared files' : 'since the last baseline'}. ✓`;

/** Chunks no pair can include: staged ones by name, plus a count of those this refresh left behind. */
export function pendingNotice(
  pending: readonly PendingChunk[],
  before: ReadonlySet<number> | null,
  changed: ReadonlySet<string> | null,
  unindexed: readonly string[],
): string[] {
  const named = pending.filter((c) => !unindexed.includes(c.file));
  const staged = named.filter((c) => changed?.has(c.file));
  const others = named.filter((c) => !staged.includes(c) && before && !before.has(c.id)).length;
  if (staged.length + others === 0) return [];
  return [
    `${staged.length + others} indexed symbol(s) have no embedding yet (an index run stopped short) — not compared:`,
    ...staged.slice(0, SAMPLE).map((c) => `  ${c.symbol}  ${c.file}`),
    ...(staged.length > SAMPLE ? [`  (+${staged.length - SAMPLE} more staged)`] : []),
    ...(others
      ? [
          `  ${staged.length ? 'and ' : ''}${others} outside the staged files, left by this run's index refresh`,
        ]
      : []),
    process.env.DEVKIT_SHIP === '1'
      ? "  Bring the primary checkout's index up to date, run `guard-prefix clear`, then re-ship: a re-ship seeds from it and would replay this cached PASS."
      : '  Let the index command finish (re-run it), then re-run this gate.',
  ];
}

/** What a scan could not judge, and why. */
export interface Withheld {
  changed: ReadonlySet<string> | null;
  rows: readonly { file_path: string }[];
  dropped: DroppedPair<VerifiablePair>[];
  db: SqlDb;
  pendingBefore: ReadonlySet<number> | null;
}

/** Print every comparison the scan withheld; under --gate record ONE gate_degraded event, since the
 * ship digest keeps one row per gate. Advisory; returns the withheld summary, '' when none. */
export function reportDegraded(
  w: Withheld,
  scope: UnindexedScope & { indexPath: string; gate: boolean },
): string {
  const unindexed = w.changed
    ? unindexedStaged(w.changed, new Set(w.rows.map((r) => r.file_path)), scope)
    : [];
  const owns = indexIsInThisCheckout(scope.indexPath, scope.cwd);
  const parts = (
    [
      ['stale_index_drop', freshnessNotice(w.dropped, { verified: true, blocking: false })],
      ['unindexed_staged', unindexedNotice(unindexed, owns)],
      ['pending_embed', pendingNotice(pendingChunks(w.db), w.pendingBefore, w.changed, unindexed)],
    ] as const
  ).filter(([, lines]) => lines.length > 0);
  const lines = parts.flatMap(([, l]) => l);
  for (const line of lines) console.log(line);
  if (parts.length === 0) return '';
  const detail = reasonDetail('dup', lines.filter(Boolean));
  const cause = parts.map(([c]) => c).join('+');
  if (scope.gate) emitGateEvent({ type: 'gate_degraded', judge: 'dup', cause, detail });
  return detail;
}
