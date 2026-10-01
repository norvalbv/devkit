import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DETAIL_CAP,
  exitGate,
  failLine,
  GATE_REASON_ENV,
  gateEnv,
  REASON_LINES,
  readGateReason,
  reasonDetail,
  reasonExcerpt,
  reasonReport,
  withReasonFiles,
  writeGateReason,
} from '../reason.mts';

const dirs: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), 'gate-reason-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env[GATE_REASON_ENV];
  vi.restoreAllMocks();
});

describe('writeGateReason — narration that can never change a verdict', () => {
  it('is a no-op outside guard-deterministic (variable unset) — a manual gate run writes nothing', () => {
    const d = scratch();
    writeGateReason(['x']);
    expect(readGateReason(join(d, 'never.txt'))).toEqual([]);
  });

  it('swallows a write error (unwritable path) instead of throwing into the gate', () => {
    process.env[GATE_REASON_ENV] = join(scratch(), 'missing-dir', 'reason.txt');
    expect(() => writeGateReason(['x'])).not.toThrow();
  });

  it('appends across calls, so a gate that explains itself twice keeps both lines', () => {
    const file = join(scratch(), 'r.txt');
    process.env[GATE_REASON_ENV] = file;
    writeGateReason(['first']);
    writeGateReason(['second', 'third']);
    expect(readGateReason(file)).toEqual(['first', 'second', 'third']);
  });

  it('an empty line set creates no file (a silent gate stays distinguishable from an explained one)', () => {
    const file = join(scratch(), 'r.txt');
    process.env[GATE_REASON_ENV] = file;
    writeGateReason([]);
    expect(() => readFileSync(file)).toThrow();
  });
});

// process.exit stand-in: throws (so it satisfies `never` with no cast) after an optional probe.
const stubExit = (probe?: () => void) =>
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    probe?.();
    throw new Error(`exit:${code}`);
  });

