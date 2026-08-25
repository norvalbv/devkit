/**
 * sc-2073: chunked review (sc-1907) records chunk grain in CHILD tables
 * (commit_review_chunks, commit_review_lens_chunks); the parent tables stay merged at one row
 * per (ship, reviewer[, lens]). Every consumer in this directory indexes or joins on those keys,
 * so a collector regression that writes per-chunk PARENT rows would silently fan out joins,
 * last-write-wins Map indexes, and mint waivers as training labels. This guard makes that
 * assumption fail loudly before any consumer reads a corrupted shape.
 */
import { execFileSync } from 'node:child_process';

const DUP_CHECKS: readonly { table: string; keyCols: string }[] = [
  { table: 'commit_reviews', keyCols: 'ship_id, reviewer' },
  { table: 'commit_review_scope', keyCols: 'ship_id, reviewer' },
  { table: 'commit_review_lenses', keyCols: 'ship_id, reviewer, lens' },
];

/**
 * Throw if any parent warehouse table carries duplicate rows for its consumer key. Deliberately
 * NOT memoized: consumers loop for minutes over a warehouse a concurrent gate run may be writing,
 * and a checked-once pass would go stale mid-loop. A missing table (older warehouse) passes —
 * there is nothing to mis-read; every OTHER query failure (locked/corrupt db, missing sqlite3)
 * rethrows, because "could not verify" must never read as "verified".
 */
export function assertMergedParentRows(dbPath: string): void {
  for (const { table, keyCols } of DUP_CHECKS) {
    let out = '';
    try {
      out = execFileSync(
        'sqlite3',
        [
          '-readonly',
          '-json',
          dbPath,
          `select ${keyCols}, count(*) as n from ${table} group by ${keyCols} having n > 1 limit 3`,
        ],
        { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
      );
    } catch (e) {
      // SAFETY: execFileSync failures surface sqlite3's stderr on .stderr (Buffer|string) and a
      // summary on .message; both are optional on the unknown error shape.
      const err = e as { stderr?: Buffer | string; message?: string };
      const detail = `${err.stderr ?? ''}${err.message ?? ''}`;
      if (/no such table/i.test(detail)) continue;
      throw new Error(
        `warehouse guard (sc-2073): could not verify ${table} in ${dbPath} — refusing to treat an unverifiable warehouse as clean: ${detail.trim().slice(0, 300)}`,
      );
    }
    if (out.trim())
      throw new Error(
        `warehouse guard (sc-2073): ${table} has duplicate (${keyCols}) rows — refusing to read a shape that fans out joins or last-write-wins indexes. Offending keys: ${out.trim().slice(0, 300)}`,
      );
  }
}
