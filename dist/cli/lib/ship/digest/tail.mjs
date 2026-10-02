/** Backward reader over the append-only, per-MACHINE gate-events sink: a full read is unbounded, so
 * each caller names how a line parses and when it has read far enough. */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
const CHUNK = 256 * 1024;
/** Backstop for a sink whose stop row is missing (a hand-set DEVKIT_SHIP_ID, a rotated file). */
const MAX_READ = 16 * 1024 * 1024;
const NEWLINE = 0x0a;
const EMPTY = Buffer.alloc(0);
/**
 * The sink's parsed rows in file order, read backward a chunk at a time until `done` holds for the
 * rows kept so far or MAX_READ is spent. Never throws: an absent, unreadable or torn sink yields [].
 */
export function scanBackward(sink, parse, done) {
    if (!sink)
        return [];
    let fd;
    try {
        fd = openSync(sink, 'r');
        let pos = fstatSync(fd).size;
        let read = 0;
        // The partial FIRST line of the region already scanned — completed by the chunk read next,
        // which sits EARLIER in the file.
        let carry = EMPTY;
        const perChunk = [];
        while (pos > 0 && read < MAX_READ) {
            const len = Math.min(CHUNK, pos);
            pos -= len;
            const buf = Buffer.alloc(len);
            readSync(fd, buf, 0, len, pos);
            read += len;
            const combined = carry.length > 0 ? Buffer.concat([buf, carry]) : buf;
            // Split on the newline BYTE: 0x0A never occurs inside a UTF-8 sequence, so no codepoint is cut
            // and the scan stays linear in the bytes read.
            let text;
            const cut = pos === 0 ? -1 : combined.indexOf(NEWLINE);
            if (pos === 0) {
                // Offset 0 IS a line boundary — the file begins here, so nothing is left dangling.
                text = combined.toString('utf8');
                carry = EMPTY;
            }
            else if (cut === -1) {
                carry = combined;
                text = '';
            }
            else {
                carry = combined.subarray(0, cut);
                text = combined.subarray(cut + 1).toString('utf8');
            }
            const rows = [];
            for (const line of text.split('\n')) {
                const row = line ? parse(line) : undefined;
                if (row !== undefined)
                    rows.push(row);
            }
            perChunk.unshift(rows);
            if (done(perChunk.flat()))
                break;
        }
        return perChunk.flat();
    }
    catch {
        return [];
    }
    finally {
        if (fd !== undefined) {
            try {
                closeSync(fd);
            }
            catch {
                /* nothing left to do with a descriptor we cannot close */
            }
        }
    }
}
