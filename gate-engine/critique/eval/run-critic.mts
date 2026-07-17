// critique-eval RUNNER — spawns the feature-critique agent exactly as a bench row needs it.
//
// There is no importable gate runner for this agent (it ships as agents/feature-critique.md and is
// dispatched via the Task tool), so the no-drift guarantee the decisions bench gets from importing
// runDetectJudge et al. comes from two substitutes instead:
//   · the agent body is read FROM SOURCE (agents/feature-critique.md — never a .claude/.cursor
//     synced copy, which is derived and may lag `devkit sync-agents`), at spawn time;
//   · the baseline embeds agentHash (the md) and runnerHash (this file + matcher.mts + contract.mts) — see
//     bench.mts; a changed prompt or a changed harness is a changed experiment, never a silent one.
//
// Fidelity: production dispatch makes the md the SUBAGENT'S SYSTEM PROMPT. `--append-system-prompt`
// is the closest `claude -p` analog and keeps the user prompt = the critique request alone.
// Residual gaps (no Task-tool env, no deep-research MCP under -p) are documented README
// departures, not hidden.
//
// Two spawn modes, one per row mode:
//   intrinsic  — no tools (JUDGE_READ_ONLY), the BENCHMARK directive inlines everything; scores the
//                agent's frame reasoning alone. Cheap (~30–60 s a row).
//   workflow   — the full contract in a disposable fixture repo: read-only tools allowed and stdout
//                is the sole exact JSON response. Expensive (2–6 min a row).
//
// Argv order is load-bearing: `--allowedTools`/`--disallowedTools` are VARIADIC — anything after
// them (including a positional prompt) is swallowed as a tool name (see check-alignment.mts:205).
// The positional prompt therefore sits BEFORE the tool flags, and tool flags go LAST.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JUDGE_ISOLATION, JUDGE_READ_ONLY } from '../../judge/judge-isolation.mts';
import { execJudgeAsync } from '../../judge/run-judge.mts';
import { stripFrontmatter } from '../../review/reviewers.mts';
import { parsePlanCritiqueResponse } from '../contract.mts';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Source-of-truth agent md — three levels up from gate-engine/critique/eval/. */
export const AGENT_MD_PATH = path.join(here, '../../../agents/feature-critique.md');

export const INTRINSIC_TIMEOUT_MS = 300_000; // run.mjs precedent; 120s false-aborts under contention
export const WORKFLOW_TIMEOUT_MS = 600_000; // agentic opus with tool use runs 2–6 min

/** What the workflow agent may touch inside its fixture. Single comma-joined string (the flag is
 * variadic — one argv slot keeps the prompt safe), prefix-colon Bash rule per check-alignment. */
export const WORKFLOW_TOOLS = 'Read,Grep,Glob,LS,Bash(git:*)';

/**
 * The intrinsic-mode directive — ported from scripts/agent-benchmarks/run.mjs and EXTENDED to
 * request the FULL summary block: the seed directive asked for VERDICT/FRAME_META/UX_IMPACT only,
 * which would parse every other closed-set field as NULL. It is part of runnerHash: editing it is
 * a new experiment by construction, so "ported" is provenance, not an immutability promise.
 */
export const BENCHMARK_DIRECTIVE = [
  '=== BENCHMARK MODE ===',
  'Everything you need is in the CRITIQUE REQUEST below. Do NOT run any tools, scripts, research,',
  'MCP calls, or file reads, and do NOT write any files — treat the inlined "RECORDED TARGET(S)" as',
  'the authoritative decision log (none inlined = no decision log; alignment unverified). Apply',
  'your full judgement (especially the Frame check), then output ONLY the exact raw JSON contract',
  'defined by the agent. No markdown fence, preamble, file write, artifact, or compact summary.',
  '',
  '=== CRITIQUE REQUEST ===',
  '',
].join('\n');

export interface CriticSource {
  /** Frontmatter-stripped agent body — what production makes the subagent's system prompt. */
  body: string;
  /** The md's frontmatter `model:` (the production model), overridable via BENCH_MODEL. */
  model: string;
  /** Raw file content — hashed into the baseline as agentHash. */
  raw: string;
}

const FRONTMATTER_MODEL_RE = /^model:\s*(\S+)\s*$/m;

/** Read the agent from SOURCE. Throws if unreadable — a bench without its subject cannot run. */
export function loadCritic(): CriticSource {
  const raw = readFileSync(AGENT_MD_PATH, 'utf8');
  const model = process.env.BENCH_MODEL ?? raw.match(FRONTMATTER_MODEL_RE)?.[1] ?? 'opus';
  return { body: stripFrontmatter(raw), model, raw };
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
  /** Workflow: the materialized fixture repo (cwd + where artifacts land). */
  fixtureDir?: string;
  exec?: typeof execJudgeAsync;
  onOutage?: (kind: 'timeout' | 'transient' | 'empty') => void;
}

