import { execSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectSmells, gateVerdict, parseVerdict } from '../detect.mjs';

const DETECT = fileURLToPath(new URL('../detect.mjs', import.meta.url));

// Boundaries are now CONFIG-driven (cfg.boundaries), not a hardcoded const — the pure helper takes
// them as its 2nd arg. A consumer opts into these via guard.config.json; the gate tests below write
// one. The default is [] (no boundaries → the cross-boundary smell never fires).
const BOUNDARIES = ['src/main/', 'socket-server/', 'vercel-serverless/'];

const entry = (o) => ({ status: 'M', path: 'x', added: 0, deleted: 0, depChanged: false, ...o });

describe('detectSmells', () => {
  it('flags a dependency change in package.json', () => {
    expect(
      detectSmells([entry({ status: 'M', path: 'package.json', depChanged: true })], BOUNDARIES),
    ).toContain('dep-change');
  });

  it('does not flag a package.json edit that left dependencies untouched', () => {
    expect(
      detectSmells([entry({ status: 'M', path: 'package.json', depChanged: false })], BOUNDARIES),
    ).toEqual([]);
  });

  it('flags a cross-trust-boundary change (≥2 boundaries)', () => {
    const s = detectSmells(
      [entry({ path: 'src/main/foo.ts' }), entry({ path: 'socket-server/src/bar.ts' })],
      BOUNDARIES,
    );
    expect(s).toContain('cross-boundary-move');
  });

  it('does NOT flag a cross-boundary change when boundaries are unconfigured (default [])', () => {
    // The parameterization invariant: with no configured boundaries the smell can never fire.
    expect(
      detectSmells([
        entry({ path: 'src/main/foo.ts' }),
        entry({ path: 'socket-server/src/bar.ts' }),
      ]),
    ).toEqual([]);
  });

  it('does not flag a single-boundary change', () => {
    expect(
      detectSmells(
        [entry({ path: 'src/main/foo.ts' }), entry({ path: 'src/main/baz.ts' })],
        BOUNDARIES,
      ),
    ).toEqual([]);
  });

  it('flags a large legacy deletion', () => {
    expect(
      detectSmells([entry({ status: 'D', path: 'src/old.ts', deleted: 240 })], BOUNDARIES),
    ).toContain('legacy-deletion');
  });

  it('does not flag a small deletion', () => {
    expect(
      detectSmells([entry({ status: 'D', path: 'src/old.ts', deleted: 12 })], BOUNDARIES),
    ).toEqual([]);
  });

  it('flags a module-replace (big delete + new file, same basename, different dir)', () => {
    const s = detectSmells(
      [
        entry({ status: 'D', path: 'src/lib/transport.ts', deleted: 80 }),
        entry({ status: 'A', path: 'src/net/transport.ts', added: 90 }),
      ],
      BOUNDARIES,
    );
    expect(s).toContain('module-replace');
  });

  it('ignores lockfile-only churn', () => {
    expect(
      detectSmells(
        [entry({ status: 'M', path: 'bun.lock', added: 200, deleted: 200 })],
        BOUNDARIES,
      ),
    ).toEqual([]);
    expect(
      detectSmells(
        [entry({ status: 'M', path: 'package-lock.json', added: 50, deleted: 50 })],
        BOUNDARIES,
      ),
    ).toEqual([]);
  });

  it('a package.json + lockfile dep bump still flags only via the real dep change', () => {
    const s = detectSmells(
      [
        entry({ status: 'M', path: 'package.json', depChanged: true }),
        entry({ status: 'M', path: 'bun.lock', added: 9, deleted: 3 }),
      ],
      BOUNDARIES,
    );
    expect(s).toEqual(['dep-change']);
  });
});

describe('gateVerdict', () => {
  const smells = ['dep-change'];
  it('blocks on a smell with no record and no bypass', () => {
    expect(gateVerdict({ bypass: false, decisionStaged: false, smells })).toBe(1);
  });
  it('passes when a decision is staged', () => {
    expect(gateVerdict({ bypass: false, decisionStaged: true, smells })).toBe(0);
  });
  it('passes on bypass (GUARD_NO_LOG)', () => {
    expect(gateVerdict({ bypass: true, decisionStaged: false, smells })).toBe(0);
  });
  it('passes when there are no smells', () => {
    expect(gateVerdict({ bypass: false, decisionStaged: false, smells: [] })).toBe(0);
  });
});

