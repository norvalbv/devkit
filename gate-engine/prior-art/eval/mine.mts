#!/usr/bin/env node
/** Prior-art candidate miner: runs and claimed feedback become private candidates, never labels.
 * Usage and the promotion rules: README.md, "Mining production runs". */
import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';
import {
  parsePriorArtResponse,
  PRIOR_ART_FRAMINGS,
  PRIOR_ART_VERDICTS,
  type PriorArtResponseV1,
} from '../response-contract.mts';
import type { Row } from './cases.mts';
import type { LegsFixture } from './run-agent.mts';

const RESEARCH_DIR = path.join(homedir(), '.devkit', 'research', 'prior-art');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The `judge_exec` fields a candidate keeps from one recorded prior-art run. */
const RunLine = z.object({
  type: z.literal('judge_exec'),
  judge: z.literal('prior-art'),
  invocation_id: z.string(),
  ts: z.string(),
  output_sha256: z.string().nullish(),
  request_sha256: z.string().nullish(),
  output_status: z.string().nullish(),
  request_status: z.string().nullish(),
  repo: z.string().nullish(),
  devkit_version: z.string().nullish(),
  prior_art_verdict: z.string().nullish(),
  disposition: z.string().nullish(),
});
export type RunEvent = z.infer<typeof RunLine>;

/** One `agent_feedback` line: a claimed correction, carried verbatim. */
const FeedbackLine = z.object({
  type: z.literal('agent_feedback'),
  judge: z.literal('prior-art'),
  invocation_id: z.string(),
  feedback_id: z.string(),
  ts: z.string(),
  claimed_verdict: z.string(),
  claimed_framing: z.string().optional(),
  supersedes: z.string().optional(),
  feedback_source: z.string(),
  reason: z.string(),
});
export type FeedbackEvent = z.infer<typeof FeedbackLine>;

export interface SinkScan {
  runs: RunEvent[];
  feedback: FeedbackEvent[];
  malformed: number;
}

export type EvidenceStatus = 'present' | 'missing' | 'corrupt' | 'hash_mismatch' | 'not_captured';

export interface Evidence {
  status: EvidenceStatus;
  bytes?: Buffer;
}

export interface Candidate {
  invocation_id: string;
  as_of: string;
  repo: string | null;
  devkit_version: string | null;
  recorded_verdict: string | null;
  disposition: string | null;
  /** Lines naming this run; copies of one line collapse, differing payloads set `conflict`. */
  copies: number;
  conflict: boolean;
  request: { sha256: string | null; evidence: EvidenceStatus; status: string | null };
  output: { sha256: string | null; evidence: EvidenceStatus; status: string | null };
  feedback: FeedbackEvent[];
  heads: string[];
  dangling: string[];
  feedback_state: 'none' | 'settled' | 'conflict';
}

export interface Queue {
  candidates: Candidate[];
  orphanFeedback: string[];
  malformed: number;
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, [T, ...T[]]> {
  const groups = new Map<string, [T, ...T[]]>();
  for (const item of items) {
    const group = groups.get(key(item));
    if (group) group.push(item);
    else groups.set(key(item), [item]);
  }
  return groups;
}

/** Stream the sink line by line: it is hundreds of MB, past what one string read can hold. */
export async function readPriorArtEvents(sinkPath: string, asOf?: string): Promise<SinkScan> {
  const scan: SinkScan = { runs: [], feedback: [], malformed: 0 };
  const lines = createInterface({ input: createReadStream(sinkPath), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes('"prior-art"')) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      scan.malformed += 1; // a torn or partial line, typically a write still in flight
      continue;
    }
    const run = RunLine.safeParse(event);
    const feedback = run.success ? null : FeedbackLine.safeParse(event);
    if (run.success && (asOf === undefined || run.data.ts <= asOf)) scan.runs.push(run.data);
    if (feedback?.success && (asOf === undefined || feedback.data.ts <= asOf))
      scan.feedback.push(feedback.data);
  }
  return scan;
}