export interface WorkflowRunOutput {
  /** stdout — the exact JSON response (or null on outage). */
  raw: string | null;
  /** Findings rendered for the existing audited slot matcher; derived only from valid JSON. */
  report: string | null;
  /** Exact JSON retained by salvage; edge cases are read from this response, not a file. */
  artifact: string | null;
  /** Logical source for diagnostics. */
  artifactPath: string;
  contractValid: boolean;
  repositoryUnchanged: boolean;
  providerArtifactsAbsent: boolean;
}

const PROVIDER_ARTIFACT_RE = /^edge-cases.*\.json$/i;

function hasProviderArtifact(root: string): boolean {
  const matches = (name: string): boolean =>
    name === 'feature-critique.md' || PROVIDER_ARTIFACT_RE.test(name);
  const hasAtSurfaceRoot = (dir: string): boolean => {
    if (!existsSync(dir)) return false;
    return readdirSync(dir, { withFileTypes: true }).some(
      (entry) => entry.isFile() && matches(entry.name),
    );
  };
  return ['.claude', '.cursor', '.codex', '.agents'].some((surface) =>
    hasAtSurfaceRoot(path.join(root, surface)),
  );
}

export async function runIntrinsic({
  critic,
  prompt,
  exec = execJudgeAsync,
  onOutage,
}: RunCriticOpts): Promise<string | null> {
  return exec({
    label: 'critique-eval:intrinsic',
    args: buildIntrinsicArgs(prompt, critic),
    timeout: INTRINSIC_TIMEOUT_MS,
    onOutage,
  });
}

export async function runWorkflow({
  critic,
  prompt,
  fixtureDir,
  exec = execJudgeAsync,
  onOutage,
}: RunCriticOpts): Promise<WorkflowRunOutput> {
  if (!fixtureDir) throw new Error('critique-eval: workflow run needs a fixtureDir');
  const before = execFileSync('git', ['status', '--porcelain=v1', '-z'], {
    cwd: fixtureDir,
    encoding: 'utf8',
  });
  const raw = await exec({
    label: 'critique-eval:workflow',
    args: buildWorkflowArgs(prompt, critic),
    timeout: WORKFLOW_TIMEOUT_MS,
    cwd: fixtureDir,
    onOutage,
  });
  const after = execFileSync('git', ['status', '--porcelain=v1', '-z'], {
    cwd: fixtureDir,
    encoding: 'utf8',
  });
  const contract = raw ? parsePlanCritiqueResponse(raw) : null;
  const report = contract?.value
    ? [
        '## Critical Issues (Blockers)',
        ...contract.value.findings
          .filter((finding) => finding.severity === 'critical')
          .map((finding, index) => `${index + 1}. **${finding.claim}**\n   ${finding.impact}`),
        '## Warnings (Non-blocking but significant)',
        ...contract.value.findings
          .filter((finding) => finding.severity !== 'critical')
          .map((finding, index) => `${index + 1}. **${finding.claim}**\n   ${finding.impact}`),
      ].join('\n')
    : null;
  return {
    raw,
    report,
    artifact: raw,
    artifactPath: 'response.edgeCases',
    contractValid: contract?.state === 'valid',
    repositoryUnchanged: before === after,
    providerArtifactsAbsent: !hasProviderArtifact(fixtureDir),
  };
}

// ─── JSON-contract parsing (deterministic) ────────────────────────────────────────

export const VERDICTS = ['PROCEED WITH CHANGES', 'PROCEED', 'RETHINK', 'REJECT'] as const;
export type Verdict = (typeof VERDICTS)[number];
export const FRAME_METAS = ['SOUND', 'NOTABUG', 'BANDAID', 'UXHARM', 'SKIP'] as const;
export type FrameMeta = (typeof FRAME_METAS)[number];

export interface ParsedSummary {
  verdict: Verdict | null;
  frameMeta: FrameMeta | null;
  feasibility: string | null;
  criticalCount: number | null;
  warningCount: number | null;
  uxImpact: string | null;
  /** Informational whole-response size using the existing chars/4 heuristic. */
  approxTokens: number;
}

/** Parse strict JSON into the benchmark's historical closed-set columns. */
export function parseSummary(raw: string): ParsedSummary {
  const contract = parsePlanCritiqueResponse(raw);
  const value = contract.value;
  const verdict =
    value?.verdict === 'PROCEED_WITH_CHANGES'
      ? 'PROCEED WITH CHANGES'
      : ((value?.verdict as Verdict | null) ?? null);
  return {
    verdict,
    frameMeta: value?.frameMeta ?? null,
    feasibility: value?.feasibility ?? null,
    criticalCount: value
      ? value.findings.filter((finding) => finding.severity === 'critical').length
      : null,
    warningCount: value
      ? value.findings.filter((finding) => finding.severity === 'warning').length
      : null,
    uxImpact:
      value?.findings.find((finding) => finding.lens === 'ux')?.impact ?? (value ? 'none' : null),
    approxTokens: Math.ceil(raw.length / 4),
  };
}
