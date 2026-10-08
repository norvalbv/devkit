// A workspace-write codex judge's cwd is always writable, so it runs in a throwaway dir rather than
// the consumer's checkout, where it could overwrite unstaged edits made during a long review.
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { needsCodexWorkspace } from './result.mjs';
// Codex loads project docs from its cwd up to the git root. In the checkout it found only the
// root's; copying them keeps the confined judge's instructions identical.
const PROJECT_DOCS = ['AGENTS.md', 'AGENTS.override.md'];
/** Create the workspace when this argv routes to a workspace-write codex judge; a no-op otherwise. */
export function prepareCodexSandbox(args, codexReadOnly, cwd) {
    if (!needsCodexWorkspace(args, codexReadOnly))
        return { codexReadOnly, cleanup: () => { } };
    const repoRoot = resolve(cwd);
    assertClaudeDirConfined(repoRoot);
    const scratch = mkdtempSync(join(tmpdir(), 'devkit-judge-'));
    const cleanup = () => removeScratch(scratch);
    try {
        for (const doc of PROJECT_DOCS)
            copyProjectDoc(join(repoRoot, doc), join(scratch, doc));
    }
    catch (error) {
        cleanup();
        throw error;
    }
    return { codexReadOnly, workspace: { scratch, repoRoot }, cleanup };
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
const isWithin = (child, parent) => {
    const rel = relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};
/** `--add-dir <repo>/.claude` must not widen to the checkout: a symlinked `.claude` may resolve
 * anywhere outside it (a worktree's projected copy), never onto or around it. */
function assertClaudeDirConfined(repoRoot) {
    const dir = join(repoRoot, '.claude');
    mkdirSync(dir, { recursive: true });
    const real = realpathSync(dir);
    const realRepo = realpathSync(repoRoot);
    if (real === join(realRepo, '.claude'))
        return;
    if (!isWithin(real, realRepo) && !isWithin(realRepo, real))
        return;
    throw new Error(`codex judge: ${dir} resolves to ${real}, so granting it would make the checkout writable — make .claude a directory, or a link outside the checkout`);
}
