import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completenessJudgeSetup, runCompleteness } from '../completeness.mts';
import { resolveGuardConfig } from '../../config.mts';
import { MCP_DEGRADED_REMEDY } from '../evidence/base-context.mts';
import {
  cleanupReviewFixtures,
  consumerRepo,
  messageFile,
  mkExec,
  trackReviewFixtureDir,
} from './run-review-fixtures.mts';

// sc-2837: completeness runs in its OWN process (backgrounded by the pre-commit hook), so it cannot
// lean on the reviewer fleet's warning — it must name itself and mark its own PASS.

const ENV_KEYS = [
  'GUARD_AI_STRICT',
  'GUARD_COMPLETENESS_HARD',
  'DEVKIT_GATE_EVENTS',
  'DEVKIT_SHIP_ID',
  'DEVKIT_SHIP_BRANCH',
  'DEVKIT_JUDGE_MCP_CONFIG',
] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
let sink = '';
let stderr: string[] = [];

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    if (key !== 'DEVKIT_JUDGE_MCP_CONFIG') delete process.env[key];
  }
  sink = join(trackReviewFixtureDir(mkdtempSync(join(tmpdir(), 'completeness-mcp-'))), 'ev.jsonl');
  process.env.DEVKIT_GATE_EVENTS = sink;
  process.env.DEVKIT_SHIP_ID = 'ship-2837-completeness';
  stderr = [];
  vi.spyOn(console, 'error').mockImplementation((...args) => {
    stderr.push(args.join(' '));
  });
});

afterEach(() => {
  cleanupReviewFixtures();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.restoreAllMocks();
});

function useRegistry(servers: readonly string[]): void {
  const dir = trackReviewFixtureDir(mkdtempSync(join(tmpdir(), 'completeness-mcp-registry-')));
  const file = join(dir, 'registry.json');
  writeFileSync(
    file,
    JSON.stringify({
      mcpServers: Object.fromEntries(servers.map((n) => [n, { type: 'stdio', command: `x-${n}` }])),
    }),
    { mode: 0o600 },
  );
  process.env.DEVKIT_JUDGE_MCP_CONFIG = file;
}

