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
});
