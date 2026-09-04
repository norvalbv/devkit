#!/usr/bin/env node
/**
 * Self-host ship preflight for devkit's force-tracked, gitignored dist/ tree.
 *
 * The ephemeral ship worktree cannot see ignored files the caller forgot to brief. Inspect the
 * caller checkout before that worktree exists, while its physical build output and real Git index
 * are both available. Consumer repos no-op: this is devkit's own release topology, not a portable
 * guard.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assignedNames, ownDirVars, scanShellScript } from '../doctor/hook-gate-scan.mjs';
const CLEAN_REPORT = {
    active: false,
    unresolved: [],
    unbriefed: [],
    untracked: [],
    unlexable: [],
};
function git(root, args) {
    const raw = execFileSync('git', ['-C', root, ...args]);
    return raw.toString('utf8').split('\0').filter(Boolean);
}
function repoPath(root, absolute) {
    return path.relative(root, absolute).split(path.sep).join('/');
}
/**
 * A brief entry in the spelling `git ls-files` prints, so it can be compared with the index. Only
 * relative forms are folded: `./dist/x.mjs` is the same pathspec as `dist/x.mjs` to git AND the
 * same file to `$ROOT/$p` in reship.sh, so both callers really do stage it.
 *
 * An ABSOLUTE entry is deliberately left unfolded, even though git's pathspecs accept it.
 * reship.sh:126 probes `[ -e "$ROOT/$p" ]` by string concatenation, which for an absolute `$p`
 * builds `/repo//abs/path`, misses, and takes the `git rm` branch — the file never reaches the
 * commit. Folding it here would let this preflight vouch for an artifact reship silently drops.
 * Unfolded, it simply fails to match and the ship blocks, which is the safe direction. Teaching
 * reship.sh absolute paths is what unlocks folding them.
 */
function briefPath(briefed) {
    const relative = briefed.split(path.sep).join('/');
    return relative.startsWith('./') ? relative.slice(2) : relative;
}
function filesUnder(root, relativeDir) {
    const dir = path.join(root, relativeDir);
    if (!existsSync(dir))
        return [];
    const files = [];
    const walk = (absolute) => {
        for (const entry of readdirSync(absolute, { withFileTypes: true })) {
            const child = path.join(absolute, entry.name);
            if (entry.isDirectory())
                walk(child);
            else if (entry.isFile())
                files.push(repoPath(root, child));
        }
    };
    walk(dir);
    return files.sort();
}
function packageName(root) {
    try {
        return JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).name;
    }
    catch {
        return undefined;
    }
}
function importTarget(root, importer, specifier) {
    const importerUrl = pathToFileURL(path.join(root, importer));
    return repoPath(root, fileURLToPath(new URL(specifier, importerUrl)));
}
function generatedPath(briefedPath) {
    const normalized = briefedPath.split(path.sep).join('/');
    if (normalized.startsWith('dist/'))
        return normalized;
    if (!normalized.startsWith('cli/') && !normalized.startsWith('gate-engine/'))
        return undefined;
    return normalized.endsWith('.mts')
        ? `dist/${normalized.slice(0, -'.mts'.length)}.mjs`
        : `dist/${normalized}`;
}
/**
 * Relative-import edges of ONE emitted module. `undefined` means unparseable — a hole every caller
 * must fail on. Shared so the preflight and the tracked-dist test cannot disagree about an edge.
 */