/** Archived bytes for a hash, verified against it; never a transcript or a reconstruction. */
export function readEvidence(evidenceDir: string, hash: string | undefined): Evidence {
  if (!hash) return { status: 'not_captured' };
  const file = path.join(evidenceDir, `${hash}.gz`);
  if (!existsSync(file)) return { status: 'missing' };
  let bytes: Buffer;
  try {
    bytes = gunzipSync(readFileSync(file));
  } catch {
    return { status: 'corrupt' };
  }
  return sha256(bytes) === hash ? { status: 'present', bytes } : { status: 'hash_mismatch' };
}

function supersession(feedback: FeedbackEvent[]) {
  const ids = new Set(feedback.map((f) => f.feedback_id));
  const dangling = feedback.filter((f) => f.supersedes && !ids.has(f.supersedes));
  const superseded = new Set(
    feedback.flatMap((f) => (f.supersedes && ids.has(f.supersedes) ? [f.supersedes] : [])),
  );
  const heads = [
    ...new Set(feedback.filter((f) => !superseded.has(f.feedback_id)).map((f) => f.feedback_id)),
  ];
  // Two payloads under one feedback id, or a cycle with no head, are conflicts, never settled.
  const settled = heads.length === 1 && ids.size === feedback.length;
  const state = feedback.length === 0 ? 'none' : settled ? 'settled' : 'conflict';
  return { heads, dangling: dangling.map((f) => f.feedback_id), feedback_state: state } as const;
}

function toCandidate(
  lines: [RunEvent, ...RunEvent[]],
  feedback: FeedbackEvent[],
  evidenceDir: string,
): Candidate {
  const [run] = lines;
  // Parsed lines serialise in schema order, so a copy matches whatever its original key order.
  const keys = new Set(lines.map((line) => JSON.stringify(line)));
  return {
    invocation_id: run.invocation_id,
    as_of: run.ts,
    repo: run.repo ?? null,
    devkit_version: run.devkit_version ?? null,
    recorded_verdict: run.prior_art_verdict ?? null,
    disposition: run.disposition ?? null,
    copies: lines.length,
    conflict: keys.size > 1,
    request: {
      sha256: run.request_sha256 ?? null,
      evidence: readEvidence(evidenceDir, run.request_sha256 ?? undefined).status,
      status: run.request_status ?? null,
    },
    output: {
      sha256: run.output_sha256 ?? null,
      evidence: readEvidence(evidenceDir, run.output_sha256 ?? undefined).status,
      status: run.output_status ?? null,
    },
    feedback,
    ...supersession(feedback),
  };
}

/** Join runs and feedback on invocation_id, keeping every revision and every gap explicit. */
export function buildCandidates(scan: SinkScan, evidenceDir: string): Queue {
  const runs = groupBy(scan.runs, (r) => r.invocation_id);
  const unique = [...new Map(scan.feedback.map((f) => [JSON.stringify(f), f])).values()].sort(
    (a, b) => a.ts.localeCompare(b.ts),
  );
  const feedback = groupBy(unique, (f) => f.invocation_id);
  return {
    candidates: [...runs].map(([id, lines]) =>
      toCandidate(lines, feedback.get(id) ?? [], evidenceDir),
    ),
    orphanFeedback: unique.filter((f) => !runs.has(f.invocation_id)).map((f) => f.feedback_id),
    malformed: scan.malformed,
  };
}

export interface PromoteInput {
  caseId: string;
  verdict: string;
  framing?: string;
  labelSource: string;
  privacyReviewed: boolean;
}

