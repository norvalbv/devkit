// critique-eval RUNNER — spawns the feature-critique agent exactly as a bench row needs it.
//
// There is no importable gate runner for this agent (it ships as agents/feature-critique.md and is
// dispatched via the Task tool), so the no-drift guarantee the decisions bench gets from importing
// runDetectJudge et al. comes from two substitutes instead:
//   · the agent body is read FROM SOURCE (agents/feature-critique.md — never a .claude/.cursor
//     synced copy, which is derived and may lag `devkit sync-agents`), at spawn time;
//   · the baseline embeds agentHash (the md) and runnerHash (this file + matcher.mts), while
//     salvage fingerprints both plus model and corpus — see bench.mts; a changed prompt or harness
//     is a changed experiment, never a silent one.
//
// Fidelity: production dispatch makes the md the SUBAGENT'S SYSTEM PROMPT. `--append-system-prompt`
// is the closest `claude -p` analog, and it keeps the user prompt = the critique request alone —
// so production and benchmark requests use the same input boundary. Residual gaps (no Task-tool
// env, no deep-research MCP under -p) are documented README departures, not hidden.
//
// Two spawn modes, one per row mode:
//   intrinsic  — no tools (JUDGE_READ_ONLY), the BENCHMARK directive inlines everything; scores the
//                agent's frame reasoning alone. Cheap (~30–60 s a row).
//   workflow   — the full contract in a disposable fixture repo: tools allowed, stdout is the
//                closed plan-critique JSON response. Expensive (2–6 min a row).
//
// Argv order is load-bearing: `--allowedTools`/`--disallowedTools` are VARIADIC — anything after
// them (including a positional prompt) is swallowed as a tool name (see check-alignment.mts:205).
// The positional prompt therefore sits BEFORE the tool flags, and tool flags go LAST.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLAUDE_RESULT_ARGS, unwrapClaudeResult } from '../../judge/claude-result.mts';
import { JUDGE_ISOLATION, JUDGE_READ_ONLY } from '../../judge/judge-isolation.mts';
import type { JudgeOutage } from '../../judge/outage/classify.mts';
import { execJudgeAsync } from '../../judge/run-judge.mts';
import { type AgentSource, loadAgentSource } from '../../review/reviewers.mts';
import { firstDuplicateJsonKey } from '../json-duplicate-keys.mts';
import {
  PLAN_CRITIQUE_FRAME_METAS,
  PLAN_CRITIQUE_RESPONSE_MAX_BYTES,
  PLAN_CRITIQUE_VERDICTS,
  parsePlanCritiqueResponse,
} from '../response-contract.mts';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Source-of-truth agent md — three levels up from gate-engine/critique/eval/. */
export const AGENT_MD_PATH = path.join(here, '../../../agents/feature-critique.md');

export const INTRINSIC_TIMEOUT_MS = 300_000; // run.mjs precedent; 120s false-aborts under contention
export const WORKFLOW_TIMEOUT_MS = 600_000; // agentic opus with tool use runs 2–6 min

/** What the workflow agent may touch inside its fixture. Single comma-joined string (the flag is
 * variadic — one argv slot keeps the prompt safe), prefix-colon Bash rule per check-alignment. */
export const WORKFLOW_TOOLS = 'Read,Grep,Glob,LS,Write,Edit,Bash(git:*)';
export { CLAUDE_RESULT_ARGS };

/**
 * The intrinsic-mode directive — ported from scripts/agent-benchmarks/run.mjs and updated to the
 * normalized response contract. It is part of runnerHash: editing it is a new experiment by
 * construction, so "ported" is provenance, not an immutability promise.
 */
export const BENCHMARK_DIRECTIVE = [
  '=== BENCHMARK MODE ===',
  'Everything you need is in the CRITIQUE REQUEST below. Do NOT run any tools, scripts, research,',
  'MCP calls, or file reads, and do NOT write any files — treat the inlined "RECORDED TARGET(S)" as',
  'the authoritative decision log (none inlined = no decision log; alignment unverified). Apply',
  'your full judgement (especially the Frame check), then return ONLY the closed JSON response',
  'defined in Phase 4. Populate its required analysis, findings, edge cases, actions, and strengths',
  'from the inlined evidence. No prose outside the JSON object and no runtime artifacts.',
  '',
  '=== CRITIQUE REQUEST ===',
  '',
].join('\n');

/** The critique bench's view of its subject. Structurally the shared AgentSource; the alias keeps
 * this harness's own vocabulary at its call sites. */
export type CriticSource = AgentSource;

/** Read the agent from SOURCE. Throws if unreadable — a bench without its subject cannot run. */
export function loadCritic(): CriticSource {
  return loadAgentSource(AGENT_MD_PATH);
}

// ─── Argv builders (pure — unit-tested for the variadic-swallow ordering) ─────────

