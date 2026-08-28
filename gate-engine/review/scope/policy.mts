import { selectCorrectnessFiles } from '../../../skills/_devkit/review-roots.mjs';
import type { GuardConfig } from '../../config.mts';

export interface ReviewerDomain {
  domain: string;
}

const RE_PROSE_FILE = /\.(md|mdx|markdown|txt)$/i;
const PROSE_FILTERED_DOMAINS = new Set(['backend', 'frontend']);
const UNION_ROOT_DOMAINS = new Set(['all', 'conventions']);

/** The deduped union of every declared review root. */
export function declaredRoots(cfg: GuardConfig): string[] {
  return [...new Set([...cfg.scanRoots, ...cfg.review.backendRoots, ...cfg.review.frontendRoots])];
}

/** The config roots that trigger a reviewer's domain. */
export function rootsFor(reviewer: ReviewerDomain, cfg: GuardConfig): string[] {
  const directRoots = new Map([
    ['backend', cfg.review.backendRoots],
    ['frontend', cfg.review.frontendRoots],
  ]);
  const direct = directRoots.get(reviewer.domain);
  if (direct !== undefined) return direct;
  if (UNION_ROOT_DOMAINS.has(reviewer.domain)) return declaredRoots(cfg);
  return cfg.scanRoots;
}

export function underRoot(file: string, root: string): boolean {
  const normalizedRoot = root.endsWith('/') ? root.slice(0, -1) : root;
  if (normalizedRoot === '.') return true;
  return file === normalizedRoot || file.startsWith(`${normalizedRoot}/`);
}

function correctnessFiles(stagedFiles: string[], cfg: GuardConfig): string[] {
  return selectCorrectnessFiles(stagedFiles, {
    correctnessPaths: cfg.review.correctnessPaths,
    roots: declaredRoots(cfg),
    sourceExtensions: cfg.sourceExtensions,
  });
}

/** Current plus HEAD policy when guard.config.json changes, preventing same-commit self-exemption. */
export function correctnessReviewerFiles(
  stagedFiles: string[],
  cfg: GuardConfig,
  baselineCfg?: GuardConfig,
): string[] {
  const selected = new Set(correctnessFiles(stagedFiles, cfg));
  for (const file of baselineCfg ? correctnessFiles(stagedFiles, baselineCfg) : [])
    selected.add(file);
  return stagedFiles.filter((file) => selected.has(file));
}

export function domainReviewerFiles(
  reviewer: ReviewerDomain,
  stagedFiles: string[],
  cfg: GuardConfig,
  isSource: (file: string) => boolean,
): string[] {
  const roots = rootsFor(reviewer, cfg);
  let files = stagedFiles.filter((file) => roots.some((root) => underRoot(file, root)));
  if (PROSE_FILTERED_DOMAINS.has(reviewer.domain))
    files = files.filter((file) => !RE_PROSE_FILE.test(file));
  if (reviewer.domain === 'code')
    files = files.filter((file) => isSource(file.split('/').pop() ?? ''));
  return files;
}
