/**
 * At `devkit ship`, remind the agent to add before/after PR screenshots when the UI can change.
 * Advisory: always exits 0, no model call, silent outside ship (no DEVKIT_COMMIT_MSG_FILE).
 */
import { readFileSync } from 'node:fs';
import { matchesRepoGlob } from '../../skills/_devkit/review-roots.mjs';
import { resolveGuardConfig } from '../config.mts';
import { stagedFiles } from '../decisions/git-io.mts';
import { emitAdvisoryResult } from '../judge/advisory/emit.mts';

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

/** Whole words only: a hyphen also ends the token, so `ui-kit` or `layout-agnostic` never match. */
const SYMPTOM_RE =
  /(?<![\w-])(ui|display(?:s|ed|ing)?|visible|visual(?:ly)?|glitch(?:es|y)?|render(?:s|ed|ing)?|flicker(?:s|ing)?|misalign(?:ed|ment)?|layout|screen(?:s)?|blank page)(?![\w-])/i;

const PATHS_SHOWN = 3;

export function uiPaths(staged: string[], globs: string[]): string[] {
  const any = (path: string, list: string[]) => list.some((glob) => matchesRepoGlob(path, glob));
  return staged.filter((path) => any(path, globs) && !any(path, NON_UI_PATHS));
}

/** The symptom word the subject names, or null. The body is excluded: prose there is too noisy. */
export function symptomWord(message: string): string | null {
  const subject = message.split('\n', 1)[0] ?? '';
  return SYMPTOM_RE.exec(subject)?.[1] ?? null;
}

/** Why this ship deserves screenshots, or null when nothing points at the UI. */
export function uiEvidenceReason(
  staged: string[],
  message: string,
  globs: string[],
): string | null {
  const paths = uiPaths(staged, [...DEFAULT_UI_PATHS, ...globs]);
  if (paths.length > 0) {
    const more = paths.length > PATHS_SHOWN ? `, +${paths.length - PATHS_SHOWN} more` : '';
    return `UI paths changed: ${paths.slice(0, PATHS_SHOWN).join(', ')}${more}`;
  }
  const word = symptomWord(message);
  return word ? `the commit subject names a visible symptom ("${word}")` : null;
}

/** Action first: the ship digest cuts a detail at 140 characters, so only the reason may be lost. */
export const instruction = (reason: string): string =>
  `Add before (base branch) and after (this branch) screenshots to the PR description, or say there that nothing visible changed — ${reason}`;

/** The gate. Every unreadable input means silence: a reminder that cannot tell stays quiet. */
export function runUiEvidence(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): number {
  const msgFile = env.DEVKIT_COMMIT_MSG_FILE;
  if (!msgFile || env.DEVKIT_RUN_MODE === 'review' || env.DEVKIT_RUN_MODE === 'dry-gates') return 0;
  let reason: string | null;
  try {
    const globs = resolveGuardConfig(cwd).uiEvidence.paths;
    reason = uiEvidenceReason(stagedFiles(cwd), readFileSync(msgFile, 'utf8'), globs);
  } catch {
    return 0;
  }
  if (!reason) return 0;
  const text = instruction(reason);
  console.error(`📸 ${UI_EVIDENCE}: ${text}`);
  emitAdvisoryResult(UI_EVIDENCE, 'finding', text);
  return 0;
}
