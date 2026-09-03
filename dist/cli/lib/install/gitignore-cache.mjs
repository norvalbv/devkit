/**
 * .gitignore wiring for devkit's generated `.devkit/` state: ignore regenerated gate caches while
 * keeping durable manifests trackable even when a consumer carries a broad `.devkit/*` rule.
 *
 * `.devkit/` also holds tracked artifacts and local generated state. The tail rules briefly reopen
 * the parent, immediately re-ignore its children, then expose only explicitly durable paths.
 *
 * init (package/standalone) ensures these lines; clean prunes them. Overlay never uses this — there
 * the whole `.devkit/` is hidden via `.git/info/exclude`, so the caches are already invisible.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, rmdirSync, writeFileSync, } from 'node:fs';
import { join } from 'node:path';
import { check } from '../doctor/check-result.mjs';
// Each entry matches its writer verbatim: prefix-cache.mjs STORE_FILE, decisions/verdict-cache.mjs
// STORE_FILE, review/cache.mjs CACHE_FILE, review/run-review.mjs progress (DEVKIT_REVIEW_PROGRESS),
// review-target.sh's per-run output, commit-with-gate-capture.sh's log, reconcile-manifest-write,
// ship-intent.mts (which also PROBES the ignore with `git check-ignore` before writing, so the
// recorded PR body can never precede its own ignore line as a stageable untracked file).
export const DEVKIT_CACHE_IGNORES = [
    '.devkit/prefix-cache.json',
    '.devkit/decisions-verdict-cache.json',
    '.devkit/review-cache.json',
    '.devkit/sentry-verdict-cache.json',
    '.devkit/review-progress-*.json',
    '.devkit/review-runs/',
    '.devkit/last-ship-gates-*.log',
    '.devkit/ship-intent-*',
    '.devkit/reconcile-manifest.json',
    '.devkit/telemetry/',
    '.devkit/setup.json',
    '.devkit/anti-slop-baseline-upgrade.json',
    '.devkit/*.lock',
    // Not a cache — a LOCAL preference (adhd-session-start.mjs reads it as the durable off switch).
    // Ignored for the same reason the caches are: committing it would impose one reader's output
    // preference on everyone who clones the repo.
    '.devkit/adhd-off',
];
export const DEVKIT_TRACKED_UNIGNORES = [
    // Re-open the directory itself first: Git cannot re-include children of an excluded parent.
    '!.devkit/',
    '!.devkit/config.json',
    '!.devkit/skills-manifest.json',
    '!.devkit/agents-manifest.json',
    '!.devkit/agent-hooks-manifest.json',
    '!.devkit/agent-hook-registrations-manifest.json',
    '!.devkit/baselines/',
    '!.devkit/baselines/*.json',
    '!.devkit/baselines/*.mjs',
    '!.devkit/baselines/README.md',
    '!.devkit/baselines/structure/',
    '!.devkit/baselines/structure/*.mjs',
    '!.devkit/structure/',
    '!.devkit/structure/exempt.mjs',
    '!.devkit/biome/',
    '!.devkit/biome/**',
    '!.devkit/tsconfig/',
    '!.devkit/tsconfig/**',
    '!.devkit/anti-slop/',
    '!.devkit/anti-slop/**',
    '!.devkit/oxc/',
    '!.devkit/oxc/**',
    '!.devkit/vendored-skills/',
    '!.devkit/vendored-skills/**',
];
const DEVKIT_LOCAL_STATE_IGNORE = '.devkit/*';
const LEGACY_GITIGNORE_LINES = [
    '!.devkit/comment-firewall-rationales.json',
    '.devkit/comment-firewall-receipts.json',
];
const DEVKIT_GITIGNORE_LINES = [
    ...DEVKIT_CACHE_IGNORES,
    DEVKIT_LOCAL_STATE_IGNORE,
    ...DEVKIT_TRACKED_UNIGNORES,
    ...LEGACY_GITIGNORE_LINES,
];
const OBSOLETE_LINE_SET = new Set(LEGACY_GITIGNORE_LINES);
const MANAGED_TAIL_SET = new Set([...DEVKIT_TRACKED_UNIGNORES, DEVKIT_LOCAL_STATE_IGNORE]);
// Append cache rules and keep tracked-state negations at the effective tail (gitignore is last-match
// wins, so presence alone is insufficient when a consumer later appends a broad `.devkit/*` rule).
export function ensureDevkitCacheGitignore(cwd, dryRun) {
    if (dryRun) {
        const existing = readGitignore(cwd);
        const { next, additions } = withDevkitGitignoreLines(existing);
        if (next !== existing)
            console.log(`  [dry-run] ensure ${additions} devkit .gitignore line(s)`);
        return;
    }
    withGitignoreLock(cwd, () => ensureLocked(cwd));
}
function readGitignore(cwd) {
    const giPath = join(cwd, '.gitignore');
    return existsSync(giPath) ? readFileSync(giPath, 'utf8') : '';
}
/** The write itself — callers hold the lock. */
function ensureLocked(cwd) {
    const existing = readGitignore(cwd);
    const { next, additions } = withDevkitGitignoreLines(existing);
    if (next === existing)
        return;
    writeFileSync(join(cwd, '.gitignore'), next);
    console.log(`  ✓ ensured ${additions} devkit .gitignore line(s)`);
}
const GITIGNORE_LOCK = join('.devkit', 'gitignore.lock');
const LOCK_ATTEMPTS = 40;
const LOCK_RETRY_MS = 50;
/**
 * Run `fn` under `.devkit/gitignore.lock`. Exclusive among devkit writers: the holder pid is written
 * to a private file and LINKED into place, so acquisition is atomic and the lock is never observable
 * empty. A lock whose holder has died is NOT reclaimed automatically — every lock-free reclaim
 * protocol lets a delayed waiter remove a lock a faster one has just acquired — so the error names
 * the dead holder and the one command that clears it.
 */
