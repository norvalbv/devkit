/** Exact Git-index materialization and base-commit baseline evidence for anti-slop gates. */

import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adoptManagedCapability } from './base-capability.mts';
import { type AntiSlopBaseline, parseBaseline } from './baseline.mts';
import {
  ANTI_SLOP_BASELINE_REL,
  ANTI_SLOP_CONFIG_REL,
  ANTI_SLOP_MANIFEST_REL,
  parseAntiSlopManagedActivationEvidence,
} from './constants.mts';
import type { AntiSlopManagedActivationEvidence } from './constants.mts';
import type { RelocationSource } from './relocations.mts';
import {
  git,
  type GitLayout,
  layout,
  MAX_GIT_OUTPUT,
  resolveRef,
  symbolicHead,
} from './git-index-lock.mts';

export { withStableGitIndex } from './git-index-lock.mts';
export type { GitBaseIdentity, GitHeadIdentity } from './git-index-lock.mts';

const LINT_SOURCE = /\.(?:[cm]?[jt]sx?)$/u;
const FULL_SCAN_FILES = new Set([
  ANTI_SLOP_BASELINE_REL,
  '.oxlintrc.json',
  '.oxlintrc.jsonc',
  'oxlint.config.ts',
  'oxlint.config.mts',
  'package.json',
  'bun.lock',
]);

interface GitChange {
  status: string;
  oldPath?: string;
  path: string;
}

export interface GitBaselineEnvelope {
  base: AntiSlopBaseline | null;
  /** Git tree used to distinguish inherited findings from candidate growth. */
  baseTree?: string;
  /** Original checkout used when the candidate runs from a materialized staged snapshot. */
  baseCheckoutCwd?: string;
  introducedPaths: Set<string>;
  /** Candidate rules newly enforced by its managed manifest/config. Empty on invalid evidence. */
  activatedRuleIds: Set<string>;
  /** Receipt identity bound to the candidate managed manifest, even without an activation delta. */
  candidateMigrationReceipt: string | null;
  renames: Map<string, string>;
  /** Modified, deleted, and renamed-to package paths that may have vacated debt to another file. */
  relocationSources: Map<string, RelocationSource>;
}

export interface StagedAntiSlopSnapshot extends GitBaselineEnvelope {
  cwd: string;
  /** The exact `git write-tree` this snapshot materialized, for callers that re-verify it. */
  candidateTree: string;
  paths: string[];
  changedFiles: string[];
  fullScan: boolean;
  skipped: boolean;
}

function symbolicFullName(root: string, ref: string): string | null {
  const result = spawnSync('git', ['rev-parse', '--symbolic-full-name', ref], {
    cwd: root,
    encoding: 'utf8',
  });
  const name = result.status === 0 ? result.stdout.trim() : '';
  return name.startsWith('refs/') ? name : null;
}

function treeForRef(root: string, ref: string): string {
  const result = spawnSync('git', ['rev-parse', '--verify', `${ref}^{tree}`], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status === 0) return result.stdout.trim();
  if (ref !== 'HEAD') {
    throw new Error(`anti-slop: Git base ${ref} does not resolve to a tree`);
  }
  const unborn = spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (unborn.status !== 0) throw new Error('anti-slop: HEAD could not be resolved safely');
  const empty = spawnSync('git', ['mktree'], { cwd: root, encoding: 'utf8', input: '' });
  if (empty.status !== 0) throw new Error('anti-slop: could not create the initial empty Git tree');
  return empty.stdout.trim();
}

function parseChanges(root: string, baseTree: string, candidateTree: string): GitChange[] {
  return parseNameStatus(
    execFileSync(
      'git',
      ['diff-tree', '--no-commit-id', '--name-status', '-r', '-z', '-M', baseTree, candidateTree],
      { cwd: root, encoding: 'utf8', maxBuffer: MAX_GIT_OUTPUT },
    ),
  );
}

/** Parse `--name-status -z` output; rename and copy records carry two paths. */
function parseNameStatus(output: string): GitChange[] {
  const fields = output.split('\0');
  const changes: GitChange[] = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) break;
    if (status.startsWith('R') || status.startsWith('C')) {
      const oldPath = fields[index++];
      const path = fields[index++];
      if (oldPath !== undefined && path !== undefined) changes.push({ status, oldPath, path });
      continue;
    }
    const path = fields[index++];
    if (path !== undefined) changes.push({ status, path });
  }
  return changes;
}

