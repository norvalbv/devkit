export function isNonEmptyStringArray(value: unknown): value is string[];
export function normalizeReviewRoots(value: unknown, name: string): string[];
export function toGitPathspecs(roots: string[]): string[];
export function parseInjectedReviewRoots(name: string): string[] | null;
export function resolveConfigRoots(options: {
  configKey: string;
  reviewerName: string;
}): string[];
export function resolveReviewRoots(options: {
  envName: string;
  configKey: string;
  reviewerName: string;
}): string[];
