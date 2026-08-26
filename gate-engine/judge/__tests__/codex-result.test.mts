import { describe, expect, it } from 'vitest';
import {
  codexExecArgs,
  codexFailure,
  isCodexModel,
  judgeBinFor,
  judgeCliFor,
  parseClaudeArgv,
  parseCodexUsage,
  unwrapCodexResult,
} from '../codex/result.mts';

// Captured VERBATIM from a real `codex exec --json` run (codex-cli 0.149.0-alpha, 2026-08-24) —
// the schema these parsers rely on is pinned by real bytes, not a guessed shape.
const REAL_ENVELOPE = [
  '{"type":"thread.started","thread_id":"01a0347e-0af4-78b1-8b7f-5332b5393c0d"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Code Mode is unavailable because failed to spawn code-mode host."}}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"PONG"}}',
  '{"type":"turn.completed","usage":{"input_tokens":19119,"cached_input_tokens":9984,"cache_write_input_tokens":0,"output_tokens":6,"reasoning_output_tokens":0}}',
  '',
].join('\n');

describe('isCodexModel', () => {
  it('routes gpt-* ids to codex and everything else to claude', () => {
    expect(isCodexModel('gpt-5.6-sol')).toBe(true);
    expect(isCodexModel('gpt-5.6-terra')).toBe(true);
    for (const m of ['sonnet', 'haiku', 'opus', null]) expect(isCodexModel(m)).toBe(false);
  });
});

describe('parseClaudeArgv', () => {
  it('reads the factory shape: -p --model m <policy…> PROMPT (prompt trailing)', () => {
    const parts = parseClaudeArgv([
      '-p',
      '--model',
      'gpt-5.6-sol',
      '--disallowedTools',
      '*',
      '--settings',
      '{"x":1}',
      '--no-session-persistence',
      'JUDGE THIS',
    ]);
    expect(parts).toEqual({
      model: 'gpt-5.6-sol',
      prompt: 'JUDGE THIS',
      systemPrompt: null,
      readOnly: true,
      allowedTools: null,
    });
  });

  it('reads the review-gate shape: -p PROMPT --model m --allowedTools list', () => {
    const parts = parseClaudeArgv([
      '-p',
      'REVIEW THIS',
      '--model',
      'gpt-5.6-terra',
      '--settings',
      '{"x":1}',
      '--no-session-persistence',
      '--allowedTools',
      'Bash(node:*) Read',
    ]);
    expect(parts).toEqual({
      model: 'gpt-5.6-terra',
      prompt: 'REVIEW THIS',
      systemPrompt: null,
      readOnly: false,
      allowedTools: ['Bash(node:*) Read'],
    });
  });

  it('captures a trailing prompt that OPENS on a markdown bullet instead of skipping it as a flag', () => {
    // A dash-led prompt is legal prompt text; dropping it left prompt=null, made codexExecArgs
    // throw, and misreported a WORKING judge as an outage (offline/quota/absent).
    const parts = parseClaudeArgv([
      '-p',
      '--model',
      'gpt-5.6-sol',
      '--disallowedTools',
      '*',
      '- check each item\n- reply VERDICT',
    ]);
    expect(parts.prompt).toBe('- check each item\n- reply VERDICT');
    // The `-p`-adjacent caller shape has the SAME contract — a dash-led bullet prompt is text:
    expect(
      parseClaudeArgv(['-p', '- judge this\n- reply', '--model', 'gpt-5.6-terra']).prompt,
    ).toBe('- judge this\n- reply');
    // A genuinely option-looking token is still NOT a prompt, in either position.
    expect(
      parseClaudeArgv(['-p', 'REAL PROMPT', '--model', 'gpt-5.6-sol', '--no-session-persistence'])
        .prompt,
    ).toBe('REAL PROMPT');
    expect(parseClaudeArgv(['-p', '--model', 'gpt-5.6-sol', 'TRAILING']).prompt).toBe('TRAILING');
  });

  it("captures --append-system-prompt (the eval harnesses' agent-brief seam) instead of misreading its body as the prompt", () => {
    // The near-miss the prior-art review caught: an omitted value-flag makes the BRIEF the
    // positional prompt, then the real prompt overwrites it — the brief silently vanishes while
    // the bench still records agentHash as if it were used.
    const parts = parseClaudeArgv([
      '-p',
      '--model',
      'gpt-5.6-sol',
      '--append-system-prompt',
      'AGENT BRIEF BODY',
      '--disallowedTools',
      '*',
      'TASK PROMPT',
    ]);
    expect(parts.systemPrompt).toBe('AGENT BRIEF BODY');
    expect(parts.prompt).toBe('TASK PROMPT');
    const argv = codexExecArgs(parts);
    const finalPrompt = argv[argv.length - 1];
    expect(finalPrompt).toContain('AGENT BRIEF BODY');
    expect(finalPrompt).toContain('TASK PROMPT');
    expect(finalPrompt.indexOf('AGENT BRIEF BODY')).toBeLessThan(
      finalPrompt.indexOf('TASK PROMPT'),
    );
  });
});