function packagePath(repoPath: string, prefix: string): string | null {
  if (!prefix) return repoPath;
  return repoPath.startsWith(prefix) ? repoPath.slice(prefix.length) : null;
}

/** Package-relative renames, introduced paths, and relocation sources from Git change records. */
function packageChanges(
  changes: readonly GitChange[],
  prefix: string,
): Pick<GitBaselineEnvelope, 'renames' | 'introducedPaths' | 'relocationSources'> {
  const renames = new Map<string, string>();
  const introducedPaths = new Set<string>();
  const relocationSources = new Map<string, RelocationSource>();
  for (const change of changes) {
    const path = packagePath(change.path, prefix);
    if (change.status.startsWith('A') || change.status.startsWith('C')) {
      if (path !== null) introducedPaths.add(path);
    }
    if (path !== null && (change.status.startsWith('M') || change.status.startsWith('D'))) {
      relocationSources.set(path, { basePath: path, deleted: change.status.startsWith('D') });
    }
    if (!change.status.startsWith('R') || change.oldPath === undefined) continue;
    const oldPath = packagePath(change.oldPath, prefix);
    if (oldPath === null || path === null) continue;
    renames.set(oldPath, path);
    relocationSources.set(path, { basePath: oldPath, deleted: false });
  }
  return { renames, introducedPaths, relocationSources };
}

/** Rules the candidate evidence enforces that the base did not; none when either side is unknown. */
export function activatedRuleIdsBetween(
  base: AntiSlopManagedActivationEvidence | null,
  candidate: AntiSlopManagedActivationEvidence | null,
): Set<string> {
  return new Set(
    base === null || candidate === null
      ? []
      : [...candidate.activeRuleIds].filter((ruleId) => !base.activeRuleIds.has(ruleId)),
  );
}

function fileAtTree(
  layout: GitLayout,
  tree: string,
  relativePath: string,
  description: string,
): string | null {
  const path = `${layout.prefix}${relativePath}`;
  const listed = spawnSync('git', ['ls-tree', '-z', tree, '--', path], {
    cwd: layout.root,
    encoding: 'utf8',
  });
  if (listed.status !== 0) {
    throw new Error(`anti-slop: could not inspect ${description} at ${tree.slice(0, 12)}`);
  }
  if (!listed.stdout) return null;
  return execFileSync('git', ['show', `${tree}:${path}`], {
    cwd: layout.root,
    encoding: 'utf8',
    maxBuffer: MAX_GIT_OUTPUT,
  });
}

function baselineAtTree(layout: GitLayout, tree: string): AntiSlopBaseline | null {
  const json = fileAtTree(layout, tree, ANTI_SLOP_BASELINE_REL, 'the base baseline');
  return json === null
    ? null
    : parseBaseline(json, `${tree.slice(0, 12)}:${layout.prefix}${ANTI_SLOP_BASELINE_REL}`);
}

function activationEvidenceAtTree(
  layout: GitLayout,
  tree: string,
): AntiSlopManagedActivationEvidence | null {
  const manifest = fileAtTree(layout, tree, ANTI_SLOP_MANIFEST_REL, 'the managed manifest');
  const config = fileAtTree(layout, tree, ANTI_SLOP_CONFIG_REL, 'the managed config');
  if (manifest === null || config === null) return null;
  return parseAntiSlopManagedActivationEvidence(manifest, config);
}

function envelope(
  cwd: string,
  baseRef: string,
  candidateTree: string,
): GitBaselineEnvelope & {
  layout: GitLayout;
  changes: GitChange[];
  baseTree: string;
  candidateTree: string;
} {
  const repo = layout(cwd);
  const baseTree = treeForRef(repo.root, baseRef);
  const changes = parseChanges(repo.root, baseTree, candidateTree);
  const candidateActivation = activationEvidenceAtTree(repo, candidateTree);
  return {
    layout: repo,
    baseTree,
    candidateTree,
    changes,
    base: baselineAtTree(repo, baseTree),
    ...packageChanges(changes, repo.prefix),
    activatedRuleIds: activatedRuleIdsBetween(
      activationEvidenceAtTree(repo, baseTree),
      candidateActivation,
    ),
    candidateMigrationReceipt: candidateActivation?.baselineMigrationId ?? null,
  };
}

