/** Overlay's local `.devkit/hooks/commit-msg` (sc-1794): devkit's message judges from the global
 *  CLI, failing closed without it, then the repo's own commit-msg. Rationale: overlay-self-heal. */
import { chmodSync, closeSync, fstatSync, lstatSync, mkdirSync, openSync, statSync, readFileSync, renameSync, writeFileSync, } from 'node:fs';
import { join } from 'node:path';
import { GATE_LOG_FINISH_PASS } from '../gate-policy/commit-gate-log.mjs';
import { buildCommitMsgBlock, COMMIT_MSG_PREAMBLE, commitMsgGuards } from '../commit-msg-block.mjs';
import { buildPassthroughHook, chainExec, GATES_ONLY_STOP, PASSTHROUGH_MARKER, } from '../husky-block.mjs';
const LOCAL_HOOK = join('.devkit', 'hooks', 'commit-msg');
const HOOK_MODE = 0o755;
/** Git's client hook names — the set husky writes a stub for. */
export const HUSKY_HOOKS = [
    'applypatch-msg',
    'pre-applypatch',
    'post-applypatch',
    'pre-commit',
    'pre-merge-commit',
    'prepare-commit-msg',
    'commit-msg',
    'post-commit',
    'pre-rebase',
    'post-checkout',
    'post-merge',
    'pre-push',
    'pre-auto-gc',
    'post-rewrite',
];
// Wrapped whether or not the repo has the hook: chainExec checks at run time, so a later hook runs.
const SIBLING_HOOKS = [...HUSKY_HOOKS, 'post-update'].filter((h) => h !== 'pre-commit' && h !== 'commit-msg');
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
export function buildOverlayCommitMsgHook(selection, chainTarget, pkgRel = '', gitRuns = false) {
    const block = buildCommitMsgBlock(selection, pkgRel, 'global');
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
${chainExec(chainTarget, gitRuns)}
exit 0
`;
}
/** Decide what `.devkit/hooks/commit-msg` must contain. */
export function planOverlayCommitMsg({ scriptDir, scriptsAbs, gitRuns, selection, pkgRel, }) {
    const chainTarget = `${scriptDir}/commit-msg`;
    const judges = commitMsgGuards(selection.guards);
    if (judges.length) {
        let repoHook = '';
        try {
            repoHook = readFileSync(join(scriptsAbs, 'commit-msg'), 'utf8');
        }
        catch {
            repoHook = ''; // absent or unreadable: the warning is advisory, the judges run regardless
        }
        const alsoInRepo = judgesAlsoInRepoHook(repoHook).filter((id) => judges.includes(id));
        const content = buildOverlayCommitMsgHook({ guards: judges }, chainTarget, pkgRel, gitRuns);
        return { kind: 'judges', content, judges, alsoInRepo };
    }
    return { kind: 'passthrough', content: buildPassthroughHook(chainTarget, gitRuns) };
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
    // Devkit writes exactly 0755; any other mode (0644, owner-less 0001, …) may leave git skipping the
    // hook silently, so it is drift even when the bytes match.
    const drift = current === null || current.content !== plan.content || current.mode !== HOOK_MODE;
    if (!dryRun && drift)
        writeHookAtomic(path, plan.content);
    return { missing: current === null, drift, plan };
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
/** A hook-named entry in `.devkit/hooks`: devkit's own (with its content and mode), absent, or
 *  foreign — anything devkit did not write, which it must never overwrite (git-lfs installs there). */
export function classifySibling(path) {
    try {
        if (!lstatSync(path).isFile())
            return { kind: 'foreign' };
        const hook = readHook(path);
        if (hook === null)
            return { kind: 'missing' };
        // Unreadable: whose it is cannot be told, so never rewrite it (the bytes may be a user's) — report it.
        if (hook.content === null)
            return { kind: 'unreadable' };
        if (hook.content.includes(PASSTHROUGH_MARKER))
            return { kind: 'owned', content: hook.content, mode: hook.mode };
        return { kind: 'foreign' };
    }
    catch (e) {
        // Any other error (an unsearchable hooks dir, EIO) must surface, never read as "not devkit's".
        if (e instanceof Error && 'code' in e && e.code === 'ENOENT')
            return { kind: 'missing' };
        throw e;
    }
}
/** One line naming an unreadable hook-named file: git cannot run it, and devkit will not touch it. */
export function describeUnreadableHook(name) {
    return `.devkit/hooks/${name} cannot be read, so git cannot run it and devkit cannot tell whose it is — restore read permission (chmod u+r) or delete it, then run \`devkit doctor --fix\``;
}
/** One line naming a hook-named file devkit left alone, for init and doctor. */
export function describeForeignHook(name, scriptDir) {
    return `.devkit/hooks/${name} is not devkit's, so devkit leaves it — git runs it in place of any ${scriptDir}/${name}`;
}
/** Write commit-msg per the plan and a pass-through for every other hook name; shared by install and
 *  doctor. Returns the state before any write: `stale` = missing or drifted, `foreign` = left alone. */
export function syncOverlaySiblingHooks(input, { dryRun }) {
    const dir = join(input.gitRoot, '.devkit', 'hooks');
    const stale = [];
    const foreign = [];
    const unreadable = [];
    for (const h of SIBLING_HOOKS) {
        const path = join(dir, h);
        const current = classifySibling(path);
        if (current.kind === 'foreign' || current.kind === 'unreadable') {
            (current.kind === 'foreign' ? foreign : unreadable).push(h);
            continue;
        }
        const expected = buildPassthroughHook(`${input.scriptDir}/${h}`, input.gitRuns);
        if (current.kind === 'owned' && current.content === expected && current.mode === HOOK_MODE)
            continue;
        stale.push(h);
        if (!dryRun)
            writeHookAtomic(path, expected);
    }
    return { ...syncOverlayCommitMsg(input, { dryRun }), siblings: { stale, foreign, unreadable } };
}
