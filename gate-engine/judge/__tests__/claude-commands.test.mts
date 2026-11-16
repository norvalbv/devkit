import { describe, expect, it } from 'vitest';
import {
  claudeCommandLines,
  claudeFailure,
  parseJudgeUsage,
  parsePermissionDenials,
  unwrapClaudeResult,
} from '../claude-result.mts';

interface ToolInput {
  command?: string;
  description?: string;
  file_path?: string;
  content?: string;
}

const toolUse = (id: string, name: string, input: ToolInput, parent?: string) =>
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    parent_tool_use_id: parent ?? null,
  });
const toolResult = (id: string, content: string, isError?: boolean) =>
  JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }],
    },
    parent_tool_use_id: null,
  });

// Trimmed from `claude -p --output-format stream-json --verbose` (Claude Code 2.1.296, haiku,
// 2026-10-15): unread fields dropped, ids and the result shape kept as emitted.
const WRITE = { file_path: '/tmp/w/b.txt', content: 'x' };
const REAL_STREAM = [
  JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-haiku-5-5' }),
  toolUse('toolu_01UV', 'Bash', { command: 'ls', description: 'List files' }),
  toolResult('toolu_01UV', 'a.txt\nerr.txt', false),
  toolUse('toolu_01UJ', 'Read', { file_path: '/tmp/w/a.txt' }),
  toolResult('toolu_01UJ', '1\tSECRET=hunter2\n2\t'),
  toolUse('toolu_017n', 'Bash', { command: 'cat nonexistent-file' }),
  toolResult('toolu_017n', 'Exit code 1\ncat: nonexistent-file: No such file or directory', true),
  toolUse('toolu_012i', 'Write', WRITE),
  JSON.stringify({
    type: 'system',
    subtype: 'permission_denied',
    tool_name: 'Write',
    tool_use_id: 'toolu_012i',
  }),
  toolResult('toolu_012i', 'Claude requested permissions to write to /tmp/w/b.txt', true),
  toolUse('toolu_011V', 'Read', { file_path: '/tmp/w/missing.txt' }),
  toolResult('toolu_011V', 'File does not exist.', true),
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Not DONE: step 4 was blocked.',
    permission_denials: [{ tool_name: 'Write', tool_use_id: 'toolu_012i', tool_input: WRITE }],
    total_cost_usd: 0.00637235,
    usage: {
      input_tokens: 12,
      output_tokens: 1075,
      cache_creation_input_tokens: 20265,
      cache_read_input_tokens: 164755,
    },
  }),
].join('\n');

describe('claudeCommandLines', () => {
  it('lists every tool call of a real stream in order, never a result body', () => {
    const lines = claudeCommandLines(REAL_STREAM);
    expect(lines).toEqual([
      '[ok] Bash: ls',
      '[ok] Read: {"file_path":"/tmp/w/a.txt"}',
      '[error] Bash: cat nonexistent-file',
      '[denied] Write: {"file_path":"/tmp/w/b.txt","content":"x"}',
      '[error] Read: {"file_path":"/tmp/w/missing.txt"}',
    ]);
    expect(lines.join('\n')).not.toContain('hunter2');
  });

  it('a call the judge was killed during reads as no result, even past a torn final line', () => {
    const killed = `${toolUse('t1', 'Bash', { command: 'node checklist.mjs generate' })}\n{"type":"us`;
    expect(claudeCommandLines(killed)).toEqual(['[no result] Bash: node checklist.mjs generate']);
  });

  it("tags a subagent's calls and keeps each call on one bounded line", () => {
    const long = toolUse('t2', 'Bash', { command: `echo a\n${'x'.repeat(2000)}` }, 'task_1');
    const [only] = claudeCommandLines(long);
    expect(only).toMatch(/^\[no result\] \(subagent\) Bash: echo a x+$/);
    expect(only.length).toBe('[no result] (subagent) '.length + 500);
  });

  it('reads nothing from bytes that are not a claude stream', () => {
    expect(claudeCommandLines('VERDICT: PASS')).toEqual([]);
    expect(
      claudeCommandLines('{"type":"item.started","item":{"type":"command_execution"}}'),
    ).toEqual([]);
  });
});

describe('the result event of a stream', () => {
  it('carries the verdict, the spend and the refusals', () => {
    expect(unwrapClaudeResult(REAL_STREAM)).toBe('Not DONE: step 4 was blocked.');
    expect(parseJudgeUsage(REAL_STREAM)).toMatchObject({ input_tokens: 12, cache_read: 164755 });
    expect(parsePermissionDenials(REAL_STREAM)).toEqual([
      'Write: {"file_path":"/tmp/w/b.txt","content":"x"}',
    ]);
    expect(claudeFailure(REAL_STREAM)).toBeNull();
  });

  // The raw stream holds every file the judge read; it must never stand in for the verdict.
  it('a stream with no result text is a failure, never its raw bytes', () => {
    const cut = [toolUse('t1', 'Read', { file_path: '.env' }), toolResult('t1', 'SECRET=x')];
    const maxTurns = [...cut, JSON.stringify({ type: 'result', subtype: 'error_max_turns' })].join(
      '\n',
    );
    expect(unwrapClaudeResult(maxTurns)).toBeNull();
    expect(claudeFailure(maxTurns)).toBe('claude returned no result text (error_max_turns)');
    expect(unwrapClaudeResult(cut.join('\n'))).toBeNull();
    expect(claudeFailure(cut.join('\n'))).toMatch(/stream ended without a result/);
  });

  it('bytes that are not claude output pass through and are no failure', () => {
    expect(unwrapClaudeResult('VERDICT: PASS')).toBe('VERDICT: PASS');
    expect(claudeFailure('VERDICT: PASS')).toBeNull();
  });
});
