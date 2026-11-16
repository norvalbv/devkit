import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { codexGateDenials } from '../codex/commands.mts';
import { judgeCliFor } from '../codex/result.mts';
import {
  codexHookTrustHash,
  decodeToolGateToken,
  ensureLedgerDir,
  nodeGrants,
  toolGateArgs,
  toolGateLedgerDir,
} from '../codex/tool-gate.mts';
import { shellWord } from '../../review/valve/shell-word.mts';
import { execJudgeAsync } from '../run-judge.mts';

const HOOK = fileURLToPath(new URL('../codex/tool-gate-hook.mts', import.meta.url));
// Spawned, never imported: keeps the hook in vitest's import graph so its edits select this suite.
void (() => import('../codex/tool-gate-hook.mts'));
const ENV_KEYS = ['TMPDIR', 'DEVKIT_GATE_EVENTS', 'DEVKIT_SHIP_ID', 'GUARD_CODEX_BIN'];
const saved: Record<string, string | undefined> = {};
let dir: string;

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  dir = mkdtempSync(path.join(tmpdir(), 'codex-tool-gate-'));
  process.env.TMPDIR = dir;
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('codexHookTrustHash', () => {
  it('matches the hash codex trusted live and an independent implementation', () => {
    // A command string codex-cli 0.150.0, 0.159.3 and 0.162.1 trusted live with no bypass flag.
    const live = `'/Users/benji/.nvm/versions/node/v22.20.0/bin/node' '/tmp/sc4645/hook.mjs' eyJsZWRnZXIiOiIvdG1wL3NjNDY0NS9sZWRnZXIuanNvbmwifQ`;
    expect(codexHookTrustHash('pre_tool_use', '*', live)).toBe(
      'sha256:57adac4171bff63cde8a176f1a3833de471047988eaf6810a8161135e2b1aa06',
    );
    // A second, independent implementation of codex's hook hash agrees on a matcherless Stop hook.
    expect(codexHookTrustHash('stop', undefined, 'echo stop')).toBe(
      'sha256:236335e9e512004a0f5f42af65a07ea9059bd9a23dbb68286ed57fecf2b69ddf',
    );
  });
});