export function withGitignoreLock(cwd, fn) {
    const lockPath = join(cwd, GITIGNORE_LOCK);
    const devkitDir = join(cwd, '.devkit');
    const hadDevkitDir = existsSync(devkitDir);
    mkdirSync(devkitDir, { recursive: true });
    const mine = `${lockPath}.${process.pid}`;
    // `wx`: create-exclusive, so a pre-planted symlink at this name can never be written THROUGH.
    rmSync(mine, { force: true });
    writeFileSync(mine, String(process.pid), { flag: 'wx' });
    let held = false;
    try {
        for (let attempt = 0; attempt < LOCK_ATTEMPTS && !held; attempt++) {
            try {
                linkSync(mine, lockPath);
                held = true;
            }
            catch (error) {
                const code = error instanceof Error && 'code' in error ? String(error.code) : '';
                if (code !== 'EEXIST')
                    throw error;
                const dead = deadHolder(lockPath);
                if (dead !== null) {
                    throw new Error(`${GITIGNORE_LOCK} is held by pid ${dead}, which no longer exists — remove the file (rm ${lockPath}) and re-run`);
                }
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MS);
            }
        }
    }
    finally {
        rmSync(mine, { force: true });
        if (!held && !hadDevkitDir)
            rmdirIfEmpty(devkitDir);
    }
    if (!held) {
        throw new Error(`${GITIGNORE_LOCK} is held by another devkit process; re-run when it finishes`);
    }
    try {
        fn();
    }
    finally {
        rmSync(lockPath, { force: true });
        // A `.devkit/` that exists only for this lock (a nested package's git root) must not outlive it.
        if (!hadDevkitDir)
            rmdirIfEmpty(devkitDir);
    }
}
function rmdirIfEmpty(dir) {
    try {
        rmdirSync(dir);
    }
    catch {
        return; // populated meanwhile: someone else's now
    }
}
/** The holder pid when it no longer exists; null while the holder is alive, unreadable, or gone. */
function deadHolder(lockPath) {
    let pid;
    try {
        pid = Number.parseInt(readFileSync(lockPath, 'utf8'), 10);
    }
    catch {
        return null; // released meanwhile, or unreadable: keep waiting
    }
    if (!Number.isInteger(pid) || pid <= 0)
        return null;
    try {
        process.kill(pid, 0); // signal 0: existence check only
        return null;
    }
    catch (error) {
        const code = error instanceof Error && 'code' in error ? String(error.code) : '';
        return code === 'ESRCH' ? pid : null;
    }
}
/** The managed lines applied to one snapshot of `.gitignore` — pure. */
function withDevkitGitignoreLines(existing) {
    const have = new Set(existing.split('\n').map((l) => l.trim()));
    const missingCaches = DEVKIT_CACHE_IGNORES.filter((line) => !have.has(line));
    const kept = existing
        .split('\n')
        .filter((line) => !MANAGED_TAIL_SET.has(line.trim()) && !OBSOLETE_LINE_SET.has(line.trim()))
        .join('\n');
    const additions = [...missingCaches, DEVKIT_LOCAL_STATE_IGNORE, ...DEVKIT_TRACKED_UNIGNORES];
    const separator = kept && !kept.endsWith('\n') ? '\n' : '';
    return { next: `${kept}${separator}${additions.join('\n')}\n`, additions: additions.length };
}
/** A concrete path each managed rule must ignore — a glob or directory rule needs a representative. */
function probePathFor(rule) {
    const base = rule.replace(/\*/g, 'probe');
    return base.endsWith('/') ? `${base}probe` : base;
}
/**
 * The managed cache rules Git does NOT currently ignore — asked of Git itself (`check-ignore`), so
 * rule order, later negations and stray whitespace are judged exactly as `ship-intent.mts`'s own
 * pre-write probe judges them. Throws when Git cannot answer (not a repository, git absent).
 */
