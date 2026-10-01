/**
 * The local re-check line a failed deterministic gate prints (sc-3443): the gate's own argv, made
 * pasteable from the repo root. Kept beside run.mts, which renders it from the argv it just ran.
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';
// Shell-safe argv token: bare when it holds only characters no shell treats specially, else POSIX
// single-quoted. A repo path with a space is ordinary here (devkit self-hosts at one).
const SAFE_SHELL_ARG_RE = /^[\w@%+=:,./-]+$/;
function shellArg(token, forceQuote = false) {
    const bare = SAFE_SHELL_ARG_RE.test(token) && !forceQuote;
    return bare ? token : `'${token.replaceAll("'", "'\\''")}'`;
}
// argv[0] as the gate's execvp saw it. A PATH name goes through `env --` so no builtin, function or
// keyword intercepts it; `NAME=value` is quoted instead (env would read it as an assignment).
function commandWord(word) {
    if (word.includes('/'))
        return shellArg(word);
    return word.includes('=') ? shellArg(word, true) : `env -- ${shellArg(word)}`;
}
function realOrSelf(p) {
    try {
        return realpathSync(p);
    }
    catch {
        return p;
    }
}
// `p` relative to the first base containing it, else unchanged. cwd may sit behind a symlink while
// sibling modules are realpath'd (macOS /var → /private/var), so both spellings are tried.
function displayPath(p, bases) {
    for (const base of bases) {
        const rel = path.relative(base, p);
        if (rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) {
            return rel;
        }
    }
    return p;
}
/** A gate's argv as a pasteable line; only devkit's own module path is made repo-relative. */
export function recheckCommand(argv, moduleCwd) {
    if (argv.length === 0)
        return '';
    // Only argv[1] — the gate module devkit resolved itself — is relativised; repo-written args are exact.
    const bases = moduleCwd ? [...new Set([moduleCwd, realOrSelf(moduleCwd)])] : [];
    const words = argv.map((a, i) => (i === 1 && path.isAbsolute(a) ? displayPath(a, bases) : a));
    return [commandWord(words[0]), ...words.slice(1).map((w) => shellArg(w))].join(' ');
}
/** A registry gate's re-check line, plus anti-slop's documented short form. */
export function registryRecheck(g, argv, cwd) {
    const alias = g.id === 'anti-slop' ? `devkit ${g.args.join(' ')}` : undefined;
    return { recheck: recheckCommand(argv, cwd), alias };
}
/** The footer lines for one failed gate; none when it has no command (an unrunnable spec). */
export function recheckLines(failure, gate) {
    if (!gate.recheck)
        return [];
    const lines = [`     ${failure}: ${gate.recheck}`];
    if (gate.alias)
        lines.push(`       (documented form: ${gate.alias})`);
    return lines;
}
/** Footer lines after the aggregated failure: one re-check per failed gate, then ship's exact one. */
export function printRecheckFooter(rechecks) {
    if (rechecks.length === 0)
        return;
    console.error('   Re-check a fix locally (seconds, no judges) — stage it, then run:');
    for (const line of rechecks)
        console.error(line);
    // Only a new ship exports its exact command; `devkit review` and --pr also run with DEVKIT_SHIP=1.
    const shipCmd = process.env.DEVKIT_SHIP_DRY_GATES_CMD;
    if (!shipCmd)
        return;
    console.error("   Under devkit ship these are approximate: they judge YOUR checkout's staged index, not");
    console.error("   ship's briefed paths on a base-cut worktree. Ship's exact staging, no judges:");
    console.error(`     ${shipCmd}`);
}
