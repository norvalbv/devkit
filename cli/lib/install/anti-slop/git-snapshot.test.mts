import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { digest } from '../../fs-helpers.mts';
import {
  ANTI_SLOP_DEVKIT_RULE_IDS,
  ANTI_SLOP_RULE_IDS,
  ANTI_SLOP_UPSTREAM,
  ANTI_SLOP_UPSTREAM_RULE_IDS,
  antiSlopBaselineMigrationId,
} from './constants.mts';
import {
  gitBaselineEnvelope,
  withBaseAntiSlopSnapshot,
  withStagedAntiSlopSnapshot,
} from './git-snapshot.mts';

const roots: string[] = [];
const EMPTY_BASELINE = `${JSON.stringify(
  { schemaVersion: 1, upstreamCommit: ANTI_SLOP_UPSTREAM, entries: [] },
  null,
  2,
)}\n`;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function repository(withCommit = true): string {
  const root = mkdtempSync(join(tmpdir(), 'anti-slop-git-snapshot-'));
  roots.push(root);
  git(root, ['init', '-q']);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, '.anti-slop-baseline.json'), EMPTY_BASELINE);
  writeFileSync(join(root, 'src', 'file.ts'), 'export const value = "base";\n');
  git(root, ['add', '-A']);
  if (withCommit) {
    git(root, [
      '-c',
      'user.name=Devkit test',
      '-c',
      'user.email=devkit@test.invalid',
      'commit',
      '-qm',
      'base',
    ]);
  }
  return root;
}

interface ManagedEvidence {
  config: string;
  manifest: string;
}

function managedEvidence(
  rules: Record<string, string>,
  ruleIds = Object.keys(rules),
): ManagedEvidence {
  const config = `${JSON.stringify({ rules })}\n`;
  const manifest = `${JSON.stringify({
    schemaVersion: 1,
    devkitVersion: '0.59.0',
    configDigest: digest(config),
    ruleIds,
  })}\n`;
  return { config, manifest };
}

