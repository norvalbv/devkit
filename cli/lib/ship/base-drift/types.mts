/** The base-drift report shape — the one contract `base-status`, both hooks and ship share. */

/**
 * Whether the remote-tracking refs this report was computed from are known-current.
 *
 * There is deliberately no path from a failed fetch to `'fresh'`. Silence about a failure is
 * indistinguishable from "the base has not moved", and that indistinguishability is the incident
 * (sc-2297): an agent read a stale HEAD, concluded a migration did not exist, and told the user a
 * correct completeness finding was a hallucination.
 */
export type Freshness =
  /** This call fetched the base ref successfully. */
  | 'fresh'
  /** The TTL window was open, so no fetch was attempted. `ageMs` says how old the refs are. */
  | 'cached'
  /** A fetch was needed and failed (offline, auth, timeout, ref-lock contention, old git). */
  | 'unknown';

/** Which resolution tier answered. Mirrors the tiers in cli/lib/ship/origin-base.sh:27-45. */
export type BaseSource =
  /** `--base` argv or $DEVKIT_BASE_REF. Never falls through to a guess when it does not verify. */
  | 'explicit'
  /** refs/remotes/origin/HEAD, after rejecting a foreign-remote target and a dangling name. */
  | 'origin-head'
  | 'main'
  | 'master';

export type UnresolvableReason =
  | 'not-a-repo'
  | 'no-origin'
  | 'no-candidate'
  | 'explicit-missing'
  /** HEAD is unborn: there is no work here that could have been built on a stale base. */
  | 'no-commits'
  /** origin could not be reached, so whether this base exists is unknown — never reported as absent. */
  | 'fetch-failed'
  | 'unrelated-histories';

export type BaseResolution =
  | { kind: 'resolved'; base: string; ref: string; source: BaseSource; sha: string }
  /** `base` is carried when one was NAMED but could not be verified, so a note can still name it. */
  | { kind: 'unresolvable'; reason: UnresolvableReason; base?: string };

/**
 * One path that changed on the base since the merge-base.
 *
 * `status` is git's raw `--name-status` letter. It is not narrowed to a union: `R`/`C` are absent
 * only because the diff runs with --no-renames, and inventing an exhaustive set here would make an
 * unexpected letter from a future git a parse failure rather than a passthrough.
 */
export interface MovedPath {
  path: string;
  status: string;
}

/** The origin commit that last touched an overlapping path. Null when the attribution cap was hit. */
export interface Attribution {
  sha: string;
  short: string;
  date: string;
  subject: string;
}

export interface OverlapEntry extends MovedPath {
  /** The caller-supplied path that matched — the exact file, or the directory containing it. */
  matched: string;
  commit: Attribution | null;
  /**
   * Precomputed dedup token, `sha256(commonDir\0base\0baseSha\0path)`.
   *
   * The base SHA is an ingredient on purpose. A consumer that dedups on (session, path) alone goes
   * quiet after the first move and never reports the second — and sc-2297's base moved TWICE. With
   * the SHA folded in, a new base tip re-arms every path at once. Callers add their own session
   * scope; the core has no session concept.
   */
  rearm: string;
}

export interface BaseDriftReport {
  schema: 1;
  /** Absolute git toplevel of the checkout the report describes. */
  root: string;
  /**
   * Absolute `--git-common-dir`. Sibling worktrees of one clone share it, which is what lets them
   * share a single fetch window instead of each paying the network.
   */
  commonDir: string;
  base: BaseResolution;
  freshness: Freshness;
  /** Age of the refs in ms when `freshness` is `'cached'`; null otherwise. */
  ageMs: number | null;
  mergeBase: string | null;
  /**
   * `git rev-list --count HEAD..origin/<base>`. DIAGNOSTIC ONLY — never a trigger.
   *
   * In a shared parallel-agent checkout HEAD never advances as PRs merge, so this number only ever
   * grows. A signal keyed on it is permanently red and gets tuned out, which is the failure mode
   * sc-2297 describes (the session header, ship preflight, test runner and gates were all present
   * and all ignorable). The trigger is `overlap`, nothing else.
   */
  behind: number;
  moved: MovedPath[];
  /** `moved` filtered by the caller's paths. Equals `moved` when no paths were supplied. */
  overlap: OverlapEntry[];
  /** True when the attribution cap was hit, so some entries carry `commit: null`. */
  truncated: boolean;
  /**
   * Why every render function returns an empty string, or null when there is something to say.
   * Callers branch on this instead of re-deriving "is this worth printing" three different ways.
   */
  silent: null | 'unresolvable' | 'no-drift' | 'no-overlap' | 'undetermined';
}

export interface BaseDriftOptions {
  /** Any path inside the checkout; the real toplevel is resolved from it. */
  root: string;
  /** Explicit base branch. Beats $DEVKIT_BASE_REF, which beats the origin/HEAD + main/master tiers. */
  base?: string;
  /** Scope. Empty or omitted means report everything and decide nothing. */
  paths?: string[];
  /** 0 forces a fetch. Omitted uses the shared default window. */
  maxAgeMs?: number;
  fetchTimeoutMs?: number;
  maxAttributions?: number;
  /** Injectable for tests; the TTL marker namespace lives under here. */
  tmpDir?: string;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}
