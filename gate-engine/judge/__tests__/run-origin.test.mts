/** run_origin: hook-run gate entries mark 'gate', a bench claims 'bench' first, the envelope stamps
 * whichever was declared, and an on-demand check-alignment stays unmarked. */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emitGateEvent } from '../gate-events.mts';
import { isolateBenchTelemetry, markGateRun, runEnvelope } from '../run-context.mts';

const REPO = path.resolve(import.meta.dirname, '../../..');
const DECISIONS_CLI = path.join(REPO, 'gate-engine/decisions/cli.mts');
// Every gate-engine module the self-host pre-commit hook launches, with its arguments up to a quote.
const HOOK_ENTRY_RE = /node (gate-engine\/[\w/.-]+\.mts)([^"\n]*)/g;
const ENV = [
  'DEVKIT_RUN_ORIGIN',
  'DEVKIT_GATE_EVENTS',
  'DEVKIT_SHIP_ID',
  'DEVKIT_COMMIT_ID',
  'DEVKIT_REVIEW_ID',
  'DEVKIT_AGENT_RUN_ID',
  'DEVKIT_RUN_MODE',
  'DEVKIT_NO_TELEMETRY',
];
const saved: Record<string, string | undefined> = {};
const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** The fields these tests read off one sink line. */
interface SinkRow {
  type: string;
  ship_id?: string;
  run_origin?: string;
}

function rows(sink: string): SinkRow[] {
  if (!existsSync(sink)) return [];
  return readFileSync(sink, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line): SinkRow => JSON.parse(line));
}

beforeEach(() => {
  for (const key of ENV) saved[key] = process.env[key];
  delete process.env.DEVKIT_RUN_ORIGIN;
});
afterEach(() => {
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the envelope', () => {
  it('stamps a declared gate or bench origin and omits any other value', () => {
    process.env.DEVKIT_SHIP_ID = 'origin-ship';
    for (const [declared, stamped] of [
      ['gate', 'gate'],
      ['bench', 'bench'],
      ['hook', undefined],
      ['', undefined],
    ]) {
      process.env.DEVKIT_RUN_ORIGIN = declared;
      expect(runEnvelope().run_origin, declared).toBe(stamped);
    }
  });
});

describe('markGateRun', () => {
  it('returns its argument and marks only a gate run', () => {
    expect(markGateRun(false)).toBe(false);
    expect(process.env.DEVKIT_RUN_ORIGIN).toBeUndefined();
    expect(markGateRun(true)).toBe(true);
    expect(process.env.DEVKIT_RUN_ORIGIN).toBe('gate');
  });

  it('keeps an inherited bench origin', () => {
    process.env.DEVKIT_RUN_ORIGIN = 'bench';
    markGateRun();
    expect(process.env.DEVKIT_RUN_ORIGIN).toBe('bench');
  });
});

describe('isolateBenchTelemetry', () => {
  it('silences an inherited production sink; a re-opened private sink writes bench rows', () => {
    const dir = tempDir('run-origin-bench-');
    const production = path.join(dir, 'production.jsonl');
    process.env.DEVKIT_GATE_EVENTS = production;
    process.env.DEVKIT_SHIP_ID = 'outer-ship';
    isolateBenchTelemetry();
    expect(emitGateEvent({ type: 'probe' })).toBe('disabled');

    markGateRun(); // a gate CLI the bench launches
    const sink = path.join(dir, 'bench.jsonl');
    process.env.DEVKIT_GATE_EVENTS = sink;
    process.env.DEVKIT_SHIP_ID = 'bench-run';
    expect(emitGateEvent({ type: 'probe' })).toBe('written');
    expect(rows(sink)).toMatchObject([
      { type: 'probe', ship_id: 'bench-run', run_origin: 'bench' },
    ]);
    expect(existsSync(production)).toBe(false);
  });
});

describe('gate entries', () => {
  it('every hook-run gate-engine entry, and check-sentry, calls markGateRun', () => {
    const hook = readFileSync(path.join(REPO, '.husky/pre-commit'), 'utf8');
    const entries = [...hook.matchAll(HOOK_ENTRY_RE)]
      .filter(([, , args]) => /(?:^|\s)--(?:gate|hook)(?:\s|$)/.test(args))
      .map(([, file]) => file);
    // Pins the scan: losing one of today's entries means the pattern stopped matching the hook.
    expect(entries).toEqual(
      expect.arrayContaining([
        'gate-engine/deterministic/run.mts',
        'gate-engine/decisions/cli.mts',
        'gate-engine/review/cli.mts',
      ]),
    );
    for (const file of new Set([...entries, 'gate-engine/sentry/check-sentry.mts']))
      expect(readFileSync(path.join(REPO, file), 'utf8'), file).toMatch(/\bmarkGateRun\(/);
  });
});

describe('decisions gates, end to end', () => {
  let repo: string;
  let sink: string;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo });
  const cli = (args: string[], extra: Record<string, string> = {}) =>
    spawnSync(process.execPath, [DECISIONS_CLI, ...args], {
      cwd: repo,
      encoding: 'utf8',
      env: {
        ...process.env,
        DEVKIT_RUN_ORIGIN: undefined,
        DEVKIT_GATE_EVENTS: sink,
        DEVKIT_SHIP_ID: 'origin-e2e',
        GUARD_DECISIONS_DIR: path.join(repo, 'docs', 'decisions'),
        GUARD_AI_STRICT: '',
        FRINK_AI_STRICT: '',
        ...extra,
      },
    });

  beforeEach(() => {
    repo = tempDir('run-origin-repo-');
    sink = path.join(tempDir('run-origin-sink-'), 'gate-events.jsonl');
    git('init', '-q');
    mkdirSync(path.join(repo, 'docs', 'decisions'), { recursive: true });
    writeFileSync(
      path.join(repo, 'docs', 'decisions', 'ax.md'),
      '---\nslug: ax\ncreated: 2026-01-01\n---\n\n# ax\n\n## Target · 2026-01-01 — stay generic\n\n' +
        '**Context:** ax broke\n**Ruling:** stay generic\n**Consequences:**\n- Positive: v\n' +
        '- Negative: c\n**Vision-fit:** v\n**Scope:** src/**\n',
    );
    writeFileSync(path.join(repo, 'README.md'), 'base\n');
    git('add', '.');
    git('commit', '-qm', 'base');
  });

  it('detect --gate on a change with no smell writes a gate-marked gate_result', () => {
    writeFileSync(path.join(repo, 'notes.md'), 'routine\n');
    git('add', 'notes.md');
    const run = cli(['detect', '--gate']);
    expect(run.status, run.stderr).toBe(0);
    expect(rows(sink).filter((row) => row.type === 'gate_result')).toMatchObject([
      { gate: 'decisions', status: 'pass', ship_id: 'origin-e2e', run_origin: 'gate' },
    ]);
  });

  it('check-alignment --gate stays unmarked even when its judge runs', () => {
    const bin = tempDir('run-origin-bin-');
    writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\ncat >/dev/null\necho ALIGN\n');
    chmodSync(path.join(bin, 'claude'), 0o755);
    mkdirSync(path.join(repo, 'src'));
    writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
    git('add', 'src/a.ts');
    const run = cli(['check-alignment', '--gate'], {
      PATH: `${bin}:${process.env.PATH}`,
      GUARD_REVIEW_MODEL: 'haiku',
      GUARD_REVIEW_ESCALATION_MODEL: 'opus',
    });
    expect(run.status, run.stderr).toBe(0);
    const judged = rows(sink).filter((row) => row.type === 'judge_exec');
    expect(judged.length).toBeGreaterThan(0);
    for (const row of judged) {
      expect(row.ship_id).toBe('origin-e2e');
      expect(row).not.toHaveProperty('run_origin');
    }
  });
});
