// The pasteable waive command, round-tripped through a real shell into the waive CLI's own parser.
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { blockingFindings } from '../../../cli/lib/ship/digest/blocking.mts';
import { blockingNote, fingerprint, loadOverrides, reconcile } from '../overrides.mts';
import {
  shellWord,
  UNSAFE_TEXT_RE,
  WAIVE_RATIONALE_PLACEHOLDER,
  waiveCommand,
} from '../valve/shell-word.mts';
import { parseWaiveArgs, parseWaiveTarget, runWaive } from '../valve/waive.mts';

const REVIEWER = 'correctness-reviewer';
const FP = '0123456789ab';
const BASE = '5c8482e8fa4e';
const PREFIX = 'guard-review waive ';

const HOSTILE_LENSES = [
  'src/a.ts:12',
  "docs/it's here.ts@CLAUDE.md:12",
  'docs/a"b\\c.ts@CLAUDE.md:1',
  'src/flows.ts@CLAUDE.md#1a2b3c4d',
  '#notes.md',
  'src/a%b.ts@CLAUDE.md:1#L2',
  'src/$(touch pwned).ts',
  'src/`id`.ts',
  'src/!event.ts',
  '=leading.ts',
  'src/*.ts?',
  'src/ünïcödé — 名前.ts',
  '(finding)',
  `src/${'nested dir/'.repeat(20)}flows.ts@CLAUDE.md:20`,
];

const UNSAFE_LENSES = [
  'src/\u001b[2Kok.ts',
  'src/bell\u0007.ts',
  'src/a\r\nb.ts',
  'src/csi\u009b.ts',
  `src/${String.fromCodePoint(0x202e)}evil.ts`,
  `src/line${String.fromCodePoint(0x2028)}sep.ts`,
];

const hasShell = (shell: string) => spawnSync(shell, ['-c', 'true']).status === 0;

/** Split the command's arguments exactly as `shell` would, NUL-separated so any byte survives. */
function shellArgv(shell: string[], command: string): string[] {
  expect(command.startsWith(PREFIX)).toBe(true);
  const script = `printf '%s\\0' ${command.slice(PREFIX.length)}`;
  const out = spawnSync(shell[0], [...shell.slice(1), '-c', script], { encoding: 'utf8' });
  expect(out.stderr).toBe('');
  expect(out.status).toBe(0);
  return out.stdout.split('\0').slice(0, -1);
}

function expectRoundTrip(shell: string[], lens: string, base: string | null) {
  const command = waiveCommand({ reviewer: REVIEWER, lens, fp: FP, base });
  if (command === null) throw new Error(`no command for ${JSON.stringify(lens)}`);
  const args = parseWaiveArgs(shellArgv(shell, command));
  if ('error' in args) throw new Error(`waive refused ${command}: ${args.error}`);
  expect(parseWaiveTarget(args.target)).toEqual({ reviewer: REVIEWER, lens });
  expect(args).toMatchObject({ itemId: FP, baseSha: base, rationale: WAIVE_RATIONALE_PLACEHOLDER });
}

describe('waiveCommand — round-trips through a real shell into the waive parser', () => {
  it.each(HOSTILE_LENSES)('sh: %s', (lens) => {
    expectRoundTrip(['sh'], lens, BASE);
    expectRoundTrip(['sh'], lens, null);
  });

  it.skipIf(!hasShell('zsh')).each(HOSTILE_LENSES)('zsh with extendedglob: %s', (lens) => {
    expectRoundTrip(['zsh', '-f', '-o', 'extendedglob'], lens, BASE);
  });

  it('quotes every word holding `#`, which extendedglob zsh would glob', () => {
    expect(shellWord('a:src/a.ts@CLAUDE.md#1a2b3c4d')).toBe("'a:src/a.ts@CLAUDE.md#1a2b3c4d'");
  });

  it('omits a base the waive CLI would refuse, so the printed command still parses', () => {
    for (const base of ['a'.repeat(6), 'a'.repeat(41), 'f'.repeat(64), 'main', '']) {
      expect(waiveCommand({ reviewer: REVIEWER, lens: 'a.ts', fp: FP, base })).not.toContain(
        '--base',
      );
    }
  });

  it('keeps a base at both ends of the accepted length', () => {
    expectRoundTrip(['sh'], 'a.ts', 'a'.repeat(7));
    expectRoundTrip(['sh'], 'a.ts', 'a'.repeat(40));
  });

  it('is refused when pasted unedited, since the rationale is the placeholder', () => {
    const command = waiveCommand({ reviewer: REVIEWER, lens: 'src/a.ts:1', fp: FP, base: BASE });
    const argv = shellArgv(['sh'], command ?? '');
    const cwd = mkdtempSync(join(tmpdir(), 'waive-command-'));
    expect(runWaive(argv, cwd, () => 'tester')).toBe(2);
  });
});

