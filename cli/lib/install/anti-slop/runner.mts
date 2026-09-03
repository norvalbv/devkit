/** Execute pinned Oxlint and expose only normalized anti-slop findings to the baseline gate. */

import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { resolveOxlintEntryConfig } from '../oxc/lifecycle.mts';
import { resolveOxcRuntime } from '../oxc/runtime.mts';
import {
  adoptManagedCapability,
  AntiSlopCapabilityError,
  withManagedCapabilityLock,
} from './base-capability.mts';
import {
  ANTI_SLOP_BASELINE_MODE,
  ANTI_SLOP_EXECUTION_MODE_ENV,
  ANTI_SLOP_IGNORE_PATTERNS,
} from './constants.mts';
import { type FindingGroup, groupFindings, parseAntiSlopFindings } from './diagnostics.mts';
import { antiSlopCapabilityIssue } from './lifecycle.mts';

const MAX_OUTPUT = 64 * 1024 * 1024;

export interface AntiSlopScope {
  paths: string[];
  includes(file: string): boolean;
}

/** Resolve literal existing repository paths and expose their baseline-entry membership. */
export function resolveAntiSlopScope(cwd: string, args: readonly string[]): AntiSlopScope {
  const separator = args.indexOf('--');
  const options = separator >= 0 ? args.slice(0, separator) : args;
  const paths = args.filter((arg) => arg !== '--');
  const option = options.find((arg) => arg.startsWith('-'));
  if (option) {
    // Deliberately does not name a config file: which one governs depends on the install mode, and
    // in overlay the consumer's root config is not read at all.
    throw new Error(
      `anti-slop operations accept repository paths, not Oxlint option ${option}; configure rules in the repository's Oxlint config`,
    );
  }
  const requested = paths.length > 0 ? paths : ['.'];
  const lintArguments = paths.length > 0 ? [...args] : ['.'];
  const repository = realpathSync(cwd);
  const scopes = requested.map((path) => {
    const absolute = resolve(cwd, path);
    let target: string;
    try {
      target = realpathSync(absolute);
    } catch {
      throw new Error(`anti-slop path does not exist: ${path}`);
    }
    const targetRel = relative(repository, target);
    if (targetRel === '..' || targetRel.startsWith(`..${sep}`) || isAbsolute(targetRel)) {
      throw new Error(`anti-slop path escapes repository: ${path}`);
    }
    const lexical = relative(resolve(cwd), absolute);
    if (lexical === '..' || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) {
      throw new Error(`anti-slop path escapes repository: ${path}`);
    }
    return { file: lexical.split(sep).join('/'), directory: statSync(absolute).isDirectory() };
  });
  return {
    paths: lintArguments,
    includes(file: string): boolean {
      return scopes.some((scope) =>
        scope.directory ? !scope.file || file.startsWith(`${scope.file}/`) : file === scope.file,
      );
    },
  };
}

/**
 * Run the installed capability under the repository's combined Oxlint config — or devkit's own
 * git-excluded entry config in overlay. `pinCapabilityTo` copies the capability THIS lint used.
 */
export function collectAntiSlopGroups(
  cwd: string,
  args: readonly string[],
  pinCapabilityTo?: string,
): FindingGroup[] {
  if (!existsSync(resolve(cwd, '.devkit'))) {
    throw new Error('anti-slop is not installed — run `devkit init --anti-slop`');
  }
  return withManagedCapabilityLock(cwd, () => {
    const groups = collectAntiSlopGroupsUnlocked(cwd, args);
    if (pinCapabilityTo) adoptManagedCapability(cwd, pinCapabilityTo);
    return groups;
  });
}

function collectAntiSlopGroupsUnlocked(cwd: string, args: readonly string[]): FindingGroup[] {
  const issue = antiSlopCapabilityIssue(cwd);
  if (issue) throw new AntiSlopCapabilityError(issue);
  const scope = resolveAntiSlopScope(cwd, args);
  const runtime = resolveOxcRuntime('lint');
  // Resolved from the managed manifest, which travels into a snapshot cwd with the capability — so
  // this works identically in the repository and in the `mkdtemp` extraction of the Git index.
  const entry = resolveOxlintEntryConfig(cwd);
  const result = spawnSync(
    process.execPath,
    [
      runtime.binPath,
      ...(entry ? ['--config', entry] : []),
      '--format',
      'json',
      '--no-error-on-unmatched-pattern',
      '--disable-nested-config',
      ...ANTI_SLOP_IGNORE_PATTERNS.flatMap((pattern) => ['--ignore-pattern', pattern]),
      ...scope.paths,
    ],
    {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, [ANTI_SLOP_EXECUTION_MODE_ENV]: ANTI_SLOP_BASELINE_MODE },
      maxBuffer: MAX_OUTPUT,
    },
  );
  if (result.status === null) {
    throw new Error(
      `Oxlint failed: ${result.error?.message ?? (result.signal ? `signal ${result.signal}` : 'unknown error')}`,
    );
  }
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(
      `Oxlint exited ${result.status}: ${result.stderr.trim().split('\n')[0] || 'no detail'}`,
    );
  }
  if (!result.stdout.trim()) {
    throw new Error(
      `Oxlint returned no diagnostics JSON: ${result.stderr.trim().split('\n')[0] || 'no detail'}`,
    );
  }
  return groupFindings(parseAntiSlopFindings(cwd, result.stdout));
}
