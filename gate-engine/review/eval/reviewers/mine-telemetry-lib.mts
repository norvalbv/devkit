// @ts-nocheck — BENCH-ONLY (excluded from tsc, see tsconfig.json exclude); loose types deliberate.

/**
 * mine-telemetry-lib — pure helpers for mine-telemetry.mts, split out so the correlation and
 * classification logic can be unit-tested without touching sqlite3, the filesystem, or the diff
 * archive. Everything here takes plain data in, returns plain data out; no execFileSync, no fs.
 *
 * Mirrors mine-bots-lib.mts's split (network/db-free helpers vs the orchestrating script) for the
 * same reason: the correlation heuristics are the part worth pinning down with fixtures.
 */

// ---------------------------------------------------------------------------------------------
// Constants shared with the orchestrator.
// ---------------------------------------------------------------------------------------------

// Inline the archived diff text up to this many raw (decompressed) bytes; past it, emit a
// diffPath ref instead of bloating candidates-telemetry.jsonl with megabyte-scale rows.
export const INLINE_DIFF_CAP_BYTES = 200 * 1024;

// ---------------------------------------------------------------------------------------------
// Ship ordering / branch grouping.
// ---------------------------------------------------------------------------------------------

// ts_start is ISO-8601, but real rows mix a with-milliseconds form ("...:00.523Z") and a
// without-milliseconds form ("...:00Z") within the same chain. Plain string comparison is NOT
// safe for that mix: at a same-second tie, "." (0x2E) sorts before "Z" (0x5A), so the no-millis
// form (implicit .000) sorts AFTER any millis form of that same second — inverting true
// chronological order. Parse both sides to epoch millis instead; only fall back to the raw
// string compare when a value fails to parse, so malformed timestamps degrade gracefully rather
// than crash or silently coerce to NaN-driven reordering.
function tsMillis(ts) {
  const ms = Date.parse(String(ts ?? ''));
  return Number.isNaN(ms) ? null : ms;
}

export function sortByTsStart(ships) {
  return [...(ships ?? [])].sort((a, b) => {
    const ta = tsMillis(a?.ts_start);
    const tb = tsMillis(b?.ts_start);
    if (ta !== null && tb !== null) {
      if (ta !== tb) return ta - tb;
    } else {
      const sa = String(a?.ts_start ?? '');
      const sb = String(b?.ts_start ?? '');
      if (sa !== sb) return sa < sb ? -1 : 1;
    }
    // Stable-ish tiebreak on ship_id so equal timestamps don't reorder nondeterministically
    // across runs (sqlite3 -json row order isn't guaranteed for ties).
    return String(a?.ship_id ?? '').localeCompare(String(b?.ship_id ?? ''));
  });
}

const branchKey = (repo, branch) => `${repo ?? ''}::${branch}`;

/**
 * Groups ships into per-(repo,branch) chronological chains. Ships with a null/blank branch are
 * excluded (uncorrelatable — see docs/benchmarks/corpus-growth.md capture-point-1 addendum) and
 * counted separately rather than silently dropped.
 *
 * Returns `groups`: Map<"repo\0branch", ShipRow[]> sorted ascending by ts_start, and
 * `indexByShipId`: Map<ship_id, {key, idx}> for O(1) "where is this ship in its chain" lookups.
 */
export function groupShipsByRepoBranch(ships) {
  const byKey = new Map();
  let skippedNullBranch = 0;
  for (const ship of ships ?? []) {
    const branch = ship?.branch;
    if (branch === null || branch === undefined || String(branch).trim() === '') {
      skippedNullBranch += 1;
      continue;
    }
    const key = branchKey(ship.repo, branch);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(ship);
  }
  const groups = new Map();
  const indexByShipId = new Map();
  for (const [key, rows] of byKey) {
    const sorted = sortByTsStart(rows);
    groups.set(key, sorted);
    sorted.forEach((ship, idx) => {
      if (ship?.ship_id) indexByShipId.set(ship.ship_id, { key, idx });
    });
  }
  return { groups, indexByShipId, skippedNullBranch };
}

