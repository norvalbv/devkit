// A workspace-write codex judge's cwd is always writable, so it runs in a throwaway dir rather than
// the consumer's checkout, where it could overwrite unstaged edits made during a long review.
import { closeSync, constants, copyFileSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { needsCodexWorkspace } from './result.mjs';
// Codex loads project docs from its cwd up to the git root. In the checkout it found only the
// root's; copying them keeps the confined judge's instructions identical.
const PROJECT_DOCS = ['AGENTS.md', 'AGENTS.override.md'];
/** Create the workspace when this argv routes to a workspace-write codex judge; a no-op otherwise. */
export function prepareCodexSandbox(args, { codexReadOnly = false, codexWritableFile }, cwd) {
    if (!needsCodexWorkspace(args, codexReadOnly))
        return { codexReadOnly, cleanup: () => { } };
    const repoRoot = resolve(cwd);
    const stateFile = codexWritableFile ? writableStateFile(repoRoot, codexWritableFile) : undefined;
    // Real path: macOS's tmpdir sits under the /var symlink, and codex refuses symlinked roots.
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'devkit-judge-')));
    const cleanup = () => removeScratch(scratch);
    try {
        for (const doc of PROJECT_DOCS)
            copyProjectDoc(join(repoRoot, doc), join(scratch, doc));
    }
    catch (error) {
        cleanup();
        throw error;
    }
    return { codexReadOnly, workspace: { scratch, repoRoot, stateFile }, cleanup };
}
// No-follow: a prior judge may have planted a link here, and the gate must not create its target.
const CREATE_NO_FOLLOW = constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW;
/** The state file's symlink-free path, created empty if absent: Linux bwrap drops missing roots. */
function writableStateFile(repoRoot, rel) {
    const abs = resolve(repoRoot, rel);
    const inside = relative(repoRoot, abs);
    if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside))
        throw new Error(`codex judge: state file ${rel} is not a file inside ${repoRoot}`);
    mkdirSync(dirname(abs), { recursive: true });
    const real = join(realpathSync(dirname(abs)), basename(abs));
    closeSync(openSync(real, CREATE_NO_FOLLOW));
    return real;
}
function removeScratch(scratch) {
    try {
        rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
    }
    catch {
        // A killed judge's grandchild may still hold a file; the OS reaps its temp dir.
    }
}
/** Copy one project doc; an absent doc (including one removed mid-copy) is the common case. */
function copyProjectDoc(from, to) {
    try {
        copyFileSync(from, to);
    }
    catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
            throw error;
    }
}