export function buildIntrinsicArgs(prompt: string, critic: CriticSource): string[] {
  return [
    '-p',
    '--model',
    critic.model,
    '--append-system-prompt',
    critic.body,
    ...JUDGE_ISOLATION,
    ...CLAUDE_RESULT_ARGS,
    BENCHMARK_DIRECTIVE + prompt,
    ...JUDGE_READ_ONLY, // variadic — terminal, after the positional prompt
  ];
}

export function buildWorkflowArgs(prompt: string, critic: CriticSource): string[] {
  return [
    '-p',
    '--model',
    critic.model,
    '--append-system-prompt',
    critic.body,
    ...JUDGE_ISOLATION,
    ...CLAUDE_RESULT_ARGS,
    prompt,
    '--allowedTools', // variadic — terminal, after the positional prompt
    WORKFLOW_TOOLS,
  ];
}

// ─── Spawns ────────────────────────────────────────────────────────────────────────

export interface RunCriticOpts {
  critic: CriticSource;
  /** The critique request text, verbatim from the corpus row. */
  prompt: string;
  /** Workflow: the materialized fixture repo. */
  fixtureDir?: string;
  exec?: typeof execJudgeAsync;
  onOutage?: (outage: JudgeOutage) => void;
}

export interface WorkflowRunOutput {
  /** Final Claude result — the closed plan-critique response (or null on outage). */
  raw: string | null;
}

// Re-exported, not redefined — see the twin note in prior-art/eval/run-agent.mts. The spawn layer
// owns this parser now (sc-1527); importers here keep their current import path.
export { unwrapClaudeResult };

export async function runIntrinsic({
  critic,
  prompt,
  exec = execJudgeAsync,
  onOutage,
}: RunCriticOpts): Promise<string | null> {
  const raw = await exec({
    label: 'critique-eval:intrinsic',
    args: buildIntrinsicArgs(prompt, critic),
    timeout: INTRINSIC_TIMEOUT_MS,
    onOutage,
  });
  return unwrapClaudeResult(raw);
}

export async function runWorkflow({
  critic,
  prompt,
  fixtureDir,
  exec = execJudgeAsync,
  onOutage,
}: RunCriticOpts): Promise<WorkflowRunOutput> {
  if (!fixtureDir) throw new Error('critique-eval: workflow run needs a fixtureDir');
  const raw = await exec({
    label: 'critique-eval:workflow',
    args: buildWorkflowArgs(prompt, critic),
    timeout: WORKFLOW_TIMEOUT_MS,
    cwd: fixtureDir,
    onOutage,
  });
  return { raw: unwrapClaudeResult(raw) };
}

// ─── Compact-summary parsing (deterministic) ──────────────────────────────────────

export const VERDICTS = ['PROCEED WITH CHANGES', 'PROCEED', 'RETHINK', 'REJECT'] as const;
export type Verdict = (typeof VERDICTS)[number];
export const FRAME_METAS = ['SOUND', 'NOTABUG', 'BANDAID', 'UXHARM', 'SKIP'] as const;
export type FrameMeta = (typeof FRAME_METAS)[number];

export interface ParsedSummary {
  responseValid: boolean;
  verdict: Verdict | null;
  frameMeta: FrameMeta | null;
  feasibility: string | null;
  criticalCount: number | null;
  warningCount: number | null;
  uxImpact: string | null;
  /** ~tokens of the whole message (chars/4 heuristic) for the ≤300-token contract check. */
  approxTokens: number;
}

export interface BenchmarkCritiqueResponse {
  /** JSON object text from which the semantic projection was validated. */
  raw: string;
  /** True only when the provider's complete response satisfies the production contract. */
  exact: boolean;
  summary: ParsedSummary;
  findings: BenchmarkFinding[];
}

