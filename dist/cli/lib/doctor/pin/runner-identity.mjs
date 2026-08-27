/**
 * Which devkit is RUNNING, and is it the one this repo pinned?
 *
 * Why this exists. `.devkit/oxc/*` is version-coupled: `syncOxcCapabilityUnlocked` writes the base
 * from `baseContent()` — a template bundled in the RUNNING binary — and stamps its digest, while
 * `oxcBaseCapabilityIssue` recomputes that digest from the RUNNING binary. Two devkit versions
 * therefore rewrite each other's managed bytes, each declaring the other's stale. Reported as
 * sc-2100: a global 0.55.1 "fixing" a repo pinned at 0.55.3 dropped the newer probe global, so the
 * pinned gate kept refusing — and the drift message re-prescribed the very command that caused it,
 * naming no version and no particular binary.
 *
 * The ruling: an OLDER runner never writes managed state. `doctor --fix` HANDS OFF to the repo's
 * own pinned binary rather than refusing outright, because a remedy devkit prints must be one
 * devkit can perform (docs/decisions/overlay-self-heal.md, Target 2026-08-05, exists precisely
 * because `doctor --fix` once named a repair it only warned about). Refusal is the last resort, for
 * when no pinned binary resolves at all.
 *
 * Everything here is local: no network, no registry. In particular the remediation NEVER emits a
 * bare `bunx devkit` — `devkit` is an unrelated public npm package, and bunx falls through to the
 * registry in exactly the case this message is printed for (a missing or broken local install).
 * devkit executes inside repos it does not own, so it must not tell them to run a stranger's code.
 */
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { cmpSemver, DEP } from '../../../commands/update.mjs';
import { detectGitRoot } from '../../detect-git-root.mjs';
import { packageDir, readJson } from '../../fs-helpers.mjs';
import { check } from '../check-result.mjs';
import { devkitDepRef } from './pin-checks.mjs';
const SEMVER = /^\d+\.\d+\.\d+$/;
// Anchored at the end: only a bare release tag is an orderable pin — see `declaredPin`.
const DECLARED_TAG = /#v(\d+\.\d+\.\d+)$/;
const BIN_REL = join('node_modules', '.bin', 'devkit');
const INSTALLED_DIR_REL = join('node_modules', '@norvalbv', 'devkit');
const INSTALLED_PKG_REL = join(INSTALLED_DIR_REL, 'package.json');
const DEFAULT_ENTRY = join('dist', 'cli', 'index.mjs');
// Windows writes devkit.cmd BESIDE the extensionless POSIX script, so both exist and only the .cmd
// is runnable there — order by platform rather than by existence, or the printed remedy is a
// command the reader's own shell cannot execute. POSIX never wants the .cmd.
const BIN_DISPLAY_NAMES = process.platform === 'win32' ? ['devkit.cmd', 'devkit'] : ['devkit'];
/** Set on a delegated child so it repairs instead of handing off again. */
export const DELEGATED_ENV = 'DEVKIT_SKEW_DELEGATED';
/** Visible opt-out (docs/decisions/gate-opt-out-is-visible-and-detectable.md). */
export const ALLOW_SKEW_ENV = 'DEVKIT_ALLOW_SKEWED_FIX';
function readConfig(cwd) {
    try {
        return readJson(join(cwd, '.devkit', 'config.json')) ?? {};
    }
    catch {
        return {}; // a hand-edited config must not crash a write path; `unknown` never refuses
    }
}
// cwd first, then the git root: a monorepo package dir declares/installs devkit at the root, which
// is the same fallback `findLock` (pin-checks.mts) already makes for bun.lock.
function roots(cwd) {
    const { gitRoot } = detectGitRoot(cwd);
    return gitRoot === cwd ? [cwd] : [cwd, gitRoot];
}
/**
 * Overlay's pin, from the `devkitRef` init writes as `v${version}`. The leading `v` is REQUIRED, the
 * same way package mode anchors on `#v<semver>`: without it a branch named `1.2.3` would read as a
 * release and refuse a runner over a skew that does not exist.
 */