export type CommittedBaselineProbe =
  | {
      kind: 'compare';
      base: AntiSlopBaseline;
      envelope: GitBaselineEnvelope;
      baseActivation: AntiSlopManagedActivationEvidence | null;
    }
  | { kind: 'skip'; notice: string | null };

/** A staged file's bytes, or null when the index holds no single merged entry for it. */
function fileInIndex(layout: GitLayout, relativePath: string): string | null {
  const shown = spawnSync('git', ['show', `:${layout.prefix}${relativePath}`], {
    cwd: layout.root,
    encoding: 'utf8',
    maxBuffer: MAX_GIT_OUTPUT,
  });
  return shown.status === 0 ? shown.stdout : null;
}

function activationEvidenceInIndex(layout: GitLayout): AntiSlopManagedActivationEvidence | null {
  const manifest = fileInIndex(layout, ANTI_SLOP_MANIFEST_REL);
  const config = fileInIndex(layout, ANTI_SLOP_CONFIG_REL);
  return manifest === null || config === null
    ? null
    : parseAntiSlopManagedActivationEvidence(manifest, config);
}

/** The HEAD envelope `create` must satisfy, read WITHOUT `write-tree` so an unmerged index still
 * compares; renames and activation come from the index, exactly as the staged gate reads them. */
export function committedBaselineProbe(cwd: string): CommittedBaselineProbe {
  const inside = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  if (inside.status !== 0) return { kind: 'skip', notice: null };
  try {
    const repo = layout(cwd);
    if (resolveRef(repo.root, 'HEAD') === null) return { kind: 'skip', notice: null };
    const baseTree = treeForRef(repo.root, 'HEAD');
    const base = baselineAtTree(repo, baseTree);
    if (base === null) return { kind: 'skip', notice: null };
    const staged = execFileSync(
      'git',
      ['diff-index', '--cached', '--name-status', '-z', '-M', baseTree],
      { cwd: repo.root, encoding: 'utf8', maxBuffer: MAX_GIT_OUTPUT },
    );
    const baseActivation = activationEvidenceAtTree(repo, baseTree);
    const stagedActivation = activationEvidenceInIndex(repo);
    return {
      kind: 'compare',
      base,
      baseActivation,
      envelope: {
        base,
        baseTree,
        ...packageChanges(parseNameStatus(staged), repo.prefix),
        activatedRuleIds: activatedRuleIdsBetween(baseActivation, stagedActivation),
        candidateMigrationReceipt: stagedActivation?.baselineMigrationId ?? null,
      },
    };
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message.split('\n')[0] : String(error);
    return {
      kind: 'skip',
      notice: `anti-slop: growth not pre-checked (${detail}); the commit gate still enforces the committed baseline`,
    };
  }
}

/** Read the base baseline and exact rename map used by a full-tree CI check. */
export function gitBaselineEnvelope(
  cwd: string,
  baseRef: string,
): GitBaselineEnvelope & {
  baseTree: string;
  candidateTree: string;
  baseOid: string | null;
  baseRefName: string | null;
  headOid: string | null;
  headRef: string | null;
} {
  const repo = layout(cwd);
  const headRef = symbolicHead(repo.root);
  const headOid = resolveRef(repo.root, 'HEAD');
  const baseOid = resolveRef(repo.root, baseRef);
  const baseRefName = symbolicFullName(repo.root, baseRef);
  const candidateTree = git(repo.root, ['write-tree']);
  const {
    base,
    baseTree,
    introducedPaths,
    activatedRuleIds,
    candidateMigrationReceipt,
    renames,
    relocationSources,
  } = envelope(cwd, baseOid ?? baseRef, candidateTree);
  return {
    base,
    baseTree,
    candidateTree,
    baseOid,
    baseRefName,
    headOid,
    headRef,
    introducedPaths,
    activatedRuleIds,
    candidateMigrationReceipt,
    renames,
    relocationSources,
  };
}

function requiresFullScan(path: string): boolean {
  return (
    FULL_SCAN_FILES.has(path) ||
    path.startsWith('.devkit/oxc/') ||
    path.startsWith('.devkit/anti-slop/')
  );
}

