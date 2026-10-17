/**
 * The ship terminus findings digest: what every gate observed this run, not only the one that
 * blocked.
 *
 * AUTHORITY: none, and that is a constraint no code here can demonstrate. Per
 * blocking-gates-narrate-attribution-never-depend-on-it this module may only narrate a verdict
 * already decided — so it holds no exit, its caller invokes it through an errexit-suppressing
 * OR-list, and every failure path returns the empty string. It also never re-derives which gate
 * blocked: the shell settled that and published it on this ship's ship_result row, which this
 * reader consumes, so the two can never disagree.
 */
import { type Attributable, type Buckets, COMPLETENESS, classify } from './event-rows.mts';
import { oneLine, textOf } from './fields.mts';
import { scanBackward } from './tail.mts';
import { readBranchHistory, renderTrend, summariseTrend } from './trend.mts';

/**
 * The fields this digest reads off a gate event, and only those. The sink is an append-only stream
 * that several engines write with differing shapes, so every field is optional and the reader names
 * exactly what it consumes: a producer adding a field can never break it, and a producer dropping
 * one degrades a single line rather than the run. `family` is the coarse gate group a row belongs
 * to when its own `gate` is finer than the blocked_gate vocabulary (the deterministic chain reports
 * per-gate: `fanout`, `anti-slop`).
 *
 * `advisory_result` is the one row type here that can never be the blocker: it comes from a stage
 * that holds no exit, so it is read for `gate`/`status`/`detail` and never for attribution.
 */
export interface GateEvent {
  type?: string;
  ship_id?: string;
  reviewer?: string;
  gate?: string;
  family?: string;
  judge?: string;
  status?: string;
  detail?: string;
  cause?: string;
  reason?: string;
  /** review_result inconclusive only: the machine cause (`outage`, `rate-limited`, `timeout`, …). */
  inconclusive_cause?: string;
  /** judge_exec only: `ok` or the classified outage kind, and on failure the provider's own words. */
  outcome?: string;
  outage_detail?: string;
  bypass?: string;
  blocked_gate?: string | null;
  exit_code?: number;
  /** cache_hit only: `intent` marks completeness's branch+message key, which ignores the diff. */
  scope?: string;
  /** cache_hit only: false = the cached verdict was judged on a different staged diff (sc-3175). */
  diff_matches?: boolean;
  /** review cache_hit only (sc-3468): where the PASS's judged base stands against this run's base. */
  base_state?: string;
  judged_base_sha?: string | null;
  /** review_result / review cache_hit (sc-2305): what the judge's capped packet left out. Absent =
   * every file shown whole, or an emitter that predates the measurement. */
  evidence_file_count?: number;
  evidence_omitted_files?: number;
  evidence_truncated_files?: number;
  evidence_omitted_paths?: string[];
  evidence_truncated_paths?: string[];
  evidence_lens?: string;
  /** review_result FAIL only (sc-3212): every finding the override valve left blocking, one per
   * fingerprint. Absent on a cascade-confirmed FAIL (no valve) and on an emitter predating it. */
  blocking?: { lens?: string; fp?: string }[];
  blocking_omitted?: number;
  blocking_base?: string;
  /** review_result only: the per-lens checklist vector; absent when it spilled or was never kept. */
  items?: unknown[];
  /** completeness gate_result FAIL only: its CRITICAL and IMPORTANT finding counts. */
  tally?: { critical?: number; important?: number };
}

/** One gate's contribution to this attempt. `gate` is the event's own label, never parsed prose.
 * `unverified`: a downgraded judge, a PASS judged on an earlier diff, or a PASS over a packet that
 * omitted or truncated files. It never blocks. */
export interface DigestRow {
  gate: string;
  state: 'finding' | 'cached' | 'could-not-run' | 'unverified';
  /** true = this stopped the run · false = it did not · null = the run failed unattributably. */
  blocking: boolean | null;
  detail: string;
  /** The finding's fingerprint, when the gate named one — one gate can yield several rows. */
  fp?: string;
  /** How many findings this row stands for, when not one: omitted IDs, or the issues under one. */
  findings?: number;
  /** From a stage that holds no exit: the reader acts on it, but never by retrying the ship. */
  advisory?: true;
}