describe('judgeCliFor', () => {
  it('leaves a non-gpt argv on the claude path with withResultArgs applied — byte-identical', () => {
    const args = ['-p', '--model', 'sonnet', '--disallowedTools', '*', 'PROMPT'];
    const cli = judgeCliFor(args);
    expect(cli.bin).toBe('claude');
    expect(cli.codex).toBe(false);
    expect(cli.argv).toEqual(['--output-format', 'json', ...args]);
  });

  it('maps a read-only gpt judge onto the read-only sandbox and an investigating one onto workspace-write', () => {
    const ro = judgeCliFor(['-p', '--model', 'gpt-5.6-sol', '--disallowedTools', '*', 'P']);
    expect(ro.bin).toBe('codex');
    expect(ro.argv).toContain('read-only');
    const rw = judgeCliFor(['-p', 'P', '--model', 'gpt-5.6-sol', '--allowedTools', 'Bash Read']);
    expect(rw.argv).toContain('workspace-write');
    // Hermetic + parseable, always: no user config, no persisted session, JSONL out.
    for (const flag of ['--ignore-user-config', '--ephemeral', '--json'])
      expect(rw.argv).toContain(flag);
    expect(rw.argv[rw.argv.length - 1]).toBe('P');
  });

  it('refuses (throws) a gpt argv with no extractable prompt — never a silent stdin-as-prompt run', () => {
    expect(() =>
      codexExecArgs({ model: 'gpt-5.6-sol', prompt: null, systemPrompt: null, readOnly: true }),
    ).toThrow(/no --model or no prompt/);
  });
});

describe('unwrapCodexResult', () => {
  it('returns the last completed agent_message from the real envelope', () => {
    expect(unwrapCodexResult(REAL_ENVELOPE)).toBe('PONG');
  });

  it('returns null (caller falls back to raw) when no agent_message parses', () => {
    expect(unwrapCodexResult('{"type":"turn.started"}\nnot json\n')).toBeNull();
    expect(unwrapCodexResult(null)).toBeNull();
  });

  it('skips error items and blank messages, keeping the LAST real message', () => {
    const jsonl = [
      '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"  "}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"VERDICT: PASS"}}',
    ].join('\n');
    expect(unwrapCodexResult(jsonl)).toBe('VERDICT: PASS');
  });
});

describe('codexFailure', () => {
  it('reports turn.failed (error.message) and top-level error events as failures', () => {
    // Both are first-class terminal events in codex-rs/exec/src/exec_events.rs — a stream
    // carrying one must land on the OUTAGE path, never fall through as "no verdict text".
    expect(codexFailure('{"type":"turn.failed","error":{"message":"usage limit reached"}}')).toBe(
      'usage limit reached',
    );
    expect(codexFailure('{"type":"error","message":"stream disconnected"}')).toBe(
      'stream disconnected',
    );
  });

  it('is null on a healthy stream (the real captured envelope) and on unparseable input', () => {
    expect(codexFailure(REAL_ENVELOPE)).toBeNull();
    expect(codexFailure('not json at all')).toBeNull();
    expect(codexFailure(null)).toBeNull();
  });
});

describe('judgeBinFor', () => {
  it('agrees with judgeCliFor on every argv shape — one routing truth, even mid-catch', () => {
    const callerArgvs = [
      ['-p', '--model', 'gpt-5.6-sol', '--disallowedTools', '*', 'P'],
      ['-p', 'P', '--model', 'gpt-5.6-terra', '--allowedTools', 'Bash'],
      ['-p', '--model', 'sonnet', '--disallowedTools', '*', 'P'],
    ];
    for (const args of callerArgvs) expect(judgeBinFor(args)).toBe(judgeCliFor(args).bin);
    // Never throws, even on an argv translation would refuse (no prompt at all):
    expect(judgeBinFor(['-p', '--model', 'gpt-5.6-sol'])).toBe('codex');
  });
});

describe('parseCodexUsage', () => {
  it('maps the real envelope onto claude-shaped columns: cached slice out of input, cost 0 + subscription marker', () => {
    expect(parseCodexUsage(REAL_ENVELOPE)).toEqual({
      // codex input_tokens INCLUDES the cached portion; the collector's input_tokens means
      // "uncached input" (claude convention), so 19119 - 9984:
      input_tokens: 9135,
      output_tokens: 6,
      cache_creation: 0,
      cache_read: 9984,
      cost_usd: 0,
      billing: 'subscription',
    });
  });

  it('folds reasoning tokens into output (billed output the collector must not lose)', () => {
    const jsonl =
      '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":0,"cache_write_input_tokens":5,"output_tokens":20,"reasoning_output_tokens":30}}';
    expect(parseCodexUsage(jsonl)).toMatchObject({ output_tokens: 50, cache_creation: 5 });
  });

  it('returns null, never a zero-filled row, when no usage event parses', () => {
    expect(parseCodexUsage('{"type":"turn.started"}')).toBeNull();
    expect(parseCodexUsage(null)).toBeNull();
  });
});
