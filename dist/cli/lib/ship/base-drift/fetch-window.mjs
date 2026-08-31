/**
 * The TTL-bounded fetch. One fetch per (clone, base) per window, shared by every sibling worktree.
 *
 * Two properties here are load-bearing and easy to lose in a refactor:
 *
 * 1. The marker is written BEFORE the fetch. A hung remote then costs one stall per window per
 *    clone instead of one stall per edit — and this runs on the pre-edit path, so "per edit" would
 *    be intolerable.
 * 2. A failed fetch yields `'unknown'`, never `'fresh'`. There is no code path from failure to
 *    fresh. Reporting a green computed from unknown-age refs is precisely the false confidence
 *    sc-2297 is about.
 *
 * SIDE EFFECT, stated plainly: this mutates `refs/remotes/origin/<base>` in the SHARED clone, so a
 * sibling worktree's next report sees the newer tip. That is bounded to remote-tracking refs — no
 * local branch, no index, no HEAD, no checkout, so no sibling's working tree can be affected — and
 * it is what the rearm token wants anyway. It does not perturb `devkit ship`, which resolves its
 * own BASE from its own FETCH_HEAD (ship-branch.sh:298-303) and never from these refs.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, utimesSync, writeFileSync, } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ok } from './git-run.mjs';
/** Detection latency ceiling, traded against how often the pre-edit hook may reach the network. */
export const DEFAULT_TTL_MS = 120_000;
/** Past any realistic handshake, under any interactive patience. A miss degrades to 'unknown'. */
export const DEFAULT_FETCH_TIMEOUT_MS = 2_500;
function shortHash(value) {
    return createHash('sha256').update(value).digest('hex').slice(0, 12);
}
/**
 * Where the window marker for one (clone, base) pair lives.
 *
 * Keyed on the COMMON git dir, not the worktree path: sibling worktrees of one clone share the
 * refs a fetch updates, so they must share the window that decides whether to pay for it.
 *
 * The base is HASHED rather than interpolated for the reason prior-art-gate.mjs:52-53 gives about
 * session ids — it arrives from argv or the environment, and a path-shaped value would otherwise
 * escape the namespace directory. $TMPDIR rather than .git/ because this is machine-local
 * ephemeral state in a repo devkit does not own (W-3), and the OS reaps it.
 */
export function markerPathsFor(commonDir, base, tmp = tmpdir()) {
    let real = commonDir;
    try {
        real = realpathSync(commonDir);
    }
    catch {
        // A stable wrong key still isolates the namespace; only sharing between clones would be lost.
    }
    const dir = join(tmp, 'devkit-base-drift');
    const key = join(dir, `${shortHash(real)}-${shortHash(base)}`);
    // TWO files, because they answer different questions and one must never overwrite the other.
    // `attempt` rate-limits; `done` proves the refs were actually updated. With a single file, an
    // agent starting a fetch would stamp over a sibling's completed proof, and its own failure would
    // then discard a refresh that really happened.
    return { dir, attempt: `${key}.attempt`, done: `${key}.done` };
}
/**
 * What the window marker currently says.
 *
 * The `done` half is what stops a concurrent reader mistaking an IN-FLIGHT refresh for current
 * refs: agent A stamps and then spends up to the fetch timeout on the network, and during that
 * time the refs are still the pre-fetch ones. A reader that saw only the timestamp would report
 * them as cached — and answer "no drift" from exactly the stale state this feature exists to catch.
 */
