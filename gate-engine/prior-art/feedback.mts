/** `guard-review record-feedback prior-art`: an append-only CLAIMED correction to one recorded run. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { emitGateEvent } from '../judge/gate-events.mts';
import { telemetrySink } from '../judge/run-context.mts';
import {
  PRIOR_ART_FRAMINGS,
  PRIOR_ART_VERDICTS,
  type PriorArtVerdict,
} from './response-status.mts';

const SOURCES = ['root', 'user'] as const;
const REASON_EVENT_CAP = 400;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const USAGE =
  'Usage: guard-review record-feedback prior-art --run <invocation_id> ' +
  `--claimed-verdict ${PRIOR_ART_VERDICTS.join('|')} [--claimed-framing ${PRIOR_ART_FRAMINGS.join('|')}] ` +
  `[--supersedes <feedback_id>] --source ${SOURCES.join('|')} --reason "<why>"`;

const OPTIONS = {
  run: { type: 'string' },
  'claimed-verdict': { type: 'string' },
  'claimed-framing': { type: 'string' },
  supersedes: { type: 'string' },
  source: { type: 'string' },
  reason: { type: 'string' },
} as const;

function isOneOf<T extends string>(set: readonly T[], value: string | undefined): value is T {
  return set.some((member) => member === value);
}

/** One claimed correction. Deliberately no gold/label field: it is evidence, not a ruling. */
interface AgentFeedback {
  judge: 'prior-art';
  invocation_id: string;
  feedback_id: string;
  claimed_verdict: PriorArtVerdict;
  claimed_framing?: (typeof PRIOR_ART_FRAMINGS)[number];
  supersedes?: string;
  feedback_source: (typeof SOURCES)[number];
  reason: string;
}

type Parsed = { ok: true; event: AgentFeedback } | { ok: false; error: string };

function fail(error: string): Parsed {
  return { ok: false, error };
}

/** The `agent_feedback` event for valid flags, or the reason they are not valid. */
export function parseFeedback(argv: string[]): Parsed {
  let values: Partial<Record<keyof typeof OPTIONS, string>>;
  try {
    ({ values } = parseArgs({ args: argv, options: OPTIONS, strict: true }));
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const { run, supersedes, source } = values;
  const verdict = values['claimed-verdict'];
  const framing = values['claimed-framing'];
  const reason = values.reason?.trim();
  if (!run || !UUID_RE.test(run))
    return fail('--run must be the invocation_id from a record-agent receipt');
  if (!isOneOf(PRIOR_ART_VERDICTS, verdict)) return fail('unknown or missing --claimed-verdict');
  if (framing !== undefined && !isOneOf(PRIOR_ART_FRAMINGS, framing))
    return fail('unknown --claimed-framing');
  if (supersedes !== undefined && !UUID_RE.test(supersedes))
    return fail('--supersedes must be a feedback_id from an earlier record-feedback receipt');
  if (!isOneOf(SOURCES, source)) return fail('unknown or missing --source');
  if (!reason) return fail('--reason is required');
  // Code points, not UTF-16 units: an emoji is one character to the person writing the reason.
  if ([...reason].length > REASON_EVENT_CAP)
    return fail(`--reason exceeds ${REASON_EVENT_CAP} characters`);
  const event: AgentFeedback = {
    judge: 'prior-art',
    invocation_id: run,
    feedback_id: randomUUID(),
    claimed_verdict: verdict,
    feedback_source: source,
    reason,
  };
  if (framing) event.claimed_framing = framing;
  if (supersedes) event.supersedes = supersedes;
  return { ok: true, event };
}

/** Whether one sink line is a prior-art event carrying every `fields` value. */
function lineMatches(line: string, fields: Readonly<Record<string, string>>): boolean {
  try {
    // SAFETY: sink lines are flat JSON objects written by emitGateEvent; only string fields are read.
    const ev = JSON.parse(line) as Partial<Record<string, string>>;
    return (
      ev.judge === 'prior-art' &&
      Object.entries(fields).every(([k, v]) => Object.hasOwn(ev, k) && ev[k] === v)
    );
  } catch {
    return false;
  }
}

/** Whether a sink line holding `id` matches. Buffer search: the sink outgrows Node's string limit. */
function sinkHas(sink: Buffer, id: string, fields: Readonly<Record<string, string>>): boolean {
  for (let at = sink.indexOf(id); at !== -1; at = sink.indexOf(id, at + id.length)) {
    const end = sink.indexOf(0x0a, at);
    const line = sink.toString(
      'utf8',
      sink.lastIndexOf(0x0a, at) + 1,
      end === -1 ? sink.length : end,
    );
    if (lineMatches(line, fields)) return true;
  }
  return false;
}

/** Why a reference does not resolve in the sink, or null when it does. */
function unresolvedReference(event: AgentFeedback): string | null {
  const sink = telemetrySink();
  if (!sink)
    return 'telemetry is off: no recorded run can be resolved, and nothing would be written';
  let bytes: Buffer;
  try {
    bytes = readFileSync(sink);
  } catch {
    return `cannot read the telemetry sink ${sink}, so run ${event.invocation_id} cannot be resolved`;
  }
  const run = event.invocation_id;
  if (!sinkHas(bytes, run, { type: 'judge_exec', invocation_id: run }))
    return `no prior-art run ${run} is recorded in ${sink}`;
  const prior = event.supersedes;
  if (
    prior &&
    !sinkHas(bytes, prior, { type: 'agent_feedback', feedback_id: prior, invocation_id: run })
  )
    return `no feedback ${prior} on run ${run} is recorded in ${sink}`;
  return null;
}

/** Exit 2 on bad input with nothing appended; otherwise 0 with a receipt, even if telemetry failed. */
export function runRecordFeedback(argv: string[]): number {
  const parsed = parseFeedback(argv);
  const error = parsed.ok ? unresolvedReference(parsed.event) : parsed.error;
  if (!parsed.ok || error) {
    console.error(`guard-review record-feedback: ${error}\n${USAGE}`);
    return 2;
  }
  const telemetry = emitGateEvent({ ...parsed.event, type: 'agent_feedback' });
  console.log(JSON.stringify({ feedback_id: parsed.event.feedback_id, telemetry }));
  return 0;
}
