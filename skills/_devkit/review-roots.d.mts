export function isNonEmptyStringArray(value: unknown): value is string[];
export function stagedFilesOverride(): string[] | null;
export function authoritativeStagedFilesOverride(): string[] | null;
export function normalizeRepositoryFile(file: string, name?: string): string;
export interface CorrectnessPaths {
  include: string[];
  exclude: string[];
}
export interface CorrectnessPathsInput {
  include?: string[];
  exclude?: string[];
}
export function normalizeCorrectnessPaths(
  value: CorrectnessPathsInput | undefined,
  name?: string,
): CorrectnessPaths | undefined;
export function selectCorrectnessFiles(
  files: string[],
  options: {
    correctnessPaths?: CorrectnessPaths;
    roots: string[];
    sourceExtensions: string[];
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
