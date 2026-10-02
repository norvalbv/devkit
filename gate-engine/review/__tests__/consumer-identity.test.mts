/**
 * `consumerReviewerIdentity` is the prompt-version stamp the ordinary commit/ship path records on
 * its telemetry. Two properties make it worth anything, and both are asserted here:
 *
 *  1. It agrees with the packaged review-mode identity byte-for-byte. Without that, review-mode and
 *     ship-mode identities are two incomparable namespaces and every cross-mode rate is a blend.
 *  2. It never throws. It feeds telemetry, and telemetry must never fail a gate.
 */
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveGuardConfig } from '../../config.mts';
import { checklistAssetRoot, OWN_PACKAGE_ROOT } from '../cascade/consumer-assets.mts';
import {
  checklistAssetPath,
  hasChecklist,
  REVIEWERS,
  type Reviewer,
  type ReviewerSelection,
} from '../reviewers.mts';
import { consumerReviewerIdentity, preflightReviewAssets } from '../runtime.mts';

const ROOTS: string[] = [];
afterEach(() => {
  for (const r of ROOTS) rmSync(r, { recursive: true, force: true });
  ROOTS.length = 0;
});

const write = (root: string, rel: string, body: string): void => {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
};

/** Package-relative asset paths for one reviewer, mirroring runtime.mts's own contract. */
function assetPaths(reviewer: Reviewer): string[] {
  const paths = [`agents/${reviewer.name}.md`];
  if (hasChecklist(reviewer)) {
    paths.push(
      `skills/${reviewer.skill}/SKILL.md`,
      checklistAssetPath(reviewer),
      'skills/_devkit/review-roots.mjs',
      'skills/_devkit/checklist-store.mjs',
    );
    if (reviewer.skill === 'commit-guard')
      paths.push('skills/commit-guard/references/co-occurrence.md');
  }
  return paths;
}

/**
 * A consumer checkout holding the SAME bytes at its own locations: briefs under the default
 * `.claude/agents`, every skill asset under `.claude/` per devkit's sync convention. Identical
 * content at both layouts is exactly the case where the two identities must agree.
 */
function consumerFixture() {
  const root = mkdtempSync(join(tmpdir(), 'devkit-consumer-identity-'));
  const packaged = mkdtempSync(join(tmpdir(), 'devkit-packaged-identity-'));
  const bare = mkdtempSync(join(tmpdir(), 'devkit-bare-consumer-'));
  ROOTS.push(root, packaged, bare);
  writeFileSync(join(root, 'guard.config.json'), JSON.stringify({ scanRoots: ['src'] }));
  for (const reviewer of REVIEWERS) {
    for (const rel of assetPaths(reviewer)) {
      const body = `# ${rel}\ncontent for ${rel}\n`;
      write(packaged, rel, body);
      write(root, `.claude/${rel}`, body);
    }
  }
  return { root, packaged, bare };
}

const selectAll = (): ReviewerSelection[] =>
  REVIEWERS.map((reviewer) => ({ reviewer, files: ['src/example.ts'] }));

describe('consumerReviewerIdentity', () => {
  it('agrees with the packaged review-mode identity when the bytes match', () => {
    const { root, packaged, bare } = consumerFixture();
    const cfg = resolveGuardConfig(root);
    const packagedIdentities = preflightReviewAssets(bare, packaged, selectAll(), cfg);

    for (const reviewer of REVIEWERS) {
      expect(consumerReviewerIdentity(root, cfg, reviewer)).toBe(
        packagedIdentities.get(reviewer.name),
      );
    }
  });

  it('uses a provider-projected skill root for execution identity when Claude skills are absent', () => {
    const { root, packaged, bare } = consumerFixture();
    mkdirSync(join(root, '.agents'), { recursive: true });
    renameSync(join(root, '.claude/skills'), join(root, '.agents/skills'));
    const cfg = resolveGuardConfig(root);
    const packagedIdentities = preflightReviewAssets(bare, packaged, selectAll(), cfg);

    for (const reviewer of REVIEWERS) {
      if (hasChecklist(reviewer)) expect(checklistAssetRoot(root, reviewer)).toBe('.agents');
      expect(consumerReviewerIdentity(root, cfg, reviewer)).toBe(
        packagedIdentities.get(reviewer.name),
      );
    }
  });

  it('changes when the brief changes, and only for that reviewer', () => {
    const { root } = consumerFixture();
    const cfg = resolveGuardConfig(root);
    const [target, other] = REVIEWERS;
    const before = REVIEWERS.map((r) => consumerReviewerIdentity(root, cfg, r));

    write(root, `.claude/agents/${target.name}.md`, '# edited brief\nnew calibration rule\n');

    expect(consumerReviewerIdentity(root, cfg, target)).not.toBe(before[0]);
    expect(consumerReviewerIdentity(root, cfg, other)).toBe(before[1]);
  });

  it('changes the commit-guard identity when its heavy reference changes', () => {
    const { root } = consumerFixture();
    const cfg = resolveGuardConfig(root);
    const commitGuard = REVIEWERS.find((reviewer) => reviewer.skill === 'commit-guard');
    const other = REVIEWERS.find((reviewer) => reviewer.skill === 'backend-performance');
    expect(commitGuard).toBeDefined();
    expect(other).toBeDefined();
    const beforeCommitGuard = consumerReviewerIdentity(root, cfg, commitGuard as Reviewer);
    const beforeOther = consumerReviewerIdentity(root, cfg, other as Reviewer);

    write(
      root,
      '.claude/skills/commit-guard/references/co-occurrence.md',
      '# edited detector contract\n',
    );

    expect(consumerReviewerIdentity(root, cfg, commitGuard as Reviewer)).not.toBe(
      beforeCommitGuard,
    );
    expect(consumerReviewerIdentity(root, cfg, other as Reviewer)).toBe(beforeOther);
  });

  it('is stable across repeated calls on unchanged assets', () => {
    const { root } = consumerFixture();
    const cfg = resolveGuardConfig(root);
    const [reviewer] = REVIEWERS;
    expect(consumerReviewerIdentity(root, cfg, reviewer)).toBe(
      consumerReviewerIdentity(root, cfg, reviewer),
    );
  });

  it('returns null instead of throwing when an asset is unreadable', () => {
    const { root } = consumerFixture();
    const cfg = resolveGuardConfig(root);
    const [reviewer] = REVIEWERS;
    rmSync(join(root, `.claude/agents/${reviewer.name}.md`), { force: true });
    mkdirSync(join(root, `.claude/agents/${reviewer.name}.md`));

    expect(consumerReviewerIdentity(root, cfg, reviewer)).toBeNull();
  });

  it('resolves a bare checkout from the running package, with the same identity review mode gets', () => {
    const { bare } = consumerFixture();
    const cfg = resolveGuardConfig(bare);
    const reviewMode = preflightReviewAssets(bare, OWN_PACKAGE_ROOT, selectAll(), cfg);
    for (const reviewer of REVIEWERS) {
      if (hasChecklist(reviewer)) {
        expect(checklistAssetRoot(bare, reviewer)).toBe(OWN_PACKAGE_ROOT);
        expect(existsSync(join(OWN_PACKAGE_ROOT, checklistAssetPath(reviewer)))).toBe(true);
      }
      expect(consumerReviewerIdentity(bare, cfg, reviewer)).toBe(reviewMode.get(reviewer.name));
    }
  });
});
