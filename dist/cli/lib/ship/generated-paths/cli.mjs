#!/usr/bin/env node
// ship-branch.sh's staging-abort renderer: NUL-delimited unmerged paths (`git diff -z`) in, abort
// text out. Any failure exits 2 with an EMPTY stdout, so ship falls back to its hand-merge text.
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { classifyGenerated, generatedPathsFor, renderCommand, renderConflictAbort, } from './registry.mjs';
import { errorMessage } from '../review/shared/common.mjs';
import { readGitPaths } from '../../../../gate-engine/ratchets/git-paths.mjs';
export function parseArgs(argv) {
    let root;
    let baseRef;
    for (let i = 0; i < argv.length; i++) {
        const value = argv[i + 1];
        if (argv[i] === '--root' && value && !value.startsWith('--'))
            root = argv[++i];
        else if (argv[i] === '--base-ref' && value && !value.startsWith('--'))
            baseRef = argv[++i];
        else
            throw new Error(`unknown or incomplete argument: ${argv[i]}`);
    }
    if (!root || !baseRef)
        throw new Error('usage: cli.mts --root <root> --base-ref <ref> < paths');
    return { root, baseRef };
}
/** The rendered abort for these unmerged paths, with every command in the form typed at `root`. */
export function renderAbort(paths, { root, baseRef }) {
    const classified = classifyGenerated(paths, generatedPathsFor(root));
    classified.generated = classified.generated.map((m) => ({
        ...m,
        command: renderCommand(m.command, root),
    }));
    return renderConflictAbort(classified, baseRef).join('\n');
}
// A non-UTF-8 name throws, so ship prints git's own listing instead.
function readPaths(stdin) {
    const paths = readGitPaths(stdin);
    if (!paths)
        throw new Error('a conflicted path is not valid UTF-8');
    return paths;
}
function main() {
    try {
        const args = parseArgs(process.argv.slice(2));
        const text = renderAbort(readPaths(readFileSync(0)), args);
        if (text)
            process.stdout.write(`${text}\n`);
    }
    catch (error) {
        process.stderr.write(`generated-paths: ${errorMessage(error)}\n`);
        process.exitCode = 2;
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
    main();
}
