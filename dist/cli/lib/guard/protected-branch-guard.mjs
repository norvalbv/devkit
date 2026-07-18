/**
 * Protected-branch guard — core logic for the `devkit guard-branch` PreToolUse hook.
 *
 * When an agent runs a direct `git commit` whose TARGET repo is on a protected branch (main / any
 * X.Y.Z release branch), this DENIES it — but instead of a generic "use the ship script", it hands
 * back a COPY-PASTE-READY `devkit ship …` command (auto branch, the agent's own `-m` title, the
 * staged paths). So the agent never has to KNOW the ceremony: it just `git commit`s, gets the exact
 * command, and runs it. `git commit --pr <branch>` is translated to a re-push (`devkit ship … --pr`).
 *
 * Why DENY (not a silent rewrite): a PreToolUse `updatedInput` rewrite is honoured only by CC builds
 * that support it — an older one silently runs the RAW commit on the protected branch. DENY is
 * unconditionally effective and composes with the other deny-hooks. (Decision: parallel-commit-isolation.)
 *
 * FAIL-OPEN on every internal error (we parse JSON natively; a git error, detached/unborn HEAD, or
 * anything unexpected → allow). The deny is carried in the returned reason, never an exit code, so a
 * guard bug can never wedge the agent's Bash.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const DEFAULT_SHIP = 'devkit ship'; // a consuming repo overrides via .devkit/config.json → { ship: { command, extraArgs } }
const RELEASE_BRANCH = /^\d+\.\d+\.\d+$/; // X.Y.Z — a release branch is protected alongside main
const SLUG_MAX = 32;
// `git … commit` detection, ported from the bash guard: `git` must start a command segment (line
// start or after a shell separator), global flags + their args are skipped, and `commit` is the
// FIRST non-flag positional (so `commit-tree` / `git log --grep commit` don't false-match).
const FLAG = '-\\S+';
const ARG = `("[^"]*"|'[^']*'|[^-]\\S*)`;
const UNIT = `${FLAG}\\s+(${ARG}\\s+)?`;
const COMMIT_RE = new RegExp(`(^|[\\s;|&()\`])\\s*git\\s+(${UNIT})*commit([\\s]|$|[;|&"'\`])`);
// Hoisted parsing regexes (biome useTopLevelRegex). The /g ones are consumed via match/matchAll,
// which don't pollute lastIndex across calls.
const SEG_SPLIT = /&&|\|\||[;|&]/;
const GIT_COMMIT_RE = /\bgit\s.*\bcommit\b/;
const COMMIT_WORD_RE = /\bcommit\b/;
const TOKENS_RE = /(?:"[^"]*"|'[^']*'|\S)+/g; // rough shell tokens (keeps quoted runs whole)
const STAGE_ALL_RE = /^-[a-zA-Z]*a[a-zA-Z]*$/; // a short-flag bundle containing `a` (-a, -am, -na…)
// Plain "…" / '…' / a bare token, AND escaped \"…\": a commit built inside a nested shell
// arrives backslash-escaped, and without the escaped branch the title falls through to the
// bare-token case and truncates to the first whitespace-delimited word (a mangled PR title).
const MSG_RE = /(?:^|\s)(?:-m|--message)\s+(?:"([^"]*)"|'([^']*)'|\\"([^"]*)\\"|(\S+))/g;
const PR_RE = /(?:^|\s)--pr\s+(\S+)/;
/** Run git in <dir>; trimmed stdout, or null on any failure (never throws). */
function git(dir, args) {
    try {
        return execFileSync('git', ['-C', dir, ...args], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    }
    catch {
        return null;
    }
}
/**
 * The dir the commit targets: an explicit global `git -C <dir>` (before the subcommand) wins, else
 * cwd. Mirrors the bash guard — scopes `-C` to the commit's own invocation so `git commit -C <ish>`
 * (the reuse-message flag, AFTER commit) and a stray `-C` from a different git in a compound don't
 * hijack it.
 */
function targetDir(command, cwd) {
    const pre = '(?:-[A-Za-z]\\S*\\s+|--\\S+\\s+)*';
    const post = `\\s+(?:${UNIT})*commit`;
    for (const quoted of [`"([^"]*)"`, `'([^']*)'`, `([^\\s"']+)`]) {
        const m = command.match(new RegExp(`git\\s+${pre}-C\\s+${quoted}${post}`));
        if (m)
            return m[1];
    }
    return cwd;
}
/** Short branch of HEAD in <dir>, or null for unborn / detached / not-a-repo / any error (→ allow). */
function currentBranch(dir) {
    if (git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']) === null)
        return null; // unborn → allow
    return git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']) || null; // detached → '' → null
}
const isProtected = (branch) => branch === 'main' || RELEASE_BRANCH.test(branch);
/** Isolate the `git commit …` portion: the command segment containing it, from `commit` onward. */
function commitSegment(command) {
    const seg = command.split(SEG_SPLIT).find((s) => GIT_COMMIT_RE.test(s)) ?? command;
    const i = seg.search(COMMIT_WORD_RE);
    return i === -1 ? seg : seg.slice(i + 'commit'.length);
}
const REJECT_STAGE_ALL = '`-a`/`-am` stages all tracked changes — on a shared tree that sweeps in parallel work. Stage your files explicitly (`git add <files>`) and commit with `-m`.';
const REJECT_AMEND = '`--amend` rewrites history — not supported on a protected branch. Make a fresh commit with `-m`.';
const REJECT_FILE = 'commit-message-from-file (`-F`) is not supported here — use `-m "<title>"`.';
const REJECT_NO_MSG = 'commit with `-m "<title>"` on a protected branch (a bare `git commit` would open an editor the agent can\'t drive).';
/**
 * Parse the commit flags into a ship intent: { title, body, prBranch } on success, or
 * { reject: <fix-it message> } when the commit can't be safely translated (so the guard denies with
 * guidance rather than guessing). Reject: -a/-am/--all (shared-tree sweep), --amend / -F (out of the
 * ship model), and no -m (would open an editor).
 */
function parseCommit(seg) {
    const tokens = seg.match(TOKENS_RE) ?? [];
    for (const t of tokens) {
        if (STAGE_ALL_RE.test(t) || t === '--all')
            return { reject: REJECT_STAGE_ALL };
        if (t === '--amend')
            return { reject: REJECT_AMEND };
        if (t === '-F' || t === '--file')
            return { reject: REJECT_FILE };
    }
    const msgs = [...seg.matchAll(MSG_RE)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4]);
    if (msgs.length === 0)
        return { reject: REJECT_NO_MSG };
    const pr = seg.match(PR_RE);
    return { title: msgs[0], body: msgs.slice(1).join('\n\n'), prBranch: pr ? pr[1] : null };
}
/** Files in the index of <dir> (the explicit per-file ship scope), or [] on error. */
function stagedPaths(dir) {
    const out = git(dir, ['diff', '--cached', '--name-only']);
    return out ? out.split('\n').filter(Boolean) : [];
}
/** A repo's ship command + extra args, from .devkit/config.json (default `devkit ship`, no extras). */
function shipConfig(repoRoot) {
    try {
        const cfg = JSON.parse(readFileSync(join(repoRoot, '.devkit', 'config.json'), 'utf8'));
        const s = cfg?.ship;
        if (s && typeof s.command === 'string') {
            return { command: s.command, extraArgs: Array.isArray(s.extraArgs) ? s.extraArgs : [] };
        }
    }
    catch {
        /* absent / malformed → defaults */
    }
    return { command: DEFAULT_SHIP, extraArgs: [] };
}
/** POSIX single-quote a token so it copy-pastes safely (literal, no expansion). */
export const quoteShellToken = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
/** kebab slug of the title for the auto branch name. */
const slug = (title) => title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX) || 'change';
/**
 * Decide on a Bash tool input. Returns a deny-reason string (the copy-paste-ready ship command, or a
 * fix-it message) when the commit targets a protected branch, else null (allow / not our concern).
 * `rand` is injectable for deterministic tests; production uses a short random suffix to avoid branch
 * collisions across retries.
 */