// ---------------------------------------------------------------------------------------------
// Fail → fix correlation.
// ---------------------------------------------------------------------------------------------

/**
 * Forward-scans a branch's chronologically-sorted ships, starting just after `failShipId`,
 * looking for the reviewer's fix. `statusOf(shipId, reviewer)` returns 'pass' | 'fail' | undefined
 * (undefined = the reviewer didn't run / wasn't recorded for that ship — e.g. its domain wasn't
 * touched, or it's absent from a deterministic-blocked ship that never reached review).
 *
 * Rules (see corpus-growth.md capture-point-1 addendum, verified against a live 5-ship sequence):
 *  - reviewer status 'fail' on a candidate ship → still broken, keep scanning (do NOT stop at the
 *    very next ship blindly — a retry can fail the same lens repeatedly before it lands).
 *  - reviewer status 'pass' → FIXED, stop here.
 *  - reviewer absent AND the ship shipped clean (exit_code === 0) → treat as fixed-by-absence: the
 *    ship reached a non-blocked end without this reviewer objecting (its scope may simply have
 *    moved on). This is the "absent-from-failing" case the task brief calls out.
 *  - reviewer absent AND the ship did NOT ship clean (blocked by something else, or still mid-flight)
 *    → no signal either way, keep scanning.
 *  - chain exhausted with no fix found → 'no-fix-found' (covers both "still failing at the end of
 *    the chain" and "branch abandoned" — corpus-growth.md's case (a)/(c), neither is a gold).
 */
export function findNextOutcome(shipsForBranch, failShipId, reviewer, statusOf) {
  const chain = shipsForBranch ?? [];
  const failIdx = chain.findIndex((s) => s?.ship_id === failShipId);
  if (failIdx === -1) return { kind: 'no-fix-found', nextShipId: null };
  for (let i = failIdx + 1; i < chain.length; i += 1) {
    const candidate = chain[i];
    const status = statusOf(candidate.ship_id, reviewer);
    if (status === 'pass')
      return { kind: 'fixed', nextShipId: candidate.ship_id, rule: 'reviewer-pass' };
    if (status === 'fail') continue; // still broken — keep scanning
    // status is undefined (reviewer absent from this ship's commit_reviews rows)
    if (candidate.exit_code === 0)
      return { kind: 'fixed', nextShipId: candidate.ship_id, rule: 'absence-exit0' };
    // absent and not clean — no signal, keep scanning
  }
  return { kind: 'no-fix-found', nextShipId: null, rule: null };
}

/** The four label rules a fail→fix candidate is minted under, strongest first; stamped as `labelRule`
 * (sc-2497) so noise reports per tier. Documentation-only on a row: outside BEHAVIOR_FIELDS. */
export const LABEL_RULES = Object.freeze([
  'lens-pass',
  'reviewer-pass',
  'absence-exit0',
  'fallback',
]);

/**
 * Lens-specific variant of findNextOutcome. `statusOf` is reviewer-level (as above);
 * `lensStatusOf(shipId, reviewer, lens)` returns 'pass' | 'fail' | undefined from
 * commit_review_lenses for that exact lens.
 *
 * Why this exists: statusOf/findNextOutcome is reviewer-level only. A reviewer can FAIL a ship on
 * several distinct lenses at once; naively stamping one reviewer-level verdict onto every failing
 * lens of that ship asserts THIS lens's problem was resolved when only the reviewer's overall
 * next-attempt status is actually known — the other lens may be what actually got fixed. This
 * scans for a 'pass' on the SAME lens first (real per-lens evidence); only when a candidate ship
 * has no lens-level row at all for this lens does it fall back to the reviewer-level signal, and
 * even then only treats a reviewer PASS or a clean ship (absent reviewer, exit_code 0) as fixed —
 * a reviewer FAIL with no lens data keeps scanning rather than assuming this lens's fate either way.
 */
