/**
 * Delivery for the vendored i-have-adhd skill: devkit's OWN `.devkit/vendored-skills/` tree rather
 * than the consumer's `.claude/skills/`.
 *
 * Why not the agent skills dirs: those hold the consumer's hand-authored skills. A third-party copy
 * devkit vendors, pins by upstream SHA, and reclaims on deselection does not belong among them.
 * `.devkit/` is already devkit's namespace — `clean` removes that tree wholesale and the overlay
 * git-exclude already covers it — so this destination needs no removal or ignore machinery of its
 * own. The tradeoff is that `/i-have-adhd` no longer resolves as a slash command; the SessionStart
 * hook makes the skill always-on regardless, which is the only way it was ever meant to run
 * (the skill sets `disable-model-invocation`).
 *
 * The hook (agents-hooks/adhd-session-start.mjs) reads the skill from here.
 */
import { cpSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { detectGitRoot } from '../detect-git-root.mjs';
import { check } from '../doctor/check-result.mjs';
import { packageDir } from '../fs-helpers.mjs';
/** The vendored skill's dir name, in devkit's bundle and in the consumer repo alike. */
const ADHD_SKILL = 'i-have-adhd';
/**
 * Consumer-repo location of the vendored skill — the path the SessionStart hook reads. POSIX
 * separators deliberately: this string is also written verbatim into `.git/info/exclude`, which
 * takes forward slashes on every platform. `join` normalises it for filesystem use.
 */
export const ADHD_SKILL_DIR = `.devkit/vendored-skills/${ADHD_SKILL}`;
/**
 * Install the vendored skill when selected, reclaim it when not. Idempotent; reclaiming an absent
 * copy is a no-op.
 *
 * Deliberately no pristine check before removal: `.devkit/` is devkit-owned by contract and `clean`
 * already deletes the whole tree unconditionally, so honouring a local edit here — but not there —
 * would be the inconsistency rather than the safeguard.
 */
export function syncAdhdSkill(gitRoot, adhd, dryRun) {
    if (dryRun)
        return;
    const dest = join(gitRoot, ADHD_SKILL_DIR);
    if (!adhd) {
        rmSync(dest, { recursive: true, force: true });
        return;
    }
    cpSync(join(packageDir(), 'skills', ADHD_SKILL), dest, { recursive: true });
}
/**
 * Doctor's coverage for the vendored skill. The hook self-skips when the file is absent, so a
 * selected component whose skill went missing would otherwise fail silently — a session that simply
 * stops being ADHD-shaped, with nothing anywhere saying why.
 */
export function checkAdhdSkill(cwd) {
    const { gitRoot } = detectGitRoot(cwd);
    return existsSync(join(gitRoot, ADHD_SKILL_DIR, 'SKILL.md'))
        ? check('adhd skill', 'OK', ADHD_SKILL_DIR)
        : check('adhd skill', 'MISSING', `${ADHD_SKILL_DIR}/SKILL.md absent — the SessionStart hook injects nothing`, 'devkit doctor --fix', true);
}