describe('toolGateArgs', () => {
  const tools = [
    'Read',
    'Bash(node .claude/skills/x/scripts/checklist.mjs:*)',
    'mcp__codebase__searchCode',
  ];

  it('installs the hook with a trust hash computed for its exact command', () => {
    const [c1, hook, c2, state] = toolGateArgs({ allowedTools: tools }, { repoRoot: '/work/repo' });
    expect([c1, c2]).toEqual(['-c', '-c']);
    const command = JSON.parse(hook.match(/command=("(?:[^"\\]|\\.)*")/)?.[1] ?? '""');
    expect(command.startsWith(`${shellWord(process.execPath)} ${shellWord(HOOK)} `)).toBe(true);
    expect(state).toBe(
      `hooks.state={"/<session-flags>/config.toml:pre_tool_use:0:0"={trusted_hash="${codexHookTrustHash('pre_tool_use', '*', command)}"}}`,
    );
    expect(decodeToolGateToken(command.split(' ').pop())).toEqual({
      grants: ['.claude/skills/x/scripts/checklist.mjs'],
      ledgerDir: toolGateLedgerDir(),
      repoRoot: '/work/repo',
    });
  });

  it('reads checklist grants only from Bash(node …) entries', () => {
    expect(nodeGrants(tools)).toEqual(['.claude/skills/x/scripts/checklist.mjs']);
    expect(nodeGrants(null)).toEqual([]);
  });

  it('the command codex is handed runs under a shell and gates the call', () => {
    const hook = toolGateArgs({
      allowedTools: ['Bash(node ./skills/x/scripts/checklist.mjs:*)'],
    })[1];
    const command = JSON.parse(hook.match(/command=("(?:[^"\\]|\\.)*")/)?.[1] ?? '""');
    const run = (cmd: string) =>
      spawnSync('/bin/sh', ['-c', command], { input: callJson(cmd, 'argv-1'), encoding: 'utf8' });
    expect(run('bun test').status).toBe(2);
    expect(run('node ./skills/x/scripts/checklist.mjs status').status).toBe(0);
    const ledger = path.join(toolGateLedgerDir(), 'argv-1.jsonl');
    expect(readFileSync(ledger, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('a confined judge may cd only into the repository it reviews', () => {
    const workspace = { scratch: '/tmp/scratch', repoRoot: '/work/repo' };
    const cli = judgeCliFor(
      ['-p', 'q', '--model', 'gpt-5', '--allowedTools', 'Read'],
      {},
      false,
      workspace,
    );
    const hook = cli.argv.find((a) => a.startsWith('hooks.PreToolUse=')) ?? '';
    const command = JSON.parse(hook.match(/command=("(?:[^"\\]|\\.)*")/)?.[1] ?? '""');
    expect(decodeToolGateToken(command.split(' ').pop()).repoRoot).toBe('/work/repo');
  });

  it('every codex judge gets the hook, read-only ones included; claude judges never do', () => {
    const codex = judgeCliFor(['-p', 'q', '--model', 'gpt-5', '--disallowedTools', '*']);
    expect(codex.argv.some((a) => a.startsWith('hooks.PreToolUse='))).toBe(true);
    expect(codex.argv.at(-1)).toBe('q');
    const claude = judgeCliFor(['-p', 'q', '--model', 'claude-haiku-5-5']);
    expect(claude.argv.join(' ')).not.toContain('hooks.');
  });
});

/** Run the hook as codex does: token in argv, the tool call as JSON on stdin. */
function runHook(call: string, token = toolGateArgsToken(['./skills/x/scripts/checklist.mjs'])) {
  return spawnSync(process.execPath, [HOOK, token], { input: call, encoding: 'utf8' });
}

function toolGateArgsToken(grants: string[]): string {
  return Buffer.from(JSON.stringify({ grants, ledgerDir: path.join(dir, 'ledger') })).toString(
    'base64url',
  );
}

const callJson = (command: string, session = 'sess-1') =>
  JSON.stringify({ session_id: session, tool_name: 'Bash', tool_input: { command } });

const ledgerLines = (session = 'sess-1') =>
  readFileSync(path.join(dir, 'ledger', `${session}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

describe('tool-gate-hook', () => {
  it('allows a read silently and blocks a test run with exit 2 and a reason', () => {
    const allow = runHook(
      callJson('sed -n 1,5p a && node ./skills/x/scripts/checklist.mjs status'),
    );
    expect([allow.status, allow.stdout, allow.stderr]).toEqual([0, '', '']);
    const deny = runHook(callJson('bun test'));
    expect(deny.status).toBe(2);
    expect(deny.stderr).toContain('tests belong to the pre-push suite');
    expect(ledgerLines()).toEqual([
      {
        decision: 'allow',
        line: 'Bash: sed -n 1,5p a && node ./skills/x/scripts/checklist.mjs status',
      },
      { decision: 'deny', line: 'Bash: bun test' },
    ]);
  });

  it('refuses when its own input is broken, because codex runs the call on any other exit', () => {
    expect(runHook('not json').status).toBe(2);
    expect(runHook(callJson('cat a'), 'not-a-token').status).toBe(2);
  });

  it('refuses a ledger dir planted as a symlink, so its writes cannot land elsewhere', () => {
    const elsewhere = mkdtempSync(path.join(dir, 'elsewhere-'));
    const planted = path.join(dir, 'planted');
    symlinkSync(elsewhere, planted);
    expect(ensureLedgerDir(planted)).toBe(false);
    expect(ensureLedgerDir(path.join(dir, 'fresh'))).toBe(true);
  });

  it('never writes outside the ledger dir for a hostile session id', () => {
    const out = runHook(callJson('cat a', '../escape'));
    expect(out.status).toBe(0);
    expect(existsSync(path.join(dir, 'escape.jsonl'))).toBe(false);
  });
});

const thread = (id: string) => JSON.stringify({ type: 'thread.started', thread_id: id });
const item = (id: string, status: string) =>
  JSON.stringify({
    type: 'item.completed',
    item: { id, type: 'command_execution', command: "/bin/zsh -lc 'cat a'", status },
  });

function writeLedger(session: string, decisions: string[]): string {
  const ledgerDir = toolGateLedgerDir();
  mkdirSync(ledgerDir, { recursive: true });
  const file = path.join(ledgerDir, `${session}.jsonl`);
  writeFileSync(
    file,
    decisions.map((d) => JSON.stringify({ decision: d, line: `Bash: ${d}-cmd` })).join('\n'),
  );
  return file;
}

describe('codexGateDenials', () => {
  it('returns the refused calls and consumes the ledger', () => {
    const file = writeLedger('t1', ['allow', 'deny']);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      codexGateDenials('review:x', [thread('t1'), item('i1', 'completed')].join('\n')),
    ).toEqual(['Bash: deny-cmd']);
    expect(err).not.toHaveBeenCalled();
    expect(existsSync(file)).toBe(false);
  });

  it('warns and emits gate_degraded when a command ran that the gate never saw', () => {
    const sink = path.join(dir, 'telemetry', 'gate-events.jsonl');
    process.env.DEVKIT_GATE_EVENTS = sink;
    process.env.DEVKIT_SHIP_ID = 'ship-gate';
    writeLedger('t2', ['allow']);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const raw = [thread('t2'), item('i1', 'completed'), item('i2', 'failed')].join('\n');
    expect(codexGateDenials('review:x', raw)).toEqual([]);
    expect(err.mock.calls.join('\n')).toContain('codex tool gate inactive: saw 1 of 2 commands');
    expect(readFileSync(sink, 'utf8')).toContain('"cause":"tool-gate-inactive"');
  });

  it('an allowed MCP call does not stand in for a shell command the gate never saw', () => {
    const file = writeLedger('t7', []);
    writeFileSync(
      file,
      `${JSON.stringify({ decision: 'allow', line: 'mcp__codebase__searchCode: {}' })}\n`,
    );
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    codexGateDenials('review:x', [thread('t7'), item('i1', 'completed')].join('\n'));
    expect(err.mock.calls.join('\n')).toContain('saw 0 of 1 commands');
  });

  it('does not count a declined command as executed', () => {
    writeLedger('t3', []);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    codexGateDenials('review:x', [thread('t3'), item('i1', 'declined')].join('\n'));
    expect(err).not.toHaveBeenCalled();
  });

  it('counts a command codex reported as started and completed once', () => {
    writeLedger('t6', ['allow']);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const started = item('i1', 'in_progress').replace('item.completed', 'item.started');
    codexGateDenials('review:x', [thread('t6'), started, item('i1', 'completed')].join('\n'));
    expect(err).not.toHaveBeenCalled();
  });

  it('leaves a non-codex stream unmeasured', () => {
    expect(codexGateDenials('review:x', '{"type":"result","result":"VERDICT: PASS"}')).toBeNull();
    expect(codexGateDenials('review:x', undefined)).toBeNull();
  });

  it('prunes ledgers a killed run left behind', () => {
    const stale = writeLedger('old', ['allow']);
    utimesSync(stale, new Date(0), new Date(0));
    writeLedger('t4', []);
    codexGateDenials('review:x', thread('t4'));
    expect(existsSync(stale)).toBe(false);
  });
});

describe('a codex judge refusal reaches judge_exec', () => {
  it('records permission_denials and hands them to the caller', async () => {
    const sink = path.join(dir, 'telemetry', 'gate-events.jsonl');
    process.env.DEVKIT_GATE_EVENTS = sink;
    process.env.DEVKIT_SHIP_ID = 'ship-gate';
    const bin = path.join(dir, 'codex');
    const stream = path.join(dir, 'stream.jsonl');
    writeFileSync(
      stream,
      `${[thread('t5'), item('i1', 'completed'), JSON.stringify({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'VERDICT: PASS' } })].join('\n')}\n`,
    );
    // Stands in for codex plus its hook: the hook allowed one read and refused `bun test`.
    const ledger = path.join(toolGateLedgerDir(), 't5.jsonl');
    writeFileSync(
      bin,
      `#!/bin/sh\ncat >/dev/null\nmkdir -p '${path.dirname(ledger)}'\nprintf '%s\\n' '{"decision":"allow","line":"Bash: cat a"}' '{"decision":"deny","line":"Bash: bun test"}' > '${ledger}'\ncat '${stream}'\n`,
      { mode: 0o755 },
    );
    process.env.GUARD_CODEX_BIN = bin;
    const seen: string[][] = [];
    const out = await execJudgeAsync({
      label: 'review:correctness-reviewer',
      args: ['-p', 'q', '--model', 'gpt-5'],
      timeout: 20_000,
      codexReadOnly: true,
      transcript: false,
      onPermissionDenials: (denied) => seen.push(denied),
    });
    expect(out).toBe('VERDICT: PASS');
    expect(seen).toEqual([['Bash: bun test']]);
    const rows = readFileSync(sink, 'utf8').trim().split('\n');
    expect(JSON.parse(rows[rows.length - 1])).toMatchObject({ permission_denials: 1 });
  });
});
