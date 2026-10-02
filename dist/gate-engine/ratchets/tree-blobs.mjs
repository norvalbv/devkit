// Batched byte-exact blob reads from one git tree (sc-2759); git-index.mts holds the per-path readers.
import { execFileSync } from 'node:child_process';
import { commitIndexEnv } from './commit-index.mjs';
// Fatal: a lossy decode maps distinct non-UTF-8 paths to one `\uFFFD` key, so one blob overwrites another.
const UTF8 = new TextDecoder('utf-8', { fatal: true });
/** Regular blobs under `pathspecs` in `tree`, byte-exact, in two spawns; symlinks → null, gitlinks
 * skipped. Null when git cannot answer or a path is not UTF-8, so the caller stands down. */
export function treeBlobsAtRef(root, tree, pathspecs) {
    try {
        const listing = execFileSync('git', ['ls-tree', '-r', '-z', tree, '--', ...pathspecs], {
            cwd: root,
            env: commitIndexEnv(root),
            stdio: ['ignore', 'pipe', 'ignore'],
            maxBuffer: 64 * 1024 * 1024,
        });
        const blobs = new Map();
        const oids = [];
        for (let at = 0; at < listing.length;) {
            const end = listing.indexOf(0, at);
            const entry = listing.subarray(at, end === -1 ? listing.length : end);
            at = end === -1 ? listing.length : end + 1;
            const tab = entry.indexOf(0x09);
            const [mode, type, oid] = entry.subarray(0, tab).toString('ascii').split(' ');
            const path = UTF8.decode(entry.subarray(tab + 1));
            if (type !== 'blob')
                continue;
            if (mode === '120000')
                blobs.set(path, null);
            else
                oids.push([path, oid]);
        }
        if (!oids.length)
            return blobs;
        const out = execFileSync('git', ['cat-file', '--batch'], {
            cwd: root,
            env: commitIndexEnv(root),
            input: `${oids.map(([, oid]) => oid).join('\n')}\n`,
            stdio: ['pipe', 'pipe', 'ignore'],
            maxBuffer: 512 * 1024 * 1024,
        });
        let at = 0;
        for (const [path, oid] of oids) {
            const eol = out.indexOf(0x0a, at);
            const [gotOid, type, size] = out.subarray(at, eol).toString('utf8').split(' ');
            if (gotOid !== oid || type !== 'blob')
                return null;
            const start = eol + 1;
            const end = start + Number(size);
            blobs.set(path, Buffer.from(out.subarray(start, end)));
            at = end + 1;
        }
        return blobs;
    }
    catch {
        return null;
    }
}
