/**
 * Doctor-time judge-family binding — the sanctioned replacement for a runtime `review.family`
 * preset (sc-2193). The machine's resolvable binaries are knowable at doctor time, so the family
 * choice is bound ONCE, into the consumer's guard.config.json, instead of re-derived per spawn or
 * silently swapped at outage time (runtime cross-family fallback stays rejected: it moves spend to
 * an unwatched subscription and its verdicts sit outside the model-keyed cache salt).
 *
 * Only one direction can ever fire: the package defaults are the codex family, so a bind happens
 * exactly when codex is unresolvable, claude resolves, and the effective values come from package
 * DEFAULTS. Explicit review.* keys — which resolveGuardConfig collapses into the same resolved
 * values — block the write (raw-file check) and stay authoritative, as do GUARD_* envs.
 *
 * The family unit is the complete SET including correctnessChunkLoc: cap 400 was benched for
 * gpt-5.6-sol only, so a trio-only bind would run a sonnet correctness reviewer chunked at an
 * un-benched cap (docs/decisions/correctness-chunking-ships-dark.md, 2026-08-28 note).
 */
import { accessSync, closeSync, constants, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync, } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { readJson } from '../../fs-helpers.mjs';
import { check } from '../check-result.mjs';
export const CLAUDE_RUNTIME_CHECK = 'claude judge runtime';
export const FAMILY_STALE_CHECK = 'judge family pin';
export const FAMILY_PROVENANCE_KEY = '//judgeFamily';
export const FAMILY_PROVENANCE_TEXT = 'claude family bound by devkit doctor --fix (codex binary was unresolvable). Explicit edits and GUARD_* envs win; delete these four keys to return to package defaults.';
/** The complete claude family set — matches guard.config.example.json's documented claude-era
 * values, chunking off included (cap 400 is benched for gpt-5.6-sol, not sonnet). */
export const CLAUDE_FAMILY_SET = {
    model: 'haiku',
    escalationModel: 'opus',
    correctnessModel: 'sonnet',
    correctnessChunkLoc: 0,
};
const FAMILY_KEYS = ['model', 'escalationModel', 'correctnessModel', 'correctnessChunkLoc'];
/** A bind is a sub-second synchronous operation; a lock older than this belongs to a dead process. */
const STALE_LOCK_MS = 10_000;
const executable = (abs) => {
    try {
        accessSync(abs, constants.X_OK);
        return statSync(abs).isFile();
    }
    catch {
        return false;
    }
};
/** Same resolution the judge spawn applies: an explicit pin wins, else a PATH search. Relative
 * PATH entries resolve against the CONSUMER cwd — where the judge spawns — never doctor's own. */
export function binResolvable(name, cwd) {
    if (name === 'codex' && process.env.GUARD_CODEX_BIN)
        return executable(resolve(cwd, process.env.GUARD_CODEX_BIN));
    return (process.env.PATH ?? '/usr/bin:/bin')
        .split(':')
        .some((d) => executable(resolve(cwd, d === '' ? '.' : d, name)));
}
function rawReview(cwd) {
    try {
        const raw = readJson(join(cwd, 'guard.config.json'));
        const review = raw?.review;
        return review ? review : null;
    }
    catch {
        return null;
    }
}
/** Family keys literally present in the raw file — the one place an explicit choice survives
 * resolveGuardConfig's collapse of explicit-vs-default (the indexPathKeyPresent idiom). */
export function explicitFamilyKeys(cwd) {
    const review = rawReview(cwd);
    if (!review)
        return [];
    try {
        return FAMILY_KEYS.filter((k) => k in review);
    }
    catch {
        return [];
    }
}
const MODEL_ENVS = [
    'GUARD_REVIEW_MODEL',
    'FRINK_REVIEW_MODEL',
    'GUARD_REVIEW_ESCALATION_MODEL',
    'GUARD_CORRECTNESS_MODEL',
    'GUARD_CORRECTNESS_CHUNK',
];
/** Env overrides outrank anything devkit writes, so a bind under one repairs nothing: the DRIFT is
 * driven by the env-resolved model and the written keys would sit inert beneath it. */
export function modelEnvOverridesActive() {
    return MODEL_ENVS.some((k) => Boolean(process.env[k]?.trim()));
}
// The provenance key counts as claimed too: an operator note under it would silently shadow the
// marker the stale-pin detector matches on.
const familyKeysAbsent = (review) => {
    try {
        return !FAMILY_KEYS.some((k) => k in review) && !(FAMILY_PROVENANCE_KEY in review);
    }
    catch {
        return false;
    }
};
/** Can `doctor --fix` bind the claude family here? Owns EVERY precondition, codex included —
 * callers hold no facts the writer trusts. */