/** A marker's recorded body, or null when it is absent or unreadable. */
function bodyOf(path) {
    try {
        const body = readFileSync(path, 'utf8').trim();
        return body === '' ? null : body;
    }
    catch {
        return null;
    }
}
/** A marker's mtime, or null when it is absent or dated in the future. */
function mtimeOf(path) {
    try {
        return existsSync(path) ? statSync(path).mtimeMs : null;
    }
    catch {
        return null;
    }
}
function ageOf(path, now) {
    const mtimeMs = mtimeOf(path);
    if (mtimeMs === null)
        return null;
    // A marker dated in the FUTURE — a clock rollback, or a $TMPDIR restored from elsewhere — is
    // evidence of nothing. Clamping its age to 0 would keep `age < ttl` true until wall-clock
    // caught up, holding the window open past its ceiling and suppressing every refresh in between.
    // Reporting no window instead costs one extra fetch and cannot suppress one.
    return mtimeMs > now ? null : now - mtimeMs;
}
export function windowState(markers, now, maxAgeMs) {
    const ageMs = ageOf(markers.attempt, now);
    const doneAge = ageOf(markers.done, now);
    if (doneAge === null || (maxAgeMs > 0 && doneAge >= maxAgeMs))
        return { ageMs, done: false };
    // The completion must name the attempt it certifies, by an id no other attempt can share. A
    // clock cannot supply that: two attempts inside one mtime tick are indistinguishable, so a
    // previous window's completion could certify a refresh that is still in flight.
    const attemptId = bodyOf(markers.attempt);
    return { ageMs, done: attemptId !== null && bodyOf(markers.done) === attemptId };
}
function stamp(path, dir, now, body = '') {
    try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(path, body);
        // writeFileSync sets mtime from the real clock; tests inject `now`, so pin it explicitly or a
        // fake-clock assertion would measure wall time instead of the injected value.
        const seconds = now / 1000;
        utimesSync(path, seconds, seconds);
    }
    catch {
        // Unwritable $TMPDIR: every call then fetches. Slower, never wrong.
    }
}
/**
 * Refresh `refs/remotes/origin/<base>` if the window has expired, and report which of the three
 * freshness states now holds.
 *
 * --no-write-fetch-head is MANDATORY, not hygiene. ship-branch.sh:298-303 runs `git fetch` and then
 * reads `git rev-parse FETCH_HEAD` to pin the commit its ephemeral worktree is cut from. FETCH_HEAD
 * is per-worktree, so only a fetch in the SAME worktree can collide — which is exactly what a
 * PreToolUse hook firing during a ship would be. Without the flag that hook silently repoints the
 * ship's base. On git <2.29 the flag is unknown, the fetch exits non-zero, and this degrades to
 * 'unknown': loud and harmless, which is the right direction to fail.
 *
 * The refspec is a single forced branch. `+` so a force-push on the base still updates instead of
 * failing non-fast-forward; one explicit refspec plus --no-tags so nothing else in the shared
 * clone's ref space is touched or pruned.
 */
export function refreshWindow(run, opts) {
    const markers = markerPathsFor(opts.commonDir, opts.base, opts.tmpDir);
    const state = windowState(markers, opts.now, opts.maxAgeMs);
    const open = opts.maxAgeMs > 0 && state.ageMs !== null && state.ageMs < opts.maxAgeMs;
    if (open) {
        return state.done
            ? { freshness: 'cached', ageMs: state.ageMs }
            : { freshness: 'unknown', ageMs: state.ageMs };
    }
    // A fresh id per attempt: what the completion below will name, and what makes any OTHER agent's
    // completion unable to certify this one.
    const attemptId = randomUUID();
    stamp(markers.attempt, markers.dir, opts.now, attemptId);
    const result = run([
        'fetch',
        '--quiet',
        '--no-tags',
        '--no-write-fetch-head',
        'origin',
        `+refs/heads/${opts.base}:refs/remotes/origin/${opts.base}`,
    ], { timeoutMs: opts.timeoutMs });
    if (!ok(result))
        return { freshness: 'unknown', ageMs: state.ageMs };
    // A SEPARATE file naming the attempt it certifies, so this proof survives another agent starting
    // its own attempt and cannot be mistaken for a certification of theirs.
    stamp(markers.done, markers.dir, opts.now, attemptId);
    return { freshness: 'fresh', ageMs: 0 };
}