export function missingDevkitCacheIgnores(cwd) {
    const probes = DEVKIT_CACHE_IGNORES.map(probePathFor);
    const r = spawnSync('git', ['-C', cwd, 'check-ignore', '--no-index', '-v', '-n', '-z', '--stdin'], {
        input: `${probes.join('\0')}\0`,
        encoding: 'utf8',
    });
    // 0 = at least one path ignored, 1 = none ignored; anything else is Git refusing to answer.
    if (r.error || (r.status !== 0 && r.status !== 1)) {
        throw new Error(`git check-ignore failed: ${r.error?.message ?? r.stderr.trim()}`);
    }
    // `-z`: `<source>\0<line>\0<pattern>\0<path>\0` per probe — a colon in a source path (an excludes
    // file) cannot shift the fields. A non-matching probe carries empty source/line/pattern, and a
    // match on a NEGATED pattern (`!…`) means the path is not ignored either.
    const fields = r.stdout.split('\0');
    const ignored = new Set();
    for (let i = 0; i + 3 < fields.length; i += 4) {
        const pattern = fields[i + 2] ?? '';
        const path = fields[i + 3] ?? '';
        if (pattern !== '' && !pattern.startsWith('!'))
            ignored.add(path);
    }
    return DEVKIT_CACHE_IGNORES.filter((rule) => !ignored.has(probePathFor(rule)));
}
/** Git's answer when it can give one, else the exact-line text — the single notion of "missing"
 *  that the check reports and the repair converges on. */
function missingByGitOrText(cwd) {
    try {
        return missingDevkitCacheIgnores(cwd);
    }
    catch {
        return missingDevkitCacheIgnoreLines(cwd);
    }
}
/** Textual fallback for a directory Git cannot answer for: exact, untrimmed line matches only. */
function missingDevkitCacheIgnoreLines(cwd) {
    let existing = '';
    try {
        existing = readFileSync(join(cwd, '.gitignore'), 'utf8');
    }
    catch {
        // absent or unreadable → every rule is missing
    }
    const have = new Set(existing.split('\n'));
    return DEVKIT_CACHE_IGNORES.filter((line) => !have.has(line));
}
export const CACHE_GITIGNORE_CHECK = 'devkit cache .gitignore';
/**
 * `doctor --fix`: make every managed rule take effect. `ensure` appends the lines that are absent;
 * a rule that is textually present but DEFEATED (a later negation, a stray leading space) is not
 * absent by that test, so those are re-asserted verbatim at the tail, where last-match-wins gives
 * them the final word. Converges by construction: the check asks Git, and Git honours the tail.
 */