function extractTree(root: string, tree: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  const archive = execFileSync('git', ['archive', '--format=tar', tree], {
    cwd: root,
    maxBuffer: MAX_GIT_OUTPUT,
  });
  const extracted = spawnSync('tar', ['-x', '-C', destination], { input: archive });
  if (extracted.status !== 0) {
    throw new Error(
      `anti-slop: could not materialize staged Git tree: ${extracted.stderr?.toString().trim() || `tar exit ${extracted.status}`}`,
    );
  }
}

/**
 * Run an action against selected files from the exact base tree used by a CI comparison.
 * `cwd` locates the REPOSITORY; `capabilityCwd` holds the capability to judge it with (sc-2084).
 */
export function withBaseAntiSlopSnapshot<T>(
  cwd: string,
  capabilityCwd: string,
  baseTree: string,
  paths: readonly string[],
  action: (snapshot: { cwd: string; paths: string[] }) => T,
): T {
  const repo = layout(cwd);
  const temp = mkdtempSync(join(tmpdir(), 'devkit-anti-slop-base-'));
  try {
    extractTree(repo.root, baseTree, temp);
    const snapshotCwd = join(temp, repo.prefix);
    adoptManagedCapability(capabilityCwd, snapshotCwd);
    const existingPaths = paths.filter((path) => existsSync(join(snapshotCwd, path)));
    return action({ cwd: snapshotCwd, paths: existingPaths });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/**
 * Run an action against the exact candidate index, never the mutable working tree. `overlay` adds
 * the git-excluded capability and baseline; opt-in, never default — see oxc-toolchain-migration.
 */
export function withStagedAntiSlopSnapshot<T>(
  cwd: string,
  action: (snapshot: StagedAntiSlopSnapshot) => T,
  { overlay = false, baseRef = 'HEAD' }: { overlay?: boolean; baseRef?: string } = {},
): T {
  const repo = layout(cwd);
  const candidateTree = git(repo.root, ['write-tree']);
  const evidence = envelope(cwd, baseRef, candidateTree);
  const packageChanges = evidence.changes.flatMap((change) => {
    const path = packagePath(change.path, repo.prefix);
    return path === null ? [] : [{ ...change, path }];
  });
  const changedFiles = packageChanges.map((change) => change.path);
  const fullScan = changedFiles.some(requiresFullScan);
  const paths = fullScan
    ? []
    : packageChanges
        .filter((change) => !change.status.startsWith('D') && LINT_SOURCE.test(change.path))
        .map((change) => change.path);
  const skipped = !fullScan && paths.length === 0;
  if (skipped) {
    return action({
      cwd,
      paths,
      changedFiles,
      fullScan,
      skipped,
      base: evidence.base,
      baseTree: evidence.baseTree,
      baseCheckoutCwd: cwd,
      introducedPaths: evidence.introducedPaths,
      activatedRuleIds: evidence.activatedRuleIds,
      candidateMigrationReceipt: evidence.candidateMigrationReceipt,
      renames: evidence.renames,
      relocationSources: evidence.relocationSources,
      candidateTree,
    });
  }

  const temp = mkdtempSync(join(tmpdir(), 'devkit-anti-slop-index-'));
  try {
    extractTree(repo.root, candidateTree, temp);
    const snapshotCwd = join(temp, repo.prefix);
    if (overlay) {
      adoptManagedCapability(cwd, snapshotCwd);
      // Copied separately, NOT via MANAGED_RELS: `adoptManagedCapability` also runs for the BASE
      // snapshot, where overwriting its committed baseline would destroy the comparison.
      const baseline = join(cwd, ANTI_SLOP_BASELINE_REL);
      if (existsSync(baseline)) cpSync(baseline, join(snapshotCwd, ANTI_SLOP_BASELINE_REL));
    }
    return action({
      cwd: snapshotCwd,
      paths,
      changedFiles,
      fullScan,
      skipped,
      base: evidence.base,
      baseTree: evidence.baseTree,
      baseCheckoutCwd: cwd,
      introducedPaths: evidence.introducedPaths,
      activatedRuleIds: evidence.activatedRuleIds,
      candidateMigrationReceipt: evidence.candidateMigrationReceipt,
      renames: evidence.renames,
      relocationSources: evidence.relocationSources,
      candidateTree,
    });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