describe('parseVerdict', () => {
  it('clears on a confident ROUTINE (case/space-insensitive)', () => {
    expect(parseVerdict('routine\n')).toBe('ROUTINE');
  });
  it('returns DECISION on a confident DECISION', () => {
    expect(parseVerdict('DECISION')).toBe('DECISION');
  });
  it('never returns ROUTINE when both words appear (ambiguous → DECISION, block stands)', () => {
    const v = parseVerdict('This looks ROUTINE but is arguably a DECISION');
    expect(v).not.toBe('ROUTINE'); // the safety invariant: ambiguity can never clear a block
    expect(v).toBe('DECISION');
  });
  it('returns null on garbage or empty (→ regex block stands)', () => {
    expect(parseVerdict('maybe?')).toBeNull();
    expect(parseVerdict('')).toBeNull();
  });
});

// Exercises the git-reading wrappers (gatherEntries/decisionStaged) + dispatch that the pure
// tests above can't reach — a real staged diff in a throwaway repo. The gate resolves its config
// (decisionsDir, boundaries, noLog/noLlm) from the repo cwd, never the package dir (W-3).
describe('--gate (integration, real git repo)', () => {
  let repo;
  const git = (args) => execSync(`git ${args}`, { cwd: repo, encoding: 'utf8' });
  // GUARD_DECISION_NO_LLM forces the deterministic regex floor so tests never make a real,
  // non-deterministic `claude -p` call. The LLM path can only DOWNGRADE a block, so the floor
  // is exactly what these assertions verify.
  const gate = (env = {}) =>
    spawnSync('node', [DETECT, '--gate'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, GUARD_DECISION_NO_LLM: '1', ...env },
    }).status;
  const scan = (args = []) =>
    spawnSync('node', [DETECT, 'scan', ...args], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env },
    }).stdout.trim();

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'detect-'));
    git('init -q');
    git('config user.email t@t.t');
    git('config user.name t');
    writeFileSync(
      join(repo, 'package.json'),
      '{\n  "name": "x",\n  "dependencies": { "a": "1.0.0" }\n}\n',
    );
    writeFileSync(join(repo, 'keep.ts'), 'export const x = 1;\n');
    git('add .');
    git('commit -qm base');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('blocks (1) on a staged dependency change with no decision', () => {
    writeFileSync(
      join(repo, 'package.json'),
      '{\n  "name": "x",\n  "dependencies": { "a": "1.0.0", "b": "2.0.0" }\n}\n',
    );
    git('add package.json');
    expect(gate()).toBe(1);
  });

  it('passes (0) with GUARD_NO_LOG=1', () => {
    writeFileSync(
      join(repo, 'package.json'),
      '{\n  "name": "x",\n  "dependencies": { "a": "1.0.0", "b": "2.0.0" }\n}\n',
    );
    git('add package.json');
    expect(gate({ GUARD_NO_LOG: '1' })).toBe(0);
  });

  it('passes (0) with the legacy FRINK_NO_LOG=1 alias', () => {
    writeFileSync(
      join(repo, 'package.json'),
      '{\n  "name": "x",\n  "dependencies": { "a": "1.0.0", "b": "2.0.0" }\n}\n',
    );
    git('add package.json');
    expect(gate({ FRINK_NO_LOG: '1' })).toBe(0);
  });

  it('passes (0) when a decision record is staged alongside the smell', () => {
    writeFileSync(
      join(repo, 'package.json'),
      '{\n  "name": "x",\n  "dependencies": { "a": "1.0.0", "b": "2.0.0" }\n}\n',
    );
    mkdirSync(join(repo, 'docs', 'decisions'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'decisions', 'dep-x.md'), '# x\n');
    git('add .');
    expect(gate()).toBe(0);
  });

  it('passes (0) on lockfile-only churn', () => {
    writeFileSync(join(repo, 'bun.lock'), 'lockfile v2\n');
    git('add bun.lock');
    expect(gate()).toBe(0);
  });

  it('blocks (1) on a large legacy deletion', () => {
    writeFileSync(
      join(repo, 'big.ts'),
      Array.from({ length: 150 }, (_, i) => `line ${i}`).join('\n'),
    );
    git('add big.ts');
    git('commit -qm big');
    git('rm -q big.ts');
    expect(gate()).toBe(1);
  });

  it('scan --working sees an UNSTAGED smell that the staged scan misses (Stop-hook path)', () => {
    writeFileSync(
      join(repo, 'package.json'),
      '{\n  "name": "x",\n  "dependencies": { "a": "1.0.0", "b": "2.0.0" }\n}\n',
    );
    // deliberately NOT staged
    expect(scan()).toBe(''); // cached scan: nothing staged
    expect(scan(['--working'])).toContain('dep-change'); // working scan: sees the unstaged change
  });
});