export interface BenchmarkFinding {
  severity: 'CRITICAL' | 'WARNING';
  /** Exact contract validates the enum; semantic matching only needs a non-empty label. */
  lens: string;
  claim: string;
  evidence: string;
  impact: string;
  recommendation: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function semanticProjection(raw: string): Omit<BenchmarkCritiqueResponse, 'exact'> | null {
  if (Buffer.byteLength(raw, 'utf8') > PLAN_CRITIQUE_RESPONSE_MAX_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (firstDuplicateJsonKey(raw) !== null || !isRecord(value)) return null;
  if (
    value.schemaVersion !== 1 ||
    value.kind !== 'plan_critique' ||
    value.phase !== 'plan' ||
    value.status !== 'reviewed' ||
    !PLAN_CRITIQUE_VERDICTS.includes(value.verdict as never) ||
    !PLAN_CRITIQUE_FRAME_METAS.includes(value.frameMeta as never) ||
    !Array.isArray(value.findings)
  )
    return null;
  const findings: BenchmarkFinding[] = [];
  for (const candidate of value.findings) {
    if (
      !isRecord(candidate) ||
      (candidate.severity !== 'CRITICAL' && candidate.severity !== 'WARNING') ||
      !['lens', 'claim', 'evidence', 'impact', 'recommendation'].every(
        (field) => typeof candidate[field] === 'string' && candidate[field].trim().length > 0,
      )
    )
      return null;
    findings.push(candidate as unknown as BenchmarkFinding);
  }
  const feasibility = isRecord(value.feasibility) ? value.feasibility.status : null;
  const uxImpact = isRecord(value.uxImpact)
    ? `${String(value.uxImpact.level ?? '')}: ${String(value.uxImpact.detail ?? '')}`
    : null;
  const verdict =
    value.verdict === 'PROCEED_WITH_CHANGES' ? 'PROCEED WITH CHANGES' : (value.verdict as Verdict);
  return {
    raw,
    summary: {
      responseValid: false,
      verdict,
      frameMeta: value.frameMeta as FrameMeta,
      feasibility: typeof feasibility === 'string' ? feasibility : null,
      criticalCount: findings.filter((finding) => finding.severity === 'CRITICAL').length,
      warningCount: findings.filter((finding) => finding.severity === 'WARNING').length,
      uxImpact,
      approxTokens: Math.ceil(raw.length / 4),
    },
    findings,
  };
}

/**
 * Keep semantic quality observable when transport-only or unrelated schema fields fail. This is
 * benchmark-only: production eligibility still parses the complete response. The projection
 * validates exactly the verdict/frame/findings fields the semantic metrics consume; it never
 * rewrites the response or chooses between multiple semantically valid objects.
 */
export function extractBenchmarkCritiqueResponse(raw: string): BenchmarkCritiqueResponse | null {
  const exact = parsePlanCritiqueResponse(raw);
  if (exact.ok) {
    const projection = semanticProjection(raw);
    return projection ? { ...projection, exact: true } : null;
  }
  const matches: Array<Omit<BenchmarkCritiqueResponse, 'exact'>> = [];
  for (let start = raw.indexOf('{'); start !== -1; start = raw.indexOf('{', start + 1)) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    let end = -1;
    for (let index = start; index < raw.length; index += 1) {
      const character = raw[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') quoted = true;
      else if (character === '{') depth += 1;
      else if (character === '}' && --depth === 0) {
        end = index + 1;
        break;
      }
    }
    if (end === -1) continue;
    const candidate = raw.slice(start, end);
    const projection = semanticProjection(candidate);
    if (projection) matches.push(projection);
    start = end - 1;
  }
  return matches.length === 1 ? { ...matches[0], exact: false } : null;
}

const line = (raw: string, label: string): string | null => {
  const m = raw.match(new RegExp(`^[\\s>*#-]*\\**${label}\\**\\s*:\\s*(.+)$`, 'im'));
  return m ? m[1].trim() : null;
};

const count = (raw: string, label: string): number | null => {
  const v = line(raw, label);
  if (v === null) return null;
  const n = Number.parseInt(v, 10);
  return Number.isInteger(n) && n >= 0 ? n : null;
};

/** Parse the normalized response, with the retired compact summary retained only as a deterministic
 * legacy fallback. Missing/ambiguous fields parse null — NULL is a verdict column, never an error. */
export function parseSummary(raw: string): ParsedSummary {
  const response = parsePlanCritiqueResponse(raw);
  if (response.ok) {
    const value = response.value;
    return {
      responseValid: true,
      verdict:
        value.verdict === 'PROCEED_WITH_CHANGES'
          ? 'PROCEED WITH CHANGES'
          : (value.verdict as Verdict | null),
      frameMeta: value.frameMeta,
      feasibility: value.feasibility?.status ?? null,
      criticalCount: value.findings.filter((finding) => finding.severity === 'CRITICAL').length,
      warningCount: value.findings.filter((finding) => finding.severity === 'WARNING').length,
      uxImpact: `${value.uxImpact.level}: ${value.uxImpact.detail}`,
      approxTokens: Math.ceil(raw.length / 4),
    };
  }
  const v = line(raw, 'VERDICT')?.toUpperCase() ?? '';
  const verdict = VERDICTS.find((k) => v.includes(k)) ?? null;
  const metaRaw = line(raw, 'FRAME_META')?.toUpperCase() ?? '';
  const metaHits = FRAME_METAS.filter((k) => metaRaw.includes(k));
  return {
    responseValid: false,
    verdict,
    // Exactly one token per the md's contract — two hits is ambiguity, scored NULL.
    frameMeta: metaHits.length === 1 ? metaHits[0] : null,
    feasibility: line(raw, 'FEASIBILITY'),
    criticalCount: count(raw, 'CRITICAL_ISSUES'),
    warningCount: count(raw, 'WARNINGS'),
    uxImpact: line(raw, 'UX_IMPACT'),
    approxTokens: Math.ceil(raw.length / 4),
  };
}
