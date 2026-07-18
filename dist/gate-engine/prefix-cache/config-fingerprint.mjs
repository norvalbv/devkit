/**
 * A fingerprint of the gate CONFIGURATION, folded into the deterministic-prefix cache key so that
 * hardening the gates invalidates a PASS earned under the weaker config — the masking bug this closes.
 *
 * The prefix key hashed only `git write-tree` (the tracked index) + devkit version + hook bytes, so a
 * gate input that lives OUTSIDE the tracked index — an untracked/overlay-gitignored guard.config.json,
 * a gitignored baseline, the .search-code index, the presence of jscpd — could change the verdict
 * without changing the key, and a stale all-green entry would skip the newly-hardened gates. This adds
 * a fifth salt covering exactly those inputs.
 *
 * Guiding property: when in doubt, INVALIDATE. Every uncertain read resolves to a distinct stable
 * token (`absent`/`missing`/`none`) — never "" — so presence↔absence flips the hash; a genuinely
 * unexpected error (malformed guard.config.json → resolveGuardConfig throws) bubbles to computeKey,
 * which turns it into a null key = run the gates. A spurious re-run is acceptable; a stale pass is not.
 *
 * Import-side-effect-free (unlike clone-detector, which resolves config at module top level): all
 * config/fs access happens inside gateConfigFingerprint(), so importing this never runs a config read.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { JSCPD_OWN_ROOT, JSCPD_PATH_TERMINAL, resolveJscpdBin, } from "../co-occurrence/jscpd-bin.mjs";
import { resolveFromCwd, resolveGuardConfig } from "../config.mjs";
import { canonicalJson } from "../deterministic/canonical-json.mjs";
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
// Content fingerprint of a directory tree: sorted `relpath:sha256` for every file, or the 'absent'
// token when the dir doesn't exist. A read error mid-walk bubbles (→ null key → run the gates).
function fingerprintDir(dir) {
    if (!existsSync(dir))
        return 'absent';
    const parts = [];
    const walk = (d, prefix) => {
        for (const name of readdirSync(d).sort()) {
            const abs = join(d, name);
            if (statSync(abs).isDirectory())
                walk(abs, `${prefix}${name}/`);
            else
                parts.push(`${prefix}${name}:${sha256(readFileSync(abs))}`);
        }
    };
    walk(dir, '');
    return parts.join('|');
}
// Cheap stat proxy for a large binary artifact (the sqlite index, the jscpd binary) — `size:mtimeMs`,
// or a token when the path is unset/absent. Hashing multi-MB contents per commit isn't worth it; the
// only failure mode (a no-op rebuild churning mtime) is a spurious re-run, never a stale pass.
function statProxy(abs, absentToken) {
    if (abs == null)
        return 'none';
    try {
        const st = statSync(abs);
        return `${st.size}:${st.mtimeMs}`;
    }
    catch {
        return absentToken; // set-but-not-on-disk (e.g. a JSCPD_BIN env override that doesn't exist yet)
    }
}
/**
 * A sha256 over every gate input that governs a deterministic-gate verdict but is invisible to
 * `git write-tree`. `cwd` is the directory the gates run in (the ship worktree). Throws only if
 * resolveGuardConfig throws (malformed guard.config.json) — the caller (computeKey) treats that as a
 * null key so the gates run.
 */
export function gateConfigFingerprint(cwd) {
    // (1) Behavioral config as canonical JSON. resolveGuardConfig keeps every path field RELATIVE (W-3);
    // the only absolute/per-worktree value is `cwd` — omit it, or the ship worktree's PID-suffixed path
    // would make the key never collide across retries and silently defeat the cache.
    const cfg = resolveGuardConfig(cwd);
    const { cwd: _omitCwd, ...behavioral } = cfg;
    // (2) Baseline directory + allowlist contents. The whole eslint/baselines/ dir (not three named
    // files): the structure gate runs inside guard-deterministic and reads the .mjs grandfather/exempt
    // lists distinct from the ratchet .json baselines, and the dir is gitignored in overlay consumers.
    const baselines = fingerprintDir(join(cwd, 'eslint', 'baselines'));
    const allowlistAbs = resolveFromCwd(cfg, 'allowlistPath');
    const allowlist = allowlistAbs && existsSync(allowlistAbs) ? sha256(readFileSync(allowlistAbs)) : 'absent';
    // (3) search-code index — stat proxy (unset → 'none', configured-but-absent → 'missing').
    const index = statProxy(resolveFromCwd(cfg, 'indexPath'), 'missing');
    // (4) jscpd availability + version. Resolve the SAME bin the clone gate uses. The bare-PATH terminal
    // (global install) is a stable token — statSync('jscpd') is cwd-relative and would throw. An absolute
    // path is stat-proxied so "newly present" and "upgraded in place" both flip the hash.
    const bin = resolveJscpdBin({
        env: process.env.JSCPD_BIN,
        ownRoot: JSCPD_OWN_ROOT,
        repoRoot: cwd,
    });
    const jscpd = bin === JSCPD_PATH_TERMINAL ? 'jscpd:path' : `jscpd:${statProxy(bin, 'missing')}`;
    return sha256([canonicalJson(behavioral), baselines, allowlist, index, jscpd].join('\0'));
}
