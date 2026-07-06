// critique-eval RUNNER — spawns the feature-critique agent exactly as a bench row needs it.
//
// There is no importable gate runner for this agent (it ships as agents/feature-critique.md and is
// dispatched via the Task tool), so the no-drift guarantee the decisions bench gets from importing
// runDetectJudge et al. comes from two substitutes instead:
//   · the agent body is read FROM SOURCE (agents/feature-critique.md — never a .claude/.cursor
//     synced copy, which is derived and may lag `devkit sync-agents`), at spawn time;
//   · the baseline embeds agentHash (the md) and runnerHash (this file + matcher.mts) — see
//     bench.mts; a changed prompt or a changed harness is a changed experiment, never a silent one.
//
// Fidelity: production dispatch makes the md the SUBAGENT'S SYSTEM PROMPT. `--append-system-prompt`
// is the closest `claude -p` analog, and it keeps the user prompt = the critique request alone —
// which is what lets the EDGE_CASES_ID contract row genuinely test the md's "top of the prompt"
// clause. Residual gaps (no Task-tool env, no deep-research MCP under -p) are documented README
// departures, not hidden.
//
// Two spawn modes, one per row mode:
//   intrinsic  — no tools (JUDGE_READ_ONLY), the BENCHMARK directive inlines everything; scores the
//                agent's frame reasoning alone. Cheap (~30–60 s a row).
//   workflow   — the full contract in a disposable fixture repo: tools allowed, the agent writes
//                .cursor/.feature-critique.md + the edge-cases artifact, stdout is the compact
//                summary. Expensive (2–6 min a row).
//
// Argv order is load-bearing: `--allowedTools`/`--disallowedTools` are VARIADIC — anything after
// them (including a positional prompt) is swallowed as a tool name (see check-alignment.mts:205).
// The positional prompt therefore sits BEFORE the tool flags, and tool flags go LAST.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JUDGE_ISOLATION, JUDGE_READ_ONLY } from '../../judge/judge-isolation.mts';
import { execJudgeAsync } from '../../judge/run-judge.mts';
import { stripFrontmatter } from '../../review/reviewers.mts';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Source-of-truth agent md — three levels up from gate-engine/critique/eval/. */
export const AGENT_MD_PATH = path.join(here, '../../../agents/feature-critique.md');

export const INTRINSIC_TIMEOUT_MS = 300_000; // run.mjs precedent; 120s false-aborts under contention
export const WORKFLOW_TIMEOUT_MS = 600_000; // agentic opus with tool use runs 2–6 min

/** What the workflow agent may touch inside its fixture. Single comma-joined string (the flag is
 * variadic — one argv slot keeps the prompt safe), prefix-colon Bash rule per check-alignment. */
export const WORKFLOW_TOOLS = 'Read,Grep,Glob,LS,Write,Edit,Bash(git:*)';

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
  'your full judgement (especially the Frame check), then output ONLY the compact summary block of',
  'Phase 5 — CRITIQUE (write "none — benchmark mode"), VERDICT, FEASIBILITY, CRITICAL_ISSUES,',
  'WARNINGS, UX_IMPACT, FRAME_META, SUMMARY, ACTIONS. No file writes, no edge-case artifact.',
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
  /** For the EDGE_CASES_ID contract row — prefixed at the very top of the user prompt. */
  edgeCasesId?: string;
  exec?: typeof execJudgeAsync;
  onOutage?: (kind: 'timeout' | 'transient' | 'empty') => void;
}

export interface WorkflowRunOutput {
  /** stdout — the compact summary block (or null on outage). */
  raw: string | null;
  /** .cursor/.feature-critique.md content from the fixture, or null when not written. */
  report: string | null;
  /** The edge-cases artifact content, or null when not written. */
  artifact: string | null;
  /** Where the artifact was expected — depends on edgeCasesId per the md's contract. */
  artifactPath: string;
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
  edgeCasesId,
  exec = execJudgeAsync,
  onOutage,
}: RunCriticOpts): Promise<WorkflowRunOutput> {
  if (!fixtureDir) throw new Error('critique-eval: workflow run needs a fixtureDir');
  const userPrompt = edgeCasesId ? `EDGE_CASES_ID=${edgeCasesId}\n---\n${prompt}` : prompt;
  const raw = await exec({
    label: 'critique-eval:workflow',
    args: buildWorkflowArgs(userPrompt, critic),
    timeout: WORKFLOW_TIMEOUT_MS,
    cwd: fixtureDir,
    onOutage,
  });
  const artifactPath = path.join(
    fixtureDir,
    '.cursor',
    edgeCasesId ? `.edge-cases-${edgeCasesId}.json` : '.edge-cases.json',
  );
  const readOrNull = (p: string): string | null => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return null; // absence is a scored contract miss, not a crash
    }
  };
  return {
    raw,
    report: readOrNull(path.join(fixtureDir, '.cursor', '.feature-critique.md')),
    artifact: readOrNull(artifactPath),
    artifactPath,
  };
}

// ─── Compact-summary parsing (deterministic) ──────────────────────────────────────

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
  /** ~tokens of the whole message (chars/4 heuristic) for the ≤300-token contract check. */
  approxTokens: number;
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

/** Parse the compact summary. Missing/ambiguous fields parse null — NULL is a verdict column in
 * the bench, never an exception. 'PROCEED WITH CHANGES' is matched before its 'PROCEED' prefix. */
export function parseSummary(raw: string): ParsedSummary {
  const v = line(raw, 'VERDICT')?.toUpperCase() ?? '';
  const verdict = VERDICTS.find((k) => v.includes(k)) ?? null;
  const metaRaw = line(raw, 'FRAME_META')?.toUpperCase() ?? '';
  const metaHits = FRAME_METAS.filter((k) => metaRaw.includes(k));
  return {
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
