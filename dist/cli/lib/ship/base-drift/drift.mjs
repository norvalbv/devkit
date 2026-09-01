/** Has the base moved under this checkout, and does what moved overlap what the caller cares about? */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DEFAULT_FETCH_TIMEOUT_MS, DEFAULT_TTL_MS, markerPathsFor, refreshWindow, } from './fetch-window.mjs';
import { gitRunner, line, ok } from './git-run.mjs';
import { resolveBase } from './resolve-base.mjs';
function snapshotPath(commonDir, base, head, tip, tmp) {
    const { dir } = markerPathsFor(commonDir, base, tmp);
    const key = createHash('sha256')
        .update(`${commonDir}\0${base}\0${head}\0${tip}`)
        .digest('hex')
        .slice(0, 16);
    return join(dir, `${key}.snapshot.json`);
}
function readSnapshot(path) {
    try {
        // A cache file is machine-local and can be truncated by a kill or left over from an older
        // schema, so the two fields the caller relies on are proven before any of it is trusted.
        const value = JSON.parse(readFileSync(path, 'utf8'));
        if (!Array.isArray(value?.moved) || !Number.isFinite(value.behind))
            return null;
        // Every RECORD too, not just the array: an entry missing its path reaches `git log -- undefined`
        // and throws, and the outer catch would then answer `not-a-repo` for as long as the file lives —
        // a wrong verdict that persists instead of recomputing.
        const moved = value.moved.filter((entry) => (entry?.path ?? '') !== '' && (entry?.status ?? '') !== '');
        if (moved.length !== value.moved.length)
            return null;
        return { mergeBase: value.mergeBase ?? null, behind: value.behind ?? 0, moved };
    }
    catch {
        return null;
    }
}
function writeSnapshot(path, snapshot) {
    try {
        writeFileSync(path, JSON.stringify(snapshot));
    }
    catch {
        // A cache that cannot be written just means the next call recomputes. Never fail on it.
    }
}
/** Attribution is one `git log` per path (~15ms warm); beyond a handful the list stops being read. */
export const DEFAULT_MAX_ATTRIBUTIONS = 5;
function emptyReport(root, commonDir, base) {
    return {
        schema: 1,
        root,
        commonDir,
        base,
        freshness: 'unknown',
        ageMs: null,
        mergeBase: null,
        behind: 0,
        moved: [],
        overlap: [],
        truncated: false,
        silent: 'unresolvable',
    };
}
/** The scope marker meaning "the whole checkout". */
export const EVERYTHING = '.';
/** Repo-relative POSIX form; {@link EVERYTHING} for the root itself, null for anything outside. */
export function normalizePath(root, candidate) {
    // Emptiness is tested on a trimmed copy, but the PATH keeps its spaces: git allows a filename
    // with leading or trailing whitespace, and trimming would silently look for a different file.
    if (!candidate.trim())
        return null;
    const absolute = isAbsolute(candidate) ? candidate : resolve(root, candidate);
    const rel = relative(root, absolute).split(sep).join('/');
    if (rel === '..' || rel.startsWith('../'))
        return null;
    const cleaned = rel.replace(/\/+$/, '');
    return cleaned === '' ? EVERYTHING : cleaned;
}
/**
 * Does a moved file fall under one of the caller's paths?
 *
 * Exact match or directory containment — NOT globbing. All three input sources are literal
 * filesystem paths (a hook's tool_input.file_path, ship's PATHS, argv), none of them a glob source,
 * and a glob matcher would mis-handle the paths that legally contain `*`, `?` or `[`.
 *
 * The `/` in the prefix test is not cosmetic: a bare startsWith makes the caller path
 * `cli/lib/ship` match the moved file `cli/lib/shipwreck.mts`.
 */
export function matchedBy(moved, callerPaths) {
    for (const candidate of callerPaths) {
        if (candidate === EVERYTHING)
            return EVERYTHING;
        if (moved === candidate || moved.startsWith(`${candidate}/`))
            return candidate;
    }
    return null;
}
/**
 * Parse `git diff --name-status -z`: a status field and a path field, each NUL-terminated.
 *
 * -z rather than line splitting because --name-status C-quotes any path containing a tab, newline
 * or quote, and these names are fed straight back into `git log -- <path>` where a mangled name
 * silently matches nothing and the attribution comes back empty rather than wrong-looking.
 */
export function parseNameStatusZ(raw) {
    const fields = raw.split('\0');
    const out = [];
    for (let i = 0; i + 1 < fields.length; i += 2) {
        const status = fields[i]?.trim();
        const path = fields[i + 1];
        // A trailing empty field is the normal terminator; a status with no path is a truncated record.
        if (!status || !path)
            continue;
        out.push({ path, status });
    }
    return out;
}
/**
 * The dedup token consumers stamp on. The base SHA is an ingredient so a SECOND move of the base
 * re-arms every path at once — sc-2297's origin moved twice, and a (session, path) key would have
 * reported only the first.
 */
