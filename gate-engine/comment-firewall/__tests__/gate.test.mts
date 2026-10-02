import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCommentCli } from '../cli.mts';
import { runCommentFirewall } from '../gate.mts';
import { emptyInventory } from '../inventory.mts';
import type { CommentFinding, DetectionResult, RefFinding } from '../types.mts';

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
  anchor: '0123456789ab',
  textLines: 3,
};
const second: CommentFinding = { ...finding, id: 'b1c2d3e4f5a6', path: 'src/b.ts', endLine: 2 };
const ref: RefFinding = {
  path: 'src/c.ts',
  line: 7,
  refs: ['sc-3836'],
  comment: '// Residual until a queued note can be told from a typed reply (sc-3836).',
};
const detection = (
  findings: CommentFinding[] = [finding],
  refFindings: RefFinding[] = [],
): DetectionResult => ({
  findings,
  refFindings,
  unsupported: [],
  inventory: {
    ...emptyInventory(),
    files: 1,
    paragraphs: { one: 0, two: 0, over: findings.length },
    touched: findings.map((item) => ({ anchor: item.anchor, textLines: item.textLines })),
  },
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** A store where only `shown` anchors were seen before; every recording is captured, none written. */
function fresh(shown: string[] = []) {
  const read = vi.fn((_cwd: string, anchors: string[]) => {
    return new Set(anchors.filter((anchor) => shown.includes(anchor)));
  });
  return { shown: read, record: vi.fn() };
}

function capture(): () => string {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  return () => vi.mocked(console.error).mock.calls.flat().join('\n');
}

describe('runCommentFirewall', () => {
  it('passes a staged change with no challenged paragraph', () => {
    const output = capture();
    expect(runCommentFirewall('/repo', { ...fresh(), detect: () => detection([]) })).toBe(0);
    expect(output()).toBe('');
  });

  it('blocks a new over-budget paragraph once, with the collector-stable first line', () => {
    const output = capture();
    const deps = fresh();
    expect(runCommentFirewall('/repo', { ...deps, detect: () => detection() })).toBe(1);
    const text = output();
    expect(text).toContain('guard-comments: 1 added/modified comment paragraph need a decision.');
    expect(text).toContain('[a1b2c3d4e5f6] src/a.ts:2-4 — // The wire format uses UTF-16');
    expect(text).toContain('Shorten the comment where possible.');
    expect(text).toContain('to justify a workaround, the code is wrong — fix the code.');
    expect(text).toContain('retry unchanged: a paragraph blocks only once.');
    expect(text).not.toContain('2 lines');
    expect(deps.record).toHaveBeenCalledWith('/repo', ['0123456789ab']);
  });

  it('passes a paragraph an earlier attempt already showed, and says it was kept', () => {
    const output = capture();
    const deps = fresh(['0123456789ab']);
    const emit = vi.fn();
    expect(runCommentFirewall('/repo', { ...deps, emit, detect: () => detection() })).toBe(0);
    expect(output()).toBe('guard-comments: kept 1 long comment(s) shown on an earlier attempt.');
    expect(output()).not.toMatch(/guard-comments: .* need a decision/);
    expect(emit.mock.calls[0]?.[3]).toEqual({ kept: 1, refs: 0 });
  });

  it('lists only the unseen paragraphs when some were shown before', () => {
    const output = capture();
    const deps = fresh(['0123456789ab']);
    const other = { ...second, anchor: 'ffffffffffff' };
    expect(
      runCommentFirewall('/repo', { ...deps, detect: () => detection([finding, other]) }),
    ).toBe(1);
    expect(output()).toContain(
      'guard-comments: 1 added/modified comment paragraph need a decision.',
    );
    expect(output()).not.toContain('[a1b2c3d4e5f6]');
    expect(deps.record).toHaveBeenCalledWith('/repo', ['ffffffffffff']);
  });

  it('shows every finding in a review run, already-shown ones included, and records none', () => {
    vi.stubEnv('DEVKIT_RUN_MODE', 'review');
    const output = capture();
    const deps = fresh(['0123456789ab']);
    expect(runCommentFirewall('/repo', { ...deps, detect: () => detection() })).toBe(1);
    expect(output()).toContain('[a1b2c3d4e5f6]');
    expect(deps.shown).not.toHaveBeenCalled();
    expect(deps.record).not.toHaveBeenCalled();
  });

  it('blocks a forbidden reference on every attempt, never recording it as shown', () => {
    const output = capture();
    const deps = fresh();
    expect(runCommentFirewall('/repo', { ...deps, detect: () => detection([], [ref]) })).toBe(1);
    const text = output();
    expect(text).toContain('guard-comments: 1 added/modified comment paragraph need a decision.');
    expect(text).toContain('src/c.ts:7 cites sc-3836 —');
    expect(text).toContain('the ticket belongs in the commit message or PR body');
    expect(text).not.toContain('Shorten the comment');
    expect(deps.record).toHaveBeenCalledWith('/repo', []);
  });

  it('blocks a reference even when its paragraph was already shown', () => {
    capture();
    const emit = vi.fn();
    const deps = fresh(['0123456789ab']);
    expect(
      runCommentFirewall('/repo', { ...deps, emit, detect: () => detection([finding], [ref]) }),
    ).toBe(1);
    expect(emit.mock.calls[0]?.[2]).toEqual([]);
    expect(emit.mock.calls[0]?.[3]).toEqual({ kept: 1, refs: 1 });
  });

  it('pluralises and lists every finding with a single-line location for a one-line span', () => {
    const output = capture();
    expect(
      runCommentFirewall('/repo', { ...fresh(), detect: () => detection([finding, second]) }),
    ).toBe(1);
    const text = output();
    expect(text).toContain('guard-comments: 2 added/modified comment paragraphs need a decision.');
    expect(text).toContain('[b1c2d3e4f5a6] src/b.ts:2 —');
  });

  it('reads no environment: strict mode and ship-log hints change nothing', () => {
    vi.stubEnv('GUARD_AI_STRICT', '1');
    vi.stubEnv('DEVKIT_SHIP_GATE_LOG', '/tmp/last-ship-gates-feat.log');
    const output = capture();
    expect(runCommentFirewall('/repo', { ...fresh(), detect: () => detection() })).toBe(1);
    expect(output()).not.toContain('--from-ship-log');
    vi.unstubAllEnvs();
  });

  it('reports unreadable evidence as exit 4, never a rejection', () => {
    const output = capture();
    expect(
      runCommentFirewall('/repo', {
        ...fresh(),
        detect: () => {
          throw new Error('git show failed');
        },
      }),
    ).toBe(4);
    expect(output()).toContain('comment evidence unreadable — git show failed');
  });

  it('reports an unusable shown-paragraph store as exit 4, with telemetry', () => {
    const output = capture();
    const emit = vi.fn();
    const record = () => {
      throw new Error('EACCES: permission denied, open .git/devkit/comment-shown/x');
    };
    const run = { ...fresh(), record, emit, detect: () => detection() };
    expect(runCommentFirewall('/repo', run)).toBe(4);
    expect(emit.mock.calls[0]?.[0]).toBe('unreadable');
    expect(output()).toContain('comment evidence unreadable — EACCES: permission denied');
  });

  it('prints the block before recording it, so an interrupted run can never pass it unseen', () => {
    const output = capture();
    let printedFirst = false;
    const record = () => {
      printedFirst = output().includes('[a1b2c3d4e5f6]');
    };
    runCommentFirewall('/repo', { ...fresh(), record, detect: () => detection() });
    expect(printedFirst).toBe(true);
  });

  it('does not record paragraphs when an unsupported language makes the run exit 4', () => {
    capture();
    const deps = fresh();
    const detect = () => ({ ...detection(), unsupported: [{ extension: 'py', path: 'src/a.py' }] });
    expect(runCommentFirewall('/repo', { ...deps, detect })).toBe(4);
    expect(deps.record).not.toHaveBeenCalled();
  });

  it('keeps the old unreadable message when detection itself fails', () => {
    const output = capture();
    const shown = () => {
      throw new Error('not a git repository');
    };
    expect(runCommentFirewall('/repo', { detect: shown })).toBe(4);
    expect(output()).toContain('comment evidence unreadable — not a git repository');
  });

  it('fails visibly when a configured changed language has no lexer adapter', () => {
    const output = capture();
    expect(
      runCommentFirewall('/repo', {
        ...fresh(),
        detect: () => ({
          findings: [],
          refFindings: [],
          unsupported: [{ extension: 'py', path: 'src/a.py' }],
          inventory: emptyInventory(),
        }),
      }),
    ).toBe(4);
    expect(output()).toContain('.py — src/a.py');
  });

  it.each([
    ['pass', () => detection([]), 0, 0],
    ['block', () => detection([finding, second]), 1, 2],
    [
      'unsupported',
      () => ({
        findings: [],
        refFindings: [],
        unsupported: [{ extension: 'py', path: 'src/a.py' }],
        inventory: emptyInventory(),
      }),
      4,
      0,
    ],
    [
      'unreadable',
      () => {
        throw new Error('index locked');
      },
      4,
      0,
    ],
  ])('emits one %s comment-budget event per run', (status, detect, exit, findingCount) => {
    capture();
    const emit = vi.fn();
    expect(runCommentFirewall('/repo', { ...fresh(), detect, emit })).toBe(exit);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]?.[0]).toBe(status);
    expect(emit.mock.calls[0]?.[2]).toHaveLength(findingCount);
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
