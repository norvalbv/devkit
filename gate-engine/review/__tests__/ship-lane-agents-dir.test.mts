/** sc-1882: in a ship lane every brief reader takes the refreshed `.claude/agents` projection, never
 *  a custom `review.agentsDir`; outside it (even a leaked run mode) the configured dir rules. A brief
 *  missing from that directory resolves from the running package (review-gate-in-chain). */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type GuardConfig, resolveGuardConfig } from '../../config.mts';
import {
  isShipLane,
  reviewAgentsDir,
  SHIP_AGENTS_PROJECTION,
} from '../cascade/consumer-assets.mts';
import { runCompleteness } from '../completeness.mts';
import { REVIEWERS } from '../reviewers.mts';
import { runReviewGate } from '../run-review.mts';
import { consumerReviewerIdentity } from '../runtime.mts';
import {
  cleanupReviewFixtures,
  consumerRepo,
  messageFile,
  mkExec,
  packagedBriefLine,
  trackReviewFixtureDir,
  writeArtifact,
} from './run-review-fixtures.mts';

const ENV_KEYS = [
  'DEVKIT_RUN_MODE',
  'DEVKIT_SHIP_MODE',
  'DEVKIT_REVIEW_ASSET_ROOT',
  'GUARD_AI_STRICT',
  'GUARD_CORRECTNESS_SPLIT',
  'GUARD_REVIEW_ESCALATION_MODEL',
  'GUARD_CODEX_BIN',
  'DEVKIT_GATE_EVENTS',
  'DEVKIT_SHIP_ID',
  'DEVKIT_SHIP_BRANCH',
  'DEVKIT_COMMIT_MSG_FILE',
  'SHIP_COMMIT_TIMEOUT',
  'DEVKIT_GATE_DEADLINE_MS',
] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  // Same reason as run-review.test.mts: assert the undivided cascade, not the lens fan-out.
  process.env.GUARD_CORRECTNESS_SPLIT = 'off';
});

afterEach(() => {
  cleanupReviewFixtures();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.restoreAllMocks();
});

const enterShipLane = (mode: 'ship' | 'dry-gates' = 'ship'): void => {
  process.env.DEVKIT_RUN_MODE = mode;
  process.env.DEVKIT_SHIP_MODE = mode === 'ship' ? 'ship' : 'dry-gates';
};