export function repairDevkitCacheGitignore(cwd, results) {
    const row = results.find((r) => r.name === CACHE_GITIGNORE_CHECK);
    if (!(row?.fixable && row.status !== 'OK'))
        return;
    // One lock span for the whole repair: ensure, re-ask Git, re-assert — no other devkit writer can
    // move the file between the check and the tail write.
    withGitignoreLock(cwd, () => {
        ensureLocked(cwd);
        // Whatever the CHECK's notion of missing still reports after ensure (a defeated rule, or in a
        // non-repository a whitespace-mangled line ensure's trimmed dedup counted as present).
        const defeated = missingByGitOrText(cwd);
        if (defeated.length === 0)
            return;
        appendFileSync(join(cwd, '.gitignore'), `# devkit: re-asserted — a later rule above defeated these\n${defeated.join('\n')}\n`);
        console.log(`  ✓ re-asserted ${defeated.length} defeated devkit .gitignore rule(s) at the tail`);
    });
}
/** Doctor row: every managed cache rule IN EFFECT per Git (verbatim text outside a repository), else
 *  DRIFT — `ship-intent.mts` cannot record a resumable invocation without them (sc-2333). */
export function checkDevkitCacheGitignore(cwd) {
    // Not a repository (or no git): nothing can ship from there either, so the exact text is the best
    // available answer — untrimmed, since Git itself would not trim it.
    let missing = [];
    try {
        // Read under the writers' lock: `ensure` truncates and rewrites in place, and a doctor that
        // reads mid-write would report DRIFT against a file that is whole a moment later.
        withGitignoreLock(cwd, () => {
            missing = missingByGitOrText(cwd);
        });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return check(CACHE_GITIGNORE_CHECK, 'DRIFT', `could not read .gitignore: ${message}`, 're-run doctor once that devkit process finishes');
    }
    if (missing.length === 0) {
        return check(CACHE_GITIGNORE_CHECK, 'OK', `${DEVKIT_CACHE_IGNORES.length} managed rules in effect`);
    }
    return check(CACHE_GITIGNORE_CHECK, 'DRIFT', `${missing.length} managed rule(s) not in effect: ${missing.join(', ')}`, 'run `devkit doctor --fix` (adds the missing managed .gitignore lines and re-asserts defeated ones at the tail)', true);
}
/** `.gitignore` text without the managed lines, or null when none is present. */
function withoutManagedLines(raw) {
    const drop = new Set(DEVKIT_GITIGNORE_LINES);
    const lines = raw.split('\n');
    const kept = lines.filter((l) => !drop.has(l.trim()));
    return kept.length === lines.length ? null : kept.join('\n');
}
// Remove the generated-state lines from <root>/.gitignore (clean reversal). No-op when absent.
export function pruneDevkitCacheGitignore(root, dryRun) {
    const giPath = join(root, '.gitignore');
    if (!existsSync(giPath))
        return;
    if (dryRun) {
        if (withoutManagedLines(readFileSync(giPath, 'utf8')) !== null) {
            console.log('  [dry-run] prune devkit .gitignore lines');
        }
        return;
    }
    // Under the same lock as ensure/repair: a prune landing between their check and write would
    // otherwise leave the repair converged on a file that no longer holds what it re-asserted.
    withGitignoreLock(root, () => {
        const kept = withoutManagedLines(readFileSync(giPath, 'utf8'));
        if (kept === null)
            return;
        writeFileSync(giPath, kept);
        console.log('  ✓ pruned devkit .gitignore lines');
    });
}