export function claudeBindable(cwd) {
    if (binResolvable('codex', cwd) || !binResolvable('claude', cwd) || modelEnvOverridesActive())
        return false;
    const review = rawReview(cwd);
    return review !== null && familyKeysAbsent(review);
}
export function bindClaudeFamily(cwd) {
    if (binResolvable('codex', cwd) || !binResolvable('claude', cwd) || modelEnvOverridesActive())
        return false;
    const path = join(cwd, 'guard.config.json');
    // Writer exclusion: an atomically-created lockfile (`wx`) carrying this binder's OWNERSHIP TOKEN.
    // A held lock aborts, never waits. A lock older than STALE_LOCK_MS is broken (one crash cannot
    // wedge future binds); the token makes a takeover safe — a binder whose lock was stolen fails its
    // own pre-rename token check and aborts, it can never delete the taker's lock or publish over it.
    const lock = `${path}.devkit-lock`;
    const token = `${process.pid}:${Date.now()}`;
    const acquire = () => {
        try {
            const fd = openSync(lock, 'wx');
            writeSync(fd, token, 0, 'utf8');
            return fd;
        }
        catch {
            return null;
        }
    };
    let lockFd = acquire();
    if (lockFd === null) {
        try {
            if (Date.now() - statSync(lock).mtimeMs < STALE_LOCK_MS)
                return false;
            unlinkSync(lock);
            // The dead binder's staged leftovers go with its lock — nothing else ever reaps them.
            for (const orphan of readdirSync(cwd).filter((n) => n.startsWith(`${basename(lock)}.`))) {
                try {
                    unlinkSync(join(cwd, orphan));
                }
                catch {
                    // Already gone — fine.
                }
            }
        }
        catch {
            return false;
        }
        lockFd = acquire();
        if (lockFd === null)
            return false;
    }
    const ownsLock = () => {
        try {
            return readFileSync(lock, 'utf8') === token;
        }
        catch {
            return false;
        }
    };
    // The staged path is per-binder, so even a mid-takeover loser can only ever rename bytes it
    // finished writing itself — a torn intermediate can never become guard.config.json.
    const tmp = `${lock}.${token.replace(':', '-')}.staged`;
    try {
        const snapshot = readFileSync(path, 'utf8');
        let raw;
        try {
            // SAFETY: the parsed shape is range-checked below — a null document, missing review
            // object, or claimed family/provenance key aborts the bind without writing.
            raw = JSON.parse(snapshot);
        }
        catch {
            return false;
        }
        const review = raw?.review;
        if (!raw || !review || !familyKeysAbsent(review))
            return false;
        const next = {
            ...raw,
            review: { [FAMILY_PROVENANCE_KEY]: FAMILY_PROVENANCE_TEXT, ...CLAUDE_FAMILY_SET, ...review },
        };
        writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
        // Last-instant guards before the atomic swap: the lock must still carry OUR token (a stale
        // takeover means we lost), and the file must be byte-identical to the parsed snapshot (a
        // writer outside the lock protocol — a hand editor — wins). The residual compare→rename span
        // is the narrowest the filesystem allows without a lock every writer honors.
        if (!ownsLock() || readFileSync(path, 'utf8') !== snapshot)
            return false;
        renameSync(tmp, path);
        return true;
    }
    catch {
        return false;
    }
    finally {
        closeSync(lockFd);
        try {
            unlinkSync(tmp);
        }
        catch {
            // Normally gone by rename — the desired end state.
        }
        // Release only a lock that is still ours: after a takeover, the taker owns the path.
        if (ownsLock()) {
            try {
                unlinkSync(lock);
            }
            catch {
                // Already gone — the desired end state.
            }
        }
    }
}
/** The review fleet is wider than the configured trio: the completeness judge is pinned to a
 * claude model, so a codex-only machine passes every model-derived check and then fails closed on
 * the LAST ship gate. Real drift, named before the ship. */
export function claudeRuntimeResult(cwd) {
    if (binResolvable('claude', cwd))
        return null;
    return check(CLAUDE_RUNTIME_CHECK, 'DRIFT', 'the completeness judge is pinned to a claude model, but no claude binary resolves (PATH) — every strict ship fails closed on the final gate', 'install the claude CLI; the completeness judge always runs on it regardless of review.model');
}
/** A devkit-written claude pin whose reason has expired: codex resolves again, but the
 * both-binaries-present rule keeps the written set forever. Advisory — clearing it is a choice. */
export function familyStaleResult(cwd) {
    const review = rawReview(cwd);
    // The EXACT marker devkit writes — a user-authored note under the same key is not a devkit pin.
    if (review?.[FAMILY_PROVENANCE_KEY] !== FAMILY_PROVENANCE_TEXT || !binResolvable('codex', cwd))
        return null;
    return check(FAMILY_STALE_CHECK, 'DRIFT', 'guard.config.json carries a devkit-written claude family pin, but codex now resolves — the pin has outlived the outage that justified it', 'delete the four review model keys (and //judgeFamily) to return to package defaults, or keep them as a deliberate choice and delete only //judgeFamily', false, true);
}
