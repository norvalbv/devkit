/**
 * Doctor's drift checks for the SYNCED agent half — skills, agents, agent-hook scripts, and the
 * hook registrations that accompany them.
 *
 * All four share one contract: a `.devkit/*-manifest.json` records a sha256 per synced file, and
 * drift is any disagreement between that record, devkit's bundled source, and the consumer's copy.
 * They are leaf checks — they read the repo and return a {@link CheckResult}, calling nothing else
 * in doctor — so they live outside the command module, which keeps its orchestration deliberately
 * intact. Every path resolves from the GIT ROOT: the agent half is repo-wide, so a monorepo package
 * subdir must still verify the root's copies (W-3 — resolve from the consumer, never __dirname).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { detectGitRoot } from '../detect-git-root.mts';
import { packageDir, readJson, sha256 } from '../fs-helpers.mts';
import { checkHookRegistrations } from '../install/install-hooks.mts';
import { bundledNames } from '../sync-manifest.mts';
import { type CheckResult, check } from './check-result.mts';

/** A skills / agents / agent-hooks manifest: repo-relative path → recorded sha256. */
export interface Manifest {
  files: Record<string, string>;
}

// Reason: the branches ARE the manifest-drift algorithm — per file, two independent SHA comparisons
// (devkit source vs manifest, consumer copy vs manifest) feed two drift buckets, then a
// missing-manifest short-circuit and a source/consumer DRIFT split. Each branch is a distinct drift
// verdict; extracting them hides which side drifted.
// fallow-ignore-next-line complexity
export async function checkSkills(cwd: string, surface = 'claude'): Promise<CheckResult> {
  // Skills are repo-wide → manifest + the agent-surface dir live at the git root (cwd for a
  // single-package repo). Verify against the selected surface (.claude or .cursor — same content).
  const { gitRoot } = detectGitRoot(cwd);
  const manifestPath = join(gitRoot, '.devkit', 'skills-manifest.json');
  const manifest = readJson(manifestPath) as Manifest | null;
  if (!manifest) {
    return check('skills', 'MISSING', 'no skills-manifest.json', 'run `devkit sync-skills`', true);
  }
  const skillsSrc = join(packageDir(), 'skills');
  const consumerDrift: string[] = [];
  const sourceDrift: string[] = [];
  for (const [rel, recordedSha] of Object.entries(manifest.files)) {
    const srcPath = join(skillsSrc, rel);
    if (existsSync(srcPath) && sha256(srcPath) !== recordedSha) sourceDrift.push(rel);
    const consumerPath = join(gitRoot, `.${surface}`, 'skills', rel);
    if (!existsSync(consumerPath) || sha256(consumerPath) !== recordedSha) consumerDrift.push(rel);
  }
  // Bundle-completeness: a NEW bundled skill the (stale) manifest doesn't list — and that was never
  // synced under .<surface>/skills — is drift the per-file loop above can't see (it iterates manifest
  // keys only, so a just-added skill is invisible). A consumer-authored same-named skill (present on
  // disk, deliberately off-manifest) is NOT drift, so require absent-on-disk too — see the
  // non-devkit-asset-collision-preserve decision.
  const manifestSkillDirs = new Set(Object.keys(manifest.files).map((k) => k.split('/')[0]));
  const unsynced = bundledNames('skills', (e) => e.isDirectory()).filter(
    (dir) =>
      !manifestSkillDirs.has(dir) && !existsSync(join(gitRoot, `.${surface}`, 'skills', dir)),
  );
  if (sourceDrift.length || consumerDrift.length || unsynced.length) {
    const parts: string[] = [];
    if (sourceDrift.length) parts.push(`devkit source ahead of manifest (${sourceDrift.length})`);
    if (consumerDrift.length) parts.push(`consumer copy drifted (${consumerDrift.length})`);
    if (unsynced.length)
      parts.push(
        `bundle has ${unsynced.length} skill(s) the manifest lacks (${unsynced.join(', ')})`,
      );
    return check('skills', 'DRIFT', parts.join('; '), 'run `devkit sync-skills`', true);
  }
  return check('skills', 'OK', `${Object.keys(manifest.files).length} file(s) in sync`);
}

