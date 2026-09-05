/**
 * The advisory channel: a stage that holds no exit still has to be readable at the ship terminus.
 * Its OWN event type, never gate_result — reasoning in gate-telemetry-self-describing (sc-2526).
 */
import { emitGateEvent } from '../gate-events.mts';

/** What an advisory can say about itself. It can never say "blocked": it holds no exit. */
export type AdvisoryStatus = 'finding' | 'could_not_run';

/** What the caller does next: print nothing, print the human report, or say it could not tell. */
export type AdvisoryToken = 'clean' | 'findings' | 'unreadable';

/**
 * Caps the SINK, not the terminal — one sub-4KB O_APPEND is what keeps a concurrent judge's row
 * intact while this one is written. Completeness's cap.
 */
const DETAIL_CAP = 500;

/**
 * Carries NO `family`: the digest's isBlocking() matches on that field, and a stage holding no exit
 * must never be renderable as the gate that stopped the run.
 */
export function emitAdvisoryResult(gate: string, status: AdvisoryStatus, detail: string): void {
  emitGateEvent({
    type: 'advisory_result',
    gate,
    status,
    detail: detail.length > DETAIL_CAP ? `${detail.slice(0, DETAIL_CAP - 1)}…` : detail,
  });
}

/** The self-host fallow stage's gate label — one token, shared by the emitter and its tests. */
export const FALLOW_ADVISORY = 'fallow-advisory';

/**
 * fallow's OWN published counters, the only numbers devkit reports. Reading them is licensed by
 * fallow-gate-owned-by-fallow; deriving a count from its human report would not be.
 */
interface FallowAttribution {
  complexity_introduced?: number;
  duplication_introduced?: number;
  dead_code_introduced?: number;
  styling_introduced?: number;
}

/**
 * Every field optional because this is a VENDOR payload that may change shape and must never throw
 * inside a hook; no read below trusts a declared type.
 */
interface FallowAudit {
  verdict?: string;
  attribution?: FallowAttribution;
}

/** The counters paired with the words devkit prints for them. */
const INTRODUCED: ReadonlyArray<readonly [field: keyof FallowAttribution, label: string]> = [
  ['complexity_introduced', 'complexity'],
  ['duplication_introduced', 'duplication'],
  ['dead_code_introduced', 'dead code'],
  ['styling_introduced', 'styling'],
];

/** A counter the report did not supply, or supplied as something that is not a number, counts 0. */
const count = (value: number | undefined): number =>
  Number.isFinite(value) && Number(value) > 0 ? Math.trunc(Number(value)) : 0;

/** fallow's introduced counters as the words devkit prints. Zeroes are omitted, never rendered. */
function introducedParts(attribution: FallowAttribution = {}): string[] {
  return INTRODUCED.map(([field, label]) => [count(attribution[field]), label] as const)
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${n} ${label}`);
}

/**
 * An unreadable payload yields the EMPTY report, so one downstream check — "is there a verdict" —
 * covers malformed JSON, a null body, a non-object body and a dropped field alike.
 */
function readReport(text: string): FallowAudit {
  let report: FallowAudit;
  try {
    // SAFETY: asserts a SHAPE only — no read trusts a declared type (VERDICTS.includes on the
    // verdict, Number.isFinite on counters), and `?? {}` makes a null payload safe to access.
    report = (JSON.parse(text) as FallowAudit | null) ?? {};
  } catch {
    return {};
  }
  // The verdict must be one devkit KNOWS, not merely present: interpreting an object would put
  // `verdict=[object Object]` at the terminus as though it were real attribution.
  if (!VERDICTS.includes(report.verdict ?? '')) return {};
  // `?? {}` covers a literal `attribution: null`, which the parameter default cannot: a default
  // fires only on undefined, so null would reach the counter reads and throw inside the hook.
  return { verdict: report.verdict, attribution: report.attribution ?? {} };
}

/** The verdicts fallow emits and this module can interpret; anything else is an unreadable report. */
const VERDICTS: readonly string[] = ['pass', 'warn', 'fail'];

/** Clean means fallow passed AND introduced nothing — a `warn` verdict is a finding, not silence. */
const isClean = (verdict: string, parts: string[]): boolean =>
  verdict === 'pass' && parts.length === 0;

/** What the terminus prints: fallow's verdict, its own counters, and where the prose is. */
const detailFor = (verdict: string, parts: string[]): string =>
  `verdict=${verdict}${parts.length > 0 ? ` · ${parts.join(', ')} introduced` : ''} — read the fallow section of the log`;

/**
 * CLEAN needs a `pass` verdict AND zero introduced counters: fallow returns warn with EXIT 0 for a
 * duplication-only changeset, which is exactly the run sc-2526 reports as lost.
 */
export function summariseFallowAudit(
  text: string,
): { token: Exclude<AdvisoryToken, 'unreadable'>; detail: string } | null {
  const { verdict, attribution } = readReport(text);
  if (!verdict) return null;
  const parts = introducedParts(attribution);
  if (isClean(verdict, parts)) return { token: 'clean', detail: '' };
  return { token: 'findings', detail: detailFor(verdict, parts) };
}

/** `absent` is its own case rather than a silent skip — gate-opt-out-is-visible-and-detectable. */
export function reportFallowAudit(
  read: () => string,
  absent: boolean,
  auditFailed = false,
): AdvisoryToken {
  if (absent) return verifiedNothing('fallow is not on PATH — the advisory audit verified nothing');
  const summary = summariseSafely(read);
  if (!summary)
    return verifiedNothing(
      "fallow's audit report could not be read — the advisory verified nothing",
    );
  if (summary.token === 'clean') {
    // A non-zero exit is fallow's normal signal for a FAIL verdict, so it is only contradictory
    // beside a clean report — and a report contradicted by its own process is not evidence.
    if (auditFailed)
      return verifiedNothing(
        'fallow exited non-zero while reporting a clean verdict — the advisory verified nothing',
      );
    // Silence on a genuinely clean audit is deliberate (sc-2488): a digest firing on every green
    // ship is a line nobody reads. Measured, 6 of devkit's last 10 commits audit clean.
    return 'clean';
  }
  emitAdvisoryResult(FALLOW_ADVISORY, 'finding', summary.detail);
  return 'findings';
}

/** A gate that verified NOTHING must not read like a gate that found nothing. */
function verifiedNothing(detail: string): AdvisoryToken {
  emitAdvisoryResult(FALLOW_ADVISORY, 'could_not_run', detail);
  return 'unreadable';
}

/** The reader is caller-supplied IO (a missing file throws), and a throw means "cannot tell". */
function summariseSafely(read: () => string): ReturnType<typeof summariseFallowAudit> {
  try {
    return summariseFallowAudit(read());
  } catch {
    return null;
  }
}

// CLI: `node advisory/emit.mjs fallow-advisory <json-path>|--absent` prints ONE token — clean |
// findings | unreadable. Narration only: it always exits 0 and may never change a verdict.
if (
  /[/\\]advisory[/\\]emit\.m[jt]s$/.test(process.argv[1] ?? '') &&
  process.argv[2] === FALLOW_ADVISORY
) {
  const arg = process.argv[3] ?? '';
  let token: AdvisoryToken = 'unreadable';
  try {
    const { readFileSync } = await import('node:fs');
    token = reportFallowAudit(
      () => readFileSync(arg, 'utf8'),
      arg === '--absent',
      (process.argv[4] ?? '0') !== '0',
    );
  } catch {
    /* narration only — the default token already tells the caller to print the human report */
  }
  process.stdout.write(`${token}\n`);
}