export function findNextLensOutcome(
  shipsForBranch,
  failShipId,
  reviewer,
  lens,
  statusOf,
  lensStatusOf,
) {
  const chain = shipsForBranch ?? [];
  const failIdx = chain.findIndex((s) => s?.ship_id === failShipId);
  if (failIdx === -1) return { kind: 'no-fix-found', nextShipId: null };
  for (let i = failIdx + 1; i < chain.length; i += 1) {
    const candidate = chain[i];
    const lensStatus = lensStatusOf(candidate.ship_id, reviewer, lens);
    if (lensStatus === 'pass')
      return { kind: 'fixed', nextShipId: candidate.ship_id, rule: 'lens-pass' };
    if (lensStatus === 'fail') continue; // this specific lens still broken — keep scanning
    // lensStatus undefined — no lens-level row for this lens on this candidate ship. Fall back
    // to the reviewer-level signal, but only trust it in the directions that don't require
    // assuming this lens's specific fate:
    const status = statusOf(candidate.ship_id, reviewer);
    if (status === 'pass')
      return { kind: 'fixed', nextShipId: candidate.ship_id, rule: 'reviewer-pass' };
    if (status === 'fail') continue; // reviewer still failing overall on SOME lens — could be a
    // different lens than this one; not evidence this lens resolved, keep scanning.
    if (candidate.exit_code === 0)
      return { kind: 'fixed', nextShipId: candidate.ship_id, rule: 'absence-exit0' };
    // reviewer absent and not clean — no signal, keep scanning
  }
  return { kind: 'no-fix-found', nextShipId: null, rule: null };
}

/** Decide which lens rows a reviewer-level FAIL mints fail→fix candidates for.
 *
 * Only a BLOCKING failed lens qualifies (allowlist — LensDisposition is 'blocking' | 'waived' |
 * 'dropped_out_of_charter', items.mts): a waived lens is a human-labeled false positive that the
 * waived-decoy loop owns (colliding here would silently win the merge), and a
 * dropped_out_of_charter lens was dismissed by the gate's own cross-domain valve, so correlating
 * a "fix" for either is meaningless. Null/absent disposition (pre-disposition-era rows) counts as
 * blocking.
 *
 * Three cases, and the middle one is the trap — "no blocking lens failed" is NOT the same fact as
 * "no lens breakdown exists", even though both leave the blocking filter empty:
 *   · breakdown with blocking failed lenses → those lenses, correlated per-lens
 *   · breakdown whose failed lenses are ALL waived/dropped → SKIP (`rows: []` + a skip reason).
 *     Falling through to the reviewer-level scan here would mint a gold from exactly the lenses
 *     the allowlist just excluded.
 *   · no lens breakdown recorded at all → `[null]`, the reviewer-level scan
 *
 * The caller counts `skipped` in its drop histogram rather than dropping the fail silently. */
export function selectFailLensRows(lenses) {
  const recorded = lenses ?? [];
  const blocking = recorded.filter(
    (l) => l.status === 'fail' && (l.disposition == null || l.disposition === 'blocking'),
  );
  if (blocking.length > 0) return { rows: blocking, skipped: null };
  if (recorded.some((l) => l.status === 'fail'))
    return { rows: [], skipped: 'all-failing-lenses-non-blocking' };
  return { rows: [null], skipped: null }; // null lens = no per-lens breakdown recorded
}

// ---------------------------------------------------------------------------------------------
// diff_sha256 equality — guards against mislabeling an override-valve waiver (same diff bytes,
// reconciled to pass with no code change) as a "fix". That case belongs to the waived-decoy path
// (commit_review_lenses.disposition='waived'), not fail-fix.
// ---------------------------------------------------------------------------------------------

export function isSameDiff(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.length > 0 && a === b;
}