/** The ship_attempt row opens this attempt's span, so finding it bounds the backward read exactly. */
const ATTEMPT = 'ship_attempt';
/** Caps on what one terminus prints: past these the digest is the wall of text it replaces. */
const MAX_FINDINGS = 8;
const MAX_MISSING = 3;

/**
 * The I/O boundary: one JSONL line in, this ship's event or nothing. Every downstream function
 * takes GateEvent, so no unparsed value travels past here.
 */
function parseEvent(line: string, shipId: string): GateEvent | undefined {
  try {
    // SAFETY: the cast asserts a SHAPE, never the runtime type of any field — a row is arbitrary
    // JSON, so a field declared string here can hold a number. What makes it sound is that no read
    // downstream relies on the declared type: every field is compared with === or coerced through
    // a template literal (see oneLine), so a wrong-typed value renders oddly instead of throwing.
    const event = JSON.parse(line) as GateEvent;
    return event.ship_id === shipId ? event : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The tail of `sink` back to this ship's own ship_attempt row, filtered to this ship.
 *
 * The default sink is per-MACHINE (~/.devkit/telemetry/gate-events.jsonl) and accumulates across
 * every commit on the box, so a full read is unbounded and a ship_id filter is not optional —
 * without it a digest blends repos. Never throws: an absent, unreadable or torn sink yields [].
 */
export function readShipEvents(sink: string, shipId: string): GateEvent[] {
  if (!shipId) return [];
  return scanBackward(
    sink,
    (line) => parseEvent(line, shipId),
    // Stop at MY attempt, not the first one met: two repos' ships interleave in the per-machine sink.
    (kept) => kept.some((e) => e.type === ATTEMPT),
  );
}

/**
 * Which finding this run actually stopped on, given the coarse `blocked_gate` the shell published.
 *
 * `blocked_gate` names a FAMILY ('review', 'deterministic', 'decisions'), and the review family
 * holds both the reviewer fleet and the completeness judge. The hook's own precedence settles the
 * ambiguity: the fleet's status ($rrc) is dispatched BEFORE the completeness status ($crc), so when
 * a fleet reviewer failed, that is what stopped the run and completeness did not — which is exactly
 * the case this digest exists for. Completeness is blocking only when nothing else in the family
 * failed.
 */
function isBlocking(finding: Attributable, blocked: string, siblings: Attributable[]): boolean {
  // `comments` is the one deterministic sub-gate that keeps its own blocked_gate token (sc-2753).
  if (!blocked || (finding.family !== blocked && finding.gate !== blocked)) return false;
  if (finding.gate !== COMPLETENESS) return true;
  return !siblings.some((s) => s.family === 'review' && s.gate !== COMPLETENESS);
}

/** A codex error envelope's message (`error.message` or `detail`, one JSON line), else
 *  the text as given — the envelope alone would spend the whole detail budget before the cause. */
function providerMessage(text: string): string {
  try {
    // SAFETY: a shape, not a type — `?.` survives null or a primitive, and textOf drops a non-string.
    const parsed = JSON.parse(text.split('\n')[0] ?? '') as {
      error?: { message?: string };
      detail?: string;
    };
    return textOf(parsed?.error?.message) || textOf(parsed?.detail) || text;
  } catch {
    return text;
  }
}

/** The provider's own words per judge — the LAST failed spawn's, keyed by reviewer, not by pass. */
function outageWordsByJudge(events: GateEvent[]): Map<string, string> {
  const words = new Map<string, string>();
  for (const e of events) {
    const detail = oneLine(providerMessage(textOf(e.outage_detail)));
    if (e.type !== 'judge_exec' || e.outcome === 'ok' || !detail) continue;
    words.set(textOf(e.judge).replace(/:escalate$/, ''), detail);
  }
  return words;
}

/** Pure: events → the rows the terminus should show. No IO, so the interesting cases unit-test. */
export function summarise(events: GateEvent[], shipId: string): DigestRow[] {
  const all = events.filter((e) => e.ship_id === shipId);
  // DEVKIT_SHIP_ID is INHERITED when already set (commit-with-gate-capture.sh), so one id can span
  // attempts, and the chunk holding this attempt's ship_attempt can also hold the previous one's
  // rows. Everything before the NEWEST attempt marker belongs to a run that is already over.
  const opened = all.map((e) => e.type).lastIndexOf(ATTEMPT);
  const mine = opened === -1 ? all : all.slice(opened);
  // The LAST result row, not the first: index arithmetic rather than findLast, which this
  // target's lib does not carry.
  const results = mine.filter((e) => e.type === 'ship_result');
  const result = results[results.length - 1];
  const blocked = result?.blocked_gate ?? '';
  // 'unknown' is what the shell records when the run failed and none of its prose greps matched
  // (sc-2520); an absent ship_result is a --dry-gates rehearsal, which emits none. Either way the
  // blocking gate is not knowable, and saying "did NOT block this run" about a finding would state
  // something this digest cannot know. A run that exited 0 attributes trivially: nothing blocked.
  const exitCode = result?.exit_code ?? null;
  const unattributed = (blocked === '' || blocked === 'unknown') && exitCode !== 0;

  // Findings and could-not-runs share one list because BOTH can be the blocker: under
  // GUARD_DETERMINISTIC_STRICT=1 an opted-out gate is labelled could-not-run and exits 1, so
  // hard-coding these rows non-blocking misattributes the run to whatever else it found.
  const b: Buckets = {
    attributable: [],
    advisory: [],
    unverified: [],
    cached: [],
    outageWords: outageWordsByJudge(mine),
  };
  for (const e of mine) classify(e, b);

  const seen = new Set<string>();
  const key = (a: Attributable): string => `${a.state}:${a.gate}:${a.fp ?? ''}`;
  const unique = b.attributable.filter((a) => !seen.has(key(a)) && seen.add(key(a)) !== undefined);
  return [
    ...unique.map((a) => {
      const blocking = unattributed ? null : isBlocking(a, blocked, unique);
      const row: DigestRow = { gate: a.gate, state: a.state, blocking, detail: a.detail };
      if (a.fp) row.fp = a.fp;
      if (a.findings) row.findings = a.findings;
      return row;
    }),
    // NOT passed through the `unattributed` null-blocking arm: that arm exists for a run whose
    // blocker is unknowable, and an advisory's non-blocking status is knowable on every run.
    ...firstPerGate(b.advisory),
    // Deduped for the same reason: pre-commit and commit-msg can both replay one stale verdict.
    ...firstPerGate(b.unverified),
    ...b.cached,
  ];
}

/** The first row per state+gate, in event order. */
function firstPerGate(rows: DigestRow[]): DigestRow[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const id = `${r.state}:${r.gate}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** Pure: rows → the block printed below the blocking gate's remediation, or '' for silence. */
export function render(rows: DigestRow[], logPath = ''): string {
  const findings = rows.filter((r) => r.state === 'finding');
  const missing = rows.filter((r) => r.state === 'could-not-run');
  const unverified = rows.filter((r) => r.state === 'unverified');
  // An unverified row alone is reason to speak: it is exactly the green run a reader stops tailing.
  if (findings.length === 0 && missing.length === 0 && unverified.length === 0) return '';

  const cached = rows.filter((r) => r.state === 'cached').length;
  const listed = [...findings, ...missing, ...unverified];
  const total = listed.reduce((n, r) => n + (r.findings ?? 1), 0);
  const gates = new Set(listed.map((r) => `${r.state}:${r.gate}`)).size;
  // Findings, not gates, are what a reader must clear: one reviewer can block on several IDs.
  const counted = gates === total ? `${total}` : `${gates} gate(s) / ${total} finding(s)`;
  const out = [`📋 Gate findings this run (${counted}):`];
  // Never capped: a blocker, or a row naming a fingerprint even when attribution is unknown — each
  // is a separate ID to fix or waive, and a hidden one costs a whole re-ship.
  const pinned = (r: DigestRow): boolean => r.blocking === true || r.fp !== undefined;
  const blockers = findings.filter(pinned);
  const others = findings.filter((r) => !pinned(r));
  for (const r of [...blockers, ...others.slice(0, MAX_FINDINGS)]) {
    const tail = r.detail ? `: ${r.detail}` : '';
    if (r.blocking === true) out.push(`   ✗ ${r.gate} — BLOCKED this run${tail}`);
    else if (r.advisory) out.push(`   ⚠ ${r.gate} — advisory, did NOT block this run${tail}`);
    else if (r.blocking === null) {
      // No "did NOT block" claim: the blocking gate is unknowable on this run.
      out.push(`   ⚠ ${r.gate} — finding recorded — read it before retrying${tail}`);
    } else {
      out.push(
        `   ⚠ ${r.gate} — finding recorded, did NOT block this run — read it before retrying${tail}`,
      );
    }
  }
  if (others.length > MAX_FINDINGS) {
    out.push(`   … ${others.length - MAX_FINDINGS} more finding(s) — all of them are in the log`);
  }
  // Blockers are never capped, as with findings: each fail-closed reviewer is one more to clear.
  const missingBlockers = missing.filter((r) => r.blocking === true);
  const missingOthers = missing.filter((r) => r.blocking !== true);
  for (const r of [...missingBlockers, ...missingOthers.slice(0, MAX_MISSING)]) {
    // A gate that could not run is normally advisory context, but under GUARD_DETERMINISTIC_STRICT
    // an opt-out IS the block — so this marker follows the computed status, never the row's kind.
    const mark = r.blocking === true ? '✗' : '·';
    const tail = r.blocking === true ? ' — BLOCKED this run' : '';
    out.push(`   ${mark} ${r.gate}${tail} — ${r.detail}`);
  }
  if (missingOthers.length > MAX_MISSING) {
    out.push(`   … ${missingOthers.length - MAX_MISSING} more gate(s) that could not run`);
  }
  // Uncapped: at most one row per judge survives the dedupe, and a cut one would be the silent
  // omission this section exists to end. The same `·` a bypass wears, because it carries that weight.
  for (const r of unverified) out.push(`   · ${r.gate} — ${r.detail}`);
  if (cached > 0) {
    out.push(`   ✓ ${cached} verdict(s) served from cache — not re-judged, not re-reported`);
  }
  if (logPath) out.push(`   Full log: ${logPath}`);
  return out.join('\n');
}

// CLI: `node gate-digest.mjs digest <sink> <ship-id> [log-path]`. commit-with-gate-capture.sh shells
// here by a path RELATIVE to itself, so it resolves in every install mode without a bunx/registry
// lookup. Guarded so importing the module never triggers the CLI. Writes to stdout; the caller
// redirects to stderr (a ship's stdout is reserved for the PR URL). Any throw is contained above,
// so this prints nothing rather than adding noise to a run that already failed.
if (/[/\\]gate-digest\.m[jt]s$/.test(process.argv[1] ?? '') && process.argv[2] === 'digest') {
  const [sink = '', shipId = '', logPath = ''] = process.argv.slice(3);
  // The ship exports its own repo/branch (commit-with-gate-capture.sh); unset = no trend line.
  const { DEVKIT_SHIP_REPO: repo = '', DEVKIT_SHIP_BRANCH: branch = '' } = process.env;
  const key = { shipId, repo, branch };
  const text = [
    render(summarise(readShipEvents(sink, shipId), shipId), logPath),
    renderTrend(summariseTrend(readBranchHistory(sink, key), key)),
  ]
    .filter(Boolean)
    .join('\n');
  if (text) process.stdout.write(`${text}\n`);
}
