// Strict + ignoreBOM: a Git name is exact bytes, and a leading U+FEFF is part of it. A lossy
// decode would collapse two distinct non-UTF-8 names into the same U+FFFD string.
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** NUL-delimited `git … -z` path output, verbatim; null when a name is not valid UTF-8. */
export function readGitPaths(out: Uint8Array): string[] | null {
  try {
    return UTF8.decode(out).split('\0').filter(Boolean);
  } catch {
    return null;
  }
}