export function rearmToken(commonDir, base, baseSha, path) {
    return createHash('sha256')
        .update(`${commonDir}\0${base}\0${baseSha}\0${path}`)
        .digest('hex')
        .slice(0, 16);
}
function attribute(run, head, tip, path) {
    const result = run([
        'log',
        '-1',
        '--format=%H%x00%h%x00%aI%x00%s',
        `${head}..${tip}`,
        '--',
        path,
    ]);
    if (!ok(result))
        return null;
    const [sha, short, date, subject] = line(result).split('\0');
    return sha ? { sha, short: short ?? '', date: date ?? '', subject: subject ?? '' } : null;
}
/**
 * Absolute toplevel + common dir, or null when this is not a work tree.
 *
 * ONE call per value. Asking for both at once separates the answers with a newline, which is a legal
 * character in a directory name — a checkout beneath such a path would be split mid-name and every
 * comparison below would run against the wrong root. Splitting the calls also avoids
 * `--path-format=absolute` (git 2.31+), whose failure on an older git would read as "not a repo" and
 * kill the feature silently; `--git-common-dir` may answer relatively, so it is resolved here.
 */
function locate(run) {
    const top = run(['rev-parse', '--show-toplevel']);
    if (!ok(top))
        return null;
    const root = line(top);
    if (!root)
        return null;
    const common = run(['rev-parse', '--git-common-dir']);
    if (!ok(common))
        return null;
    const raw = line(common);
    if (!raw)
        return null;
    return { root, commonDir: isAbsolute(raw) ? raw : resolve(root, raw) };
}
function computeDrift(options) {
    const now = options.now ?? Date.now;
    const run = gitRunner(options.root, options.env);
    const located = locate(run);
    if (!located)
        return emptyReport(options.root, '', { kind: 'unresolvable', reason: 'not-a-repo' });
    const { root, commonDir } = located;
    // An unborn HEAD has no work that could have been built on a stale read, so there is nothing to
    // be loud about — and every comparison below would fail anyway. Silence is the honest answer.
    const headResult = run(['rev-parse', '--verify', '--quiet', 'HEAD']);
    if (!ok(headResult)) {
        return emptyReport(root, commonDir, { kind: 'unresolvable', reason: 'no-commits' });
    }
    // Pinned for the same reason the base is: HEAD is symbolic, and a checkout or reset in this
    // worktree between two reads below would have them describe different commits.
    const head = line(headResult);
    const maxAgeMs = options.maxAgeMs ?? DEFAULT_TTL_MS;
    const timeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    const fetchFor = (base) => refreshWindow(run, {
        commonDir,
        base,
        maxAgeMs,
        timeoutMs,
        tmpDir: options.tmpDir,
        now: now(),
    });
    // The explicit tier may fetch once to materialize a tracking ref a fresh worktree lacks; that
    // fetch is the window, so its outcome is reused rather than re-run below.
    const captured = { outcome: null };
    const base = resolveBase(run, {
        explicit: options.base,
        env: options.env,
        refetch: (name) => {
            captured.outcome = fetchFor(name);
            return captured.outcome.freshness;
        },
    });
    if (base.kind !== 'resolved')
        return emptyReport(root, commonDir, base);
    const fetched = captured.outcome ?? fetchFor(base.base);
    // Re-read the tip: the fetch above is what makes this report current, and the SHA resolved before
    // it is the pre-fetch one. Using the stale value would put the OLD sha in every rearm token, so a
    // move that just landed would not re-arm anything.
    const tipResult = run([
        'rev-parse',
        '--verify',
        '--quiet',
        `refs/remotes/origin/${base.base}^{commit}`,
    ]);
    const sha = ok(tipResult) ? line(tipResult) : base.sha;
    // Every read below addresses that immutable SHA, never the ref name. The remote-tracking ref lives
    // in the shared clone and a sibling agent's fetch can advance it at any moment — reading it twice
    // would mix two states, so a path that moved in the second could carry a token minted from the
    // first and be suppressed as already-briefed.
    const ref = sha;
    const resolvedBase = { ...base, sha };
    const report = {
        schema: 1,
        root,
        commonDir,
        base: resolvedBase,
        freshness: fetched.freshness,
        ageMs: fetched.freshness === 'cached' ? fetched.ageMs : null,
        mergeBase: null,
        behind: 0,
        moved: [],
        overlap: [],
        truncated: false,
        silent: 'no-drift',
    };
    // THE asymmetric probe. `origin/<base> != HEAD` is equally true when HEAD merely carries an
    // unpushed commit, and so is the three-dot `rev-list --left-right --count`. Exit 0 here means
    // origin's tip is already CONTAINED in HEAD, so nothing can have moved under us regardless of
    // how far ahead HEAD is.
    // Both shas are known, so the path-independent half of the answer is fully determined. Serving it
    // from cache is what keeps the pre-edit hook off the ~5 extra git subprocesses below.
    const snapshotFile = snapshotPath(commonDir, base.base, head, sha, options.tmpDir);
    const cached = readSnapshot(snapshotFile);
    if (cached) {
        report.mergeBase = cached.mergeBase;
        report.behind = cached.behind;
        report.moved = cached.moved;
        return finish(run, report, cached, options, root, commonDir, base.base, head, sha);
    }
    if (ok(run(['merge-base', '--is-ancestor', ref, head]))) {
        // Ancestry answers the question only if the ref it was measured against is current. After a
        // failed fetch it is whatever was last cached, so "already contained in HEAD" proves nothing
        // about origin now — and reporting no-drift here would be a clean exit 0 earned from a failure.
        if (fetched.freshness === 'unknown')
            report.silent = 'undetermined';
        return report;
    }
    const mergeBase = run(['merge-base', head, ref]);
    if (!ok(mergeBase))
        return emptyReport(root, commonDir, { kind: 'unresolvable', reason: 'unrelated-histories' });
    report.mergeBase = line(mergeBase);
    const behind = run(['rev-list', '--count', `${head}..${ref}`]);
    report.behind = ok(behind) ? Number.parseInt(line(behind), 10) || 0 : 0;
    // --no-renames is load-bearing. With rename detection on, `old.mts -> new.mts` reports only
    // `new.mts` — and the agent who ran `git show HEAD:old.mts`, got nothing and concluded the file
    // did not exist is exactly who this must reach. --no-renames emits `D old` + `A new`, so both
    // names participate in matching.
    const diff = run(['diff', '--name-status', '-z', '--no-renames', `${head}...${ref}`]);
    if (!ok(diff)) {
        // The base HAS moved (the ancestry probe above already said so) and we could not find out what
        // changed. Returning the report as-is would leave silent at 'no-drift' and answer exit 0 — a
        // green produced by a failure, which is the one thing this feature must never emit.
        report.silent = 'undetermined';
        return report;
    }
    report.moved = parseNameStatusZ(diff.stdout);
    const snapshot = {
        mergeBase: report.mergeBase,
        behind: report.behind,
        moved: report.moved,
    };
    writeSnapshot(snapshotFile, snapshot);
    return finish(run, report, snapshot, options, root, commonDir, base.base, head, sha);
}
/**
 * Apply the caller's scope to a snapshot. Split out so a cached snapshot and a freshly computed one
 * go through exactly the same filtering — the paths differ per call, the snapshot never does.
 */
