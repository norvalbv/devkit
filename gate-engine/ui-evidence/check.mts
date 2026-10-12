/**
 * At every commit, remind the agent to add before/after PR screenshots when the UI can change.
 * Advisory: always exits 0. UI extensions speak free; any other code diff asks the light judge.
 */
import { matchesRepoGlob } from '../../skills/_devkit/review-roots.mjs';
import { resolveGuardConfig } from '../config.mts';
import { git, stagedFiles } from '../decisions/git-io.mts';
import { emitAdvisoryResult } from '../judge/advisory/emit.mts';
import { resolveReviewModel } from '../review/reviewers.mts';
import { DIFF_CAP, judgeUiVisible } from './judge.mts';

export const UI_EVIDENCE = 'ui-evidence';

/** Files that render or style UI in every mainstream web stack, named by extension only. */
export const DEFAULT_UI_PATHS = [
  'tsx',
  'jsx',
  'vue',
  'svelte',
  'astro',
  'html',
  'css',
  'scss',
  'sass',
  'less',
].map((ext) => `**/*.${ext}`);

/** Test, story and fixture files carry UI extensions but change nothing a user sees. */
const NON_UI_PATHS = [
  '**/*.test.*',
  '**/*.spec.*',
  '**/*.stories.*',
  '**/__tests__/**',
  '**/test/**',
  '**/tests/**',
  '**/e2e/**',
  '**/__snapshots__/**',
  '**/__mocks__/**',
  '**/fixtures/**',
  '**/*.d.ts',
];

/** Never worth a model call: prose and generated dependency pins. */
const NOT_JUDGED = ['**/*.md', '**/*.lock', '**/package-lock.json', '**/pnpm-lock.yaml'];

const PATHS_SHOWN = 3;

export function uiPaths(staged: string[], globs: string[]): string[] {
  const any = (path: string, list: string[]) => list.some((glob) => matchesRepoGlob(path, glob));
  return staged.filter((path) => any(path, globs) && !any(path, NON_UI_PATHS));
}

/** Why this commit deserves screenshots by path alone, or null when no UI file is staged. */
export function uiPathReason(staged: string[], globs: string[]): string | null {
  const paths = uiPaths(staged, [...DEFAULT_UI_PATHS, ...globs]);
  if (paths.length === 0) return null;
  const more = paths.length > PATHS_SHOWN ? `, +${paths.length - PATHS_SHOWN} more` : '';
  return `UI paths changed: ${paths.slice(0, PATHS_SHOWN).join(', ')}${more}`;
}

/** The judged paths, listed in full, then their staged diff capped at DIFF_CAP; '' when none. */
export function judgeInput(cwd: string, staged: string[]): string {
  const skip = [...NON_UI_PATHS, ...NOT_JUDGED];
  const paths = staged.filter((path) => !skip.some((g) => matchesRepoGlob(path, g)));
  if (paths.length === 0) return '';
  const prefixes = ['-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false'];
  const pathspecs = paths.map((path) => `:(literal)${path}`);
  const diff = git(cwd, [...prefixes, 'diff', '--cached', '--', ...pathspecs]);
  return `Changed files:\n${paths.join('\n')}\n\n${diff.slice(0, DIFF_CAP)}`;
}

/** Why this commit deserves screenshots, or null when neither the paths nor the judge say so. */
function uiEvidenceReason(cwd: string): string | null {
  const cfg = resolveGuardConfig(cwd);
  const staged = stagedFiles(cwd);
  const byPath = uiPathReason(staged, cfg.uiEvidence.paths);
  if (byPath) return byPath;
  const input = judgeInput(cwd, staged);
  const verdict = input ? judgeUiVisible(cwd, input, resolveReviewModel(cfg)) : null;
  return verdict?.visible
    ? `the staged diff could change what users see${verdict.why ? `: ${verdict.why}` : ''}`
    : null;
}

/** Action first: the ship digest cuts a detail at 140 characters, so only the reason may be lost. */
export const instruction = (reason: string): string =>
  `Add before (base branch) and after (this branch) screenshots when you open or update the PR, or say there that nothing visible changed — ${reason}`;

/** The gate. Every unreadable input means silence: a reminder that cannot tell stays quiet. */
export function runUiEvidence(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): number {
  if (env.DEVKIT_RUN_MODE === 'review' || env.DEVKIT_RUN_MODE === 'dry-gates') return 0;
  let reason: string | null;
  try {
    reason = uiEvidenceReason(cwd);
  } catch {
    return 0;
  }
  if (!reason) return 0;
  const text = instruction(reason);
  console.error(`📸 ${UI_EVIDENCE}: ${text}`);
  emitAdvisoryResult(UI_EVIDENCE, 'finding', text);
  return 0;
}
