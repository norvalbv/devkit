import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
function ensurePrivateDir(path) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
}
/** Atomically create a private immutable file; callers choose its evidence or git-dir location. */
export function atomicWrite(path, content) {
    ensurePrivateDir(dirname(path));
    if (existsSync(path))
        throw new Error(`immutable evidence already exists: ${path}`);
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
}
