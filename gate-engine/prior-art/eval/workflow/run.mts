// prior-art workflow tier: one agent session, spawned directly so the stream-json trace survives. The
// prompt goes on stdin because --add-dir, --tools and --mcp-config would swallow a positional one.

import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process';
import { cleanBenchEnv } from '../../../decisions/eval/bench.mts';
import { withoutGitEnv } from '../../../judge/judge-isolation.mts';
import { classifyJudgeOutage, type JudgeOutage } from '../../../judge/outage/classify.mts';
import type { AgentSource } from '../../../review/reviewers.mts';
import { layoutLegs, type Member, type Slot } from './families.mts';
import { snapshotFile } from './materialize.mts';
import { parseTrace, type TraceInit } from './trace.mts';

export type Condition = 'search' | 'supplied';
export const CONDITIONS: readonly Condition[] = ['search', 'supplied'];
export const TOOL_PROFILE = {
  search: ['Glob', 'Grep', 'Read'],
  supplied: [],
} satisfies Record<Condition, string[]>;
export const EFFORT = 'medium';
export const SESSION_TIMEOUT_MS = 900_000;
export const SESSION_BUDGET_USD = 5;

export interface WorkspacePaths {
  consumer: string;
  refs: string;
}

/** The spawn argv. Paths come from the workspace, so identity hashes it with placeholder paths. */
export function buildArgs(agent: AgentSource, condition: Condition, ws: WorkspacePaths): string[] {
  return [
    '-p',
    '--model',
    agent.model,
    '--effort',
    EFFORT,
    '--append-system-prompt',
    agent.body,
    '--restricted',
    '--settings',
    '{"disableAllHooks":true}',
    '--no-session-persistence',
    '--output-format',
    'stream-json',
    '--verbose',
    '--max-budget-usd',
    String(SESSION_BUDGET_USD),
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--add-dir',
    ws.refs,
    '--tools',
    TOOL_PROFILE[condition].join(','),
  ];
}

function legLines(member: Member): string[] {
  return layoutLegs(member).map((leg) =>
    leg.leg === 'local'
      ? `- local: status=${leg.status}, declaredCheckouts=1, resolvedCheckouts=${leg.resolvedCheckouts}`
      : `- ${leg.leg}: status=${leg.status}`,
  );
}

function spanLabel(root: string, file: string, lines: [number, number]): string {
  return `${root === 'consumer' ? file : `refs/${root}/${file}`}:${lines[0]}-${lines[1]}`;
}

/** Every labelled span, sorted by location so gold never sorts first, read from the snapshot. */
export function suppliedExcerpts(member: Member, read = snapshotFile): string[] {
  const spans = [...member.gold, ...member.decoys]
    .flatMap((slot: Slot) => slot.spans)
    .sort((a, b) =>
      spanLabel(a.root, a.path, a.lines).localeCompare(spanLabel(b.root, b.path, b.lines)),
    );
  return spans.map((span, index) => {
    const text = read(member, span.root, span.path)?.split('\n') ?? [];
    const body = text.slice(span.lines[0] - 1, span.lines[1]).join('\n');
    return `[E${index + 1} · ${spanLabel(span.root, span.path, span.lines)}]\n${body}`;
  });
}

/** The directive + validation request written to stdin. Part of the execution identity. */
export function buildDirective(member: Member, condition: Condition, read = snapshotFile): string {
  const external = member.external.map(
    (excerpt, index) => `[X${index + 1} · ${excerpt.leg} · ${excerpt.source}] ${excerpt.text}`,
  );
  const frozen = [
    '=== FROZEN EXTERNAL RESULTS (complete contents of the github, web and papers legs) ===',
    ...(external.length ? external : ['(searched; nothing relevant)']),
  ];
  const head =
    condition === 'search'
      ? [
          '=== BENCHMARK MODE (workflow tier, search-required) ===',
          'Your cwd is the consumer repository. The local leg is LIVE: resolve the reference checkouts',
          'guard.config.json declares yourself (you have no Bash, so resolve the glob patterns by hand',
          'with Glob/Read as Phase 0 describes) and search them, and the consumer repo, with',
          'Read/Grep/Glob. The external legs are FROZEN: github, web and papers are reached and their',
          'COMPLETE results are below; deep-research is unavailable. Attempt no network tools.',
        ]
      : [
          '=== BENCHMARK MODE (workflow tier, supplied-evidence) ===',
          'Do NOT run any tools. Your research legs are PINNED to these attestations (report them',
          'verbatim in `legs[]`):',
          ...legLines(member),
          'The REFERENCE EXCERPTS (paths under refs/<name>/ are reference checkouts, other paths are',
          'the consumer repo) and the FROZEN EXTERNAL RESULTS are the COMPLETE contents of every',
          'reached leg — a finding absent from them is absent from that leg.',
          '=== REFERENCE EXCERPTS ===',
          ...suppliedExcerpts(member, read),
        ];
  return [
    ...head,
    ...frozen,
    'Return ONLY the closed JSON response defined in Phase 4 — no prose, no files.',
    '',
    '=== VALIDATION REQUEST ===',
    '',
    member.prompt,
  ].join('\n');
}

/** The child env: no gate policy, git control or Claude Code session vars, and no telemetry. */
/** Claude Code vars that select the account or provider; without them the host cannot authenticate. */
const CLAUDE_AUTH_VARS = /^CLAUDE_CODE_(?:OAUTH_TOKEN|USE_BEDROCK|USE_VERTEX|SKIP_\w+_AUTH)$/;

export function childEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = withoutGitEnv({ ...base });
  cleanBenchEnv(env);
  for (const key of Object.keys(env))
    if (key.startsWith('CLAUDE_CODE_') && !CLAUDE_AUTH_VARS.test(key)) delete env[key];
  return env;
}

/** A harness fault (not an agent result) when the session did not get exactly the frozen profile. */
export function initFault(init: TraceInit | null, condition: Condition): string | null {
  if (!init) return 'no system/init event';
  const tools = [...init.tools].sort();
  const expected: string[] = [...TOOL_PROFILE[condition]].sort();
  if (tools.join() !== expected.join()) return `tools ${tools.join(',') || '(none)'} ≠ profile`;
  if (init.mcpServers.length) return `MCP server ${init.mcpServers.join(',')} was connected`;
  return null;
}

export type SessionOutcome = { stream: string } | { outage: JudgeOutage };

export interface RunSessionOptions {
  args: string[];
  stdin: string;
  cwd: string;
  spawnFn?: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  timeoutMs?: number;
}

/** One session. A non-zero exit, a kill, or a result-less / errored stream is an outage. */
export function runSession(options: RunSessionOptions): Promise<SessionOutcome> {
  const { args, stdin, cwd, spawnFn = spawn, timeoutMs = SESSION_TIMEOUT_MS } = options;
  return new Promise((resolve) => {
    const child = spawnFn('claude', args, {
      cwd,
      env: childEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    // Decode per stream, not per chunk: a pipe can split one UTF-8 character across two chunks.
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ outage: classifyJudgeOutage({ code: error.code, stderr }) });
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      const trace = parseTrace(stdout);
      if (killed || status !== 0 || trace.result === null || trace.isError)
        resolve({
          outage: classifyJudgeOutage({
            killed,
            status,
            stderr,
            providerFailure: trace.isError ? `${trace.subtype}: ${trace.result ?? ''}` : undefined,
          }),
        });
      else resolve({ stream: stdout });
    });
    // A child that exits before reading (a rejected flag) breaks the pipe; its close reports it.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(stdin);
  });
}
