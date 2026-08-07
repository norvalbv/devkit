// prior-art-eval RUNNER — spawns the prior-art agent exactly as a bench row needs it.
//
// There is no importable gate runner for this agent (it ships as agents/prior-art.md and is
// dispatched via the Task tool), so the no-drift guarantee comes from the run-critic.mts
// substitutes: the agent body is read FROM SOURCE at spawn time (never a synced copy), and the
// baseline embeds agentHash + runnerHash + corpusHash — a changed prompt or harness is a changed
// experiment, never a silent one.
//
// Intrinsic mode only (Phase 2): no tools (JUDGE_READ_ONLY); the BENCHMARK directive inlines the
// entire reachable research corpus and PINS each leg's attestation, so absence-from-a-reached-leg
// is citable for Q4 offline — the one precondition production never guarantees, which is exactly
// why the intrinsic tier measures recognition + frame courage, not retrieval (the workflow tier,
// Phase 3, measures retrieval against fixture checkouts).
//
// Argv order is load-bearing: `--disallowedTools` is VARIADIC — anything after it is swallowed as
// a tool name, so the positional prompt sits BEFORE the tool flags and tool flags go LAST.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLAUDE_RESULT_ARGS, unwrapClaudeResult } from '../../judge/claude-result.mts';
import { JUDGE_ISOLATION, JUDGE_READ_ONLY } from '../../judge/judge-isolation.mts';
import { execJudgeAsync } from '../../judge/run-judge.mts';
import { stripFrontmatter } from '../../review/reviewers.mts';
import { PRIOR_ART_LEG_NAMES, type PriorArtLegName } from '../response-contract.mts';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Source-of-truth agent md — three levels up from gate-engine/prior-art/eval/. */
export const AGENT_MD_PATH = path.join(here, '../../../agents/prior-art.md');

export const INTRINSIC_TIMEOUT_MS = 300_000;

export { CLAUDE_RESULT_ARGS };

/** A row's pinned research-leg fixture: what the offline run is allowed to attest. */
export interface LegsFixture {
  local: { status: 'reached' | 'unavailable' | 'failed'; declared: number; resolved: number };
  github: 'reached' | 'unavailable' | 'failed';
  web: 'reached' | 'unavailable' | 'failed';
  'deep-research': 'reached' | 'unavailable' | 'failed';
}

/** Every leg reached over a declared, resolved reference corpus — the default haystack fixture. */
export const ALL_LEGS_REACHED: LegsFixture = {
  local: { status: 'reached', declared: 1, resolved: 2 },
  github: 'reached',
  web: 'reached',
  'deep-research': 'unavailable',
};

function legLine(name: PriorArtLegName, fixture: LegsFixture): string {
  if (name === 'local') {
    const local = fixture.local;
    return `- local: status=${local.status}, declaredCheckouts=${local.declared}, resolvedCheckouts=${local.resolved}`;
  }
  return `- ${name}: status=${fixture[name]}`;
}

/**
 * The intrinsic-mode directive. Part of runnerHash: editing it is a new experiment by
 * construction. The leg attestations are PINNED — the fixture, not the model, decides what was
 * reachable — so the legs-degradation rows measure the coupling rules, not spawn-time luck.
 */
export function buildBenchmarkDirective(fixture: LegsFixture): string {
  return [
    '=== BENCHMARK MODE ===',
    'Everything you can reach is in the VALIDATION REQUEST below. Do NOT run any tools, scripts,',
    'research, MCP calls, or file reads, and do NOT write any files. Your research legs are PINNED',
    'to exactly these attestations (report them verbatim in `legs[]`):',
    ...PRIOR_ART_LEG_NAMES.map((name) => legLine(name, fixture)),
    'The inlined REFERENCE EXCERPTS are the COMPLETE contents of every reached leg — a finding',
    'absent from them is absent from that leg, which you may cite for Q4. A leg pinned unavailable',
    'or failed gave you nothing; never cite it. Apply your full judgement (especially the frame',
    'interrogation), then return ONLY the closed JSON response defined in Phase 4. No prose outside',
    'the JSON object and no runtime artifacts.',
    '',
    '=== VALIDATION REQUEST ===',
    '',
  ].join('\n');
}

export interface AgentSource {
  /** Frontmatter-stripped agent body — what production makes the subagent's system prompt. */
  body: string;
  /** The md's frontmatter `model:` (the production model), overridable via BENCH_MODEL. */
  model: string;
  /** Raw file content — hashed into the baseline as agentHash. */
  raw: string;
}

const FRONTMATTER_MODEL_RE = /^model:\s*(\S+)\s*$/m;

/** Read the agent from SOURCE. Throws if unreadable — a bench without its subject cannot run. */
export function loadAgent(): AgentSource {
  const raw = readFileSync(AGENT_MD_PATH, 'utf8');
  const model = process.env.BENCH_MODEL ?? raw.match(FRONTMATTER_MODEL_RE)?.[1] ?? 'opus';
  return { body: stripFrontmatter(raw), model, raw };
}

export function buildIntrinsicArgs(
  prompt: string,
  agent: AgentSource,
  fixture: LegsFixture,
): string[] {
  return [
    '-p',
    '--model',
    agent.model,
    '--append-system-prompt',
    agent.body,
    ...JUDGE_ISOLATION,
    ...CLAUDE_RESULT_ARGS,
    buildBenchmarkDirective(fixture) + prompt,
    ...JUDGE_READ_ONLY, // variadic — terminal, after the positional prompt
  ];
}

// Re-exported, not redefined: the spawn layer now requests and unwraps the same envelope for every
// production judge (sc-1527), and three identical copies of the parser is exactly what the dup gate
// exists to stop. Importers here keep their current import path.
export { unwrapClaudeResult };

export interface RunAgentOpts {
  agent: AgentSource;
  /** The validation request text, verbatim from the corpus row. */
  prompt: string;
  fixture: LegsFixture;
  exec?: typeof execJudgeAsync;
  onOutage?: (kind: 'timeout' | 'transient' | 'empty') => void;
}

export async function runIntrinsic({
  agent,
  prompt,
  fixture,
  exec = execJudgeAsync,
  onOutage,
}: RunAgentOpts): Promise<string | null> {
  const raw = await exec({
    label: 'prior-art-eval:intrinsic',
    args: buildIntrinsicArgs(prompt, agent, fixture),
    timeout: INTRINSIC_TIMEOUT_MS,
    onOutage,
  });
  return unwrapClaudeResult(raw);
}
