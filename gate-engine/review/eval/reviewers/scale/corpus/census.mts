import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, lstatSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILENAME, resolveGuardConfigJson } from '../../../../../config.mts';
import { selectReviewers } from '../../../../reviewers.mts';
import { planFixture } from '../../corpus/chunk-guard.mts';
import { buildCappedDiffEvidence } from '../../../../diff-evidence.mts';
import { sha256, canonical } from '../claim-inventory.mts';
import { manifestHash, parseManifest } from './manifest.mts';
import { measureSpan } from './visibility.mts';
import { hashLocalModuleClosure } from '../../../module-closure-hash.mts';

const git = (cwd: string, args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_DIR: undefined,
      GIT_COMMON_DIR: undefined,
      GIT_WORK_TREE: undefined,
      GIT_INDEX_FILE: undefined,
    },
  });
const groups = [
  ['state-transitions'],
  ['concurrency-races'],
  ['error-and-edge-classification'],
  ['writer-reader-contracts'],
];

export function privateSourceRoot(directory: string): string {
  const root = realpathSync(path.join(os.homedir(), '.devkit', 'research'));
  const actual = realpathSync(directory);
  if (!actual.startsWith(`${root}${path.sep}`)) throw new Error('PRIVATE_SOURCE_REQUIRED');
  return actual;
}

/** Operates on an already reconstructed, explicit-base private source snapshot; never searches
 * for a merely applicable base, stages source files, or invokes a reviewer. */
export function censusSource(serialized: string, caseId: string, directory: string) {
  if (
    ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].some((key) => process.env[key])
  )
    throw new Error('AMBIENT_GIT_OVERRIDE');
  const manifest = parseManifest(serialized);
  const entry = manifest.entries.find((candidate) => candidate.id === caseId);
  if (!entry || !manifest.selectedFamilies.includes(entry.family))
    throw new Error('CASE_NOT_SELECTED');
  const cwd = privateSourceRoot(directory);
  if (git(cwd, ['rev-parse', 'HEAD']).trim() !== entry.source.baseSha)
    throw new Error('BASE_MISMATCH');
  const diff = git(cwd, ['diff', '--cached', '--no-ext-diff']);
  if (sha256(diff) !== entry.source.diffSha256) throw new Error('DIFF_MISMATCH');
  if (git(cwd, ['diff', '--name-only']).trim()) throw new Error('WORKTREE_CHANGED');
  const stagedTreeSha = git(cwd, ['write-tree']).trim();
  const frozenDiff = (args: string[], paths: string[]) =>
    git(cwd, [
      'diff',
      '--no-ext-diff',
      ...args,
      entry.source.baseSha,
      stagedTreeSha,
      '--',
      ...paths.map((file) => `:(top,literal)${file}`),
    ]);
  if (sha256(frozenDiff([], [])) !== entry.source.diffSha256) throw new Error('DIFF_MISMATCH');
  const files = frozenDiff(['--name-only', '-z'], []).split('\0').filter(Boolean);
  const configPath = git(cwd, [
    'ls-tree',
    '--name-only',
    '-z',
    stagedTreeSha,
    '--',
    CONFIG_FILENAME,
  ]);
  const configContents = configPath
    ? git(cwd, ['show', `${stagedTreeSha}:${CONFIG_FILENAME}`])
    : null;
  const cfg = resolveGuardConfigJson(configContents, cwd);
  const sel = selectReviewers(files, cfg).find(
    (selection) => selection.reviewer.name === 'correctness-reviewer',
  );
  if (!sel) throw new Error('NO_REVIEW_SELECTION');
  if (sel.reviewer.model !== 'gpt-5.6-sol') throw new Error('MODEL_CONDITION_MISMATCH');
  const base: Record<string, string | null> = {};
  const post: Record<string, string | null> = {};
  for (const span of entry.spans) {
    if (span.side === 'base') {
      base[span.file] = git(cwd, ['show', `${entry.source.baseSha}:${span.file}`]);
    } else {
      const target = path.join(cwd, span.file);
      if (!realpathSync(target).startsWith(`${cwd}${path.sep}`) || !lstatSync(target).isFile())
        throw new Error('SOURCE_PATH_ESCAPE');
      post[span.file] = readFileSync(target, 'utf8');
      if (post[span.file] !== git(cwd, ['show', `${stagedTreeSha}:${span.file}`]))
        throw new Error('POSTIMAGE_MISMATCH');
    }
  }
  const plan = planFixture(sel, cwd, { cap: 400, groups, diff: frozenDiff([], sel.files) });
  const tasks = plan.tasks.map((task) => {
    const scoped = frozenDiff([], task.sel.files);
    if (scoped !== task.diffText) throw new Error('TASK_DIFF_CHANGED');
    const inventory = frozenDiff(['--stat'], task.sel.files);
    const rendered = buildCappedDiffEvidence(scoped, inventory);
    return {
      taskSha256: sha256(task.key),
      lens: task.group,
      targetLens: task.group === entry.targetLens,
      scope: task.chunk
        ? 'local-chunk'
        : task.group === 'writer-reader-contracts'
          ? 'whole-diff-contracts'
          : 'whole-diff-local',
      filesSha256: sha256(canonical(task.sel.files)),
      fileCount: task.sel.files.length,
      diffSha256: sha256(scoped),
      inputSha256: sha256(rendered),
      inputBytes: Buffer.byteLength(rendered),
      required: entry.spans.map((span) => ({
        spanSha256: sha256(canonical(span)),
        ...measureSpan(span, { base, post, selectedFiles: task.sel.files, diff: scoped, rendered }),
        retrieval: 'not-observed-zero-judge',
      })),
    };
  });
  if (
    git(cwd, ['rev-parse', 'HEAD']).trim() !== entry.source.baseSha ||
    sha256(git(cwd, ['diff', '--cached', '--no-ext-diff'])) !== entry.source.diffSha256 ||
    git(cwd, ['diff', '--name-only']).trim()
  )
    throw new Error('SOURCE_CHANGED_DURING_CENSUS');
  return {
    version: 1,
    mode: 'zero-judge-source-census',
    manifestSha256: manifestHash(manifest),
    implementationSha256: hashLocalModuleClosure([
      fileURLToPath(import.meta.url),
      fileURLToPath(new URL('./census-cli.mts', import.meta.url)),
      fileURLToPath(new URL('./census-worker.mts', import.meta.url)),
    ]),
    dependenciesSha256: sha256(
      readFileSync(new URL('../../../../../../bun.lock', import.meta.url), 'utf8'),
    ),
    runtime: process.version,
    case: entry.id,
    family: entry.family,
    exposure: entry.exposure,
    role: entry.role,
    qualification: entry.qualification,
    targetLens: entry.targetLens,
    source: entry.source,
    evidence: entry.evidence,
    condition: {
      cap: 400,
      groups,
      configSha256: sha256(JSON.stringify(cfg)),
      configSourceSha256: configContents === null ? null : sha256(configContents),
      model: sel.reviewer.model,
      judgeCalls: 0,
    },
    facts: {
      ...plan.facts,
      stagedTreeSha,
      sourceChangedFiles: files.length,
      selectedFiles: sel.files.length,
    },
    tasks,
  };
}
