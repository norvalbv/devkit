export function isNonEmptyStringArray(value: unknown): value is string[];
export function stagedFilesOverride(): string[] | null;
export function authoritativeStagedFilesOverride(): string[] | null;
export function normalizeRepositoryFile(file: string, name?: string): string;
export interface ReviewPaths {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}
export interface ReviewPathsInput {
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
}
export function normalizeReviewPaths(
  value: ReviewPathsInput | undefined,
  name?: string,
): ReviewPaths | undefined;
export function selectReviewFiles(
  files: readonly string[],
  options: {
    paths?: ReviewPaths;
    roots: readonly string[];
    sourceExtensions: readonly string[];
  },
): string[];
export function normalizeReviewRoots(value: unknown, name: string): string[];
export function toGitPathspecs(roots: string[]): string[];
export function parseInjectedReviewRoots(name: string): string[] | null;
export function resolveConfigRoots(options: { configKey: string; reviewerName: string }): string[];
export function resolveReviewRoots(options: {
  envName: string;
  configKey: string;
  reviewerName: string;
}): string[];
export function assertStagedSetSane(pathspecs: string[], reviewerName: string): void;