// Agents are repo-wide → manifest + the agent-surface dir live at the git root (same contract as skills).
// Reason: the branches ARE the manifest-drift algorithm (same contract as checkSkills): per file, two independent SHA comparisons (devkit source vs manifest, consumer copy vs manifest) feed two drift buckets, then a missing-manifest short-circuit and a source/consumer DRIFT split. Each branch is a distinct drift verdict; extracting them hides which side drifted.
// fallow-ignore-next-line complexity
export async function checkAgents(cwd: string, surface = 'claude'): Promise<CheckResult> {
  const { gitRoot } = detectGitRoot(cwd);
  const manifest = readJson(join(gitRoot, '.devkit', 'agents-manifest.json')) as Manifest | null;
  if (!manifest) {
    return check('agents', 'MISSING', 'no agents-manifest.json', 'run `devkit sync-agents`', true);
  }
  const agentsSrc = join(packageDir(), 'agents');
  const consumerDrift: string[] = [];
  const sourceDrift: string[] = [];
  for (const [rel, recordedSha] of Object.entries(manifest.files)) {
    const srcPath = join(agentsSrc, rel);
    if (existsSync(srcPath) && sha256(srcPath) !== recordedSha) sourceDrift.push(rel);
    const consumerPath = join(gitRoot, `.${surface}`, 'agents', rel);
    if (!existsSync(consumerPath) || sha256(consumerPath) !== recordedSha) consumerDrift.push(rel);
  }
  // Bundle-completeness: a NEW bundled agent the (stale) manifest doesn't list — and that was never
  // synced under .<surface>/agents — is drift the per-file loop above can't see (it iterates manifest
  // keys only). A consumer-authored same-named agent (present on disk, deliberately off-manifest) is
  // NOT drift, so require absent-on-disk too — see the non-devkit-asset-collision-preserve decision.
  const unsynced = bundledNames('agents', (e) => e.isFile() && e.name.endsWith('.md')).filter(
    (name) =>
      !(name in manifest.files) && !existsSync(join(gitRoot, `.${surface}`, 'agents', name)),
  );
  if (sourceDrift.length || consumerDrift.length || unsynced.length) {
    const parts: string[] = [];
    if (sourceDrift.length) parts.push(`devkit source ahead of manifest (${sourceDrift.length})`);
    if (consumerDrift.length) parts.push(`consumer copy drifted (${consumerDrift.length})`);
    if (unsynced.length)
      parts.push(
        `bundle has ${unsynced.length} agent(s) the manifest lacks (${unsynced.join(', ')})`,
      );
    return check('agents', 'DRIFT', parts.join('; '), 'run `devkit sync-agents`', true);
  }
  return check('agents', 'OK', `${Object.keys(manifest.files).length} agent file(s) in sync`);
}

// agentHooks: the six synced scripts (under <surface>/hooks) match the manifest, and are present.
export function checkAgentHookScripts(cwd: string, surface = 'claude'): CheckResult {
  const { gitRoot } = detectGitRoot(cwd);
  const manifest = readJson(
    join(gitRoot, '.devkit', 'agent-hooks-manifest.json'),
  ) as Manifest | null;
  if (!manifest) {
    return check(
      'agent-hooks',
      'MISSING',
      'no agent-hooks-manifest.json',
      'run `devkit init`',
      true,
    );
  }
  const drift = Object.keys(manifest.files).filter((rel) => {
    const p = join(gitRoot, `.${surface}`, 'hooks', rel);
    return !existsSync(p) || sha256(p) !== manifest.files[rel];
  });
  if (drift.length) {
    return check(
      'agent-hooks',
      'DRIFT',
      `${drift.length} script(s) drifted/absent`,
      'run `devkit init`',
      true,
    );
  }
  return check('agent-hooks', 'OK', `${Object.keys(manifest.files).length} hook script(s) in sync`);
}

// Hook registrations present in .claude/settings.json for the selected hook-owning components.
export function checkRegistrations(cwd: string, hookComponents: string[]): CheckResult {
  const { gitRoot } = detectGitRoot(cwd);
  const { ok, missing } = checkHookRegistrations(gitRoot, hookComponents);
  if (ok) return check('hook registrations', 'OK', `${hookComponents.join(', ')} registered`);
  return check(
    'hook registrations',
    'DRIFT',
    `${missing.length} command(s) not in .claude/settings.json`,
    'run `devkit init` to re-register',
    true,
  );
}
