// A staged deletion leaves no file to lint, so each removed path's folder lints a synthetic file.

// The plugin checks folders before the file's own name: a lone name error means the folders passed.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { ESLint } from 'eslint';
import { commitIndexEnv } from '../ratchets/commit-index.mts';
import { splitNul } from '../ratchets/git-index.mts';
import { buildStructureConfigs } from './eslint-config.mts';
import {
  clean,
  combineStructureResults,
  couldNotRun,
  type StructureGateResult,
  violations,
} from './verdict.mts';

const PROBE_NAME = '__devkit-structure-probe__';
const RULE_ID = 'project-structure/folder-structure';
const EXISTENCE_RE = /Enforce existence = (.+)/;

export interface DeletionProbe {
  dir: string;
  ext: string;
}

function rootRelativeDirs(cwd: string, root: string): Set<string> {
  const files = splitNul(
    execFileSync('git', ['--literal-pathspecs', 'ls-files', '-z', '--', root], {
      cwd,
      env: commitIndexEnv(cwd),
      encoding: 'buffer',
    }).toString(),
  );
  const dirs = new Set<string>();
  for (const file of files) {
    for (let dir = dirname(file); !dirs.has(dir); dir = dirname(dir)) {
      dirs.add(dir);
      if (dir === '.') break;
    }
  }
  return dirs;
}

/** The nearest folder of each removed path that still holds indexed files, never above `root`;
 * `null` when the root itself is left empty. */
export function deletionProbes(
  cwd: string,
  root: string,
  removed: string[],
): DeletionProbe[] | null {
  const cleanRoot = root.replace(/\/+$/, '') || '.';
  const live = rootRelativeDirs(cwd, cleanRoot);
  if (!live.has(cleanRoot)) return null;
  const probes = new Map<string, DeletionProbe>();
  for (const file of removed) {
    let dir = dirname(file);
    while (dir !== cleanRoot && !live.has(dir)) dir = dirname(dir);
    if (!probes.has(dir)) probes.set(dir, { dir, ext: extname(file).slice(1) });
  }
  return [...probes.values()];
}

function namesRemoved(message: string, removed: string[]): boolean {
  const enforced = EXISTENCE_RE.exec(message)?.[1]?.split(', ') ?? [];
  return enforced.some((path) =>
    removed.some((file) => `./${file}` === path || `./${file}`.startsWith(`${path}/`)),
  );
}

function classifyProbe(dir: string, messages: string[], removed: string[]): StructureGateResult {
  if (messages.some((message) => namesRemoved(message, removed))) {
    return violations(1, messages.join('\n'));
  }
  // No message, or only the probe's own name error: every folder on the path was checked and passed.
  if (messages.every((message) => message.includes(`'${PROBE_NAME}.`))) return clean();
  return couldNotRun(`deletion probe in ${dir} was masked by structure debt: ${messages[0]}`);
}

/** Lint one synthetic path per probe dir; block only on an enforceExistence error that names a path
 * this commit removed. */
export async function runDeletionProbes(
  cwd: string,
  probes: DeletionProbe[],
  removed: string[],
): Promise<StructureGateResult> {
  const configs = await buildStructureConfigs(cwd);
  if (!configs.length) {
    return couldNotRun('no structure.trees[].grammar declared (preset-only consumer)');
  }
  // Its own cache: the plugin drops a message already cached for another filename.
  const cacheDir = mkdtempSync(join(tmpdir(), 'devkit-structure-probe-'));
  try {
    const eslint = new ESLint({
      cwd,
      overrideConfigFile: true,
      baseConfig: [...configs, { settings: { 'project-structure/cache-location': cacheDir } }],
    });
    const results: StructureGateResult[] = [];
    for (const { dir, ext } of probes) {
      const [result] = await eslint.lintText('', {
        filePath: join(cwd, dir, `${PROBE_NAME}.${ext}`),
      });
      // A path ESLint or the plugin ignores yields no rule message: CI's whole-tree lint skips it too.
      const errors = (result?.messages ?? []).filter((m) => m.ruleId === RULE_ID);
      results.push(
        classifyProbe(
          dir,
          errors.map((m) => m.message),
          removed,
        ),
      );
    }
    return combineStructureResults(results);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
}
