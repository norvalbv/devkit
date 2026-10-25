import { isUtf8 } from 'node:buffer';
// A Git name is exact bytes: a leading U+FEFF is kept, and an invalid name is counted, never
// collapsed to U+FFFD (two distinct non-UTF-8 names would otherwise read as the same string).
/** NUL-delimited `git … -z` path output, verbatim; names that are not valid UTF-8 are counted. */
export function splitGitPaths(out) {
    const paths = [];
    let undecodable = 0;
    const bytes = Buffer.from(out.buffer, out.byteOffset, out.byteLength);
    for (const record of bytes.toString('latin1').split('\0')) {
        if (!record)
            continue;
        const name = Buffer.from(record, 'latin1');
        if (isUtf8(name))
            paths.push(name.toString('utf8'));
        else
            undecodable++;
    }
    return { paths, undecodable };
}
/** NUL-delimited `git … -z` path output, verbatim; null when a name is not valid UTF-8. */
export function readGitPaths(out) {
    const { paths, undecodable } = splitGitPaths(out);
    return undecodable ? null : paths;
}
