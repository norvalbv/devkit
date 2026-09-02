import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCommentCli } from '../cli.mts';
import { runCommentFirewall } from '../gate.mts';
import type { CommentFinding, DetectionResult } from '../types.mts';

const finding: CommentFinding = {
  id: 'a1b2c3d4e5f6',
  path: 'src/a.ts',
  extension: 'ts',
  adapterVersion: 'typescript-scanner-v2',
  kind: 'line',
  startLine: 2,
  endLine: 4,
  comment:
    '// The wire format uses UTF-16 code units.\n// A surrogate pair advances by two.\n// Byte slicing corrupts later messages.',
  context: 'const width = input.length;',
  relevantDiff: '@@ -1 +1,4 @@\n+// The wire format uses UTF-16 code units.',
};
const second: CommentFinding = { ...finding, id: 'b1c2d3e4f5a6', path: 'src/b.ts', endLine: 2 };
const detection = (findings: CommentFinding[] = [finding]): DetectionResult => ({
  findings,
  unsupported: [],
});

afterEach(() => {
  vi.restoreAllMocks();
});

function capture(): () => string {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  return () => vi.mocked(console.error).mock.calls.flat().join('\n');
}

describe('runCommentFirewall', () => {
  it('passes a staged change with no challenged paragraph', () => {
    const output = capture();
    expect(runCommentFirewall('/repo', { detect: () => detection([]) })).toBe(0);
    expect(output()).toBe('');
  });

  it('blocks an over-budget paragraph with the collector-stable first line and one remedy', () => {
    const output = capture();
    expect(runCommentFirewall('/repo', { detect: () => detection() })).toBe(1);
    const text = output();
    expect(text).toContain('guard-comments: 1 added/modified comment paragraph need a decision.');
    expect(text).toContain('[a1b2c3d4e5f6] src/a.ts:2-4 — // The wire format uses UTF-16');
    expect(text).toContain('Shorten it to at most 2 lines');
    expect(text).toContain('decision record (guard-decisions)');
    expect(text).toContain('There is no rationale or waiver.');
    expect(text).not.toContain('justify');
    expect(text).not.toContain('ticket');
  });

  it('pluralises and lists every finding with a single-line location for a one-line span', () => {
    const output = capture();
    expect(runCommentFirewall('/repo', { detect: () => detection([finding, second]) })).toBe(1);
    const text = output();
    expect(text).toContain('guard-comments: 2 added/modified comment paragraphs need a decision.');
    expect(text).toContain('[b1c2d3e4f5a6] src/b.ts:2 —');
  });

  it('reads no environment: strict mode and ship-log hints change nothing', () => {
    vi.stubEnv('GUARD_AI_STRICT', '1');
    vi.stubEnv('DEVKIT_SHIP_GATE_LOG', '/tmp/last-ship-gates-feat.log');
    const output = capture();
    expect(runCommentFirewall('/repo', { detect: () => detection() })).toBe(1);
    expect(output()).not.toContain('--from-ship-log');
    vi.unstubAllEnvs();
  });

  it('reports unreadable evidence as exit 4, never a rejection', () => {
    const output = capture();
    expect(
      runCommentFirewall('/repo', {
        detect: () => {
          throw new Error('git show failed');
        },
      }),
    ).toBe(4);
    expect(output()).toContain('comment evidence unreadable — git show failed');
  });

  it('fails visibly when a configured changed language has no lexer adapter', () => {
    const output = capture();
    expect(
      runCommentFirewall('/repo', {
        detect: () => ({ findings: [], unsupported: [{ extension: 'py', path: 'src/a.py' }] }),
      }),
    ).toBe(4);
    expect(output()).toContain('.py — src/a.py');
  });
});

describe('runCommentCli', () => {
  it.each([['justify'], ['list'], ['prune'], [undefined]])(
    'exits 4 (blocking, not fail-open) on the retired or missing subcommand %s',
    (command) => {
      const output = capture();
      expect(runCommentCli(command === undefined ? [] : [command, 'x', 'why'], '/repo')).toBe(4);
      expect(output()).toContain('Usage:');
      expect(output()).not.toContain('justify');
    },
  );
});
