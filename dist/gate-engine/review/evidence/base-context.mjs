/**
 * The commit a reviewer's diff was computed against (sc-2480): the gate cwd's own HEAD, never an
 * env var, so a printed base always describes the tree the reviewers actually saw.
 */
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { headHash } from './staged-git.mjs';
const SHA_RE = /^[0-9a-f]{7,40}$/;
/** A FULL object id (SHA-1 or SHA-256): a stored base is compared exactly, never by prefix. */
const FULL_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PATHS_SHOWN = 10;
export const shortSha = (sha) => sha.slice(0, 12);
/** Two spellings of one commit. A ship exports a full sha, but a hand-set hint is often abbreviated,
 * and reporting an abbreviation of the reviewed base as a DISAGREEMENT is a false alarm. */
const sameCommit = (hint, base) => SHA_RE.test(hint) && (base.startsWith(hint) || hint.startsWith(base));
function git(cwd, args) {
    try {
        return execFileSync('git', args, {
            cwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            maxBuffer: 64 * 1024 * 1024,
        });
    }
    catch {
        return null;
    }
}
function resolve(cwd, env, pinnedHead) {
    const head = pinnedHead ?? headHash(cwd);
    const baseSha = head !== null && !head.startsWith('unborn:') ? head : null;
    const shipBase = env.DEVKIT_SHIP_BASE_SHA?.trim() || null;
    const reviewBase = env.DEVKIT_REVIEW_MERGE_BASE?.trim() || null;
    const hint = shipBase ?? reviewBase;
    const source = shipBase
        ? 'ship base'
        : reviewBase
            ? 'review merge-base'
            : 'local HEAD';
    const callerRaw = env.DEVKIT_SHIP_SOURCE_HEAD?.trim() || null;
    // Resolved, not string-compared: a hint may be abbreviated, and an abbreviation of the reviewed
    // base is the caller sitting ON the base — no divergence to report, and no diff worth running.
    const resolved = callerRaw && SHA_RE.test(callerRaw)
        ? (git(cwd, ['rev-parse', '--verify', '--quiet', `${callerRaw}^{commit}`])?.trim() ?? null)
        : null;
    const callerHead = resolved && resolved !== baseSha ? resolved : null;
    const counted = callerHead && baseSha
        ? Number.parseInt(git(cwd, ['rev-list', '--count', `${callerHead}..${baseSha}`])?.trim() ?? '', 10)
        : Number.NaN;
    return {
        baseSha,
        source,
        envHintMismatch: hint && baseSha && !sameCommit(hint, baseSha) ? hint : null,
        callerHead,
        behind: callerHead && Number.isFinite(counted) ? counted : null,
    };
}
const cache = new Map();
const cacheKeyFor = (cwd, env) => [
    cwd,
    env.DEVKIT_SHIP_BASE_SHA ?? '',
    env.DEVKIT_REVIEW_MERGE_BASE ?? '',
    env.DEVKIT_SHIP_SOURCE_HEAD ?? '',
].join('\0');
/** Resolved once per (cwd, env-hint) pair: every reviewer's scope row and block note reports the
 * same base, and the git reads do not repeat per reviewer. */
export function reviewBaseContext(cwd, env = process.env) {
    const key = cacheKeyFor(cwd, env);
    const hit = cache.get(key);
    if (hit)
        return hit;
    const ctx = resolve(cwd, env, null);
    cache.set(key, ctx);
    return ctx;
}
/** Seed the context from a head the caller already pinned. The gate snapshots HEAD before it reads
 * any evidence, so re-reading it here could name a tree the reviewers never judged (sc-2054). */
export function primeReviewBaseContext(cwd, head, env = process.env) {
    const ctx = resolve(cwd, env, head);
    cache.set(cacheKeyFor(cwd, env), ctx);
    return ctx;
}
/** Test seam: the resolution reads live git state, which a fixture repo mutates between cases. */
export function resetReviewBaseContext() {
    cache.clear();
    movedBetween.clear();
}
/** Paths the base changed since the caller diverged; NULL when git could not answer — a shallow
 * clone exits 128 here, and that is not the same fact as "nothing moved". */