const events = (): { type?: string; judge?: string; cause?: string }[] =>
  readFileSync(sink, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

describe('completeness without the codebase MCP server (sc-2837)', () => {
  it('a live PASS reads DEGRADED, names itself in the fleet line, and emits gate_degraded', async () => {
    useRegistry(['context7', 'autonomous_bugs']);
    const repo = consumerRepo({ backend: true });
    const exec = mkExec(async () => 'VERDICT: PASS — nothing missing');
    expect(await runCompleteness(messageFile(repo, 'feat: x'), repo, { exec })).toBe(0);
    expect(stderr).toContainEqual(
      expect.stringMatching(/^guard-review: completeness — PASS \(DEGRADED\) — message /),
    );
    expect(stderr).toContainEqual(
      expect.stringMatching(/^⚠️ {2}guard-review: DEGRADED — no MCP codebase for completeness /),
    );
    expect(events().filter((e) => e.type === 'gate_degraded')).toEqual([
      expect.objectContaining({
        judge: 'completeness',
        cause: expect.stringMatching(/^MCP codebase/),
      }),
    ]);
  });

  it('the sticky replay stays DEGRADED with the remedy, and spawns no judge (so no fleet line)', async () => {
    useRegistry([]);
    const repo = consumerRepo({ backend: true });
    const msg = messageFile(repo, 'feat: sticky');
    await runCompleteness(msg, repo, { exec: mkExec(async () => 'VERDICT: PASS') });
    stderr.length = 0;
    const exec = mkExec(async () => 'VERDICT: PASS');
    expect(await runCompleteness(msg, repo, { exec })).toBe(0);
    expect(exec).not.toHaveBeenCalled();
    expect(stderr).toContainEqual(
      expect.stringMatching(/^guard-review: completeness — cached PASS \(DEGRADED\) \(same branch/),
    );
    expect(stderr.join('\n')).toContain(MCP_DEGRADED_REMEDY);
    expect(stderr.filter((l) => l.includes('no MCP'))).toEqual([]);
  });

  it('once codebase returns the capability-keyed cache misses and the PASS is re-judged clean', async () => {
    useRegistry(['context7']);
    const repo = consumerRepo({ backend: true });
    const msg = messageFile(repo, 'feat: recover');
    await runCompleteness(msg, repo, { exec: mkExec(async () => 'VERDICT: PASS') });
    useRegistry(['codebase', 'context7', 'autonomous_bugs']);
    stderr.length = 0;
    const exec = mkExec(async () => 'VERDICT: PASS');
    expect(await runCompleteness(msg, repo, { exec })).toBe(0);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(stderr.join('\n')).not.toContain('DEGRADED');
  });

  it('the spawn decides: its own cause degrades a clean run-level read, and is what gets cached', async () => {
    useRegistry(['codebase', 'context7', 'autonomous_bugs']);
    const repo = consumerRepo({ backend: true });
    const { capabilityFingerprint } = completenessJudgeSetup(resolveGuardConfig(repo), repo);
    const cause = 'MCP codebase unavailable (private MCP profile file could not be created) — x';
    const exec = mkExec(async ({ onMcpPrepared }) => {
      onMcpPrepared?.(capabilityFingerprint, cause);
      return 'VERDICT: PASS';
    });
    expect(await runCompleteness(messageFile(repo, 'feat: spawn'), repo, { exec })).toBe(0);
    expect(stderr).toContainEqual(
      expect.stringMatching(/^guard-review: completeness — PASS \(DEGRADED\) — message /),
    );
    expect(stderr).toContain(`⚠️  guard-review: completeness — DEGRADED: ${cause}`);
  });

  it('a private-config write failure changes the fingerprint yet reports PASS (DEGRADED), not SKIPPED', async () => {
    useRegistry(['codebase', 'context7', 'autonomous_bugs']);
    const repo = consumerRepo({ backend: true });
    const cause = 'MCP codebase unavailable (private MCP profile file could not be created) — x';
    const exec = mkExec(async ({ onMcpPrepared }) => {
      onMcpPrepared?.('empty-profile-fingerprint', cause);
      return 'VERDICT: PASS';
    });
    const msg = messageFile(repo, 'feat: tmp fail');
    expect(await runCompleteness(msg, repo, { exec })).toBe(0);
    expect(stderr.join('\n')).not.toContain('SKIPPED');
    expect(stderr).toContainEqual(
      expect.stringMatching(/^guard-review: completeness — PASS \(DEGRADED\) — message /),
    );
    // Never cached under the full-capability key: once codebase is back it must re-judge.
    const healthy = mkExec(async () => 'VERDICT: PASS');
    expect(await runCompleteness(msg, repo, { exec: healthy })).toBe(0);
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  it('a registry repaired before spawn: the clean PASS is accepted (not SKIPPED), but never cached', async () => {
    useRegistry(['context7']);
    const repo = consumerRepo({ backend: true });
    const msg = messageFile(repo, 'feat: repaired');
    const exec = mkExec(async ({ onMcpPrepared }) => {
      onMcpPrepared?.('repaired-full-fingerprint', undefined);
      return 'VERDICT: PASS';
    });
    expect(await runCompleteness(msg, repo, { exec })).toBe(0);
    expect(stderr.join('\n')).not.toContain('SKIPPED');
    expect(stderr.filter((l) => / — (PASS \(DEGRADED\)|DEGRADED: )/.test(l))).toEqual([]);
    const again = mkExec(async () => 'VERDICT: PASS');
    expect(await runCompleteness(msg, repo, { exec: again })).toBe(0);
    expect(again).toHaveBeenCalledTimes(1);
  });

  it('a capability change with NO degraded cause still SKIPs (an unexplained registry race)', async () => {
    useRegistry(['codebase', 'context7', 'autonomous_bugs']);
    const repo = consumerRepo({ backend: true });
    const exec = mkExec(async ({ onMcpPrepared }) => {
      onMcpPrepared?.('some-other-fingerprint', undefined);
      return 'VERDICT: PASS';
    });
    expect(await runCompleteness(messageFile(repo, 'feat: race'), repo, { exec })).toBe(2);
    expect(stderr.join('\n')).toContain('completeness SKIPPED (MCP capabilities changed');
  });

  it('the spawn decides: a clean spawn clears a degraded run-level read', async () => {
    useRegistry(['context7']);
    const repo = consumerRepo({ backend: true });
    const { capabilityFingerprint } = completenessJudgeSetup(resolveGuardConfig(repo), repo);
    const exec = mkExec(async ({ onMcpPrepared }) => {
      onMcpPrepared?.(capabilityFingerprint, undefined);
      return 'VERDICT: PASS';
    });
    expect(await runCompleteness(messageFile(repo, 'feat: clean spawn'), repo, { exec })).toBe(0);
    expect(stderr.filter((l) => / — (PASS \(DEGRADED\)|DEGRADED: )/.test(l))).toEqual([]);
  });

  it('a FAIL is never marked DEGRADED and still blocks', async () => {
    useRegistry([]);
    const repo = consumerRepo({ backend: true });
    const exec = mkExec(async () => 'VERDICT: FAIL — tests missing');
    expect(await runCompleteness(messageFile(repo, 'feat: gap'), repo, { exec })).toBe(1);
    expect(stderr.filter((l) => /completeness — .*DEGRADED/.test(l))).toEqual([]);
    expect(events().filter((e) => e.type === 'gate_degraded')).toEqual([]);
  });
});