/**
 * True when there is SOME diff hash to reconstruct from — either side. False means neither the
 * broken nor the fixed ship even has a commit_review_scope row for this reviewer (not just a
 * missing archive), so the only evidence for the row is free-text failReason. commit_review_scope
 * only starts covering ships from 2026-07-27 (see module docstring); most historical FAILs
 * predate it, so a large share of fail-fix rows are expected to be `hasDiffEvidence: false`.
 * Surfaced as its own field (rather than left implicit in diffSha256/nextDiffSha256 both being
 * null) so downstream triage can threshold on it explicitly, the way propose.mts hard-drops
 * empty-hunk bot candidates.
 */
export function hasDiffEvidence(diffSha256, nextDiffSha256) {
  return Boolean(diffSha256) || Boolean(nextDiffSha256);
}

// ---------------------------------------------------------------------------------------------
// Diff archive addressing.
// ---------------------------------------------------------------------------------------------

/** `diffs/<sha256>.diff.gz`, relative to the telemetry dir — mirrors diff-archive.mts exactly. */
export function diffArchiveRelPath(diffSha256) {
  if (!diffSha256) return null;
  return `diffs/${diffSha256}.diff.gz`;
}

/**
 * Decides between inlining decompressed diff text and emitting a path ref, given the already
 * gunzipped text (or null when the archive doesn't have this hash). Pure — the caller does the
 * actual existsSync/gunzip IO and passes the result in.
 */
export function resolveDiffPayload(diffText, relPath) {
  if (typeof diffText !== 'string') return { diffText: null, diffPath: null };
  if (Buffer.byteLength(diffText, 'utf8') <= INLINE_DIFF_CAP_BYTES) {
    return { diffText, diffPath: null };
  }
  return { diffText: null, diffPath: relPath ?? null };
}

// ---------------------------------------------------------------------------------------------
// Synthetic dedupe key / candidate row shaping.
// ---------------------------------------------------------------------------------------------

/** `telemetry://<kind>/<shipId>/<reviewer>[/<lens>]` — the stable merge-by key (mirrors
 * mine-bots' `url`). `kind` is part of the key so a fail-fix row and a decoy row derived from the
 * same (ship, reviewer, lens) can never silently overwrite each other in mergeCandidates — the
 * emit loops are mutually exclusive by disposition, and the key makes any future regression of
 * that invariant visible in the output instead of a silent last-write-wins. */
export function telemetryUrl(kind, shipId, reviewer, lens) {
  const base = `telemetry://${kind}/${shipId}/${reviewer}`;
  return lens ? `${base}/${lens}` : base;
}

/** Best-effort single failure-reason string: prefer the lens's own issues_json, else the
 * reviewer's overall commit_reviews.reason. Never throws on malformed issues_json. */
export function pickFailReason(issuesJson, reviewReason) {
  if (typeof issuesJson === 'string' && issuesJson.trim()) {
    try {
      const parsed = JSON.parse(issuesJson);
      if (Array.isArray(parsed) && parsed.length > 0) {
        // A non-empty array can still filter down to nothing (whitespace-only / non-string
        // entries) — an empty join must fall through to reviewReason like every other
        // no-usable-content path, not return '' and shadow the real reason at the `?? null`
        // call sites (empty string survives ??).
        const joined = parsed.filter((s) => typeof s === 'string' && s.trim()).join('\n');
        if (joined.trim()) return joined;
      }
    } catch {
      // fall through to reviewReason
    }
  }
  return typeof reviewReason === 'string' && reviewReason.trim() ? reviewReason : null;
}

/** Builds one fail-fix candidate row. `diffPayload`/`nextDiffPayload` are the results of
 * resolveDiffPayload (or `{diffText:null, diffPath:null}` when nothing was archived). */
