/** Overlay's local `.devkit/hooks/commit-msg` (sc-1794): devkit's message judges from the global
 *  CLI, failing closed without it, then the repo's own commit-msg. Rationale: overlay-self-heal. */
import { chmodSync, closeSync, fstatSync, mkdirSync, openSync, statSync, readFileSync, renameSync, rmSync, writeFileSync, } from 'node:fs';
import { join } from 'node:path';
import { GATE_LOG_FINISH_PASS } from '../gate-policy/commit-gate-log.mjs';
import { buildCommitMsgBlock, COMMIT_MSG_PREAMBLE, commitMsgGuards } from '../commit-msg-block.mjs';
import { buildPassthroughHook, chainWord, GATES_ONLY_STOP } from '../husky-block.mjs';
const LOCAL_HOOK = join('.devkit', 'hooks', 'commit-msg');
const HOOK_MODE = 0o755;
// Text that LOOKS like a repo hook already calls a judge. Advisory only (a double-run warning): hook
// text cannot prove execution, so a selected judge is never omitted on its strength.
const JUDGE_SIGNATURES = {
    review: /guard-review["']?\s+completeness\s+--gate/,
    sentry: /guard-sentry["']?\s+--gate/,
};
/** The commit-msg guard ids a (repo-owned) hook body appears to call itself. */
export function judgesAlsoInRepoHook(hookContent) {
    return Object.entries(JUDGE_SIGNATURES)
        .filter(([, signature]) => signature.test(hookContent))
        .map(([id]) => id);
}
/** Judge block, then the chain. `exec` drops the EXIT trap, so clear the handoff first (a no-op in a
 *  monorepo, where the package subshell already cleared it). */
export function buildOverlayCommitMsgHook(selection, chainTarget, pkgRel = '') {
    const block = buildCommitMsgBlock(selection, pkgRel, 'global');
    const chain = chainWord(chainTarget); // single-quoted: a hooksPath with $(...) must not execute
    return `${COMMIT_MSG_PREAMBLE}
# devkit OVERLAY commit-msg (LOCAL, git-ignored): devkit's message judges, then the repo's OWN
# commit-msg unchanged. Global CLI; the commit is blocked when devkit is not installed.
${block}

# Judges passed — run the exit work now: \`exec\` replaces this process, so no EXIT trap fires after.
trap - EXIT
command -v __dk_clear_commit_state >/dev/null 2>&1 && { __dk_clear_commit_state || :; }
${GATE_LOG_FINISH_PASS}
${GATES_ONLY_STOP}

# Chain to the repo's own commit-msg (exec → its exit code becomes the hook's).
[ -f ${chain} ] && exec sh ${chain} "$@"
exit 0
`;
}
/** Decide what `.devkit/hooks/commit-msg` must contain (or that it must not exist). */
export function planOverlayCommitMsg({ gitRoot, scriptDir, existing, selection, pkgRel, }) {
    const chainTarget = `${scriptDir}/commit-msg`;
    const hasRepoHook = existing.includes('commit-msg');
    const judges = commitMsgGuards(selection.guards);
    if (judges.length) {
        let repoHook = '';
        try {
            repoHook = hasRepoHook ? readFileSync(join(gitRoot, chainTarget), 'utf8') : '';
        }
        catch {
            repoHook = ''; // unreadable: the warning is advisory, the judges run regardless
        }
        const alsoInRepo = judgesAlsoInRepoHook(repoHook).filter((id) => judges.includes(id));
        const content = buildOverlayCommitMsgHook({ guards: judges }, chainTarget, pkgRel);
        return { kind: 'judges', content, judges, alsoInRepo };
    }
    if (!hasRepoHook)
        return { kind: 'absent' };
    return { kind: 'passthrough', content: buildPassthroughHook(chainTarget) };
}
// One descriptor, content THEN mode: no check-then-use gap, and a chmod during the read is seen.
export function readHook(path, readFile = (fd) => readFileSync(fd, 'utf8')) {
    let fd;
    try {
        fd = openSync(path, 'r');
    }
    catch (e) {
        const code = e instanceof Error && 'code' in e ? e.code : undefined;
        if (code === 'ENOENT')
            return null;
        // Unreadable devkit hook (e.g. mode 0100): content unknown, so it can only be drift, never clean.
        if (code === 'EACCES')
            return unreadableHook(path);
        throw e;
    }
    try {
        const content = readFile(fd);
        return { content, mode: fstatSync(fd).mode & 0o777 };
    }
    finally {
        closeSync(fd);
    }
}
function unreadableHook(path) {
    try {
        return { content: null, mode: statSync(path).mode & 0o777 };
    }
    catch (e) {
        if (e instanceof Error && 'code' in e && e.code === 'ENOENT')
            return null;
        throw e;
    }
}
/** Publish a hook atomically: git may exec it mid-write, so never truncate the live file in place. */
export function writeHookAtomic(path, content) {
    mkdirSync(join(path, '..'), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, content);
    chmodSync(tmp, HOOK_MODE);
    renameSync(tmp, path);
}
/** Compare the hook (bytes AND its exact 0755 mode) with the plan and, unless dryRun, repair it.
 *  Returns the state seen BEFORE any write; `missing` = a hook is wanted and none exists. */
export function syncOverlayCommitMsg(input, { dryRun }) {
    const plan = planOverlayCommitMsg(input);
    const path = join(input.gitRoot, LOCAL_HOOK);
    const current = readHook(path);
    const expected = plan.kind === 'absent' ? null : plan.content;
    // Devkit writes exactly 0755; any other mode (0644, owner-less 0001, …) may leave git skipping the
    // hook silently, so it is drift even when the bytes match.
    const drift = (current?.content ?? null) !== expected || (current !== null && current.mode !== HOOK_MODE);
    const missing = expected !== null && current === null;
    if (!dryRun && drift) {
        if (expected === null)
            rmSync(path, { force: true });
        else
            writeHookAtomic(path, expected);
    }
    return { missing, drift, plan };
}
/** One human line describing the plan, for init / dry-run output. */
export function describeOverlayCommitMsg(plan) {
    if (plan.kind !== 'judges')
        return null;
    const name = (id) => (id === 'review' ? 'completeness' : id);
    const line = `commit-msg: devkit ${plan.judges.map(name).join(' + ')} judge(s) → then the repo's own commit-msg`;
    if (!plan.alsoInRepo.length)
        return line;
    return `${line} (the repo's commit-msg also appears to call ${plan.alsoInRepo.map(name).join(' + ')} — it will run twice; a cached PASS makes the repeat cheap)`;
}
/** Write every non-pre-commit overlay hook: commit-msg per the plan, the rest as pass-throughs (git
 *  runs only `.devkit/hooks`). Shared by install and doctor sync. */
export function syncOverlaySiblingHooks(input, { dryRun }) {
    const dir = join(input.gitRoot, '.devkit', 'hooks');
    for (const h of input.existing.filter((n) => n !== 'pre-commit' && n !== 'commit-msg')) {
        if (!dryRun)
            writeHookAtomic(join(dir, h), buildPassthroughHook(`${input.scriptDir}/${h}`));
    }
    return syncOverlayCommitMsg(input, { dryRun });
}