function overlayPin(ref) {
    return ref?.startsWith('v') ? semver(ref.slice(1)) : undefined;
}
/** The greater of two resolved pins — see `runnerSkew` for why the maximum is the requirement. */
function higher(a, b) {
    if (!a || !b)
        return a ?? b;
    return cmpSemver(a, b) >= 0 ? a : b;
}
/** Narrow a declared version string to one we can actually order. */
function semver(value) {
    return value !== undefined && SEMVER.test(value) ? value : undefined;
}
/** The version of the devkit executing right now. Works in both source and dist layouts. */
function runningVersion() {
    return semver(readJson(join(packageDir(), 'package.json'))?.version);
}
/**
 * The installed devkit AND its bin, resolved from the SAME root. Traversing the two independently
 * let a monorepo package dir validate against the git root's install while handing off to a stale
 * package-local binary — a delegation to code that is not the version we just approved.
 */
function installedAt(cwd) {
    let versionOnly = {};
    for (const root of roots(cwd)) {
        const pkgDir = join(root, INSTALLED_DIR_REL);
        const version = semver(readJson(join(root, INSTALLED_PKG_REL))?.version);
        if (!version)
            continue;
        const entry = entrypoint(pkgDir);
        // A root with a SPAWNABLE entrypoint wins outright. A manifest with no entry is only a
        // fallback — a partial package-local install must not mask a complete one further up, or a
        // monorepo `--fix` refuses while a perfectly good hand-off target sits at the git root.
        if (entry)
            return { version, entry, bin: displayBin(root) };
        versionOnly = versionOnly.version ? versionOnly : { version };
    }
    return versionOnly;
}
/**
 * What package.json ASKS for. Anchored deliberately, unlike the shared `pinnedVersion` this once
 * borrowed: that regex is unanchored, so `#v1.2.3-feature` — a perfectly ordinary BRANCH name —
 * reads as the release `1.2.3` and a running `1.2.2` gets refused for a skew that does not exist.
 * A ref we cannot order must fall through to `unknown`, which proceeds, never to a false refusal.
 */
function declaredPin(cwd) {
    for (const root of roots(cwd)) {
        const version = devkitDepRef(root)?.match(DECLARED_TAG)?.[1];
        if (version)
            return version;
    }
    return undefined;
}
function isFile(path) {
    try {
        return statSync(path).isFile();
    }
    catch {
        return false; // absent, or not a file
    }
}
/**
 * The pinned package's own JS entrypoint — NOT `node_modules/.bin/devkit`.
 *
 * The bin directory is a platform shim: on POSIX it is a shell script, on Windows bun writes
 * `devkit.cmd` beside an extensionless script Node cannot spawn at all (and `accessSync(X_OK)` is
 * a no-op there, so the unusable one still looks executable). Spawning a `.cmd` needs a shell,
 * which would put user-supplied argv through shell interpretation in a tool that runs inside repos
 * it does not own. Resolving the package's declared `bin.devkit` and running it with
 * `process.execPath` sidesteps the shim entirely and behaves identically on every platform — the
 * same thing `applyFix` already does for its own re-exec.
 */
function entrypoint(pkgDir) {
    const declared = readJson(join(pkgDir, 'package.json'))?.bin?.devkit;
    const entry = join(pkgDir, declared ?? DEFAULT_ENTRY);
    return isFile(entry) ? entry : undefined;
}
/** The `.bin` path to PRINT. Display only: the remedy a human types, never what devkit spawns. */
function displayBin(root) {
    return BIN_DISPLAY_NAMES.map((name) => join(root, 'node_modules', '.bin', name)).find(isFile);
}
function remediationFor(overlay, pinned, bin) {
    if (bin)
        return `${bin} doctor --fix`;
    const tag = pinned ? `#v${pinned}` : '';
    // No local bin to name. Overlay's sanctioned install IS the global one (overlay-self-heal,
    // Target 2026-07-14); package mode's is the lockfile's, so tell it to install first.
    return overlay
        ? `bun add -g ${DEP}${tag}, then \`devkit doctor --fix\``
        : `bun install, then \`./${BIN_REL} doctor --fix\``;
}
/**
 * Compare the running devkit against the one this repo pins. Local and total: any unreadable input
 * yields `unknown`, which proceeds with a caveat and never refuses.
 */
