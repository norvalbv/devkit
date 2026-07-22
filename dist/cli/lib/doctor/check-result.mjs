/**
 * The `devkit doctor` result primitive — one health signal, its verdict, and how to heal it.
 *
 * Lives here rather than in `cli/commands/doctor.mts` so that modules doctor itself IMPORTS can
 * return one without a cycle. `checkCommitMsgHook` previously had to restate the shape structurally
 * for exactly that reason; it now imports this instead.
 */
export function check(name, status, detail, remediation = '', fixable = false) {
    return { name, status, detail, remediation, fixable };
}
