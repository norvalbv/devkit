import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetRunContextForTests,
  originatingAgent,
  runEnvelope,
  runId,
  telemetryEnabled,
  telemetrySink,
} from '../run-context.mts';

// The agent-fingerprint vars are cleared per test so `source` is deterministically 'unknown' here,
// regardless of the runner's own env (the test process itself runs under Claude Code = CLAUDECODE=1).
const ENV = [
  'DEVKIT_SHIP_ID',
  'DEVKIT_REVIEW_ID',
  'DEVKIT_REVIEW_REPO',
  'DEVKIT_REVIEW_BRANCH',
  'DEVKIT_GATE_EVENTS',
  'DEVKIT_NO_TELEMETRY',
  'CLAUDECODE',
  'CODEX_HOME',
  'CODEX_CLI_PATH',
];
const saved: Record<string, string | undefined> = {};
let origCwd: string;
const repos: string[] = [];

beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k]; // DEVKIT_NO_TELEMETRY unset → capture ON by default (the tested default)
  }
  origCwd = process.cwd();
  _resetRunContextForTests();
});
afterEach(() => {
  process.chdir(origCwd);
  while (repos.length) rmSync(repos.pop() as string, { recursive: true, force: true });
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  _resetRunContextForTests();
});

function gitRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'run-ctx-'));
  repos.push(repo);
  execSync('git init -q', { cwd: repo });
  execSync('git config user.email t@t.t', { cwd: repo });
  execSync('git config user.name t', { cwd: repo });
  writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n');
  execSync('git add .', { cwd: repo });
  return repo;
}

describe('run-context', () => {
  it('a ship: runId = DEVKIT_SHIP_ID, envelope carries only ship_id, sink = DEVKIT_GATE_EVENTS', () => {
    process.env.DEVKIT_SHIP_ID = 'ship-9';
    process.env.DEVKIT_GATE_EVENTS = '/tmp/x/gate-events.jsonl';
    expect(runId()).toBe('ship-9');
    expect(runEnvelope()).toEqual({ ship_id: 'ship-9', source: 'unknown' });
    expect(telemetrySink()).toBe('/tmp/x/gate-events.jsonl');
  });

  it('a review has an explicit review envelope and never masquerades as commit/ship', () => {
    process.env.DEVKIT_REVIEW_ID = 'review-9';
    process.env.DEVKIT_REVIEW_REPO = 'owners-web';
    process.env.DEVKIT_REVIEW_BRANCH = 'feature/pr';
    expect(runId()).toBe('review-9');
    expect(runEnvelope()).toEqual({
      ship_id: 'review-9',
      run_mode: 'review',
      repo: 'owners-web',
      branch: 'feature/pr',
      source: 'unknown',
    });
  });

  it('off-ship, capture ON by default: runId = commit-<write-tree>, envelope has run_mode/repo/branch', () => {
    const repo = gitRepo();
    process.chdir(repo);
    _resetRunContextForTests();
    expect(telemetryEnabled()).toBe(true); // default — no env needed
    const id = runId();
    expect(id).toMatch(/^commit-[0-9a-f]{40}$/);
    const env = runEnvelope();
    expect(env.ship_id).toBe(id);
    expect(env.run_mode).toBe('commit');
    expect(typeof env.repo).toBe('string');
    expect(typeof env.branch).toBe('string');
    expect(env.source).toBe('unknown'); // agent vars cleared → unknown
    expect(telemetrySink()).toMatch(/\.devkit[/\\]telemetry[/\\]gate-events\.jsonl$/);
  });

  it('off-ship, DEVKIT_NO_TELEMETRY=1: silent — runId null, empty envelope, no default sink', () => {
    process.env.DEVKIT_NO_TELEMETRY = '1';
    expect(telemetryEnabled()).toBe(false);
    expect(runId()).toBeNull();
    expect(runEnvelope()).toEqual({});
    expect(telemetrySink()).toBeUndefined();
  });

  it('the commit runId is STABLE for identical staged content (tree-hash based)', () => {
    const repo = gitRepo();
    process.chdir(repo);
    _resetRunContextForTests();
    const a = runId();
    _resetRunContextForTests(); // recompute from scratch → same staged tree → same id
    expect(runId()).toBe(a);
  });

  it('a ship id wins even with capture on (ship correlation is authoritative)', () => {
    const repo = gitRepo();
    process.chdir(repo);
    process.env.DEVKIT_SHIP_ID = 'ship-1';
    _resetRunContextForTests();
    expect(runId()).toBe('ship-1');
    expect(runEnvelope()).toEqual({ ship_id: 'ship-1', source: 'unknown' });
  });

  it('a ship id wins over a review id', () => {
    process.env.DEVKIT_SHIP_ID = 'ship-1';
    process.env.DEVKIT_REVIEW_ID = 'review-1';
    expect(runId()).toBe('ship-1');
    expect(runEnvelope()).toEqual({ ship_id: 'ship-1', source: 'unknown' });
  });

  it('capture on but not a git repo: fail-safe silent (runId null)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'not-git-'));
    repos.push(dir);
    process.chdir(dir);
    _resetRunContextForTests();
    expect(runId()).toBeNull();
    expect(runEnvelope()).toEqual({});
  });

  describe('originatingAgent (source fingerprint)', () => {
    it('CLAUDECODE truthy → claude, and rides the ship envelope', () => {
      process.env.CLAUDECODE = '1';
      process.env.DEVKIT_SHIP_ID = 'ship-c';
      expect(originatingAgent()).toBe('claude');
      expect(runEnvelope()).toEqual({ ship_id: 'ship-c', source: 'claude' });
    });

    it('CODEX_HOME (or CODEX_CLI_PATH) set, no CLAUDECODE → codex', () => {
      process.env.CODEX_HOME = '/Users/x/.codex';
      expect(originatingAgent()).toBe('codex');
      process.env.DEVKIT_SHIP_ID = 'ship-x';
      expect(runEnvelope()).toEqual({ ship_id: 'ship-x', source: 'codex' });
    });

    it('CLAUDECODE wins when both are present (Claude is the active agent)', () => {
      process.env.CLAUDECODE = '1';
      process.env.CODEX_HOME = '/Users/x/.codex';
      expect(originatingAgent()).toBe('claude');
    });

    it('neither present → unknown', () => {
      expect(originatingAgent()).toBe('unknown');
    });

    it('CLAUDECODE=0/empty is not truthy → not claude', () => {
      process.env.CLAUDECODE = '0';
      expect(originatingAgent()).toBe('unknown');
    });
  });
});
