// A workspace-write codex judge's cwd is always writable, so it runs in a throwaway dir rather than
// the consumer's checkout, where it could overwrite unstaged edits made during a long review.
import { closeSync, constants, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ensureCodexJudgeHome } from './home.mjs';
import { isCodexModel, needsCodexWorkspace, parseClaudeArgv } from './result.mjs';
/** Any codex judge gets its own home; a workspace-write one also a scratch cwd. Claude: a no-op. */
export function prepareCodexSandbox(args, { codexReadOnly = false, codexWritableFile }, cwd, ownerEnv = process.env) {
    if (!isCodexModel(parseClaudeArgv(args).model))
        return { codexReadOnly, cleanup: () => { } };
    // Before mkdtemp: a home that cannot be made must not leak a scratch dir.
    const env = { CODEX_HOME: ensureCodexJudgeHome(ownerEnv) };
    if (!needsCodexWorkspace(args, codexReadOnly))
        return { codexReadOnly, env, cleanup: () => { } };
    const repoRoot = resolve(cwd);
    const stateFile = codexWritableFile ? writableStateFile(repoRoot, codexWritableFile) : undefined;
    // Real path: macOS's tmpdir sits under the /var symlink, and codex refuses symlinked roots.
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'devkit-judge-')));
    return {
        codexReadOnly,
        env,
        workspace: { scratch, repoRoot, stateFile },
        cleanup: () => removeScratch(scratch),
    };
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
