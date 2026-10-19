// Shared fixtures for the prior-art workflow-tier tests: a member factory and a synthetic
// `claude -p --output-format stream-json --verbose` stream builder. No test here spawns claude.

import { ChildProcess, execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { Member, Snapshot } from '../eval/workflow/families.mts';
import type { RunSessionOptions } from '../eval/workflow/run.mts';
import type { ToolInput } from '../eval/workflow/trace.mts';

const snap = (name: string) => ({
  name,
  url: `https://example.test/${name}`,
  sha: 'a'.repeat(40),
  tree: 'b'.repeat(40),
});

export function member(overrides: Partial<Member> = {}): Member {
  return {
    id: 'm1',
    caseId: 'fam',
    kind: 'natural',
    provenance: 'test',
    consumer: snap('consumer-repo'),
    refs: [snap('peer')],
    external: [],
    prompt: '## Problem Statement\nx',
    expectVerdict: ['GENUINE_NEW_WORK'],
    expectFraming: ['HOLDS'],
    gold: [],
    decoys: [],
    ...overrides,
  };
}

export const snapshot = snap;

export interface FakeCall {
  name: string;
  input: ToolInput;
  result?: string;
}

/** A stream-json session: init, one assistant tool_use + user tool_result per call, then result. */
export function stream(options: {
  tools?: string[];
  mcp?: unknown[];
  calls?: FakeCall[];
  result?: string | null;
  isError?: boolean;
}): string {
  const {
    tools = ['Glob', 'Grep', 'Read'],
    mcp = [],
    calls = [],
    result = null,
    isError = false,
  } = options;
  const lines: unknown[] = [
    { type: 'system', subtype: 'init', tools, mcp_servers: mcp, model: 'claude-opus-5-5' },
  ];
  calls.forEach((call, index) => {
    const id = `toolu_${index}`;
    lines.push({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id, name: call.name, input: call.input }] },
    });
    lines.push({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: id, content: call.result ?? '' }] },
    });
  });
  lines.push({
    type: 'result',
    subtype: isError ? 'error_max_budget_usd' : 'success',
    is_error: isError,
    result: result ?? '',
    total_cost_usd: 0.5,
    permission_denials: [],
  });
  return lines.map((line) => JSON.stringify(line)).join('\n');
}

type Verdict = 'SOLVED_ELSEWHERE' | 'DISSOLVE_FRAME' | 'GENUINE_NEW_WORK' | 'INSUFFICIENT_EVIDENCE';
const NEXT = {
  SOLVED_ELSEWHERE: 'adopt_existing',
  DISSOLVE_FRAME: 'reframe',
  GENUINE_NEW_WORK: 'proceed_to_plan',
  INSUFFICIENT_EVIDENCE: 'gather_evidence',
};

/** A contract-valid prior-art response with the given verdict, local-leg counts and evidence. */
export function response(options: {
  verdict: Verdict;
  resolved: number;
  localStatus?: 'reached' | 'unavailable';
  evidence?: { kind?: string; source: string; repoRoot?: string | null; quote: string }[];
}): string {
  const { verdict, resolved, evidence = [] } = options;
  const localStatus = options.localStatus ?? (resolved ? 'reached' : 'unavailable');
  return JSON.stringify({
    schemaVersion: 1,
    kind: 'prior_art',
    phase: 'problem',
    status: 'reviewed',
    problem: { statement: 's', restatedFrame: 'f', assumedConstraints: [] },
    verdict,
    confidence: 'medium',
    legs: [
      {
        leg: 'local',
        status: localStatus,
        detail: 'd',
        declaredCheckouts: 1,
        resolvedCheckouts: resolved,
      },
      { leg: 'github', status: 'reached', detail: 'd' },
      { leg: 'web', status: 'reached', detail: 'd' },
      { leg: 'papers', status: 'reached', detail: 'd' },
      { leg: 'deep-research', status: 'unavailable', detail: 'd' },
    ],
    frameChallenge: {
      framing: verdict === 'DISSOLVE_FRAME' ? 'DISSOLVES' : 'NARROWS',
      upstreamChoice: 'u',
      boundaryMustExist: 'unknown',
    },
    questions: ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7'].map((id) => ({
      id,
      status: 'ANSWERED',
      finding: 'f',
    })),
    evidence: (evidence.length ? evidence : [{ source: 'README.md', quote: '' }]).map((item) => ({
      kind: item.kind ?? 'local',
      source: item.source,
      repoRoot: item.repoRoot ?? null,
      claim: 'c',
      quote: item.quote,
    })),
    suggestedNextStep: { kind: NEXT[verdict], detail: 'd' },
    routing: null,
    summary: 's',
    researchReferences: [],
  });
}

/** A fake child that replays fixed stdout/stderr and an exit code once stdin closes. */
export function fakeSpawn(out: {
  stdout?: string;
  /** Raw stdout chunks written in order, e.g. one UTF-8 character split across two. */
  stdoutChunks?: Buffer[];
  /** Per-spawn stdout, from the spawn argv. */
  stdoutFor?: (args: string[]) => string;
  stderr?: string;
  status?: number;
  hang?: boolean;
  /** The child exits before reading stdin, so the stdin pipe errors (EPIPE). */
  stdinError?: boolean;
}) {
  const calls: { args: string[]; stdin: string }[] = [];
  const spawnFn: NonNullable<RunSessionOptions['spawnFn']> = (_cmd, args) => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const child = Object.assign(new ChildProcess(), { stdout, stderr, stdin });
    child.kill = () => child.emit('close', null);
    let written = '';
    stdin.on('data', (chunk) => {
      written += chunk;
    });
    if (out.stdinError)
      setImmediate(() => {
        stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
        stdout.end('');
        stderr.end('error: unknown option');
        child.emit('close', 1);
      });
    stdin.on('finish', () => {
      calls.push({ args, stdin: written });
      if (out.hang) return;
      for (const chunk of out.stdoutChunks ?? []) stdout.write(chunk);
      stdout.end(out.stdoutFor?.(args) ?? out.stdout ?? '');
      stderr.end(out.stderr ?? '');
      setImmediate(() => child.emit('close', out.status ?? 0));
    });
    return child;
  };
  return { spawnFn, calls };
}

export interface PinnedRepo {
  repo: string;
  /** The repo's one commit as a pinned snapshot; its url is unreachable, so only the repo serves it. */
  pin: Snapshot;
}

/** A temp git repo holding `files` (and `links`: name → relative target) in one commit. The caller
 *  removes `repo`. */
export function pinnedRepo(
  files: Record<string, string>,
  links: Record<string, string> = {},
): PinnedRepo {
  const repo = realpathSync(mkdtempSync(path.join(tmpdir(), 'wf-repo-')));
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init', '-q', '-b', 'main');
  for (const [file, text] of Object.entries(files)) writeFileSync(path.join(repo, file), text);
  for (const [link, target] of Object.entries(links)) symlinkSync(target, path.join(repo, link));
  git('add', '-A');
  git(
    '-c',
    'user.email=t@t',
    '-c',
    'user.name=t',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    'seed',
  );
  const pin = {
    name: 'src',
    url: 'file:///nonexistent',
    sha: git('rev-parse', 'HEAD'),
    tree: git('rev-parse', 'HEAD^{tree}'),
  };
  return { repo, pin };
}
