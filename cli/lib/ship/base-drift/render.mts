/** Report -> text, and report -> exit code. Pure: no git, no fs, no clock. */
import type { BaseDriftReport, OverlapEntry } from './types.mts';

/** Long lists stop being read; the count line carries the rest. */
const MAX_LISTED = 8;

function describe(entry: OverlapEntry): string {
  const verb = entry.status.startsWith('D')
    ? 'deleted'
    : entry.status.startsWith('A')
      ? 'added'
      : 'changed';
  if (!entry.commit) return `  ${entry.path} — ${verb} on the base`;
  return `  ${entry.path} — ${verb} in ${entry.commit.short} (${entry.commit.subject})`;
}

function listing(report: BaseDriftReport): string {
  const shown = report.overlap.slice(0, MAX_LISTED).map(describe);
  const rest = report.overlap.length - shown.length;
  return rest > 0 ? [...shown, `  …and ${rest} more`].join('\n') : shown.join('\n');
}

/**
 * The one honest thing to say when a fetch failed. Emitted INSTEAD of silence, because silence is
 * indistinguishable from "the base has not moved" — the inference that caused sc-2297.
 */
/**
 * The loud line for a base that could not be VERIFIED because origin was unreachable. Distinct from
 * every other unresolvable reason, which are genuine answers rather than a failure to get one.
 */
function unreachableNote(report: BaseDriftReport): string {
  if (report.base.kind !== 'unresolvable' || report.base.reason !== 'fetch-failed') return '';
  const named = report.base.base ? `origin/${report.base.base}` : 'the base';
  return (
    `Base freshness UNKNOWN: could not reach origin to verify ${named}, so whether it has moved ` +
    'is unknown — this is NOT a report that it is unchanged.'
  );
}

function undeterminedNote(report: BaseDriftReport): string {
  if (report.silent !== 'undetermined' || report.base.kind !== 'resolved') return '';
  return (
    `origin/${report.base.base} HAS moved, but the comparison against it could not be completed — ` +
    'treat this as UNKNOWN, not as "no drift".'
  );
}

function unknownNote(report: BaseDriftReport): string {
  if (report.freshness !== 'unknown' || report.base.kind !== 'resolved') return '';
  return (
    `Base freshness UNKNOWN: could not reach origin to check whether ${report.base.base} has moved. ` +
    `Anything below is computed from possibly-stale refs — re-run \`git fetch\` before trusting a "not found".`
  );
}

/** SessionStart: whole-repo, once per session, at the moment the agent forms its mental model. */
export function renderSessionBrief(report: BaseDriftReport): string {
  const unknown = undeterminedNote(report) || unknownNote(report);
  if (report.silent === 'unresolvable') return unreachableNote(report);
  if (report.silent !== null) return unknown;
  const base = report.base.kind === 'resolved' ? report.base.base : '';
  const head = `origin/${base} has moved since this checkout was cut: ${report.behind} commit(s), ${report.moved.length} file(s).`;
  const warn =
    'Anything you conclude from `git show HEAD:<path>` or a local read of those files is computed ' +
    'against a stale base. Re-read them from the base before deciding a symbol, migration or entry ' +
    'does not exist.';
  return [unknown, head, warn, listing(report)].filter(Boolean).join('\n\n');
}

/** PreToolUse: only the path about to be edited, so it stays specific enough to act on. */
export function renderEditAdvisory(report: BaseDriftReport): string {
  if (report.silent !== null)
    return report.silent === 'unresolvable'
      ? unreachableNote(report)
      : undeterminedNote(report) || unknownNote(report);
  const base = report.base.kind === 'resolved' ? report.base.base : '';
  return [
    unknownNote(report),
    `origin/${base} changed the file you are about to edit. Re-read it from the base first — your ` +
      `working copy predates this, so an edit written against it can revert merged work.`,
    listing(report),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** ship: advisory only. Never blocks — see docs/decisions/base-drift-surfaced-at-read-time.md. */
export function renderShipNotice(report: BaseDriftReport): string {
  if (report.silent !== null)
    return report.silent === 'unresolvable'
      ? unreachableNote(report)
      : undeterminedNote(report) || unknownNote(report);
  const base = report.base.kind === 'resolved' ? report.base.base : '';
  return [
    `⚠️  devkit ship: ${report.overlap.length} shipped path(s) also changed on origin/${base} since this branch diverged.`,
    listing(report),
    '  Shipping is not blocked: git merges these three-way, so a same-region conflict surfaces at merge.',
    '  Check any of these you hand-edited after reading a local copy.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** `devkit base-status` human output. Always non-empty: a query must answer, never stay silent. */
export function renderStatus(report: BaseDriftReport): string {
  if (report.base.kind !== 'resolved') {
    const unreachable = unreachableNote(report);
    return (
      unreachable || `base: unresolvable (${report.base.reason}) — nothing to compare against.`
    );
  }
  const age = report.ageMs === null ? '' : ` (${Math.round(report.ageMs / 1000)}s old)`;
  const lines = [
    `base:      origin/${report.base.base} @ ${report.base.sha.slice(0, 7)} (via ${report.base.source})`,
    `freshness: ${report.freshness}${age}`,
    `merge-base ${report.mergeBase ? report.mergeBase.slice(0, 7) : '—'}, base is ${report.behind} commit(s) ahead of it`,
    `moved:     ${report.moved.length} file(s) on the base since the merge-base`,
    `overlap:   ${report.overlap.length} of them in the paths you asked about`,
  ];
  const note = undeterminedNote(report) || unknownNote(report);
  if (note) lines.push('', note);
  if (report.overlap.length > 0) lines.push('', listing(report));
  return lines.join('\n');
}

/**
 * The exit-code contract for `devkit base-status`.
 *
 * 1 and 2 are deliberately left to Node's uncaught-throw default and to usage errors: 2 is also
 * what `ls-remote --exit-code` returns for "absent", which ship-branch.sh:277-283 already cases on,
 * so keeping the semantic answers at 3 and 4 lets a shell wrapper around both stay unambiguous.
 *
 * `freshness: 'unknown'` maps to 4 even with an empty overlap. A green computed from refs of
 * unknown age is the false confidence this feature exists to kill, so it must not read as 0.
 */
export function exitCodeFor(report: BaseDriftReport): 0 | 3 | 4 {
  if (report.base.kind !== 'resolved') return 4;
  if (report.freshness === 'unknown') return 4;
  // A comparison that could not be completed is undetermined, never a clean 0.
  if (report.silent === 'undetermined') return 4;
  // The is-ancestor early-out returns before a merge-base is computed, so a null one is CORRECT
  // there and must not be read as "could not determine".
  if (report.silent === 'no-drift') return 0;
  if (report.mergeBase === null) return 4;
  return report.overlap.length > 0 ? 3 : 0;
}
