/**
 * The spawn both judge twins share: what reaches the child (stdin, cwd, a git-scrubbed env), how
 * much output it may return, and that both temp dirs are removed on every settle path.
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { namedAgentMcpProfile, withNamedAgentMcpTools } from '../mcp/profile.mts';
import type { JudgeOutage } from '../outage/classify.mts';
import { execJudge, execJudgeAsync } from '../run-judge.mts';

const ENV_KEYS = [
  'GUARD_CODEX_BIN',
  'DEVKIT_NO_TELEMETRY',
  'DEVKIT_GATE_EVENTS',
  'DEVKIT_JUDGE_MCP_CONFIG',
  'TMPDIR',
];
const saved: Record<string, string | undefined> = {};
let dir: string;
let repo: string;
let tmp: string;

const TWINS = {
  execJudge: async (opts: Parameters<typeof execJudge>[0]) => execJudge(opts),
  execJudgeAsync,
};

const SPAWNED = [
  { name: 'a verdict', script: 'echo VERDICT', timeout: 30000, result: 'VERDICT' },
  { name: 'a non-zero exit', script: 'exit 3', timeout: 30000, result: null },
  { name: 'a timeout kill', script: "trap '' TERM\nexec sleep 5", timeout: 500, result: null },
  { name: 'a synchronous spawn throw', script: 'echo VERDICT', timeout: -1, result: null },
];

/** A workspace-write codex judge that also carries a named-agent MCP profile. */
function judgeOpts(model: string, timeout: number) {
  const tools = withNamedAgentMcpTools('Read,Grep');
  return {
    label: 'review:x',
    args: ['-p', 'P', '--model', model, '--allowedTools', tools],
    input: 'diff',
    timeout,
    cwd: repo,
    transcript: false,
    mcpProfile: namedAgentMcpProfile(),
  };
}

function fakeCodex(script: string, drainStdin = 'cat >/dev/null'): void {
  const bin = path.join(dir, 'codex');
  writeFileSync(bin, `#!/bin/sh\n${drainStdin}\n${script}\n`);
  chmodSync(bin, 0o755);
  process.env.GUARD_CODEX_BIN = bin;
}

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'judge-exec-cleanup-')));
  repo = path.join(dir, 'repo');
  tmp = path.join(dir, 'tmp');
  mkdirSync(repo);
  mkdirSync(tmp);
  const registry = path.join(dir, 'registry.json');
  const stdio = (command: string) => ({ type: 'stdio', command });
  const servers = { codebase: stdio('cb'), context7: stdio('c7'), autonomous_bugs: stdio('bugs') };
  writeFileSync(registry, JSON.stringify({ mcpServers: servers }), { mode: 0o600 });
  process.env.DEVKIT_JUDGE_MCP_CONFIG = registry;
  process.env.DEVKIT_NO_TELEMETRY = '1';
  delete process.env.DEVKIT_GATE_EVENTS;
  // os.tmpdir() reads TMPDIR per call, so both temp dirs land where the test can list them.
  process.env.TMPDIR = tmp;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe.each(Object.entries(TWINS))('%s cleanup', (_name, run) => {
  it.each(SPAWNED)('removes both temp dirs after $name', async ({ script, timeout, result }) => {
    fakeCodex(script);
    let during: string[] = [];
    const out = await run({
      ...judgeOpts('gpt-5.6-sol', timeout),
      onMcpPrepared: () => {
        during = readdirSync(tmp);
      },
    });
    expect(out?.trim() ?? null).toBe(result);
    expect(during.some((n) => n.startsWith('devkit-judge-mcp-'))).toBe(true);
    expect(during.some((n) => /^devkit-judge-(?!mcp-)/.test(n))).toBe(true);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it('removes both temp dirs when routing throws after the sandbox exists', async () => {
    fakeCodex('echo VERDICT');
    const outages: JudgeOutage[] = [];
    const opts = {
      ...judgeOpts('gpt-5.6-terra@ultra', 30000),
      onOutage: (o: JudgeOutage) => outages.push(o),
    };
    expect(await run(opts)).toBeNull();
    expect(outages).toHaveLength(1);
    expect(readdirSync(tmp)).toEqual([]);
  });
});

describe.each(Object.entries(TWINS))('%s spawn wiring', (_name, run) => {
  it('feeds the input to the child on stdin', async () => {
    fakeCodex('', 'cat');
    expect(await run({ ...judgeOpts('gpt-5.6-sol', 30000), input: 'DIFF-BODY' })).toBe('DIFF-BODY');
  });

  it("runs in the caller's cwd with git repository selectors scrubbed from its env", async () => {
    fakeCodex('pwd -P; echo "${GIT_INDEX_FILE-unset} ${GIT_DIR-unset}"');
    const env = { ...process.env, GIT_INDEX_FILE: '/poison/index', GIT_DIR: '/poison/.git' };
    const out = await run({ ...judgeOpts('gpt-5.6-sol', 30000), env });
    expect(out?.trim().split('\n')).toEqual([repo, 'unset unset']);
  });

  it('returns a verdict larger than the 1 MB default buffer', async () => {
    fakeCodex("head -c 2000000 /dev/zero | tr '\\0' x");
    expect((await run(judgeOpts('gpt-5.6-sol', 30000)))?.length).toBe(2000000);
  });
});
