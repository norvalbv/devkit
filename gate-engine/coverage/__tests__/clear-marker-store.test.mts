import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ClearMarker,
  readClearMarker,
  removeClearMarker,
  writeClearMarker,
} from '../clear-marker/store.mts';

let roots: string[] = [];
const makeRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'coverage-clear-marker-'));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

describe('the clear marker store', () => {
  it('round-trips, and is removable', () => {
    const root = makeRoot();
    const marker: ClearMarker = {
      clearedAt: '2026-08-30T09:00:00.000Z',
      previousMtime: 1234.5,
      head: 'da19b37c',
      failedFiles: ['/repo/a.test.ts'],
    };
    writeClearMarker(root, marker);
    expect(readClearMarker(root)).toEqual(marker);
    removeClearMarker(root);
    expect(readClearMarker(root)).toBeNull();
  });

  // The gate's verdict must never depend on this file. A corrupt marker is a missing marker.
  it('reads a corrupt marker as absent instead of throwing', () => {
    const root = makeRoot();
    writeFileSync(join(root, '.last-clear.json'), 'not json');
    expect(readClearMarker(root)).toBeNull();
    writeFileSync(join(root, '.last-clear.json'), '{"nope":1}');
    expect(readClearMarker(root)).toBeNull();
  });

  // 0 is a legitimate mtime (epoch), and `||` here would silently rewrite it to null — losing the
  // one field that says WHICH artifact was discarded.
  it('keeps a previousMtime of 0 instead of collapsing it to null', () => {
    const root = makeRoot();
    writeFileSync(
      join(root, '.last-clear.json'),
      JSON.stringify({ clearedAt: '2026-08-30T09:00:00.000Z', previousMtime: 0, failedFiles: [] }),
    );
    expect(readClearMarker(root)?.previousMtime).toBe(0);
  });

  it('reads a marker written before the field existed', () => {
    const root = makeRoot();
    writeFileSync(
      join(root, '.last-clear.json'),
      JSON.stringify({ clearedAt: new Date().toISOString(), failedFiles: [] }),
    );

    expect(readClearMarker(root)?.unhandledErrors).toBeUndefined();
  });
});

describe('a marker whose unhandledErrors we did not write', () => {
  // coverage/ is shared and symlinked into ship worktrees; a hand-edited entry must not crash the gate
  // message that explains the block.
  it('keeps only well-formed entries', () => {
    const root = makeRoot();
    const good = { file: null, message: 'Error: boom' };
    writeFileSync(
      join(root, '.last-clear.json'),
      JSON.stringify({
        clearedAt: '2026-10-06T09:00:00.000Z',
        failedFiles: [],
        unhandledErrors: [null, 'Error: bare string', { file: 3, message: 'x' }, good],
      }),
    );

    const marker = readClearMarker(root);
    expect(marker?.unhandledErrors).toEqual([good]);
  });
});
