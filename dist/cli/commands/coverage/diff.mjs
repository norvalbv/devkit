/** `devkit coverage-diff` — coverage of the lines a change ADDED, not of the files it touched.
 * Advisory, except under `coverage.scope: "diff"`, where it also prints that gate's verdict. */
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveGuardConfig } from '../../../gate-engine/config.mjs';
import { addedLineVerdict, addedProductionLines, diffClassifier, resolveScope, } from '../../../gate-engine/coverage/diff-gate.mjs';
import { addedLineCoverage, lineRanges, } from '../../../gate-engine/coverage/lines.mjs';
import { COVERAGE_DIR, COVERAGE_FILE } from '../../../gate-engine/coverage/produce.mjs';
import { blobsIn, boundManifest, checkoutRoots, DELETED, git, keysByPath, readArtifact, } from '../../../gate-engine/coverage/provenance.mjs';
import { computePercentages } from '../../../gate-engine/coverage/run.mjs';
import { gitRunner, line, ok } from '../../lib/ship/base-drift/git-run.mjs';
import { resolveBase } from '../../lib/ship/base-drift/resolve-base.mjs';
export const meta = {
    name: 'coverage-diff',
    agentFacing: true,
    summary: 'Coverage of the lines your change added (not of the files it touched).',
    help: `devkit coverage-diff — what fraction of the executable lines this change ADDED ran under test.

Usage:
  devkit coverage-diff [--base <ref>] [--min <pct>]

  --base <ref>   Compare against the merge-base of HEAD and <ref> (a branch, tag or SHA).
                 Default: $DEVKIT_BASE_REF, then origin/HEAD, then origin/main, then origin/master.
  --min <pct>    Exit 1 when the added-line coverage is below <pct> (0-100), or when source
                 changed and ${COVERAGE_FILE} measured no files at all. With changed files
                 unmeasured, it says it judged measured lines only, or was not applied when none
                 were measured. Without it the command only reports.

Reads ${COVERAGE_FILE} as \`devkit coverage-run\` left it; it never runs tests. Added lines are
committed, staged and unstaged changes since the merge-base, plus untracked source files. A line
counts when a statement starts on it (istanbul's line rule, as guard-coverage uses), so comments,
braces and types are neither covered nor uncovered.

guard-coverage enforces this same measure at commit time when guard.config.json sets
"coverage": { "scope": "diff", "addedLines": <pct> }. With that config this command also prints the
gate's verdict on these lines — unmeasured files, a stale artifact and the threshold, as the gate
judges them — and exits 1 when the gate would block. \`devkit ship ... --dry-gates\` is the check
exact to the paths a ship stages.

Use this when a brief asks for coverage of "the new diff": whole-file percentages on a large
existing file mostly measure code the change never touched.

Exit codes: 0 report printed; 1 below --min, --min over an artifact that measured no files, the
configured diff-scope gate would fail, or the artifact is absent or malformed; 2 usage error, no base could be resolved, or git could not read
the diff.`,
};
const MAX_LISTED = 10;
function parseOptions(args) {
    const opts = {};
    for (let i = 0; i < args.length; i += 1) {
        const flag = args[i];
        const value = args[i + 1];
        if (flag === '--base' && value)
            opts.base = value;
        else if (flag === '--min' && value) {
            const min = Number(value);
            if (!Number.isFinite(min) || min < 0 || min > 100) {
                return { error: `--min must be 0-100, got ${value}` };
            }
            opts.min = min;
        }
        else
            return { error: `unknown or incomplete argument: ${flag}` };
        i += 1;
    }
    return opts;
}
/** The merge-base sha plus a label naming what it was taken against. */
function mergeBaseOf(run, base) {
    let target;
    let label;
    if (base) {
        const r = run(['rev-parse', '--verify', '--quiet', '--end-of-options', `${base}^{commit}`]);
        if (!ok(r))
            return { error: `cannot resolve --base ${base} to a commit` };
        target = line(r);
        label = base;
    }
    else {
        const resolved = resolveBase(run);
        if (resolved.kind !== 'resolved') {
            return { error: `no base branch found (${resolved.reason}) — pass --base <ref>` };
        }
        target = resolved.sha;
        label = resolved.base;
    }
    const mb = run(['merge-base', 'HEAD', target]);
    if (!ok(mb))
        return { error: `HEAD shares no history with ${label} — pass --base <ref>` };
    return { sha: line(mb), label };
}
const nulList = (out) => out.split('\0').filter(Boolean);
/** Every line of an untracked file is added. */
function allLines(top, path) {
    const count = readFileSync(join(top, path), 'utf8').split('\n').length;
    return new Set(Array.from({ length: count }, (_, i) => i + 1));
}
/** Paths whose bytes differ from what the coverage run measured, a deleted path included, so the
 * run's line numbers may not match the diff's. */