export async function moduleImportEdges(root, importer, source) {
    // This dependency is dev-only and intentionally loaded only for devkit self-hosting. Installed
    // consumer copies short-circuit before any caller reaches here and never need it at runtime.
    const { init, parse } = await import('es-module-lexer');
    await init;
    let imports;
    try {
        [imports] = parse(source, importer);
    }
    catch {
        return undefined;
    }
    const edges = [];
    for (const item of imports) {
        // `n` is populated for static and string-literal dynamic imports. It is undefined for
        // expressions/templates such as import(`./${name}.mjs`), which cannot be resolved here.
        const specifier = item.n;
        if (!specifier?.startsWith('.'))
            continue;
        edges.push({ importer, specifier, target: importTarget(root, importer, specifier) });
    }
    return edges;
}
/** The literal inline spelling of "my own directory", used without a variable. */
const SCRIPT_DIR_LITERAL = '$(dirname "${BASH_SOURCE[0]}")';
/** A leading underscore is real here — review/submodules.sh uses `_REVIEW_SUBMODULE_LIB_DIR`. */
const VAR_EXPANSION = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/;
/** Rooted outside the package tree: a real runtime dependency, but never on a dist artifact. */
const EXTERNAL_ROOT = /^\$\{?(?:HOME|TMPDIR|XDG_[A-Z_]+)\}?$/;
const BARE_VAR = /^\$[A-Za-z_][A-Za-z0-9_]*/;
/** `$( )` and `${ }` nest, so a scan to the FIRST closer takes the wrong span for `$(x "$(y)")`. */
function expansionEnd(operand) {
    const open = operand[1];
    if (open !== '(' && open !== '{') {
        return operand.startsWith('$') ? (BARE_VAR.exec(operand)?.[0].length ?? -1) : -1;
    }
    const close = open === '(' ? ')' : '}';
    let depth = 0;
    for (let i = 1; i < operand.length; i++) {
        if (operand[i] === open)
            depth++;
        else if (operand[i] === close && --depth === 0)
            return i + 1;
    }
    return -1;
}
function unwrapQuotes(operand) {
    const quoted = operand.startsWith('"') && operand.length > 1 && operand.endsWith('"');
    return quoted ? operand.slice(1, -1) : operand;
}
/** Repo path, `null` when deliberately outside the dist closure, `undefined` when opaque. */
function shellTarget(importer, operand, dirVars, assigned) {
    const bare = unwrapQuotes(operand);
    // An absolute system path (`. /etc/os-release`) is a real dependency, never a dist artifact.
    if (bare.startsWith('/'))
        return null;
    const end = expansionEnd(bare);
    if (end === -1)
        return undefined;
    const expansion = bare.slice(0, end);
    const tail = bare.slice(end);
    if (!tail.startsWith('/'))
        return undefined;
    const named = VAR_EXPANSION.exec(expansion);
    if (!(named ? dirVars.has(named[1]) : expansion === SCRIPT_DIR_LITERAL)) {
        // External root only for a name this script never assigns: a reassigned `HOME` is not $HOME,
        // whatever it now holds, so it cannot be waved through as living outside the package.
        const inherited = named === null || !assigned.has(named[1]);
        return inherited && EXTERNAL_ROOT.test(expansion) ? null : undefined;
    }
    // Returned even when it climbs out of dist/: `willShip` then names the exact edge, which is
    // what an .mjs import above dist already gets. The requeue guard keeps the WALK inside dist.
    return path.posix.normalize(path.posix.join(path.posix.dirname(importer), tail));
}
/**
 * Shell `source` edges of ONE shipped script — moduleImportEdges' shape and its `undefined` =
 * unverified = BLOCKS contract. See docs/decisions/typescript-source-prebuilt-mjs.md (sc-2522).
 */
export async function shellSourceEdges(importer, source) {
    // Dev-only in the same sense as es-module-lexer above: consumers short-circuit before this runs.
    const { parse } = await import('unbash');
    const scan = scanShellScript(source, parse);
    if (scan === undefined)
        return undefined;
    const edges = [];
    for (const { text, at } of scan.operands) {
        // Only the nearest preceding assignment counts: `DIR=<own>; DIR=/tmp; . "$DIR/x"` is untrusted.
        const target = shellTarget(importer, text, ownDirVars(scan, at), assignedNames(scan));
        if (target === null)
            continue;
        if (target === undefined)
            return undefined;
        edges.push({ importer, specifier: text, target });
    }
    return edges;
}
/**
 * Inspect the caller's physical dist tree, Git index, and ship briefing.
 * `base` is the commit the ship worktree would be cut from.
 */
