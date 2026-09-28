/** Which vitest the consumer runs, and whether it can take devkit's selective flake retry (sc-3731).
 * produce.mts injects the retry; this module only answers the version question. */
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
/** The lowest vitest that understands `--retry.condition`. Below it we retry NOTHING — see below. */
export const RETRY_MIN_VITEST = [4, 1];
/** `4.1.9` / `4.1.0-beta.1` → [4, 1]. null for anything that is not a plain semver. */
export function vitestMajorMinorOf(version) {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(version);
    if (!m)
        return null;
    const [major, minor] = [Number(m[1]), Number(m[2])];
    const [minMajor, minMinor] = RETRY_MIN_VITEST;
    const prereleaseOfMinimum = m[4] !== undefined && m[3] === '0' && major === minMajor && minor === minMinor;
    // A 4.1.0 prerelease before beta.1 still lacks retry.condition, so it counts as the minor below.
    if (prereleaseOfMinimum && !hasRetryConditionPrerelease(m[4] ?? ''))
        return [minMajor, minMinor - 1];
    return [major, minor];
}
/** retry.condition landed in 4.1.0-beta.1 (vitest#8812). Unrecognised channels are treated as older. */
function hasRetryConditionPrerelease(prerelease) {
    const [channel, n] = prerelease.split('.');
    return channel === 'rc' || (channel === 'beta' && Number(n) >= 1);
}
// Reads the package.json of the vitest `bin` runs, never an ancestor's copy (W-3). `vitest --version`
// is only a fallback: it can time out under load (sc-3731).
export function detectVitestVersion(cwd, bin) {
    const fromDisk = readInstalledVitest(packageJsonOf(cwd, bin));
    if (fromDisk.kind === 'known')
        return fromDisk;
    const fromBinary = askVitestBinary(bin);
    if (fromBinary.kind === 'known')
        return fromBinary;
    return { kind: 'unknown', reason: `${fromDisk.reason}; ${fromBinary.reason}` };
}
const VitestPackage = z.object({ name: z.literal('vitest'), version: z.string() });
/** The fields Node sets on a failed fs call or a failed/killed execFileSync. */
const ProcessFailure = z.object({ code: z.string().optional(), signal: z.string().nullish() });
const failureCode = (err) => err?.code ?? 'unknown error';
// A symlinked .bin (npm, bun) names its package exactly. A plain-file shim (pnpm, Windows) cannot be
// followed, so the sibling install the package manager wrote it from stands in.
function packageJsonOf(cwd, bin) {
    try {
        if (lstatSync(bin).isSymbolicLink())
            return join(dirname(realpathSync(bin)), 'package.json');
    }
    catch {
        // unreadable link: the sibling read below fails or answers, and the spawn stays the fallback
    }
    return join(cwd, 'node_modules', 'vitest', 'package.json');
}
function readInstalledVitest(file) {
    let contents;
    try {
        contents = readFileSync(file, 'utf8');
    }
    catch (err) {
        const failure = ProcessFailure.safeParse(err);
        return {
            kind: 'unknown',
            reason: `${file} unreadable (${failureCode(failure.success ? failure.data : null)})`,
        };
    }
    let raw;
    try {
        raw = JSON.parse(contents);
    }
    catch {
        return { kind: 'unknown', reason: `${file} is not valid JSON` };
    }
    const pkg = VitestPackage.safeParse(raw);
    const majorMinor = pkg.success ? vitestMajorMinorOf(pkg.data.version) : null;
    return pkg.success && majorMinor
        ? { kind: 'known', version: pkg.data.version, majorMinor }
        : { kind: 'unknown', reason: `${file} is not a vitest package with a semver version` };
}
const VERSION_PROBE_TIMEOUT_MS = 30_000;
function askVitestBinary(bin) {
    let out;
    try {
        out = execFileSync(bin, ['--version'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: VERSION_PROBE_TIMEOUT_MS,
        });
    }
    catch (err) {
        const failure = ProcessFailure.safeParse(err);
        const parsed = failure.success ? failure.data : null;
        // execFileSync reports its own timeout as a SIGTERM kill of the child.
        const why = parsed?.signal === 'SIGTERM'
            ? `timed out after ${VERSION_PROBE_TIMEOUT_MS / 1000}s`
            : `failed (${failureCode(parsed)})`;
        return { kind: 'unknown', reason: `\`vitest --version\` ${why}` };
    }
    // `vitest/4.1.10 darwin-arm64 node-v22.20.0` → 4.1.10
    const version = /\d+\.\d+\.\d+\S*/.exec(out)?.[0];
    const majorMinor = version ? vitestMajorMinorOf(version) : null;
    return version && majorMinor
        ? { kind: 'known', version, majorMinor }
        : { kind: 'unknown', reason: '`vitest --version` printed no version' };
}
// Unknown means unsupported: vitest silently drops an unknown `--retry.condition` but keeps
// `--retry.count=1`, turning the narrow timeout retry into a blanket one.
export function supportsRetryCondition(version) {
    if (!version)
        return false;
    const [major, minor] = version;
    return (major > RETRY_MIN_VITEST[0] || (major === RETRY_MIN_VITEST[0] && minor >= RETRY_MIN_VITEST[1]));
}