describe('withReasonFiles — the channel can never stop a gate from running', () => {
  it('an unusable TMPDIR degrades to no channel ("" paths) instead of throwing', () => {
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = join(scratch(), 'missing', 'tmp');
    try {
      const seen = withReasonFiles((fileFor) => [fileFor(0), fileFor(1)]);
      expect(seen).toEqual(['', '']);
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
  });

  it('gives each index its own file and removes the directory afterwards, even when fn throws', () => {
    let files: string[] = [];
    expect(() =>
      withReasonFiles((fileFor) => {
        files = [fileFor(0), fileFor(1)];
        writeFileSync(files[0], 'x');
        throw new Error('gate blew up');
      }),
    ).toThrow('gate blew up');
    expect(files[0]).not.toBe(files[1]);
    expect(existsSync(dirname(files[0]))).toBe(false);
  });

  it('an empty reason file path never names an inherited outer file', () => {
    process.env[GATE_REASON_ENV] = '/outer/reason.txt';
    expect(gateEnv('')[GATE_REASON_ENV]).toBe('');
  });
});

describe('failLine / exitGate', () => {
  it('failLine prints to stderr AND records the same line', () => {
    const file = join(scratch(), 'r.txt');
    process.env[GATE_REASON_ENV] = file;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    failLine('anti-slop: FAIL — 2 new error finding(s); baseline unchanged');
    expect(err).toHaveBeenCalledWith(
      'anti-slop: FAIL — 2 new error finding(s); baseline unchanged',
    );
    expect(readGateReason(file)).toEqual([
      'anti-slop: FAIL — 2 new error finding(s); baseline unchanged',
    ]);
  });

  it('exitGate(0) records nothing — a passing gate has no reason', () => {
    const file = join(scratch(), 'r.txt');
    process.env[GATE_REASON_ENV] = file;
    stubExit();
    expect(() => exitGate(0, ['should not be recorded'])).toThrow('exit:0');
    expect(readGateReason(file)).toEqual([]);
  });

  // Strict mode turns an opt-out (2) into a block, and an unexpected code always blocks.
  it.each([2, 3])('exitGate(%i) records its reason: any non-zero exit can block', (code) => {
    const file = join(scratch(), 'r.txt');
    process.env[GATE_REASON_ENV] = file;
    stubExit();
    expect(() => exitGate(code, ['no index — opted out'])).toThrow(`exit:${code}`);
    expect(readGateReason(file)).toEqual(['no index — opted out']);
  });

  it('exitGate(1) records the reason BEFORE exiting', () => {
    const file = join(scratch(), 'r.txt');
    process.env[GATE_REASON_ENV] = file;
    const seenAtExit: string[][] = [];
    stubExit(() => seenAtExit.push(readGateReason(file)));
    expect(() => exitGate(1, ['src/a.ts: 70 lines (max 50)'])).toThrow('exit:1');
    expect(seenAtExit).toEqual([['src/a.ts: 70 lines (max 50)']]);
  });
});

describe('readGateReason — real-world file shapes', () => {
  it('strips ANSI colour, splits CRLF (Windows) and drops blank lines', () => {
    const file = join(scratch(), 'r.txt');
    writeFileSync(
      file,
      '\u001b[31m🚫 red header\u001b[0m\r\n\r\n   src/a.ts: 70 lines (max 50)   \r\n',
    );
    expect(readGateReason(file)).toEqual(['🚫 red header', '   src/a.ts: 70 lines (max 50)']);
  });

  // The 64KB cut can land anywhere inside an escape sequence; no offset may leak a control byte.
  it.each(['\u001b[31m', '\u001b]8;;https://x\u0007', '\u009b31m'])(
    'a cap that splits %j at any offset leaves no control characters',
    (esc) => {
      for (let at = 0; at <= esc.length; at++) {
        const file = join(scratch(), `r${at}.txt`);
        writeFileSync(
          file,
          `${'a'.repeat(64 * 1024 - Buffer.byteLength(esc.slice(0, at)))}${esc}tail`,
        );
        for (const line of readGateReason(file)) {
          const codes = [...line].map((ch) => ch.codePointAt(0) ?? 0);
          expect(codes.filter((c) => c !== 9 && (c < 32 || (c >= 127 && c < 160)))).toEqual([]);
        }
      }
    },
  );

  it('reads at most 64KB — a runaway writer cannot exhaust the runner (and a cut char never throws)', () => {
    const file = join(scratch(), 'r.txt');
    writeFileSync(file, `${'é'.repeat(40_000)}\n`.repeat(20)); // ~1.6MB of 2-byte chars
    const lines = readGateReason(file);
    expect(Buffer.byteLength(lines.join('\n'), 'utf8')).toBeLessThanOrEqual(64 * 1024 + 3);
  });

  it('a directory at the reason path reads as no reason, never throws', () => {
    expect(readGateReason(scratch())).toEqual([]);
  });

  it('an empty path (no reason channel) reads as no reason', () => {
    expect(readGateReason('')).toEqual([]);
  });

  it('a missing file (a gate that recorded nothing) reads as no reason, never throws', () => {
    expect(readGateReason(join(scratch(), 'absent.txt'))).toEqual([]);
  });
});

describe('reasonExcerpt — boundaries', () => {
  it.each([
    [0, 0, 0],
    [REASON_LINES, REASON_LINES, 0],
    [REASON_LINES + 1, REASON_LINES, 1],
  ])('%i lines → %i shown, %i omitted', (n, shown, omitted) => {
    const lines = Array.from({ length: n }, (_, i) => `line ${i}`);
    const r = reasonExcerpt(lines);
    expect(r.shown).toHaveLength(shown);
    expect(r.omitted).toBe(omitted);
  });
});

describe('reasonDetail — the event field the ship digest renders', () => {
  it('no reason → the bare label, byte-for-byte what the event carried before (back-compat)', () => {
    expect(reasonDetail('guard-size', [])).toBe('guard-size');
    expect(reasonDetail('guard-size(unexpected:3)', [])).toBe('guard-size(unexpected:3)');
  });

  it('a caller-controlled --extra label is capped even with no reason (event stays atomic)', () => {
    const detail = reasonDetail('x'.repeat(DETAIL_CAP * 10), []);
    expect(Array.from(detail)).toHaveLength(DETAIL_CAP);
    expect(detail.endsWith('…')).toBe(true);
  });

  it('label first, reason lines joined on one line with whitespace collapsed', () => {
    expect(reasonDetail('guard-size', ['🚫 1 file(s) over', '   src/a.ts:  70 lines'])).toBe(
      'guard-size: 🚫 1 file(s) over · src/a.ts: 70 lines',
    );
  });

  it('an exactly-at-cap detail is not truncated; one code point over is', () => {
    const atCap = 'x'.repeat(DETAIL_CAP - 'g: '.length);
    expect(reasonDetail('g', [atCap])).toHaveLength(DETAIL_CAP);
    const over = reasonDetail('g', [`${atCap}y`]);
    expect(Array.from(over)).toHaveLength(DETAIL_CAP);
    expect(over.endsWith('…')).toBe(true);
  });

  it('caps by code point: astral emoji at the cut never leave a lone surrogate, and bytes stay < 4KB', () => {
    const detail = reasonDetail('guard-size', ['😀'.repeat(DETAIL_CAP * 2)]);
    expect(Array.from(detail)).toHaveLength(DETAIL_CAP);
    expect(detail.isWellFormed()).toBe(true);
    // The sink's tear-freedom rests on one sub-4KB O_APPEND; leave room for the run envelope.
    expect(Buffer.byteLength(JSON.stringify({ detail }), 'utf8')).toBeLessThan(2100);
  });
});

describe('reasonReport — the block printed under the aggregated verdict', () => {
  it('a gate that recorded nothing says so; guard-size also gets the stage-first repro hint', () => {
    const out = reasonReport([
      { id: 'size', label: 'guard-size', reason: [] },
      { label: 'lint:x', reason: [] },
    ]).join('\n');
    expect(out).toContain('── guard-size ──');
    expect(out).toMatch(/guard-size reads the index/);
    expect(out.match(/no reason summary from this gate/g)).toHaveLength(2);
    // The staging hint is guard-size specific — it would mislead on an --extra lint command.
    expect(out.match(/reads the index/g)).toHaveLength(1);
  });

  // Keyed on the registry id, never the label: every label below is something an --extra can spell.
  it.each([
    ['size', 'guard-size', true],
    ['size', 'guard-size(could-not-run)', true],
    ['size', 'guard-size(unexpected:3)', true],
    [undefined, 'guard-size', false], // an --extra literally named guard-size
    [undefined, 'guard-size(foo)', false],
    [undefined, 'guard-size-lint', false],
    ['fanout', 'guard-fanout', false],
  ])('the stage-first hint follows the gate id: %s / %s → %s', (id, label, hinted) => {
    const out = reasonReport([{ id, label, reason: [] }]).join('\n');
    expect(out.includes('reads the index')).toBe(hinted);
  });

  it('a long reason shows REASON_LINES lines and counts the rest', () => {
    const reason = Array.from(
      { length: REASON_LINES + 40 },
      (_, i) => `   f${i}.ts: 9 lines (max 1)`,
    );
    const out = reasonReport([{ label: 'guard-size', reason }]);
    expect(out.filter((l) => l.includes('.ts: 9 lines'))).toHaveLength(REASON_LINES);
    expect(out.at(-1)).toContain('40 more line(s) in the full log above');
  });
});
