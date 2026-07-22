/**
 * The `devkit doctor` result primitive — one health signal, its verdict, and how to heal it.
 *
 * Lives here rather than in `cli/commands/doctor.mts` so that modules doctor itself IMPORTS can
 * return one without a cycle. `checkCommitMsgHook` previously had to restate the shape structurally
 * for exactly that reason; it now imports this instead.
 */

/** MISSING = not there at all · DRIFT = present but no longer matches what init wires · OK = healthy. */
export type CheckStatus = 'OK' | 'DRIFT' | 'MISSING';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  remediation: string;
  /** Whether `devkit doctor --fix` can heal this one (a baseline never is — it's cut once at init). */
  fixable: boolean;
}

export function check(
  name: string,
  status: CheckStatus,
  detail: string,
  remediation = '',
  fixable = false,
): CheckResult {
  return { name, status, detail, remediation, fixable };
}