/** Point the consumer's config at `agentsDir` and fill it with STALE briefs for every reviewer. */
function withStaleCustomAgents(repo: string, agentsDir: string): string {
  const configPath = join(repo, 'guard.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.review.agentsDir = agentsDir;
  writeFileSync(configPath, JSON.stringify(config));
  const abs = resolve(repo, agentsDir);
  mkdirSync(abs, { recursive: true });
  for (const name of [...REVIEWERS.map((r) => r.name), 'feature-completeness-reviewer'])
    writeFileSync(join(abs, `${name}.md`), `---\nname: ${name}\n---\nSTALE brief for ${name}.`);
  return abs;
}

describe('isShipLane + reviewAgentsDir', () => {
  const cwd = resolve('/repo');
  // A config dir with no guard.config.json resolves to the shipped defaults.
  const defaults = resolveGuardConfig(tmpdir());
  const cfg = (agentsDir: string): GuardConfig => ({
    ...defaults,
    review: { ...defaults.review, agentsDir },
  });
  const projection = resolve(cwd, SHIP_AGENTS_PROJECTION);

  it.each([
    ['relative', 'custom/agents'],
    ['absolute outside the repo', resolve('/elsewhere/agents')],
    ['the default', '.claude/agents'],
  ])('a real ship reads the projection whatever agentsDir says (%s)', (_label, dir) => {
    const env = { DEVKIT_RUN_MODE: 'ship', DEVKIT_SHIP_MODE: 'reship' };
    expect(reviewAgentsDir(cwd, cfg(dir), env)).toBe(projection);
  });

  it('ship --dry-gates is a ship lane too (the refresh runs before its branch)', () => {
    const env = { DEVKIT_RUN_MODE: 'dry-gates', DEVKIT_SHIP_MODE: 'dry-gates' };
    expect(isShipLane(env)).toBe(true);
    expect(reviewAgentsDir(cwd, cfg('custom/agents'), env)).toBe(projection);
  });

  it.each([
    ['a leaked DEVKIT_RUN_MODE=ship with no DEVKIT_SHIP_MODE', { DEVKIT_RUN_MODE: 'ship' }],
    ['an empty DEVKIT_SHIP_MODE', { DEVKIT_RUN_MODE: 'ship', DEVKIT_SHIP_MODE: '' }],
    ['review mode inheriting a ship tag', { DEVKIT_RUN_MODE: 'review', DEVKIT_SHIP_MODE: 'ship' }],
    ['DEVKIT_SHIP_MODE alone', { DEVKIT_SHIP_MODE: 'ship' }],
    ['a plain commit', {}],
  ])('%s keeps the configured directory', (_label, env) => {
    expect(isShipLane(env)).toBe(false);
    expect(reviewAgentsDir(cwd, cfg('custom/agents'), env)).toBe(resolve(cwd, 'custom/agents'));
    const abs = resolve('/elsewhere/agents');
    expect(reviewAgentsDir(cwd, cfg(abs), env)).toBe(abs);
  });
});

describe('runReviewGate — ship lane reads the refreshed projection', () => {
  it('judges on the projected brief, not a stale custom agentsDir copy', async () => {
    const repo = consumerRepo({ backend: true });
    withStaleCustomAgents(repo, 'custom/agents');
    enterShipLane();
    const prompts: string[] = [];
    const exec = mkExec(async ({ label, args }) => {
      prompts.push(args[1]);
      writeArtifact(repo, label);
      return 'VERDICT: PASS';
    });

    expect(await runReviewGate(repo, { exec })).toBe(0);
    const all = prompts.join('\n');
    expect(all).toContain('Brief for api-security-reviewer.');
    expect(all).not.toContain('STALE brief');
  });

  it('an absolute agentsDir outside the worktree is ignored in the ship lane', async () => {
    const repo = consumerRepo({ backend: true });
    const outside = trackReviewFixtureDir(mkdtempSync(join(tmpdir(), 'guard-outside-agents-')));
    withStaleCustomAgents(repo, outside);
    enterShipLane('dry-gates');
    const prompts: string[] = [];
    const exec = mkExec(async ({ label, args }) => {
      prompts.push(args[1]);
      writeArtifact(repo, label);
      return 'VERDICT: PASS';
    });

    expect(await runReviewGate(repo, { exec })).toBe(0);
    expect(prompts.join('\n')).not.toContain('STALE brief');
  });

  it('a leaked run mode without DEVKIT_SHIP_MODE still honours the configured agentsDir', async () => {
    const repo = consumerRepo({ backend: true });
    withStaleCustomAgents(repo, 'custom/agents');
    process.env.DEVKIT_RUN_MODE = 'ship';
    const prompts: string[] = [];
    const exec = mkExec(async ({ label, args }) => {
      prompts.push(args[1]);
      writeArtifact(repo, label);
      return 'VERDICT: PASS';
    });

    expect(await runReviewGate(repo, { exec })).toBe(0);
    expect(prompts.join('\n')).toContain('STALE brief for api-security-reviewer');
  });

  it('a brief missing from the projection resolves the running package, never the stale custom copy', async () => {
    const repo = consumerRepo({ backend: true });
    withStaleCustomAgents(repo, 'custom/agents');
    rmSync(join(repo, '.claude', 'agents', 'api-security-reviewer.md'));
    enterShipLane();
    process.env.GUARD_AI_STRICT = '1';
    const prompts: string[] = [];
    const exec = mkExec(async ({ label, args }) => {
      prompts.push(args[1]);
      writeArtifact(repo, label);
      return 'VERDICT: PASS';
    });

    expect(await runReviewGate(repo, { exec })).toBe(0);
    const all = prompts.join('\n');
    expect(all).toContain(packagedBriefLine('api-security-reviewer'));
    expect(all).not.toContain('STALE brief');
  });
});

describe('runCompleteness — ship lane reads the refreshed projection', () => {
  it('runs the judge on the projected brief when the custom agentsDir has none', async () => {
    const repo = consumerRepo({ backend: true });
    const configPath = join(repo, 'guard.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.review.agentsDir = 'nowhere/agents';
    writeFileSync(configPath, JSON.stringify(config));
    enterShipLane();
    const prompts: string[] = [];
    const exec = mkExec(async ({ args }) => {
      prompts.push(args[1]);
      return 'VERDICT: PASS';
    });

    expect(await runCompleteness(messageFile(repo, 'feat: ship lane'), repo, { exec })).toBe(0);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Brief for feature-completeness-reviewer.');
  });

  it('prefers the projection over a stale custom brief', async () => {
    const repo = consumerRepo({ backend: true });
    withStaleCustomAgents(repo, 'custom/agents');
    enterShipLane();
    const prompts: string[] = [];
    const exec = mkExec(async ({ args }) => {
      prompts.push(args[1]);
      return 'VERDICT: PASS';
    });

    expect(await runCompleteness(messageFile(repo, 'feat: stale'), repo, { exec })).toBe(0);
    expect(prompts[0]).not.toContain('STALE brief');
  });
});

describe('runCompleteness — a brief missing from the consumer directory', () => {
  it.each([
    ['a strict ship lane', true],
    ['a plain commit', false],
  ])('%s judges on the running package brief instead of skipping', async (_label, ship) => {
    const repo = consumerRepo({ backend: true });
    rmSync(join(repo, '.claude', 'agents', 'feature-completeness-reviewer.md'));
    if (ship) {
      enterShipLane();
      process.env.GUARD_AI_STRICT = '1';
    }
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      errors.push(a.map(String).join(' '));
    });
    const prompts: string[] = [];
    const exec = mkExec(async ({ args }) => {
      prompts.push(args[1]);
      return 'VERDICT: PASS';
    });

    expect(await runCompleteness(messageFile(repo, 'feat: unprojected'), repo, { exec })).toBe(0);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(packagedBriefLine('feature-completeness-reviewer'));
    expect(errors.join('\n')).not.toContain('completeness skipped');
  });
});

describe('consumerReviewerIdentity — ship lane hashes the bytes it judges', () => {
  it('moves with the projection and ignores byte edits in a custom agentsDir', () => {
    const repo = consumerRepo({ backend: true });
    const custom = withStaleCustomAgents(repo, 'custom/agents');
    enterShipLane();
    // Skill-less, so the fixture's missing checklist assets cannot null the identity out.
    const reviewer = REVIEWERS.find((r) => r.name === 'conventions-reviewer');
    if (!reviewer) throw new Error('conventions-reviewer is not registered');
    const identity = () => consumerReviewerIdentity(repo, resolveGuardConfig(repo), reviewer);

    const before = identity();
    expect(before).not.toBeNull();
    writeFileSync(join(custom, 'conventions-reviewer.md'), 'edited stale copy');
    expect(identity()).toBe(before);
    writeFileSync(join(repo, '.claude', 'agents', 'conventions-reviewer.md'), 'new package brief');
    expect(identity()).not.toBe(before);
  });
});