/** A label must come from outside the run: never a feedback claim, never the run's own telemetry. */
function labelSourceError(source: string, telemetryDir: string): string | null {
  if (UUID_RE.test(source)) return 'a feedback id is a claim, not a label source';
  if (/^https?:\/\/\S+$/.test(source)) return null;
  if (!existsSync(source)) return `label source ${source} is neither an http(s) URL nor a file`;
  // Real paths on both sides: a symlink or a case variant must not hide the run's own telemetry.
  const inside = path.relative(realpathSync.native(telemetryDir), realpathSync.native(source));
  if (inside !== '..' && !inside.startsWith(`..${path.sep}`) && !path.isAbsolute(inside))
    return 'the run’s own telemetry cannot label it';
  return null;
}

function strictUtf8(bytes: Buffer | undefined): string | null {
  try {
    return bytes ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) : null;
  } catch {
    return null;
  }
}

const unusable = (evidence: Evidence): string =>
  evidence.status === 'present' ? 'not UTF-8' : evidence.status;

function legsOf(response: PriorArtResponseV1): LegsFixture {
  const status = (name: string) =>
    response.legs.find((leg) => leg.leg === name)?.status ?? 'unavailable';
  const local = response.legs.find((leg) => leg.leg === 'local');
  return {
    local: {
      status: status('local'),
      declared: local?.declaredCheckouts ?? 0,
      resolved: local?.resolvedCheckouts ?? 0,
    },
    github: status('github'),
    web: status('web'),
    papers: status('papers'),
    'deep-research': status('deep-research'),
  };
}

function inputErrors(input: PromoteInput, telemetryDir: string): string[] {
  const errors: string[] = [];
  if (!input.caseId.trim()) errors.push('a case id (the family that keeps variants together)');
  if (!PRIOR_ART_VERDICTS.some((verdict) => verdict === input.verdict))
    errors.push(`verdict "${input.verdict}" is not a prior-art verdict`);
  if (input.framing && !PRIOR_ART_FRAMINGS.some((framing) => framing === input.framing))
    errors.push(`framing "${input.framing}" is not a framing`);
  if (!input.privacyReviewed) errors.push('a privacy review before any draft exists');
  const label = labelSourceError(input.labelSource, telemetryDir);
  if (label) errors.push(label);
  return errors;
}

export type DraftRow = Row & { promoted_at: string };

/**
 * Promote one candidate to a row DRAFT. The prompt is the archived request plus excerpts quoted in
 * the archived response, so nothing written after the run can leak its answer into the row.
 */
export function draftRow(
  candidate: Candidate,
  input: PromoteInput,
  telemetryDir: string,
): { ok: true; draft: DraftRow } | { ok: false; errors: string[] } {
  const errors = inputErrors(input, telemetryDir);
  if (candidate.conflict)
    errors.push('the run was recorded with conflicting payloads; resolve which one is real first');
  const evidenceDir = path.join(telemetryDir, 'evidence');
  const request = readEvidence(evidenceDir, candidate.request.sha256 ?? undefined);
  const output = readEvidence(evidenceDir, candidate.output.sha256 ?? undefined);
  const requestText = strictUtf8(request.bytes);
  const outputText = strictUtf8(output.bytes);
  if (requestText === null) errors.push(`request evidence is ${unusable(request)}`);
  if (outputText === null) errors.push(`response evidence is ${unusable(output)}`);
  const parsed = outputText === null ? null : parsePriorArtResponse(outputText);
  if (parsed && !parsed.ok)
    errors.push(`the archived response is invalid: ${parsed.error.message}`);
  if (errors.length > 0 || !parsed?.ok || requestText === null) return { ok: false, errors };
  const excerpts = parsed.value.evidence.map(
    (item, index) => `[E${index + 1} · ${item.source}] ${item.quote}`,
  );
  const url = /^https?:\/\//.test(input.labelSource);
  return {
    ok: true,
    draft: {
      id: `mined-${candidate.invocation_id.slice(0, 8)}`,
      mode: 'intrinsic',
      prompt: `${requestText}\n\nREFERENCE EXCERPTS (complete contents of your reached legs):\n${excerpts.join('\n')}`,
      legs: legsOf(parsed.value),
      expectVerdict: [input.verdict],
      expectFraming: input.framing ? [input.framing] : [],
      gold: [],
      decoys: [],
      category: '',
      note: '',
      difficulty: 'normal',
      provenance: 'mined',
      caseId: input.caseId,
      source: {
        ...(url ? { url: input.labelSource } : { receipt: path.resolve(input.labelSource) }),
        invocationId: candidate.invocation_id,
      },
      promoted_at: new Date().toISOString(),
    },
  };
}

