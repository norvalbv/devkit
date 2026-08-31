import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveGuardConfig } from '../../config.mts';
import { completenessJudgeSetup, runCompleteness } from '../completeness.mts';
import {
  cleanupReviewFixtures,
  consumerRepo,
  messageFile,
  mkExec,
  trackReviewFixtureDir,
} from './run-review-fixtures.mts';

const ENV_KEYS = ['DEVKIT_JUDGE_MCP_CONFIG', 'DEVKIT_SHIP_BRANCH', 'GUARD_AI_STRICT'] as const;
const saved: Record<string, string | undefined> = {};

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
});

function writeTrustedRegistry(file: string, version: string): void {
  writeFileSync(
    file,
    JSON.stringify({
      mcpServers: {
        codebase: { type: 'stdio', command: 'search-code', args: [version] },
        context7: { type: 'stdio', command: 'context7' },
        autonomous_bugs: { type: 'stdio', command: 'autonomous-bugs' },
      },
    }),
    { mode: 0o600 },
  );
}

describe('runCompleteness capability cache partition', () => {
  it('invalidates exact and sticky PASSes when the trusted MCP profile changes', async () => {
    const repo = consumerRepo({ backend: true });
    const configRoot = trackReviewFixtureDir(mkdtempSync(join(tmpdir(), 'completeness-mcp-')));
    const registry = join(configRoot, 'claude.json');
    process.env.DEVKIT_JUDGE_MCP_CONFIG = registry;
    process.env.DEVKIT_SHIP_BRANCH = 'feat/capability-cache';
    const exec = mkExec(async () => 'VERDICT: PASS');

    writeTrustedRegistry(registry, 'v1');
    expect(await runCompleteness(messageFile(repo, 'feat: capability cache'), repo, { exec })).toBe(
      0,
    );
    expect(exec).toHaveBeenCalledTimes(1);

    // New message misses sticky by itself; unchanged diff proves the exact key also includes profile.
    writeTrustedRegistry(registry, 'v2-with-different-definition');
    expect(
      await runCompleteness(messageFile(repo, 'feat: capability cache amended'), repo, { exec }),
    ).toBe(0);
    expect(exec).toHaveBeenCalledTimes(2);

    // New diff misses exact by itself; original message proves the sticky key also includes profile.
    writeFileSync(join(repo, 'src', 'main', 'db.ts'), 'export const q = 2;\n');
    execSync('git add src/main/db.ts', { cwd: repo });
    writeTrustedRegistry(registry, 'v3-with-another-definition');
    expect(await runCompleteness(messageFile(repo, 'feat: capability cache'), repo, { exec })).toBe(
      0,
    );
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it('does not cache a PASS prepared with capabilities different from its planned identity', async () => {
    const repo = consumerRepo({ backend: true });
    const configRoot = trackReviewFixtureDir(mkdtempSync(join(tmpdir(), 'completeness-mcp-race-')));
    const registry = join(configRoot, 'claude.json');
    process.env.DEVKIT_JUDGE_MCP_CONFIG = registry;
    writeTrustedRegistry(registry, 'planned-v1');
    const message = messageFile(repo, 'feat: capability race');

    expect(
      await runCompleteness(message, repo, {
        exec: async (options) => {
          writeTrustedRegistry(registry, 'prepared-v2-with-different-definition');
          options.onMcpPrepared?.(
            completenessJudgeSetup(resolveGuardConfig(repo), repo).capabilityFingerprint,
          );
          return 'VERDICT: PASS';
        },
      }),
    ).toBe(2);

    const stableExec = mkExec(async () => 'VERDICT: PASS');
    expect(await runCompleteness(message, repo, { exec: stableExec })).toBe(0);
    expect(stableExec).toHaveBeenCalledTimes(1);
  });
});