export function buildFailFixCandidate({
  shipId,
  repo,
  branch,
  reviewer,
  lens,
  tsFail,
  diffSha256,
  bytesAvailable,
  diffPayload,
  failReason,
  nextShipId,
  nextDiffSha256,
  nextBytesAvailable,
  nextDiffPayload,
  tsFix,
  labelRule,
}) {
  return {
    kind: 'fail-fix',
    // sc-2497 stamps: labelRule (LABEL_RULES); sameDiffGuardArmable = both hashes known, so the
    // override guard could have fired; evidenceShrunk = fail side archived, fix side not.
    labelRule: LABEL_RULES.includes(labelRule) ? labelRule : 'fallback',
    sameDiffGuardArmable: !!diffSha256 && !!nextDiffSha256,
    evidenceShrunk: !!bytesAvailable && !nextBytesAvailable,
    url: telemetryUrl('fail-fix', shipId, reviewer, lens),
    shipId,
    repo,
    branch,
    reviewer,
    lens: lens ?? null,
    tsFail,
    diffSha256: diffSha256 ?? null,
    bytesAvailable: !!bytesAvailable,
    diffText: diffPayload?.diffText ?? null,
    diffPath: diffPayload?.diffPath ?? null,
    failReason: failReason ?? null,
    nextShipId,
    nextDiffSha256: nextDiffSha256 ?? null,
    nextBytesAvailable: !!nextBytesAvailable,
    nextDiffText: nextDiffPayload?.diffText ?? null,
    nextDiffPath: nextDiffPayload?.diffPath ?? null,
    hasDiffEvidence: hasDiffEvidence(diffSha256, nextDiffSha256),
    tsFix,
  };
}

/** Builds one waived-decoy candidate row. `rationale` stays null until capture point 2
 * (`guard-review waive`) writes it into telemetry — never fabricated here. */
export function buildWaivedCandidate({
  shipId,
  repo,
  branch,
  reviewer,
  lens,
  tsFail,
  diffSha256,
  bytesAvailable,
  diffPayload,
  failReason,
  disposition,
  rationale = null,
}) {
  return {
    kind: 'waived-decoy',
    url: telemetryUrl('waived-decoy', shipId, reviewer, lens),
    shipId,
    repo,
    branch: branch ?? null,
    reviewer,
    lens: lens ?? null,
    tsFail,
    diffSha256: diffSha256 ?? null,
    bytesAvailable: !!bytesAvailable,
    diffText: diffPayload?.diffText ?? null,
    diffPath: diffPayload?.diffPath ?? null,
    failReason: failReason ?? null,
    disposition,
    rationale,
  };
}

// ---------------------------------------------------------------------------------------------
// Merge (new wins by `url`, same contract as mine-bots.readExistingCandidates/merge).
// ---------------------------------------------------------------------------------------------

export function mergeCandidates(existingByUrl, newRows) {
  const merged = new Map(existingByUrl ?? new Map());
  for (const row of newRows ?? []) {
    if (!row?.url) continue;
    merged.set(row.url, row);
  }
  return merged;
}

// ---------------------------------------------------------------------------------------------
// Histogram (kind × reviewer × bytesAvailable) for the stderr summary.
// ---------------------------------------------------------------------------------------------

export function histogramKey(row) {
  return `${row?.kind ?? 'unknown'} / ${row?.reviewer ?? 'unknown'} / bytesAvailable=${!!row?.bytesAvailable}`;
}

export function buildHistogram(rows, keyFn = histogramKey) {
  const counts = new Map();
  for (const row of rows ?? []) {
    const k = keyFn(row);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/**
 * Map.set that refuses duplicates. The miner's indexes are keyed (ship, reviewer[, lens]) and
 * feed the training corpus unattended (weekly cron) — a duplicate key means the warehouse's
 * merged-parent-row contract broke (e.g. per-chunk rows leaking out of the sc-1999 child
 * tables), and last-write-wins would mint wrong labels silently. Fail the run instead.
 */
export function setHard(map, key, value, what) {
  if (map.has(key))
    throw new Error(
      `mine-telemetry: duplicate ${what} key ${key} — one row per key is load-bearing for the training corpus (sc-2073); refusing last-write-wins`,
    );
  map.set(key, value);
}
