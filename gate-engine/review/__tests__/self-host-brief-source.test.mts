/** In devkit's own repo the gate code runs from the tree it judges, so briefs and checklist skills
 *  come from that tree's `agents/` and `skills/`; a `.claude` projection can be stale. */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type GuardConfig, resolveGuardConfig } from '../../config.mts';
import {
  checklistAssetRoot,
  OWN_PACKAGE_ROOT,
  reviewBriefPath,
} from '../cascade/consumer-assets.mts';
import {
  allowedToolsFor,
  type ChecklistReviewer,
  checklistAssetPath,
  hasChecklist,
  REVIEWERS,
  wrapPrompt,
} from '../reviewers.mts';
import { agentBody, consumerReviewerIdentity, preflightReviewAssets } from '../runtime.mts';

const NAME = 'correctness-reviewer';
const STALE = 'STALE PROJECTION — a judge must never read this';
const REVIEWER = checklistReviewer(NAME);
const ENV_KEYS = ['DEVKIT_RUN_MODE', 'DEVKIT_SHIP_MODE'] as const;
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function checklistReviewer(name: string): ChecklistReviewer {
  const reviewer = REVIEWERS.find((r) => r.name === name);
  if (!reviewer || !hasChecklist(reviewer)) throw new Error(`${name} has no checklist`);
  return reviewer;
}

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function write(root: string, rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

/** devkit's own config, with the brief dir pointed at a tmp dir holding a stale brief. */
function selfHostWithStaleBriefDir(): GuardConfig {
  const staleDir = tmp('devkit-stale-agents-');
  write(staleDir, `${NAME}.md`, STALE);
  const cfg = resolveGuardConfig(OWN_PACKAGE_ROOT);
  return { ...cfg, review: { ...cfg.review, agentsDir: staleDir } };
}

const SOURCE_BRIEF = join(OWN_PACKAGE_ROOT, 'agents', `${NAME}.md`);

describe('self-host: the judged tree is the source', () => {
  it('a stale brief dir and a frozen asset root (review lane) never reach the judge', () => {
    const cfg = selfHostWithStaleBriefDir();
    const frozen = tmp('devkit-frozen-assets-');
    expect(reviewBriefPath(OWN_PACKAGE_ROOT, cfg, NAME, frozen)).toBe(SOURCE_BRIEF);
    expect(agentBody(OWN_PACKAGE_ROOT, cfg, NAME, frozen)).toBe(readFileSync(SOURCE_BRIEF, 'utf8'));
  });

  it('the ship lane reads agents/, not the worktree .claude/agents projection', () => {
    process.env.DEVKIT_RUN_MODE = 'ship';
    process.env.DEVKIT_SHIP_MODE = 'ship';
    const cfg = resolveGuardConfig(OWN_PACKAGE_ROOT);
    expect(reviewBriefPath(OWN_PACKAGE_ROOT, cfg, NAME)).toBe(SOURCE_BRIEF);
  });

  it('checklist skills run from a relative source root, never an absolute path', () => {
    const cfg = resolveGuardConfig(OWN_PACKAGE_ROOT);
    const root = checklistAssetRoot(OWN_PACKAGE_ROOT, REVIEWER, tmp('devkit-frozen-assets-'));
    expect(root).toBe('.');
    const script = `node ./${checklistAssetPath(REVIEWER)}`;
    const tools = allowedToolsFor(REVIEWER, cfg, root);
    const prompt = wrapPrompt('brief', REVIEWER, ['a.ts'], undefined, undefined, {}, root);
    expect(tools).toContain(`Bash(${script}:*)`);
    expect(prompt).toContain(script);
    expect(`${tools}\n${prompt}`).not.toContain(OWN_PACKAGE_ROOT);
  });

  it('review and commit modes stamp one identity, and stale projection bytes never enter it', () => {
    const cfg = selfHostWithStaleBriefDir();
    const frozen = tmp('devkit-frozen-assets-');
    mkdirSync(join(frozen, 'skills/_devkit'), { recursive: true });
    for (const helper of ['review-roots.mjs', 'checklist-store.mjs'])
      copyFileSync(
        join(OWN_PACKAGE_ROOT, 'skills/_devkit', helper),
        join(frozen, 'skills/_devkit', helper),
      );
    const selected = REVIEWERS.map((reviewer) => ({ reviewer, files: [] }));
    const reviewMode = preflightReviewAssets(OWN_PACKAGE_ROOT, frozen, selected, cfg);
    write(cfg.review.agentsDir, `${NAME}.md`, `${STALE}, rewritten`);
    for (const { reviewer } of selected)
      expect(consumerReviewerIdentity(OWN_PACKAGE_ROOT, cfg, reviewer)).toBe(
        reviewMode.get(reviewer.name),
      );
  });
});

describe('consumer repos keep the projection-wins rule', () => {
  it('a consumer brief and checklist under devkit names still win', () => {
    const consumer = tmp('devkit-consumer-');
    write(consumer, `.claude/agents/${NAME}.md`, 'consumer brief');
    write(consumer, `.claude/${checklistAssetPath(REVIEWER)}`, '');
    const cfg = resolveGuardConfig(consumer);
    expect(reviewBriefPath(consumer, cfg, NAME)).toBe(
      join(consumer, '.claude/agents', `${NAME}.md`),
    );
    expect(checklistAssetRoot(consumer, REVIEWER)).toBe('.claude');
  });

  it('an unresolvable cwd falls back to the packaged brief without throwing', () => {
    const missing = join(tmpdir(), 'devkit-sc4576-missing-cwd');
    const cfg = resolveGuardConfig(OWN_PACKAGE_ROOT);
    const packaged = tmp('devkit-packaged-');
    expect(reviewBriefPath(missing, cfg, NAME, packaged)).toBe(
      join(packaged, 'agents', `${NAME}.md`),
    );
    expect(checklistAssetRoot(missing, REVIEWER, packaged)).toBe(packaged);
  });
});
