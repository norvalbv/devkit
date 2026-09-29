/** The configured SQLite search index and its sidecars, as a review gate projection sees them. */

const SQLITE_SUFFIXES = ['', '-wal', '-shm', '-journal'] as const;

export function sqliteFamily(indexPath: string): string[] {
  return SQLITE_SUFFIXES.map((suffix) => `${indexPath}${suffix}`);
}

export function sqliteFamilyPath(path: string, indexPath: string): boolean {
  return Boolean(indexPath) && sqliteFamily(indexPath).includes(path);
}

// Every live reader rewrites the wal-index and SQLite rebuilds it on first open, so it is never
// captured or copied: the private copy starts without one, and the WAL alone carries the frames.
export function sqliteWalIndexPath(path: string, indexPath: string): boolean {
  return Boolean(indexPath) && path === `${indexPath}-shm`;
}