export async function inspectDistIntegrity(root, base, briefedPaths) {
    if (packageName(root) !== '@norvalbv/devkit')
        return { ...CLEAN_REPORT };
    const physical = filesUnder(root, 'dist');
    const physicalSet = new Set(physical);
    const tracked = new Set(git(root, ['ls-files', '--cached', '-z', '--', 'dist']));
    const briefed = new Set(briefedPaths.map(briefPath));
    // A briefed path this ship stages as a DELETION is the one case where briefing does NOT put the
    // file in the commit: ship-branch.sh skips the force-add for it on purpose (sc-1489 — otherwise a
    // regenerable artifact back on disk silently re-adds itself and the deletion can never land). It
    // reports as D because `git diff <commit>` never sees an untracked file, so a path dropped from
    // the index while still on disk looks deleted against the base the worktree is cut from.
    const deleted = new Set(git(root, ['diff', '--name-only', '-z', '--diff-filter=D', base, '--', 'dist']));
    // Index membership is not the property that matters — presence in the commit this ship is about
    // to create is. ship-branch.sh and reship.sh `git add -f` every briefed path, so briefing one IS
    // shipping it, and demanding it be pre-staged rejects the artifact a release just generated.
    const shipping = (file) => briefed.has(file) && !deleted.has(file);
    const willShip = (file) => tracked.has(file) || shipping(file);
    // Shared checkouts can contain another agent's generated output. Seed the scan from this ship's
    // explicit source/dist paths, then follow only their reachable physical dist import graph.
    const required = new Set([...briefed].map(generatedPath).filter((file) => file !== undefined));
    const unresolved = [];
    const unlexable = [];
    const walkable = (file) => file.endsWith('.mjs') || file.endsWith('.sh');
    const queue = [...required].filter(walkable).sort();
    const queued = new Set(queue);
    const parsed = new Set();
    let queueIndex = 0;
    while (queueIndex < queue.length) {
        const importer = queue[queueIndex++];
        if (parsed.has(importer))
            continue;
        parsed.add(importer);
        const absolute = path.join(root, importer);
        // Keep discovery inside the explicit roots, but continue through every reachable physical dist
        // module so one report names the whole omitted closure. A deleted artifact is deliberately not
        // a discovery root: its dependencies are leaving with it, not candidates to add back.
        if (deleted.has(importer) || !physicalSet.has(importer) || !existsSync(absolute))
            continue;
        const text = readFileSync(absolute, 'utf8');
        const edges = importer.endsWith('.sh')
            ? await shellSourceEdges(importer, text)
            : await moduleImportEdges(root, importer, text);
        if (edges === undefined) {
            // Recorded, not thrown: it still blocks via `unlexable`, and finishing the queue lets one
            // report name the file instead of main()'s catch aborting with a message naming nothing.
            unlexable.push(importer);
            continue;
        }
        for (const { specifier, target } of edges) {
            required.add(target);
            if (!willShip(target) || !existsSync(path.join(root, target))) {
                unresolved.push({ importer, specifier, target });
            }
            if (
            // Shell walks transitively too: ship-branch.sh -> review/worktrees.sh -> its own siblings.
            // Omitting .sh here would report the first hop of a new chain and stop.
            walkable(target) &&
                physicalSet.has(target) &&
                !deleted.has(target) &&
                !queued.has(target)) {
                queued.add(target);
                queue.push(target);
            }
        }
    }
    // `shipping`, never `required`: briefing cli/new.mts still maps dist/cli/new.mjs into `required`
    // without putting it in `briefed`, and that asymmetry IS the guard — it is what still catches a
    // ship that carries source while leaving its build output behind (sc-1199/sc-1246).
    const untracked = physical.filter((file) => required.has(file) && !tracked.has(file) && !shipping(file));
    const added = git(root, ['diff', '--name-only', '-z', '--diff-filter=A', base, '--', 'dist']);
    const unbriefed = added.filter((file) => required.has(file) && !briefed.has(file)).sort();
    unresolved.sort((a, b) => `${a.importer}\0${a.specifier}`.localeCompare(`${b.importer}\0${b.specifier}`));
    return { active: true, unresolved, unbriefed, untracked, unlexable: unlexable.sort() };
}
function shellQuote(value) {
    return `'${value.replaceAll("'", "'\\''")}'`;
}
export function printDistIntegrityFailure(report) {
    if (!report.active)
        return 0;
    const failed = report.untracked.length > 0 ||
        report.unbriefed.length > 0 ||
        report.unresolved.length > 0 ||
        report.unlexable.length > 0;
    if (!failed)
        return 0;
    console.error('✗ devkit ship: dist integrity preflight failed.');
    if (report.unlexable.length > 0) {
        console.error('  Generated dist artifacts could not be read, so their dependencies are unchecked:');
        for (const file of report.unlexable)
            console.error(`    ${file}`);
    }
    if (report.untracked.length > 0) {
        console.error('  Generated dist artifacts this ship would not commit:');
        for (const file of report.untracked)
            console.error(`    ${file}`);
        console.error(`  Fix: git add -f -- ${report.untracked.map(shellQuote).join(' ')}`);
        console.error('  …or drop the path from this ship if you meant its deletion to land.');
    }
    if (report.unbriefed.length > 0) {
        console.error('  Newly tracked dist artifacts are omitted from this ship:');
        for (const file of report.unbriefed)
            console.error(`    ${file}`);
    }
    if (report.unresolved.length > 0) {
        console.error('  Relative imports and shell source targets do not resolve to tracked dist files:');
        for (const item of report.unresolved) {
            console.error(`    ${item.importer}: ${item.specifier} -> ${item.target}`);
        }
    }
    if (report.untracked.length > 0 || report.unbriefed.length > 0) {
        const paths = [...new Set([...report.untracked, ...report.unbriefed])];
        console.error(`  Include after -- in the next devkit ship: ${paths.map(shellQuote).join(' ')}`);
    }
    return 1;
}
function parseArgs(argv) {
    let root = '';
    let base = '';
    let i = 0;
    for (; i < argv.length; i++) {
        if (argv[i] === '--') {
            i++;
            break;
        }
        if (argv[i] === '--root' && argv[i + 1])
            root = argv[++i];
        else if (argv[i] === '--base' && argv[i + 1])
            base = argv[++i];
        else
            throw new Error(`unknown or incomplete argument: ${argv[i]}`);
    }
    if (!root || !base)
        throw new Error('usage: dist-integrity --root <root> --base <sha> -- <paths>');
    return { base, paths: argv.slice(i), root };
}
async function main() {
    try {
        const { base, paths, root } = parseArgs(process.argv.slice(2));
        process.exitCode = printDistIntegrityFailure(await inspectDistIntegrity(root, base, paths));
    }
    catch (error) {
        console.error(`✗ devkit ship: dist integrity preflight could not run — ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
    void main();
}