export function runnerSkew(cwd, cfg = readConfig(cwd)) {
    try {
        const running = runningVersion();
        // Self-host: the source tree IS the binary and carries no self-dependency
        // (docs/decisions/devkit-self-dogfood.md), so there is nothing to be skewed against. devkitRef
        // and package.json move independently across a release, and comparing them would refuse inside
        // devkit's own repo on nothing more than bump ordering.
        if (cfg.selfHost)
            return { kind: 'none', running, remediation: '' };
        const overlay = Boolean(cfg.overlay);
        const install = overlay ? {} : installedAt(cwd);
        const installed = install.version;
        const declared = overlay ? undefined : declaredPin(cwd);
        // Overlay declares its pin in config.json — it has no devkit dependency to read. Elsewhere the
        // repo's REQUIREMENT is the HIGHER of installed and declared: a stale node_modules must not
        // mask a package.json that already asks for a newer devkit, or a runner matching the stale
        // install is judged in sync and publishes state the declared pin then rejects — sc-2100 again,
        // one indirection along.
        const pinned = overlay ? overlayPin(cfg.devkitRef) : higher(installed, declared);
        // Only offer a hand-off when the installed binary actually satisfies what package.json asks
        // for; otherwise it is the same stale code and the honest remedy is an install, not a re-exec.
        const stale = overlay || pinned !== installed;
        const pinnedEntry = stale ? undefined : install.entry;
        const pinnedBin = stale ? undefined : install.bin;
        const remediation = remediationFor(overlay, pinned, pinnedBin);
        if (!running || !pinned)
            return { kind: 'unknown', running, pinned, pinnedEntry, pinnedBin, remediation };
        const delta = cmpSemver(running, pinned);
        const kind = delta < 0 ? 'older' : delta > 0 ? 'newer' : 'none';
        return { kind, running, pinned, pinnedEntry, pinnedBin, remediation };
    }
    catch {
        return { kind: 'unknown', remediation: '' };
    }
}
/** The package-mode doctor row. Not `fixable`: --fix hands off rather than repairing in-process. */
export function skewCheck(skew) {
    if (skew.kind !== 'older')
        return null;
    return check('devkit runner', 'DRIFT', `running ${skew.running}, but this repo pins ${skew.pinned} — an older devkit rewrites .devkit/oxc managed state in its own older shape`, skew.remediation);
}
export function printSkewBanner(skew) {
    console.log(`\n  ⚠ devkit runner skew: you are running ${skew.running}, this repo pins ${skew.pinned}.`);
    console.log('    An older devkit rewrites .devkit/oxc in ITS shape, which the pinned gate then reports as stale.');
}
/**
 * Re-run this invocation under the repo's pinned devkit. Returns its exit code, or null when there
 * is nothing to hand off to (no local bin, or we ARE the delegated child). `exec` is injected so a
 * test can supply a real stand-in rather than mocking the child_process module.
 */
export function delegateToPinned(skew, args, cwd, env = process.env, exec = execFileSync) {
    if (!skew.pinnedEntry || env[DELEGATED_ENV])
        return null;
    console.log(`    Delegating to the pinned devkit: ${skew.pinnedBin ?? skew.pinnedEntry}\n`);
    try {
        exec(process.execPath, [skew.pinnedEntry, ...args], {
            cwd,
            stdio: 'inherit',
            env: { ...env, [DELEGATED_ENV]: '1' },
        });
        return 0;
    }
    catch (error) {
        // SAFETY: execFileSync's own throw is the only one reachable here, and its shape distinguishes
        // the two cases. Reporting a spawn failure as an exit code would swallow the remediation the
        // caller prints for "there was nothing to hand off to" — the user's only remaining affordance.
        const { status, signal } = error;
        if (status !== null && status !== undefined)
            return status; // the child ran and exited
        if (signal)
            return 1; // the child ran and was killed — do not claim nothing was written
        return null; // never spawned (ENOENT/EACCES/EISDIR): fall back to the refusal
    }
}
/**
 * The write guard every managed-state writer runs first. Throws when an OLDER devkit would publish
 * state a newer pin then rejects. Returns the skew so a caller can record that it wrote anyway.
 */
export function assertRunnerMayWrite(cwd, allowSkew = false, env = process.env) {
    const skew = runnerSkew(cwd);
    if (skew.kind !== 'older')
        return skew;
    if (allowSkew || env[ALLOW_SKEW_ENV]) {
        console.log(`  ⚠ ${ALLOW_SKEW_ENV} set — writing managed state from devkit ${skew.running} into a repo pinned at ${skew.pinned}.`);
        return skew;
    }
    throw new Error(`refusing to write devkit-managed state: running devkit ${skew.running}, but this repo pins ${skew.pinned}. ` +
        `An older devkit writes .devkit/oxc in its own older shape, which the pinned gate then reports as stale. ` +
        `Run: ${skew.remediation}`);
}