export function movedOnBase(cwd, ctx) {
    if (!ctx.callerHead || !ctx.baseSha)
        return [];
    const raw = git(cwd, [
        'diff',
        '--name-status',
        '-z',
        '--no-renames',
        `${ctx.callerHead}...${ctx.baseSha}`,
    ]);
    if (raw === null)
        return null;
    const fields = raw.split('\0');
    const moved = [];
    for (let i = 0; i + 1 < fields.length; i += 2)
        if (fields[i + 1])
            moved.push(fields[i + 1]);
    return moved;
}
/** Exact path or directory containment — the trailing slash keeps `cli/lib/ship` from matching
 * `cli/lib/shipwreck.mts`. Deliberately not globbing (sc-2297). */
function overlaps(moved, reviewed) {
    return reviewed.some((file) => moved === file || moved.startsWith(`${file}/`));
}
/** Printed once per run on PASS as well as FAIL. Keyed on PATH OVERLAP, never the behind-count or sha
 * inequality: in a shared checkout those are permanently red (base-drift-surfaced-at-read-time (b)).
 * `run` counts this attempt's judged vs cache-served reviewers: a cached PASS was judged against
 * whatever base it names on its own line, so the base line claims only the reviewers that ran (sc-3468).
 */
export function baseProvenanceLines(cwd, reviewedFiles, env = process.env, run = { fresh: 1, cached: 0 }) {
    const ctx = reviewBaseContext(cwd, env);
    if (!ctx.baseSha)
        return [
            'guard-review: base UNKNOWN — the reviewed tree has no readable HEAD, so no finding’s ' +
                'location can be verified against it. Treat every finding as unresolved rather than refuted.',
        ];
    const behind = ctx.behind ? `, ${ctx.behind} commit(s) ahead of your worktree` : '';
    const lines = [
        run.fresh === 0 && run.cached > 0
            ? `guard-review: no reviewer ran this attempt — this run's base is ${shortSha(ctx.baseSha)} ` +
                `(${ctx.source}${behind}), and each cached PASS above names the base it was judged against.`
            : `guard-review: reviewed against ${shortSha(ctx.baseSha)} (${ctx.source}${behind}) — ` +
                'findings below name lines in THAT tree.' +
                (run.cached > 0
                    ? ' Only the reviewers run this attempt; each cached PASS above names its own base.'
                    : ''),
    ];
    if (ctx.envHintMismatch)
        lines.push(`guard-review: the invoking ship named base ${shortSha(ctx.envHintMismatch)} but the ` +
            `reviewed tree is at ${shortSha(ctx.baseSha)}; the reviewed tree is what the findings describe.`);
    if (!ctx.callerHead)
        return lines;
    const moved = movedOnBase(cwd, ctx);
    if (moved === null) {
        lines.push(`guard-review: whether any reviewed path also moved on the base COULD NOT BE DETERMINED ` +
            `(git could not diff ${shortSha(ctx.callerHead)}...${shortSha(ctx.baseSha)} — a shallow ` +
            `clone or unrelated histories do this). Resolve findings against the base above, not your HEAD.`);
        return lines;
    }
    const overlapping = moved.filter((path) => overlaps(path, reviewedFiles));
    if (overlapping.length === 0)
        return lines;
    const shown = overlapping.slice(0, PATHS_SHOWN);
    const more = overlapping.length > shown.length ? ` …and ${overlapping.length - shown.length} more` : '';
    lines.push(`guard-review: ${overlapping.length} reviewed path(s) ALSO changed on the base after your ` +
        `worktree was cut — \`git show HEAD:<path>\` in your worktree can neither confirm nor refute ` +
        `a finding about them: ${shown.join(', ')}${more}`);
    return lines;
}
const movedBetween = new Map();
/** Paths whose content differs between two base trees — a TREE diff, so a force-pushed base that
 * is no descendant of the old one still answers. NULL when git cannot read either commit. */
function pathsBetween(cwd, from, to) {
    const key = `${cwd}\0${from}\0${to}`;
    if (movedBetween.has(key))
        return movedBetween.get(key) ?? null;
    const raw = git(cwd, ['diff', '--name-only', '-z', '--no-renames', from, to, '--']);
    const paths = raw === null ? null : raw.split('\0').filter(Boolean);
    movedBetween.set(key, paths);
    return paths;
}
const RANK = {
    current: 0,
    'moved-clear': 1,
    'moved-overlap': 2,
    unknown: 3,
};
/** A stored base as read back from the verdict cache: only a sha-shaped string survives, so an
 * absent, malformed or option-shaped value (it reaches git argv) parses to nothing. */
