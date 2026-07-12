import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildVisionPrompt, parseVisionVerdict, runVision, visionExit } from '../check-vision.mts';

// Env hygiene: the gate reads GUARD_*/FRINK_* — a developer's real env must not steer assertions.
const ENV_KEYS = [
  'GUARD_NO_VISION',
  'FRINK_NO_VISION',
  'GUARD_VISION_HARD',
  'FRINK_VISION_HARD',
  'GUARD_VISION_NO_LLM',
  'FRINK_VISION_NO_LLM',
];
const saved = {};
beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

const STATEMENT =
  'A dev TOOL, not a platform: never host the user product backend. OUT = hosting it.';

// A consumer repo with a vision statement (or none) and one staged file so the judge runs.
function consumerRepo({ statement = STATEMENT }: { statement?: string | null } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'guard-vision-'));
  dirs.push(repo);
  execSync('git init -q', { cwd: repo });
  writeFileSync(
    join(repo, 'guard.config.json'),
    JSON.stringify(statement === null ? {} : { vision: { statement } }),
  );
  writeFileSync(join(repo, 'x.ts'), 'export const x = 1;\n');
  execSync('git add .', { cwd: repo });
  return repo;
}

const mkExec = (impl) => vi.fn(impl);

describe('parseVisionVerdict', () => {
  it('parses a confident single-word verdict (case/whitespace-insensitive)', () => {
    expect(parseVisionVerdict('OUT')).toBe('OUT');
    expect(parseVisionVerdict(' drift\n')).toBe('DRIFT');
    expect(parseVisionVerdict('FIT.')).toBe('FIT');
  });

  it('returns null for ambiguous / empty / unknown (→ no block)', () => {
    expect(parseVisionVerdict('OUT but really FIT')).toBeNull();
    expect(parseVisionVerdict('')).toBeNull();
    expect(parseVisionVerdict('maybe')).toBeNull();
  });

  it('does NOT misfire on English words that merely CONTAIN a verdict substring', () => {
    expect(parseVisionVerdict('This is fine, nothing about hosting here')).toBeNull();
    expect(parseVisionVerdict('Looks good without issue — a clear FIT')).toBe('FIT');
    expect(parseVisionVerdict('benefit of the doubt')).toBeNull();
  });
});

describe('visionExit (block bounded to hard-mode + confident OUT)', () => {
  it('blocks ONLY on hard mode + OUT', () => {
    expect(visionExit('OUT', true)).toBe(1);
  });

  it('never blocks otherwise', () => {
    expect(visionExit('OUT', false)).toBe(0); // softened (GUARD_VISION_HARD=0)
    expect(visionExit('DRIFT', true)).toBe(0); // fuzzy drift never blocks, even hard
    expect(visionExit('FIT', true)).toBe(0);
    expect(visionExit(null, true)).toBe(0); // ambiguous/unavailable → no block
  });
});

describe('runVision — hard-by-default gate over consumer statement', () => {
  it('OUT with no env set → blocks (1): hard is the default; prompt carries the statement + scaffold', () => {
    const repo = consumerRepo();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    let captured: { label: string; args: string[]; input?: string };
    const exec = mkExec((opts) => {
      captured = opts;
      return 'OUT';
    });
    expect(runVision(true, repo, { exec })).toBe(1);
    const prompt = captured.args.at(-1);
    expect(prompt).toContain(STATEMENT); // consumer content embedded
    expect(prompt).toContain('exactly one word: FIT, DRIFT, or OUT'); // devkit-owned scaffold
    expect(captured.args).toContain('opus');
    expect(captured.input).toContain('CHANGED PATHS:'); // paths anchor the judgement
    expect(captured.input).toContain('x.ts');
    expect(err.mock.calls.flat().join('\n')).toContain('vision: OUT');
  });

  it('OUT + GUARD_VISION_HARD=0 → softened to warn, exit 0 (still warns visibly)', () => {
    const repo = consumerRepo();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.GUARD_VISION_HARD = '0';
    expect(runVision(true, repo, { exec: mkExec(() => 'OUT') })).toBe(0);
    expect(err.mock.calls.flat().join('\n')).toContain('vision: OUT');
  });

  it('DRIFT → warn only, exit 0 even in default hard mode', () => {
    const repo = consumerRepo();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(runVision(true, repo, { exec: mkExec(() => 'DRIFT') })).toBe(0);
    expect(err.mock.calls.flat().join('\n')).toContain('vision: DRIFT');
  });

  it('FIT → exit 0, silent in gate mode', () => {
    const repo = consumerRepo();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(runVision(true, repo, { exec: mkExec(() => 'FIT') })).toBe(0);
    expect(err).not.toHaveBeenCalled();
  });

  it('no vision.statement configured → self-skips before any spawn, exit 0', () => {
    const repo = consumerRepo({ statement: null });
    const exec = mkExec(() => 'OUT');
    expect(runVision(true, repo, { exec })).toBe(0);
    expect(exec).not.toHaveBeenCalled();
  });

  it('GUARD_NO_VISION=1 skips before any spawn', () => {
    const repo = consumerRepo();
    process.env.GUARD_NO_VISION = '1';
    const exec = mkExec(() => 'OUT');
    expect(runVision(true, repo, { exec })).toBe(0);
    expect(exec).not.toHaveBeenCalled();
  });

  it('GUARD_VISION_NO_LLM=1 → no judgement → exit 0, never blocks', () => {
    const repo = consumerRepo();
    process.env.GUARD_VISION_NO_LLM = '1';
    const exec = mkExec(() => 'OUT');
    expect(runVision(true, repo, { exec })).toBe(0);
    expect(exec).not.toHaveBeenCalled();
  });

  it('judge outage (exec → null) → exit 0 (fail-open toward not blocking)', () => {
    const repo = consumerRepo();
    expect(runVision(true, repo, { exec: mkExec(() => null) })).toBe(0);
  });

  it('git failure → exit 2 (could-not-run, fail-open)', () => {
    const notARepo = mkdtempSync(join(tmpdir(), 'guard-vision-norepo-'));
    dirs.push(notARepo);
    writeFileSync(
      join(notARepo, 'guard.config.json'),
      JSON.stringify({ vision: { statement: STATEMENT } }),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(runVision(true, notARepo, { exec: mkExec(() => 'FIT') })).toBe(2);
  });

  it('report mode (gate=false) prints the verdict and exits 0 even on OUT', () => {
    const repo = consumerRepo();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(runVision(false, repo, { exec: mkExec(() => 'OUT') })).toBe(0);
    expect(log.mock.calls.flat().join('\n')).toContain('vision: OUT');
  });
});

describe('buildVisionPrompt', () => {
  it('wraps the trimmed statement between fixed preamble and reply-format scaffold', () => {
    const p = buildVisionPrompt('  my vision  ');
    expect(p.indexOf('product vision below')).toBeLessThan(p.indexOf('my vision'));
    expect(p.indexOf('my vision')).toBeLessThan(p.indexOf('If uncertain, reply FIT'));
  });
});
