import { describe, expect, it } from 'vitest';
import {
  buildArgs,
  buildDirective,
  childEnv,
  initFault,
  runSession,
} from '../eval/workflow/run.mts';
import { parseTrace } from '../eval/workflow/trace.mts';
import { fakeSpawn, member, stream } from './workflow-fixtures.mts';

const AGENT = { body: 'agent body', model: 'opus', raw: 'raw' };
const WS = { consumer: '/ws/consumer', refs: '/ws/refs' };
const VARIADIC = new Set(['--add-dir', '--tools', '--mcp-config', '--allowedTools']);

describe('workflow runner argv', () => {
  it('never puts the prompt in argv, and every variadic flag is followed by a value then nothing', () => {
    for (const condition of ['search', 'supplied'] as const) {
      const args = buildArgs(AGENT, condition, WS);
      expect(args.join(' ')).not.toContain('VALIDATION REQUEST');
      args.forEach((arg, index) => {
        if (!VARIADIC.has(arg)) return;
        const next = args[index + 2];
        expect(next === undefined || next.startsWith('--')).toBe(true);
      });
    }
    expect(buildArgs(AGENT, 'search', WS).slice(-2)).toEqual(['--tools', 'Glob,Grep,Read']);
    expect(buildArgs(AGENT, 'supplied', WS).slice(-2)).toEqual(['--tools', '']);
    expect(buildArgs(AGENT, 'search', WS)).toEqual(
      expect.arrayContaining(['--restricted', '--strict-mcp-config']),
    );
  });

  it('strips git control, gate policy and Claude Code session vars and silences telemetry', () => {
    const env = childEnv({
      GIT_DIR: '/x',
      GUARD_REVIEW_SKIP: '1',
      CLAUDE_CODE_EFFORT_LEVEL: 'max',
      PATH: '/bin',
    });
    expect(env).toMatchObject({ PATH: '/bin', DEVKIT_NO_TELEMETRY: '1' });
    for (const key of ['GIT_DIR', 'GUARD_REVIEW_SKIP', 'CLAUDE_CODE_EFFORT_LEVEL'])
      expect(env).not.toHaveProperty(key);
  });

  it('keeps the Claude Code auth and provider vars, or every session on such a host is an outage', () => {
    const auth = {
      CLAUDE_CODE_OAUTH_TOKEN: 'token',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
      ANTHROPIC_API_KEY: 'key',
    };
    expect(childEnv({ ...auth, CLAUDE_CODE_ENTRYPOINT: 'cli' })).toMatchObject(auth);
    expect(childEnv({ CLAUDE_CODE_ENTRYPOINT: 'cli' })).not.toHaveProperty(
      'CLAUDE_CODE_ENTRYPOINT',
    );
  });

  it('flags a session that got a tool or an MCP server outside the frozen profile', () => {
    const init = (tools: string[], mcp: unknown[] = []) => parseTrace(stream({ tools, mcp })).init;
    expect(initFault(init(['Glob', 'Grep', 'Read']), 'search')).toBeNull();
    expect(initFault(init([]), 'supplied')).toBeNull();
    expect(initFault(init(['Bash', 'Glob', 'Grep', 'Read']), 'search')).toMatch(/≠ profile/);
    expect(initFault(init(['Glob', 'Grep', 'Read'], [{ name: 'codebase' }]), 'search')).toMatch(
      /MCP/,
    );
    expect(initFault(null, 'search')).toMatch(/no system\/init/);
  });

  it('frames the search condition as live-local and the supplied one as pinned excerpts', () => {
    const m = member({
      gold: [{ id: 'g', desc: 'd', spans: [{ root: 'peer', path: 'src/a.ts', lines: [2, 3] }] }],
    });
    const read = () => 'one\ntwo\nthree\nfour';
    const search = buildDirective(m, 'search', read);
    expect(search).toMatch(/local leg is LIVE/);
    expect(search).not.toMatch(/REFERENCE EXCERPTS ===/);
    const supplied = buildDirective(m, 'supplied', read);
    expect(supplied).toContain('[E1 · refs/peer/src/a.ts:2-3]\ntwo\nthree');
    expect(supplied).toContain('- local: status=reached, declaredCheckouts=1, resolvedCheckouts=1');
  });
});

describe('workflow runner session', () => {
  it('returns the stream and writes the request on stdin', async () => {
    const fake = fakeSpawn({ stdout: stream({ result: '{}' }) });
    const outcome = await runSession({
      args: ['-p'],
      stdin: 'REQUEST',
      cwd: '/',
      spawnFn: fake.spawnFn,
    });
    expect('stream' in outcome).toBe(true);
    expect(fake.calls[0].stdin).toBe('REQUEST');
  });

  it('turns a child that exits before reading stdin into an outage instead of an unhandled EPIPE', async () => {
    const early = fakeSpawn({ stdinError: true });
    const outcome = await runSession({
      args: [],
      stdin: 'x'.repeat(200_000),
      cwd: '/',
      spawnFn: early.spawnFn,
    });
    expect('outage' in outcome).toBe(true);
  });

  it('keeps a UTF-8 character intact when the pipe splits it across two chunks', async () => {
    const bytes = Buffer.from(stream({ result: '{"note":"café"}' }));
    const at = bytes.indexOf(Buffer.from('é')) + 1;
    const split = fakeSpawn({ stdoutChunks: [bytes.subarray(0, at), bytes.subarray(at)] });
    const outcome = await runSession({ args: [], stdin: '', cwd: '/', spawnFn: split.spawnFn });
    expect('stream' in outcome && outcome.stream).toContain('café');
  });

  it('classifies a quota refusal, an errored result and a timeout as outages, never responses', async () => {
    const quota = fakeSpawn({ status: 1, stderr: "You've hit your usage limit · resets 5pm" });
    const refused = await runSession({ args: [], stdin: '', cwd: '/', spawnFn: quota.spawnFn });
    expect(refused).toMatchObject({ outage: { kind: 'rate-limited' } });

    const budget = fakeSpawn({ stdout: stream({ result: 'budget', isError: true }) });
    const capped = await runSession({ args: [], stdin: '', cwd: '/', spawnFn: budget.spawnFn });
    expect('outage' in capped).toBe(true);

    const hung = fakeSpawn({ hang: true });
    const timedOut = await runSession({
      args: [],
      stdin: '',
      cwd: '/',
      spawnFn: hung.spawnFn,
      timeoutMs: 10,
    });
    expect(timedOut).toMatchObject({ outage: { kind: 'timeout' } });
  });
});
