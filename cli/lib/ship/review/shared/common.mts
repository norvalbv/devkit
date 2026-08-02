/**
 * Shared helpers for the review runtime family (cli/lib/ship/review/**). Extracted when the
 * clone gate surfaced the same fail/errorMessage/objectValue/gitEnvironment bodies copy-pasted
 * across repository/, cache/, and the setup-manifest files (sc-1414). New review modules should
 * import from here instead of re-declaring.
 */

/** Uniform review-runtime failure: every thrown message carries the `devkit review:` prefix. */
export function fail(message: string): never {
  throw new Error(`devkit review: ${message}`);
}

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Assert a parsed JSON value is a plain object; `message` is the caller's exact failure text. */
export function objectValue(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(message);
  }
  return value as Record<string, unknown>;
}

/**
 * A GIT_*-stripped environment for spawning read-only git commands: inherited GIT_DIR /
 * GIT_INDEX_FILE etc. from an enclosing hook must never leak into children. Always forbids
 * opportunistic lock-taking (GIT_OPTIONAL_LOCKS=0); callers layer extra pins on top.
 */
export function gitEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('GIT_')) delete env[name];
  }
  return { ...env, GIT_OPTIONAL_LOCKS: '0', ...extra };
}