export function decide(input, cwd, rand) {
    const command = input?.tool_input?.command;
    if (!command || !COMMIT_RE.test(command))
        return null; // not a git commit → allow
    const dir = targetDir(command, cwd);
    const branch = currentBranch(dir);
    if (!branch || !isProtected(branch))
        return null; // detached/unborn/feature branch → allow
    const intent = parseCommit(commitSegment(command));
    const head = `Blocked: direct \`git commit\` on protected branch "${branch}".`;
    const cfg = shipConfig(dir);
    if (intent.reject !== undefined) {
        return `${head}\n${intent.reject}\nThen re-run your commit — the guard will hand you a ready-to-run \`${cfg.command}\` command.`;
    }
    const paths = stagedPaths(dir);
    if (paths.length === 0) {
        return `${head}\nStage the files you mean first (\`git add <files>\`), then commit — the guard reads the staged set as the ship scope.`;
    }
    const pathArgs = paths.map(quoteShellToken).join(' ');
    const extras = cfg.extraArgs.length ? `${cfg.extraArgs.join(' ')} ` : '';
    // A multi-`-m` body is passed via `--body '<body>'` so the agent copy-pastes ONE clean command
    // (no stdin pipe, no temp file) and the body lands on the PR. quoteShellToken() single-quotes it
    // so embedded newlines / quotes / % / $ survive the paste; ship's --body takes precedence over stdin.
    const bodyArg = intent.body ? `--body ${quoteShellToken(intent.body)} ` : '';
    let ship;
    let note;
    if (intent.prBranch) {
        ship = `${cfg.command} ${quoteShellToken(intent.prBranch)} ${quoteShellToken(intent.title)} --pr ${bodyArg}${extras}-- ${pathArgs}`;
        note = `Adds these changes to the existing PR on \`${intent.prBranch}\` (fast-forward, never --force).`;
    }
    else {
        const suffix = rand ?? Math.random().toString(36).slice(2, 8);
        ship = `${cfg.command} ${quoteShellToken(`agent/${slug(intent.title)}-${suffix}`)} ${quoteShellToken(intent.title)} ${bodyArg}${extras}-- ${pathArgs}`;
        note =
            'Commits your staged files onto a fresh branch + opens a PR; the shared HEAD never moves. The PR URL is printed; to add more commits later, `git commit --pr <that-branch> -m "…"`.';
    }
    return `${head}\nRun this instead:\n  ${ship}\n${note}`;
}