export const storedBaseSchema = z.string().regex(FULL_SHA_RE);
/** The one reviewer whose PASS depends on a semantic retrieval backend it may not reach (sc-2317). */
export const RETRIEVAL_REVIEWER = 'commit-guard';
const MAX_CAUSE_CHARS = 200;
/** Judge- or cache-supplied cause text lands on one log line, a cache entry and an event. */
export function boundedCause(cause) {
    const flat = cause.replace(/\s+/g, ' ').trim();
    return flat.length > MAX_CAUSE_CHARS ? `${flat.slice(0, MAX_CAUSE_CHARS - 1)}…` : flat;
}
export const CACHED_RETRIEVAL_UNPROVEN = 'cached PASS carries no retrieval record (written before sc-2317, or the record is malformed)';
/** Why a replayed commit-guard PASS is DEGRADED; only an entry stamped `retrieval: 'ok'` is clean. */
export function cachedRetrievalDegradation(reviewer, meta) {
    if (reviewer !== RETRIEVAL_REVIEWER || meta.retrieval === 'ok')
        return undefined;
    const cause = z.string().trim().min(1).safeParse(meta.degraded_cause).data;
    return cause === undefined ? CACHED_RETRIEVAL_UNPROVEN : boundedCause(cause);
}
export function cachedBaseState(cwd, judgedBases, reviewedFiles, env = process.env) {
    const current = reviewBaseContext(cwd, env).baseSha;
    const judged = [];
    const overlapping = new Set();
    let state = 'current';
    const worsen = (next) => {
        if (RANK[next] > RANK[state])
            state = next;
    };
    for (const stored of judgedBases) {
        // A stored value reaches git argv, so only a sha-shaped one is trusted — never an option string.
        const base = stored !== null && FULL_SHA_RE.test(stored) ? stored : null;
        if (base === null || current === null) {
            worsen('unknown');
            continue;
        }
        if (base === current)
            continue;
        if (!judged.includes(base))
            judged.push(base);
        const moved = pathsBetween(cwd, base, current);
        if (moved === null) {
            worsen('unknown');
            continue;
        }
        const hit = moved.filter((path) => overlaps(path, reviewedFiles));
        for (const path of hit)
            overlapping.add(path);
        worsen(hit.length > 0 ? 'moved-overlap' : 'moved-clear');
    }
    return { state, judged, current, overlapping: [...overlapping] };
}
/** The one base a replayed PASS was judged against, or null when unknown or split across several. */
export function judgedBaseSha(verdict) {
    if (verdict.state === 'current')
        return verdict.current;
    return verdict.state !== 'unknown' && verdict.judged.length === 1 ? verdict.judged[0] : null;
}
/** The per-reviewer cache line. `current` keeps the historical wording byte-for-byte. */
export function cachedPassLine(label, verdict, identical = 'identical diff', degraded = false) {
    const head = `guard-review: ${label} — cached PASS${degraded ? ' (DEGRADED)' : ''} (${identical}`;
    const now = verdict.current ? shortSha(verdict.current) : 'UNKNOWN';
    const was = verdict.judged.map(shortSha).join(', ');
    switch (verdict.state) {
        case 'current':
            return `${head})`;
        case 'moved-clear':
            return `${head}; judged against ${was}, base now ${now} — no reviewed path changed between them; not re-judged)`;
        case 'moved-overlap': {
            const shown = verdict.overlapping.slice(0, PATHS_SHOWN);
            const more = verdict.overlapping.length > shown.length
                ? ` …and ${verdict.overlapping.length - shown.length} more`
                : '';
            return (`${head}; judged against ${was}, base now ${now} — ${verdict.overlapping.length} reviewed ` +
                `path(s) changed between them: ${shown.join(', ')}${more}; NOT re-judged against them)`);
        }
        default:
            return `${head}; judged base UNKNOWN — not re-judged against ${now})`;
    }
}