const OPTIONS = {
  sink: { type: 'string' },
  'as-of': { type: 'string' },
  out: { type: 'string' },
  drafts: { type: 'string' },
  'case-id': { type: 'string' },
  verdict: { type: 'string' },
  framing: { type: 'string' },
  'label-source': { type: 'string' },
  'privacy-reviewed': { type: 'boolean' },
} as const;

type Flags = ReturnType<
  typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>
>['values'];

function defaultSink(): string {
  return (
    process.env.DEVKIT_GATE_EVENTS ||
    path.join(homedir(), '.devkit', 'telemetry', 'gate-events.jsonl')
  );
}

/** Write one draft, write-once: the draft file is the promotion's audit record. */
function promote(queue: Queue, id: string | undefined, flags: Flags, telemetryDir: string): number {
  const candidate = queue.candidates.find((c) => c.invocation_id === id);
  if (!candidate) {
    console.error(`prior-art mine: no recorded run ${id ?? '(missing id)'}`);
    return 2;
  }
  const result = draftRow(
    candidate,
    {
      caseId: flags['case-id'] ?? '',
      verdict: flags.verdict ?? '',
      framing: flags.framing,
      labelSource: flags['label-source'] ?? '',
      privacyReviewed: flags['privacy-reviewed'] === true,
    },
    telemetryDir,
  );
  if (!result.ok) {
    console.error(`prior-art mine: refused, needs:\n- ${result.errors.join('\n- ')}`);
    return 2;
  }
  const dir = flags.drafts ?? path.join(RESEARCH_DIR, 'drafts');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${candidate.invocation_id}.json`);
  try {
    writeFileSync(file, `${JSON.stringify(result.draft, null, 2)}\n`, { flag: 'wx' });
  } catch (error) {
    console.error(
      existsSync(file)
        ? `prior-art mine: ${file} already exists; a promotion is never rewritten`
        : `prior-art mine: cannot write ${file}: ${String(error)}`,
    );
    return 2;
  }
  console.log(file);
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const { values: flags, positionals } = parseArgs({
    args: argv,
    options: OPTIONS,
    allowPositionals: true,
  });
  const asOf = flags['as-of'] === undefined ? undefined : new Date(flags['as-of']);
  if (asOf && Number.isNaN(asOf.getTime())) {
    console.error(`prior-art mine: --as-of ${flags['as-of']} is not a date`);
    return 2;
  }
  const sink = flags.sink ?? defaultSink();
  if (!existsSync(sink)) {
    console.error(`prior-art mine: no telemetry sink at ${sink}`);
    return 2;
  }
  const telemetryDir = path.dirname(sink);
  const queue = buildCandidates(
    await readPriorArtEvents(sink, asOf?.toISOString()),
    path.join(telemetryDir, 'evidence'),
  );
  if (positionals[0] === 'promote') return promote(queue, positionals[1], flags, telemetryDir);
  const out = flags.out ?? path.join(RESEARCH_DIR, 'candidates.jsonl');
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, queue.candidates.map((c) => `${JSON.stringify(c)}\n`).join(''));
  const present = queue.candidates.filter(
    (c) => c.request.evidence === 'present' && c.output.evidence === 'present',
  ).length;
  console.log(
    `${queue.candidates.length} candidates (${present} with both sides archived), ` +
      `${queue.orphanFeedback.length} orphan feedback, ${queue.malformed} malformed lines → ${out}`,
  );
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exitCode = await main(process.argv.slice(2));
