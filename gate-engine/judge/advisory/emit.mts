/**
 * The advisory channel: a stage that holds no exit still has to be readable at the ship terminus.
 * Its OWN event type, never gate_result — reasoning in gate-telemetry-self-describing (sc-2526).
 */
import { stripVTControlCharacters } from 'node:util';
import { z } from 'zod';
import { UNSAFE_TEXT_RE } from '../../review/valve/shell-word.mts';
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
  lists?: FindingLists;
}

/** A field fallow reshaped reads as absent, so one odd finding never costs the whole report. */
const loose = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);
const Text = loose(z.string().min(1));
const Line = loose(z.number().int());
const Site = z.object({ file: Text, path: Text, start_line: Line, line: Line });

/** The fields fallow's own summary renderer (action/jq/summary-audit.jq) locates and names one by. */
const Finding = z.object({
  introduced: loose(z.boolean()),
  path: Text,
  from_path: Text,
  line: Line,
  files: z.array(z.string().min(1)).catch([]),
  instances: z.array(Site).catch([]),
  locations: z.array(Site).catch([]),
  name: Text,
  export_name: Text,
  package_name: Text,
  member_name: Text,
  specifier: Text,
  code: Text,
});
type Finding = z.infer<typeof Finding>;

const Findings = z
  .array(Finding.nullable().catch(null))
  .catch([])
  .transform((items) => items.filter((item): item is Finding => item !== null));

/** The lists whose items fallow flags `introduced`; a missing or reshaped list reads as empty. */
const FindingLists = z.object({
  complexity: z
    .object({ findings: Findings, styling_findings: Findings })
    .catch({ findings: [], styling_findings: [] }),
  duplication: z.object({ clone_groups: Findings }).catch({ clone_groups: [] }),
  dead_code: z.record(z.string(), Findings).catch({}),
});
type FindingLists = z.infer<typeof FindingLists>;

/** The counters paired with the words devkit prints and the lists whose items fallow flags. */
const INTRODUCED: ReadonlyArray<
  readonly [field: keyof FallowAttribution, label: string, items: (l: FindingLists) => Finding[]]
> = [
  ['complexity_introduced', 'complexity', (l) => l.complexity.findings],
  ['duplication_introduced', 'duplication', (l) => l.duplication.clone_groups],
  ['dead_code_introduced', 'dead code', (l) => Object.values(l.dead_code).flat()],
  ['styling_introduced', 'styling', (l) => l.complexity.styling_findings],
];

/** A counter the report did not supply, or supplied as something that is not a number, counts 0. */
const count = (value: number | undefined): number =>
  Number.isFinite(value) && Number(value) > 0 ? Math.trunc(Number(value)) : 0;

/** The first candidate present — one call rather than a branch per candidate. */
const firstOf = <T,>(...candidates: Array<T | undefined>): T | undefined =>
  candidates.find((candidate) => candidate !== undefined);

/** `path:line name` for one finding; a clone group is located by its first instance. */
function locate(item: Finding): string {
  const [clone = {}] = item.instances;
  const [site = {}] = item.locations;
  const file = firstOf(item.path, item.from_path, clone.file, item.files[0], site.path);
  const line = firstOf(item.line, clone.start_line, site.line);
  const where = file && (line === undefined ? file : `${file}:${line}`);
  const { name, export_name, package_name, member_name, specifier, code } = item;
  const label = firstOf(name, export_name, package_name, member_name, specifier, code);
  const located = [where, label].filter(Boolean).join(' ') || '(no location)';
  // A committed path can carry a newline or an escape sequence; printed raw it forges a log line.
  return stripVTControlCharacters(located).replace(UNSAFE_TEXT_RE, ' ');
}

interface Introduced {
  /** fallow's introduced counters as the words devkit prints. Zeroes are omitted, never rendered. */
  parts: string[];
  /** Every finding fallow flagged introduced, from the categories whose flags match its counter. */
  named: string[];
  /** Categories whose flag count disagrees with the counter: fallow keys findings without a line. */
  unattributed: string[];
}

/** A category is named only when its flags equal its counter; a disagreement is silence, not a guess. */
function introduced({ attribution = {}, lists }: FallowAudit): Introduced {
  const result: Introduced = { parts: [], named: [], unattributed: [] };
  for (const [field, label, items] of INTRODUCED) {
    const n = count(attribution[field]);
    if (n === 0) continue;
    result.parts.push(`${n} ${label}`);
    const flagged = lists ? items(lists).filter((item) => item.introduced === true) : [];
    if (flagged.length === n) result.named.push(...flagged.map(locate));
    else result.unattributed.push(label);
  }
  return result;
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
  return {
    verdict: report.verdict,
    attribution: report.attribution ?? {},
    lists: FindingLists.safeParse(report).data,
  };
}

/** The verdicts fallow emits and this module can interpret; anything else is an unreadable report. */
const VERDICTS: readonly string[] = ['pass', 'warn', 'fail'];

/** Clean means fallow passed AND introduced nothing — a `warn` verdict is a finding, not silence. */
const isClean = (verdict: string, parts: string[]): boolean =>
  verdict === 'pass' && parts.length === 0;

/** The digest cuts a row at 140 chars, so the row carries basenames and only the first few names. */
const NAMED_IN_ROW = 3;

function rowNames(named: string[]): string {
  if (named.length === 0) return '';
  const shown = named.slice(0, NAMED_IN_ROW).map((name) => name.replace(/^\S*\//, ''));
  const more = named.length > NAMED_IN_ROW ? `, +${named.length - NAMED_IN_ROW} more` : '';
  return `: ${shown.join(', ')}${more}`;
}

/** What the terminus prints: fallow's verdict, its own counters, what they name, and the prose. */
const detailFor = (verdict: string, { parts, named }: Introduced): string =>
  `verdict=${verdict}${parts.length > 0 ? ` · ${parts.join(', ')} introduced${rowNames(named)}` : ''} — read the fallow section of the log`;

type FallowSummary = { token: Exclude<AdvisoryToken, 'unreadable'>; detail: string } & Introduced;

/**
 * CLEAN needs a `pass` verdict AND zero introduced counters: fallow returns warn with EXIT 0 for a
 * duplication-only changeset, which is exactly the run sc-2526 reports as lost.
 */
export function summariseFallowAudit(text: string): FallowSummary | null {
  const report = readReport(text);
  const { verdict } = report;
  if (!verdict) return null;
  const found = introduced(report);
  if (isClean(verdict, found.parts)) return { token: 'clean', detail: '', ...found };
  return { token: 'findings', detail: detailFor(verdict, found), ...found };
}

/** The log's answer to "which finding is mine": fallow's human report lists them unmarked. */
function introducedBlock({ named, unattributed }: Introduced): string {
  const lines = [
    ...named.map((name) => `  ${name}`),
    ...unattributed.map(
      (label) => `  ${label}: fallow's per-finding flags do not match its counter — not named`,
    ),
  ];
  if (lines.length === 0) return '';
  return `fallow — introduced by this diff (fallow's own attribution):\n${lines.join('\n')}\n`;
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
  process.stderr.write(introducedBlock(summary));
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