function managedRules(activeRuleIds: readonly string[]): Record<string, string> {
  const active = new Set(activeRuleIds);
  return Object.fromEntries(
    ANTI_SLOP_RULE_IDS.map((ruleId) => [ruleId, active.has(ruleId) ? 'error' : 'off']),
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('anti-slop staged Git snapshot', () => {
  it('reads staged bytes even when the working tree contains different bytes', () => {
    const root = repository();
    writeFileSync(join(root, 'src', 'file.ts'), 'export const value = "staged";\n');
    git(root, ['add', 'src/file.ts']);
    writeFileSync(join(root, 'src', 'file.ts'), 'export const value = "working";\n');

    withStagedAntiSlopSnapshot(root, (snapshot) => {
      expect(snapshot.paths).toEqual(['src/file.ts']);
      expect(readFileSync(join(snapshot.cwd, 'src', 'file.ts'), 'utf8')).toContain('"staged"');
      expect(snapshot.base?.entries).toEqual([]);
    });
  });

  // The DEFAULT must judge the exact index and nothing else; adopting the working-tree capability
  // would break that SILENTLY (`bytesOk` still passes), so assert the negative.
  it('does not inject the working-tree capability into the snapshot by default', () => {
    const root = repository();
    mkdirSync(join(root, '.devkit', 'anti-slop'), { recursive: true });
    writeFileSync(join(root, '.devkit', 'anti-slop', 'marker.json'), '{"from":"working tree"}\n');
    writeFileSync(join(root, 'oxlint.devkit.json'), '{"from":"working tree"}\n');
    writeFileSync(join(root, 'src', 'file.ts'), 'export const value = "staged";\n');
    git(root, ['add', 'src/file.ts']);

    withStagedAntiSlopSnapshot(root, (snapshot) => {
      expect(existsSync(join(snapshot.cwd, '.devkit', 'anti-slop', 'marker.json'))).toBe(false);
      expect(existsSync(join(snapshot.cwd, 'oxlint.devkit.json'))).toBe(false);
    });
  });

  it('injects the git-excluded capability and baseline when told the install is an overlay', () => {
    const root = repository();
    mkdirSync(join(root, '.devkit', 'anti-slop'), { recursive: true });
    mkdirSync(join(root, '.devkit', 'oxc'), { recursive: true });
    writeFileSync(join(root, '.devkit', 'anti-slop', 'marker.json'), '{"from":"overlay"}\n');
    writeFileSync(join(root, '.devkit', 'oxc', 'marker.json'), '{"from":"overlay"}\n');
    writeFileSync(join(root, 'oxlint.devkit.json'), '{"from":"overlay"}\n');
    // `repository()` COMMITTED a baseline, so an existence check would pass even if nothing copied.
    // Distinct working-tree bytes are the only assertion that proves the cpSync actually ran.
    const workingTreeBaseline = `${JSON.stringify({ version: 1, findings: { 'src/file.ts': 7 } })}\n`;
    writeFileSync(join(root, '.anti-slop-baseline.json'), workingTreeBaseline);
    writeFileSync(join(root, 'src', 'file.ts'), 'export const value = "staged";\n');
    git(root, ['add', 'src/file.ts']);

    withStagedAntiSlopSnapshot(
      root,
      (snapshot) => {
        expect(existsSync(join(snapshot.cwd, '.devkit', 'anti-slop', 'marker.json'))).toBe(true);
        expect(existsSync(join(snapshot.cwd, '.devkit', 'oxc', 'marker.json'))).toBe(true);
        expect(existsSync(join(snapshot.cwd, 'oxlint.devkit.json'))).toBe(true);
        // The baseline has to arrive too, or `baselineOrExplain` exits 2 and the gate BLOCKS — and
        // it must be the WORKING-TREE one, not the committed bytes the extraction already carries.
        expect(readFileSync(join(snapshot.cwd, '.anti-slop-baseline.json'), 'utf8')).toBe(
          workingTreeBaseline,
        );
      },
      { overlay: true },
    );
  });

  it('forces a full scan for baseline, root config, or managed capability changes', () => {
    const root = repository();
    writeFileSync(join(root, '.anti-slop-baseline.json'), `${EMPTY_BASELINE.trim()}\n\n`);
    git(root, ['add', '.anti-slop-baseline.json']);

    withStagedAntiSlopSnapshot(root, (snapshot) => {
      expect(snapshot.fullScan).toBe(true);
      expect(snapshot.paths).toEqual([]);
      expect(snapshot.skipped).toBe(false);
    });
  });

  it.each(['.oxlintrc.json', '.oxlintrc.jsonc', 'oxlint.config.ts', 'oxlint.config.mts'])(
    'forces a full scan when the recognized root config %s changes',
    (config) => {
      const root = repository();
      writeFileSync(join(root, config), '{}\n');
      git(root, ['add', config]);

      withStagedAntiSlopSnapshot(root, (snapshot) => {
        expect(snapshot.changedFiles).toContain(config);
        expect(snapshot.fullScan).toBe(true);
        expect(snapshot.paths).toEqual([]);
        expect(snapshot.skipped).toBe(false);
      });
    },
  );

  it('preserves spaces and newlines in staged source paths', () => {
    const root = repository();
    const names = ['src/space file.ts', 'src/line\nbreak.ts'];
    for (const name of names) writeFileSync(join(root, name), 'export const added = true;\n');
    git(root, ['add', ...names]);

    withStagedAntiSlopSnapshot(root, (snapshot) => {
      expect(new Set(snapshot.paths)).toEqual(new Set(names));
    });
  });

  it('scopes a monorepo package and ignores staged siblings', () => {
    const root = repository();
    const app = join(root, 'packages', 'app');
    mkdirSync(join(app, 'src'), { recursive: true });
    writeFileSync(join(app, '.anti-slop-baseline.json'), EMPTY_BASELINE);
    writeFileSync(join(app, 'src', 'inside.ts'), 'export const inside = 1;\n');
    writeFileSync(join(root, 'src', 'outside.ts'), 'export const outside = 1;\n');
    git(root, ['add', '-A']);

    withStagedAntiSlopSnapshot(app, (snapshot) => {
      expect(snapshot.paths).toEqual([]);
      expect(snapshot.changedFiles).toEqual(['.anti-slop-baseline.json', 'src/inside.ts']);
      expect(snapshot.fullScan).toBe(true);
    });
  });

  it('supports an initial commit and records exact renames', () => {
    const initial = repository(false);
    withStagedAntiSlopSnapshot(initial, (snapshot) => {
      expect(snapshot.base).toBeNull();
      expect(snapshot.fullScan).toBe(true);
    });

    const renamed = repository();
    git(renamed, ['mv', 'src/file.ts', 'src/renamed.ts']);
    withStagedAntiSlopSnapshot(renamed, (snapshot) => {
      expect(snapshot.renames.get('src/file.ts')).toBe('src/renamed.ts');
      expect(snapshot.paths).toEqual(['src/renamed.ts']);
    });
  });

  it('materializes selected files from the exact base tree and omits candidate-only paths', () => {
    const root = repository();
    const base = git(root, ['rev-parse', 'HEAD']);
    writeFileSync(join(root, 'src', 'file.ts'), 'export const value = "candidate";\n');
    writeFileSync(join(root, 'src', 'candidate.ts'), 'export const candidate = true;\n');
    git(root, ['add', '-A']);
    const envelope = gitBaselineEnvelope(root, base);
    expect(envelope.introducedPaths).toEqual(new Set(['src/candidate.ts']));

    withBaseAntiSlopSnapshot(
      root,
      root,
      envelope.baseTree,
      ['src/file.ts', 'src/candidate.ts'],
      (snapshot) => {
        expect(snapshot.paths).toEqual(['src/file.ts']);
        expect(readFileSync(join(snapshot.cwd, 'src', 'file.ts'), 'utf8')).toContain('"base"');
      },
    );
  });

  it('identifies rule IDs enabled by the staged managed capability', () => {
    const root = repository();
    const manifestPath = join(root, '.devkit', 'anti-slop', 'manifest.json');
    mkdirSync(join(root, '.devkit', 'anti-slop'), { recursive: true });
    const configPath = join(root, '.devkit', 'anti-slop', 'oxlint.json');
    const baseEvidence = managedEvidence(
      Object.fromEntries(ANTI_SLOP_UPSTREAM_RULE_IDS.map((ruleId) => [ruleId, 'error'])),
      [...ANTI_SLOP_UPSTREAM_RULE_IDS],
    );
    writeFileSync(manifestPath, baseEvidence.manifest);
    writeFileSync(configPath, baseEvidence.config);
    git(root, ['add', '-A']);
    git(root, [
      '-c',
      'user.name=Devkit test',
      '-c',
      'user.email=devkit@test.invalid',
      'commit',
      '-qm',
      'base manifest',
    ]);
    const base = git(root, ['rev-parse', 'HEAD']);
    const candidateEvidence = managedEvidence(managedRules(ANTI_SLOP_RULE_IDS));
    writeFileSync(manifestPath, candidateEvidence.manifest);
    writeFileSync(configPath, candidateEvidence.config);
    git(root, ['add', '-A']);

    const envelope = gitBaselineEnvelope(root, base);
    expect(envelope.activatedRuleIds).toEqual(new Set(ANTI_SLOP_DEVKIT_RULE_IDS));
    expect(envelope.candidateMigrationReceipt).toBe(
      antiSlopBaselineMigrationId('0.59.0', digest(candidateEvidence.config)),
    );
  });

  it('authorizes no activation when managed config bytes do not match their manifest digest', () => {
    const root = repository();
    const managed = join(root, '.devkit', 'anti-slop');
    mkdirSync(managed, { recursive: true });
    const baseEvidence = managedEvidence(managedRules(ANTI_SLOP_UPSTREAM_RULE_IDS));
    writeFileSync(join(managed, 'manifest.json'), baseEvidence.manifest);
    writeFileSync(join(managed, 'oxlint.json'), baseEvidence.config);
    git(root, ['add', '-A']);
    git(root, [
      '-c',
      'user.name=Devkit test',
      '-c',
      'user.email=devkit@test.invalid',
      'commit',
      '-qm',
      'base managed state',
    ]);
    writeFileSync(
      join(managed, 'oxlint.json'),
      `${JSON.stringify({ rules: managedRules(ANTI_SLOP_RULE_IDS) })}\n`,
    );
    git(root, ['add', '-A']);

    expect(gitBaselineEnvelope(root, 'HEAD').activatedRuleIds).toEqual(new Set());
  });

  it('authorizes no activation when the manifest omits a managed config rule', () => {
    const root = repository();
    const managed = join(root, '.devkit', 'anti-slop');
    mkdirSync(managed, { recursive: true });
    const baseEvidence = managedEvidence(
      managedRules(ANTI_SLOP_UPSTREAM_RULE_IDS),
      ANTI_SLOP_RULE_IDS.slice(1),
    );
    writeFileSync(join(managed, 'manifest.json'), baseEvidence.manifest);
    writeFileSync(join(managed, 'oxlint.json'), baseEvidence.config);
    git(root, ['add', '-A']);
    git(root, [
      '-c',
      'user.name=Devkit test',
      '-c',
      'user.email=devkit@test.invalid',
      'commit',
      '-qm',
      'base with incomplete manifest evidence',
    ]);
    const candidateEvidence = managedEvidence(managedRules(ANTI_SLOP_RULE_IDS));
    writeFileSync(join(managed, 'manifest.json'), candidateEvidence.manifest);
    writeFileSync(join(managed, 'oxlint.json'), candidateEvidence.config);
    git(root, ['add', '-A']);

    expect(gitBaselineEnvelope(root, 'HEAD').activatedRuleIds).toEqual(new Set());
  });
});