describe('waiveCommand — a lens that cannot round-trip prints no command', () => {
  it.each(UNSAFE_LENSES)('%j', (lens) => {
    expect(waiveCommand({ reviewer: REVIEWER, lens, fp: FP, base: BASE })).toBeNull();
    const note = blockingNote(REVIEWER, [{ lens, fp: FP }], `${BASE}0000`);
    expect(note.split('\n').filter((line) => line.search(UNSAFE_TEXT_RE) !== -1)).toEqual([]);
    expect(note).not.toContain('guard-review waive');
    expect(note).toContain(`OVERRIDE_${FP}_RATIONALE`);
  });

  it('stays null on a repeat call, so the shared global regex carries no state', () => {
    const w = { reviewer: REVIEWER, lens: UNSAFE_LENSES[0], fp: FP };
    expect([waiveCommand(w), waiveCommand(w), waiveCommand(w)]).toEqual([null, null, null]);
  });

  it('prints none for an empty lens', () => {
    expect(waiveCommand({ reviewer: REVIEWER, lens: '', fp: FP })).toBeNull();
  });
});

describe('blockingNote and the ship digest print the same command', () => {
  it.each(HOSTILE_LENSES.filter((lens) => lens.length <= 120))('%s', (lens) => {
    const expected = waiveCommand({ reviewer: REVIEWER, lens, fp: FP, base: BASE });
    expect(blockingNote(REVIEWER, [{ lens, fp: FP }], `${BASE}0000`)).toContain(`${expected}\n`);
    const [row] = blockingFindings({
      reviewer: REVIEWER,
      blocking: [{ lens, fp: FP }],
      blocking_base: BASE,
    });
    expect(row?.detail.endsWith(`— fix it, or: ${expected}`)).toBe(true);
  });
});

describe('a printed command, given a real reason, records the waiver its finding needs', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.DEVKIT_GATE_EVENTS;
    process.env.DEVKIT_GATE_EVENTS = join(mkdtempSync(join(tmpdir(), 'waive-sink-')), 'e.jsonl');
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.DEVKIT_GATE_EVENTS;
    else process.env.DEVKIT_GATE_EVENTS = saved;
    vi.restoreAllMocks();
  });

  it.each(['docs/it\'s #1 "x".ts@CLAUDE.md:12', 'src/flows.ts@CLAUDE.md#1a2b3c4d'])(
    '%s',
    (lens) => {
      const cwd = mkdtempSync(join(tmpdir(), 'waive-e2e-'));
      const fp = fingerprint(REVIEWER, lens, 'D');
      const note = blockingNote(REVIEWER, [{ lens, fp }], `${BASE}0000`);
      const printed = note.split('\n').find((line) => line.trim().startsWith(PREFIX)) ?? '';
      const reason = 'the lock is held for the whole read-modify-write';
      const edited = printed.trim().replace(WAIVE_RATIONALE_PLACEHOLDER, reason);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(runWaive(shellArgv(['sh'], edited), cwd, () => 'tester')).toBe(0);
      expect(loadOverrides(cwd)[fp]).toMatchObject({ lens, reviewer: REVIEWER, baseSha: BASE });
      expect(reconcile(cwd, REVIEWER, [lens], 'D', '2026-01-01').blocking).toEqual([]);
    },
  );
});