function stalePaths(run, top, manifest, paths) {
    if (paths.length === 0)
        return [];
    const stat = (p) => lstatSync(join(top, p), { throwIfNoEntry: false });
    const links = paths.filter((p) => stat(p)?.isSymbolicLink());
    const plain = paths.filter((p) => stat(p) && !links.includes(p));
    const now = plain.length
        ? run(['--literal-pathspecs', 'hash-object', '--', ...plain])
        : undefined;
    if (now && !ok(now))
        return paths;
    const hashes = now ? line(now).split('\n') : [];
    const current = new Map(plain.map((p, i) => [p, hashes[i]]));
    try {
        // A symlink's blob is its link text; hashing the path would hash its target instead.
        for (const p of links) {
            current.set(p, git(top, ['hash-object', '--stdin'], readlinkSync(join(top, p))).trim());
        }
        const atHead = blobsIn(top, manifest.head, paths.filter((p) => !Object.hasOwn(manifest.dirty, p)));
        return paths.filter((p) => (manifest.dirty[p] ?? atHead.get(p) ?? DELETED) !== (current.get(p) ?? DELETED));
    }
    catch {
        return paths;
    }
}
/** The configured diff-scope gate's verdict, in the gate's own order; null outside scope diff. */
function gateVerdict(cwd, gated, added, rows, notMeasured, empty, bound, stale) {
    const coverage = resolveGuardConfig(cwd).coverage;
    const scope = coverage === false ? null : resolveScope(coverage);
    if (!scope)
        return null;
    if ('error' in scope)
        return { pass: false, reason: `${scope.error} in guard.config.json` };
    if (scope.scope === 'repo')
        return null;
    if (![...added.keys()].some(gated)) {
        return { pass: true, reason: 'no added lines in production source' };
    }
    if (empty)
        return { pass: false, reason: `${COVERAGE_FILE} measured no files` };
    if (!bound)
        return { pass: false, reason: 'artifact provenance unknown' };
    if (stale.length) {
        return { pass: false, reason: `the artifact predates ${stale.length} changed file(s)` };
    }
    const counted = rows.filter((r) => gated(r.path));
    return addedLineVerdict(counted.reduce((n, r) => n + r.covered, 0), counted.reduce((n, r) => n + r.total, 0), notMeasured.filter(gated).length, scope.min);
}
const pct = (covered, total) => `${((covered / total) * 100).toFixed(1)}%`;
/** --min over unmeasured changed files: says how the floor was judged; true when it fails. */
function unmeasuredMin(min, total, unmeasured, empty) {
    if (empty) {
        console.error(`🚫 --min ${min}% not applied — ${COVERAGE_FILE} measured no files.`);
        console.error("   An empty report verifies nothing. Check the runner's coverage include, then re-run `devkit coverage-run`.");
        return true;
    }
    const how = total ? 'judged on measured lines only' : 'not applied: no measured added lines';
    console.error(`--min ${min}% ${how} (${unmeasured} unmeasured files listed above).`);
    return false;
}
function listCapped(paths) {
    const lines = paths.slice(0, MAX_LISTED).map((p) => `     ${p}`);
    if (paths.length > MAX_LISTED)
        lines.push(`     …and ${paths.length - MAX_LISTED} more`);
    return lines;
}
export default function coverageDiff(args, cwd) {
    const opts = parseOptions(args);
    if ('error' in opts) {
        console.error(`devkit coverage-diff: ${opts.error}\n\n${meta.help}`);
        return 2;
    }
    const file = resolve(cwd, COVERAGE_FILE);
    let artifact;
    let cov;
    try {
        artifact = readArtifact(file);
        cov = JSON.parse(artifact.bytes);
        computePercentages(cov); // shape validation: throws on a malformed entry
    }
    catch {
        const why = existsSync(file) ? 'unreadable or malformed' : 'absent';
        console.error(`🚫 ${COVERAGE_FILE} is ${why}. Produce it with \`devkit coverage-run\`, then re-run.`);
        return 1;
    }
    const probe = gitRunner(cwd);
    const topResult = probe(['rev-parse', '--show-toplevel']);
    if (!ok(topResult)) {
        console.error('devkit coverage-diff: not inside a git repository.');
        return 2;
    }
    const top = line(topResult);
    const run = gitRunner(top);
    const mb = mergeBaseOf(run, opts.base);
    if ('error' in mb) {
        console.error(`devkit coverage-diff: ${mb.error}`);
        return 2;
    }
    const bound = boundManifest(resolve(cwd, COVERAGE_DIR), artifact);
    const keys = keysByPath(Object.keys(cov), bound ? bound.roots : checkoutRoots(cwd, top));
    const classify = diffClassifier(cwd, top);
    // A measured file is reported whatever sourceExtensions says; the verdict counts the gate's set.
    const reported = (p) => classify(p, keys.has(p)) === 'production';
    const gated = (p) => classify(p, false) === 'production';
    let added;
    try {
        added = addedProductionLines(top, reported, [mb.sha]);
    }
    catch {
        console.error('devkit coverage-diff: git could not read the diff.');
        return 2;
    }
    const untracked = nulList(run(['ls-files', '-z', '--others', '--exclude-standard']).stdout).filter(reported);
    for (const path of untracked)
        added.set(path, allLines(top, path));
    const rows = [];
    const notMeasured = [];
    for (const [path, lines] of added) {
        const key = keys.get(path);
        if (key === undefined)
            notMeasured.push(path);
        else
            rows.push({ path, ...addedLineCoverage(cov[key] ?? {}, lines) });
    }
    rows.sort((a, b) => a.path.localeCompare(b.path));
    const changedSince = nulList(run(['diff', '--name-only', '-z', '--no-renames', '--no-relative', mb.sha]).stdout);
    const stale = bound
        ? stalePaths(run, top, bound, [...changedSince.filter(reported), ...untracked])
        : [];
    console.log(`Coverage of lines added since ${mb.label} (merge-base ${mb.sha.slice(0, 12)}):`);
    let covered = 0;
    let total = 0;
    for (const r of rows) {
        if (r.total === 0)
            continue;
        covered += r.covered;
        total += r.total;
        const missing = r.uncovered.length ? `   uncovered: ${lineRanges(r.uncovered)}` : '';
        console.log(`  ${`${r.covered}/${r.total}`.padStart(9)}  ${pct(r.covered, r.total).padStart(6)}  ${r.path}${missing}`);
    }
    if (total === 0)
        console.log('  no executable added lines in measured files.');
    else
        console.log(`Total: ${covered}/${total} added executable lines covered (${pct(covered, total)}).`);
    if (notMeasured.length) {
        console.log(`Not measured — changed source files absent from ${COVERAGE_FILE}:`);
        for (const l of listCapped(notMeasured.sort()))
            console.log(l);
    }
    if (!bound) {
        console.log('⚠️  Artifact provenance unknown (not from `devkit coverage-run`, or replaced since):');
        console.log('   line numbers may describe a different tree than the one diffed.');
    }
    else if (stale.length) {
        console.log('⚠️  Changed since the coverage run — line numbers may be stale; re-run `devkit coverage-run`:');
        for (const l of listCapped(stale))
            console.log(l);
    }
    const empty = Object.keys(cov).length === 0;
    const verdict = gateVerdict(cwd, gated, added, rows, notMeasured, empty, bound !== null, stale);
    if (verdict?.pass)
        console.log(`✓ Coverage gate (scope "diff") would pass — ${verdict.reason}.`);
    else if (verdict) {
        console.error(`🚫 Coverage gate (scope "diff") would FAIL if this ships — ${verdict.reason}.`);
        console.error('   Exact to what ships: devkit ship <branch> "<title>" --dry-gates -- <paths>');
    }
    const belowMin = opts.min !== undefined && total > 0 && (covered / total) * 100 < opts.min;
    if (belowMin) {
        console.error(`🚫 Added-line coverage ${pct(covered, total)} is below --min ${opts.min}%.`);
    }
    const unmeasuredFails = opts.min !== undefined &&
        notMeasured.length > 0 &&
        unmeasuredMin(opts.min, total, notMeasured.length, empty);
    return belowMin || unmeasuredFails || verdict?.pass === false ? 1 : 0;
}
