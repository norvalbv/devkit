import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCache } from '../cache.mts';
import { runCompleteness } from '../completeness.mts';
import {
  cleanupReviewFixtures,
  consumerRepo,
  messageFile,
  mkExec,
} from './run-review-fixtures.mts';

const ENV_KEYS = [
  'GUARD_AI_STRICT',
  'GUARD_REVIEW_ESCALATION_MODEL',
  'GUARD_CODEX_BIN',
  'DEVKIT_GATE_EVENTS',
  'DEVKIT_SHIP_ID',
  'DEVKIT_SHIP_BRANCH',
] as const;

const saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  cleanupReviewFixtures();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.restoreAllMocks();
});

describe('runCompleteness — configured strong-model routing', () => {
  it('uses Sol read-only by default and carries the full prompt', async () => {
    const repo = consumerRepo({ backend: true });
    delete process.env.GUARD_REVIEW_ESCALATION_MODEL;
    let captured: {
      args: string[];
      codexReadOnly?: boolean;
    };
    const exec = mkExec(async (opts) => {
      captured = opts;
      return 'VERDICT: PASS';
    });

    expect(await runCompleteness(messageFile(repo, 'feat: add db layer'), repo, { exec })).toBe(0);
    expect(captured.args[1]).toContain('feat: add db layer');
    expect(captured.args[1]).toContain('RELEVANT RECORDED TARGETS');
    expect(captured.args[1]).toContain('Brief for feature-completeness-reviewer.');
    expect(captured.args).toContain('gpt-5.6-sol');
    expect(captured.codexReadOnly).toBe(true);
  });

  it('keeps explicit file and environment escalation models on Opus', async () => {
    const fileRepo = consumerRepo({ backend: true });
    delete process.env.GUARD_REVIEW_ESCALATION_MODEL;
    const configPath = join(fileRepo, 'guard.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.review.escalationModel = 'opus';
    writeFileSync(configPath, JSON.stringify(config));
    let fileArgs: string[] = [];
    expect(
      await runCompleteness(messageFile(fileRepo, 'feat: file model'), fileRepo, {
        exec: mkExec(async (opts) => {
          fileArgs = opts.args;
          return 'VERDICT: PASS';
        }),
      }),
    ).toBe(0);
    expect(fileArgs).toContain('opus');

    const envRepo = consumerRepo({ backend: true });
    process.env.GUARD_REVIEW_ESCALATION_MODEL = 'opus';
    let envArgs: string[] = [];
    expect(
      await runCompleteness(messageFile(envRepo, 'feat: env model'), envRepo, {
        exec: mkExec(async (opts) => {
          envArgs = opts.args;
          return 'VERDICT: PASS';
        }),
      }),
    ).toBe(0);
    expect(envArgs).toContain('opus');
  });

  it('reports the selected model on a sticky cache hit', async () => {
    const repo = consumerRepo({ backend: true });
    delete process.env.GUARD_REVIEW_ESCALATION_MODEL;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exec = mkExec(async () => 'VERDICT: PASS');
    expect(await runCompleteness(messageFile(repo, 'feat: add db layer'), repo, { exec })).toBe(0);
    expect(Object.values(loadCache(repo)).map((entry) => entry.model)).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-sol',
    ]);

    const sink = join(repo, 'events.jsonl');
    process.env.DEVKIT_GATE_EVENTS = sink;
    process.env.DEVKIT_SHIP_ID = 'ship-sticky';
    writeFileSync(join(repo, 'src', 'main', 'db.ts'), 'export const q = 9;\n');
    execSync('git add .', { cwd: repo });
    expect(await runCompleteness(messageFile(repo, 'feat: add db layer'), repo, { exec })).toBe(0);
    const events = readFileSync(sink, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events.find((event) => event.type === 'cache_hit')).toMatchObject({
      judge: 'review:completeness',
      model: 'gpt-5.6-sol',
    });
    expect(events.find((event) => event.type === 'gate_timing')).toMatchObject({
      gate: 'completeness',
      cache_state: 'full',
    });
  });

  it('points a strict default-Sol outage at Codex rather than Claude', async () => {
    const repo = consumerRepo({ backend: true });
    delete process.env.GUARD_REVIEW_ESCALATION_MODEL;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.GUARD_AI_STRICT = '1';
    expect(
      await runCompleteness(messageFile(repo, 'feat: x'), repo, {
        exec: mkExec(async () => null),
      }),
    ).toBe(3);
    const output = err.mock.calls.flat().join('\n');
    expect(output).toContain('check `codex` CLI auth/quota');
    expect(output).not.toContain('check `claude` CLI auth/quota');
  });

  it('misses both PASS identities after a completeness model change', async () => {
    const exactRepo = consumerRepo({ backend: true });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.GUARD_REVIEW_ESCALATION_MODEL = 'opus';
    const exactExec = mkExec(async () => 'VERDICT: PASS');
    expect(
      await runCompleteness(messageFile(exactRepo, 'feat: exact'), exactRepo, { exec: exactExec }),
    ).toBe(0);
    process.env.GUARD_REVIEW_ESCALATION_MODEL = 'gpt-5.6-sol';
    expect(
      await runCompleteness(messageFile(exactRepo, 'feat: exact'), exactRepo, { exec: exactExec }),
    ).toBe(0);
    expect(exactExec).toHaveBeenCalledTimes(2);

    const stickyRepo = consumerRepo({ backend: true });
    process.env.GUARD_REVIEW_ESCALATION_MODEL = 'opus';
    const stickyExec = mkExec(async () => 'VERDICT: PASS');
    expect(
      await runCompleteness(messageFile(stickyRepo, 'feat: sticky'), stickyRepo, {
        exec: stickyExec,
      }),
    ).toBe(0);
    writeFileSync(join(stickyRepo, 'src', 'main', 'db.ts'), 'export const q = 99;\n');
    execSync('git add .', { cwd: stickyRepo });
    process.env.GUARD_REVIEW_ESCALATION_MODEL = 'gpt-5.6-sol';
    expect(
      await runCompleteness(messageFile(stickyRepo, 'feat: sticky'), stickyRepo, {
        exec: stickyExec,
      }),
    ).toBe(0);
    expect(stickyExec).toHaveBeenCalledTimes(2);
  });
});
