import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runReviewGate } from '../run-review.mts';
import { cleanupReviewFixtures, consumerRepo, passWithArtifact } from './run-review-fixtures.mts';

const strictEnvKeys = ['GUARD_AI_STRICT', 'FRINK_AI_STRICT'] as const;
const savedEnv: Partial<Record<(typeof strictEnvKeys)[number], string | undefined>> = {};

beforeEach(() => {
  for (const key of strictEnvKeys) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  cleanupReviewFixtures();
  for (const key of strictEnvKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.restoreAllMocks();
});

describe('conventions evidence completeness', () => {
  const cappedRepo = () => {
    const repo = consumerRepo();
    mkdirSync(join(repo, 'src'), { recursive: true });
    for (let index = 0; index < 93; index += 1)
      writeFileSync(
        join(repo, 'src', `config-${index}.json`),
        `${JSON.stringify({ value: 'x'.repeat(9_000) })}\n`,
      );
    execSync('git add .', { cwd: repo });
    return repo;
  };

  const unsubstantiatedFail = () =>
    vi.fn(
      async () =>
        'NO_VIOLATIONS in the visible code.\n' +
        '69 OMITTED and 3 TRUNCATED segments prevent a complete review.\n' +
        'VERDICT: FAIL — incomplete evidence',
    );

  it('directs the no-Bash reviewer to read omitted in-scope files before it passes', async () => {
    const repo = consumerRepo();
    mkdirSync(join(repo, 'src'), { recursive: true });
    const files = Array.from({ length: 8 }, (_, index) => `src/config-${index}.json`);
    for (const file of files)
      writeFileSync(join(repo, file), `${JSON.stringify({ value: 'x'.repeat(9_000) })}\n`);
    execSync('git add .', { cwd: repo });

    const exec = passWithArtifact(repo);
    expect(await runReviewGate(repo, { exec })).toBe(0);
    expect(exec).toHaveBeenCalledOnce();
    const [call] = exec.mock.calls[0];
    expect(call.label).toBe('review:conventions-reviewer');
    expect(call.input).toContain('OMITTED');
    expect(call.args).toContain(
      'Read,Grep,Glob,mcp__codebase__*,mcp__context7__*,mcp__autonomous_bugs__*',
    );
    expect(call.args[1]).toContain('use Read to inspect every available in-scope staged file');
    expect(call.args[1]).toContain('must not produce a semantic FAIL');
  });

  it('directs the reviewer to read a capped governing rule instead of blocking the commit', async () => {
    const repo = consumerRepo();
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'CLAUDE.md'), `Rule: ${'x'.repeat(70_000)}\n`);
    writeFileSync(join(repo, 'src', 'config.json'), '{ "flag": false }\n');
    execSync('git add .', { cwd: repo });
    const exec = passWithArtifact(repo);

    expect(await runReviewGate(repo, { exec })).toBe(0);
    expect(exec).toHaveBeenCalledOnce();
    const [call] = exec.mock.calls[0];
    expect(call.args[1]).toContain('[TRUNCATED: CLAUDE.md');
    expect(call.args[1]).toContain('use Read to inspect every named rule file');
    expect(call.args[1]).toContain('Never treat incomplete evidence alone as a violation');
  });

  it('keeps a complete line-range finding blocking', async () => {
    const repo = consumerRepo();
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'CLAUDE.md'), 'Every config must set flag true.\n');
    writeFileSync(join(repo, 'src', 'config.json'), '{ "flag": false }\n');
    execSync('git add .', { cwd: repo });
    const exec = vi.fn(
      async () =>
        'VIOLATION:\n' +
        'OFFENDING: labels in quoted rule text\n' +
        '— CLAUDE.md:1-2\n' +
        'OFFENDING:\n' +
        'VERDICT: FAIL\n' +
        '— src/config.json:1–2\n' +
        'VERDICT: FAIL — cited violation',
    );
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await runReviewGate(repo, { exec })).toBe(1);
    expect(err.mock.calls.flat().join('\n')).toContain('conventions-reviewer FAILED');
    expect(err.mock.calls.flat().join('\n')).not.toContain('unsubstantiated conventions FAIL');
  });

  it('an unsubstantiated FAIL over a 93-file capped diff is inconclusive, not a rule violation', async () => {
    const repo = cappedRepo();
    const exec = unsubstantiatedFail();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await runReviewGate(repo, { exec })).toBe(2);
    expect(exec).toHaveBeenCalledOnce();
    expect(exec.mock.calls[0][0].input).toContain('OMITTED');
    expect(exec.mock.calls[0][0].input).toContain('TRUNCATED');
    expect(err.mock.calls.flat().join('\n')).toContain('unsubstantiated conventions FAIL');
    expect(err.mock.calls.flat().join('\n')).not.toContain('conventions-reviewer FAILED');
  });

  it('strict ship mode fail-closes an unsubstantiated FAIL as exit 3, never exit 1', async () => {
    process.env.GUARD_AI_STRICT = '1';
    const repo = cappedRepo();
    const exec = unsubstantiatedFail();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await runReviewGate(repo, { exec })).toBe(3);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(err.mock.calls.flat().join('\n')).toContain('INCONCLUSIVE');
    expect(err.mock.calls.flat().join('\n')).toContain('retrying once');
    expect(err.mock.calls.flat().join('\n')).toContain('strict ship mode fails closed');
    expect(err.mock.calls.flat().join('\n')).toContain('complete cited VIOLATION/OFFENDING pair');
    expect(err.mock.calls.flat().join('\n')).toContain('69 OMITTED and 3 TRUNCATED');
    expect(err.mock.calls.flat().join('\n')).not.toContain('auth/quota');
    expect(err.mock.calls.flat().join('\n')).not.toContain('conventions-reviewer FAILED');
  });

  it('strict mode blocks when the one evidence retry returns a complete finding', async () => {
    process.env.GUARD_AI_STRICT = '1';
    const repo = cappedRepo();
    const exec = vi
      .fn()
      .mockResolvedValueOnce('VERDICT: FAIL — incomplete evidence')
      .mockResolvedValueOnce(
        'VIOLATION: Every config must set flag true. — CLAUDE.md:1\n' +
          'OFFENDING: { "flag": false } — src/config-0.json:1\n' +
          'VERDICT: FAIL — cited violation',
      );
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await runReviewGate(repo, { exec })).toBe(1);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(err.mock.calls.flat().join('\n')).toContain('conventions-reviewer FAILED');
    expect(err.mock.calls.flat().join('\n')).not.toContain('INCONCLUSIVE');
  });

  it('strict mode classifies an evidence-retry outage as an outage', async () => {
    process.env.GUARD_AI_STRICT = '1';
    const repo = cappedRepo();
    const exec = vi
      .fn()
      .mockResolvedValueOnce('VERDICT: FAIL — incomplete evidence')
      .mockImplementationOnce(async (opts) => {
        opts.onOutage?.('transient');
        return null;
      });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await runReviewGate(repo, { exec })).toBe(3);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(err.mock.calls.flat().join('\n')).toContain('auth/quota');
    expect(err.mock.calls.flat().join('\n')).not.toContain(
      'complete cited VIOLATION/OFFENDING pair',
    );
  });

  it('strict mode caps outage recovery plus evidence validation at two judge calls', async () => {
    process.env.GUARD_AI_STRICT = '1';
    const repo = cappedRepo();
    const exec = vi
      .fn()
      .mockImplementationOnce(async (opts) => {
        opts.onOutage?.('transient');
        return null;
      })
      .mockResolvedValueOnce('VERDICT: FAIL — incomplete evidence');

    expect(await runReviewGate(repo, { exec })).toBe(3);
    expect(exec).toHaveBeenCalledTimes(2);
  });
});