function finish(run, report, snapshot, options, root, commonDir, base, head, sha) {
    if (snapshot.moved.length === 0)
        return report;
    // Whether the caller SUPPLIED a scope, kept separate from whether any of it resolved. Collapsing
    // the two makes `base-status -- /etc/passwd` fall back to "no filter" and answer with every file
    // that moved in the repo — a confidently wrong verdict about a question nobody asked.
    const suppliedPaths = options.paths ?? [];
    const callerPaths = suppliedPaths
        .map((p) => normalizePath(root, p))
        .filter((p) => p !== null);
    const unscoped = suppliedPaths.length === 0;
    const maxAttributions = options.maxAttributions ?? DEFAULT_MAX_ATTRIBUTIONS;
    const overlap = [];
    for (const moved of snapshot.moved) {
        // No caller scope at all means "report everything and decide nothing" — the CLI and SessionStart
        // shape. A scope that was supplied but resolved to nothing here matches nothing, by design.
        const matched = unscoped ? EVERYTHING : matchedBy(moved.path, callerPaths);
        if (matched === null)
            continue;
        overlap.push({
            ...moved,
            matched,
            commit: overlap.length < maxAttributions ? attribute(run, head, sha, moved.path) : null,
            rearm: rearmToken(commonDir, base, sha, moved.path),
        });
    }
    report.overlap = overlap;
    report.truncated = overlap.length > maxAttributions;
    report.silent = overlap.length === 0 ? 'no-overlap' : null;
    return report;
}
/**
 * The public entry point, and the only place the never-throws contract is enforced.
 *
 * Three of the four callers are advisory (a SessionStart brief, a PreToolUse advisory, a ship
 * print) where an exception is strictly worse than silence, and the fourth turns this into an exit
 * code. So an unexpected throw — a permissions error stat-ing $TMPDIR, a git build that changes an
 * output shape — degrades to the same silent report an unresolvable base produces.
 */
export function baseDrift(options) {
    try {
        return computeDrift(options);
    }
    catch {
        return emptyReport(options.root, '', { kind: 'unresolvable', reason: 'not-a-repo' });
    }
}
