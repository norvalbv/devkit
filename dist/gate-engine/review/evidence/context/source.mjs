/** Bounded, immutable source discovery for the opt-in correctness evidence experiment. */
import { execFileSync } from 'node:child_process';
import { posix } from 'node:path';
import { initSync, parse } from 'es-module-lexer';
import { splitDiffByFile } from '../../../judge/diff-focus.mjs';
import { postImagePathOf } from '../../lens/chunk.mjs';
import { selectImports } from './import-selection.mjs';
export const CONTEXT_MODE = 'bounded-v1';
export function resolveContextMode(raw = process.env.GUARD_CORRECTNESS_CONTEXT) {
    if (!raw || raw === 'off' || raw === '0')
        return null;
    if (raw === CONTEXT_MODE)
        return CONTEXT_MODE;
    throw new Error(`GUARD_CORRECTNESS_CONTEXT: expected off or ${CONTEXT_MODE}, got ${raw}`);
}
export const PREPARATION_LIMITS = Object.freeze({
    files: 64,
    blobs: 128,
    blobBytes: 256 * 1024,
    sourceBytes: 4 * 1024 * 1024,
    gitBytes: 8 * 1024 * 1024,
    milliseconds: 15_000,
    importsPerFile: 16,
});
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
/** Resolve only a unique, direct relative module; aliases and computed imports remain unknown. */
export function relativeModule(owner, spec, paths) {
    const stem = posix.normalize(posix.join(posix.dirname(owner), spec));
    if (stem.startsWith('../') || stem === '..' || posix.isAbsolute(stem))
        return null;
    const choices = new Set([stem, ...EXTENSIONS.flatMap((e) => [stem + e, `${stem}/index${e}`])]);
    const remap = new Map([
        ['.js', ['.ts', '.tsx']],
        ['.mjs', ['.mts']],
        ['.cjs', ['.cts']],
    ]);
    const ext = posix.extname(stem);
    for (const replacement of remap.get(ext) ?? [])
        choices.add(stem.slice(0, -ext.length) + replacement);
    const found = [...choices].filter((p) => paths.has(p));
    return found.length === 1 ? found[0] : null;
}
/** Snapshot IDs are retrieval provenance, not semantic cache salt. No worktree source is read. */
export function prepareContextSource(cwd, files, snapshot) {
    const deadline = Date.now() + PREPARATION_LIMITS.milliseconds;
    const git = (args, maxBuffer = PREPARATION_LIMITS.gitBytes, input) => {
        const timeout = deadline - Date.now();
        if (timeout <= 0)
            throw new Error('context preparation time budget exhausted');
        return execFileSync('git', ['--no-pager', ...args], {
            cwd,
            encoding: 'utf8',
            timeout,
            maxBuffer,
            input,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, GIT_LITERAL_PATHSPECS: '1' },
        });
    };
    const staged = snapshot?.staged ?? git(['write-tree']).trim();
    let base = snapshot?.base;
    if (snapshot && !base)
        base = git(['hash-object', '-w', '-t', 'tree', '--stdin'], undefined, '').trim();
    if (!base) {
        try {
            base = git(['rev-parse', '--verify', 'HEAD^{tree}']).trim();
        }
        catch {
            base = git(['hash-object', '-w', '-t', 'tree', '--stdin'], undefined, '').trim();
        }
    }
    const selected = [...new Set(files)].sort();
    const result = {
        base,
        staged,
        files: selected,
        segments: new Map(),
        notes: new Map(),
        neighbors: new Map(),
    };
    const note = (owner, value) => {
        const notes = result.notes.get(owner) ?? [];
        if (!notes.includes(value))
            notes.push(value);
        result.notes.set(owner, notes);
    };
    const add = (owner, segment) => {
        const segments = result.segments.get(owner) ?? [];
        if (!segments.some((s) => s.path === segment.path && s.side === segment.side))
            segments.push(segment);
        result.segments.set(owner, segments);
    };
    const preimages = new Map();
    try {
        const names = git(['diff', '--name-status', '--find-renames', '-z', base, staged]).split('\0');
        for (let i = 0; i < names.length - 1;) {
            const status = names[i++];
            const before = names[i++];
            if (/^[RC]/.test(status)) {
                const after = names[i++];
                if (selected.includes(after))
                    preimages.set(after, before);
            }
        }
    }
    catch {
        for (const f of selected)
            note(f, 'Rename discovery unavailable (Git/preparation bound).');
    }
    // Git's enclosing-function view uses the captured pair, including deletions and rename headers.
    try {
        const expanded = git([
            'diff',
            '--no-ext-diff',
            '--no-textconv',
            '--find-renames',
            '--function-context',
            base,
            staged,
            '--',
            ...new Set([...selected, ...preimages.values()]),
        ]);
        for (const content of splitDiffByFile(expanded)) {
            const path = postImagePathOf(content);
            if (path && selected.includes(path))
                add(path, { path, side: 'function-diff', content });
        }
    }
    catch {
        for (const f of selected)
            note(f, 'Enclosing-function context unavailable (Git/preparation bound).');
    }
    const touched = new Set();
    const memo = new Map();
    let sourceBytes = 0;
    let blobs = 0;
    for (const [side, tree] of [
        ['staged', staged],
        ['base', base],
    ]) {
        const entries = new Map();
        try {
            for (const entry of git(['ls-tree', '-r', '-l', '-z', tree]).split('\0')) {
                const tab = entry.indexOf('\t');
                if (tab < 0)
                    continue;
                const [mode, type, oid, size] = entry.slice(0, tab).trim().split(/\s+/);
                if (type === 'blob')
                    entries.set(entry.slice(tab + 1), { oid, size: Number(size), mode });
            }
        }
        catch {
            for (const f of selected)
                note(f, `${side} source inventory unavailable (Git/preparation bound).`);
            continue;
        }
        const paths = new Set(entries.keys());
        const read = (path) => {
            const key = `${side}:${path}`;
            if (memo.has(key))
                return memo.get(key);
            const entry = entries.get(path);
            memo.set(key, null);
            if (!entry || !['100644', '100755'].includes(entry.mode))
                return null;
            if ((!touched.has(path) && touched.size >= PREPARATION_LIMITS.files) ||
                blobs >= PREPARATION_LIMITS.blobs ||
                entry.size > PREPARATION_LIMITS.blobBytes ||
                sourceBytes + entry.size > PREPARATION_LIMITS.sourceBytes)
                return null;
            touched.add(path);
            blobs++;
            sourceBytes += entry.size;
            try {
                const content = git(['cat-file', 'blob', entry.oid], PREPARATION_LIMITS.blobBytes);
                if (content.includes('\0'))
                    return null;
                memo.set(key, content);
                return content;
            }
            catch {
                return null;
            }
        };
        const links = [];
        for (const owner of selected) {
            const sourcePath = side === 'base' ? (preimages.get(owner) ?? owner) : owner;
            if (!entries.has(sourcePath))
                continue; // A deletion/addition has no source on this side.
            const content = read(sourcePath);
            if (content === null) {
                note(owner, `${side} imports unavailable (unsupported source/preparation bound).`);
                continue;
            }
            if (!EXTENSIONS.includes(posix.extname(owner))) {
                note(owner, `${side} import discovery unsupported for this language.`);
                continue;
            }
            try {
                initSync();
                const [imports] = parse(content);
                const relative = imports.filter((imp) => imp.n && /^\.\.?\//.test(imp.n));
                if (relative.length !== imports.length)
                    note(owner, `${side} non-relative/computed imports are outside automatic discovery.`);
                if (relative.length > PREPARATION_LIMITS.importsPerFile)
                    note(owner, `${side} import discovery truncated after ${PREPARATION_LIMITS.importsPerFile} imports.`);
                const functionDiff = result.segments.get(owner)?.find((s) => s.side === 'function-diff')?.content ?? '';
                for (const imp of selectImports(relative, content, functionDiff, side, PREPARATION_LIMITS.importsPerFile)) {
                    const target = relativeModule(sourcePath, imp.n, paths);
                    if (target)
                        links.push([owner, target]);
                    else
                        note(owner, `${side} unresolved or ambiguous relative import: ${JSON.stringify(imp.n)}.`);
                }
                if (/\brequire\s*\(/.test(content))
                    note(owner, `${side} CommonJS imports are outside automatic discovery.`);
            }
            catch {
                note(owner, `${side} import syntax unsupported by the module lexer.`);
            }
        }
        for (const [owner, target] of links) {
            const content = read(target);
            if (content === null)
                note(owner, `${side} related source unavailable: ${JSON.stringify(target)} (preparation bound/unsupported source).`);
            else
                add(owner, { path: target, side, content });
            // Reverse reach is deliberately limited to selected changed importers, not repository-wide.
            const targetOwner = side === 'base'
                ? ([...preimages].find(([, before]) => before === target)?.[0] ?? target)
                : target;
            if (!selected.includes(targetOwner))
                continue;
            for (const [a, b] of [
                [owner, targetOwner],
                [targetOwner, owner],
            ]) {
                const neighbors = result.neighbors.get(a) ?? new Set();
                neighbors.add(b);
                result.neighbors.set(a, neighbors);
            }
            const callerPath = side === 'base' ? (preimages.get(owner) ?? owner) : owner;
            const caller = read(callerPath);
            if (caller !== null)
                add(targetOwner, { path: callerPath, side, content: caller });
        }
    }
    return result;
}
/** Stable component traversal puts directly related changed files near one another; cycles terminate. */
export function relatedFileOrder(source) {
    const ordered = [];
    const seen = new Set();
    for (const start of source.files) {
        const stack = [start];
        while (stack.length) {
            const file = stack.pop();
            if (seen.has(file))
                continue;
            seen.add(file);
            ordered.push(file);
            stack.push(...[...(source.neighbors.get(file) ?? [])].sort().reverse());
        }
    }
    return ordered;
}
