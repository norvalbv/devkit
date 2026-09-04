/**
 * The tracked dist dependency closure — ESM imports AND shell `source` edges — over the COMMITTED
 * tree, not the ship path dist-integrity.mts guards. docs/decisions/typescript-source-prebuilt-mjs.md.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  type ImportEdge,
  moduleImportEdges,
  shellSourceEdges,
} from '../lib/ship/dist-integrity.mts';

const root = fileURLToPath(new URL('../..', import.meta.url));

function git(args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Index content, never disk: between releases the physical build is ahead of the committed one, so
 * reading disk would both hide real drift and invent absent drift.
 */
const indexBlob = (file: string): string => git(['cat-file', 'blob', `:${file}`]);

describe('tracked dist import closure', () => {
  it('resolves every relative import to another tracked file', async () => {
    const tracked = git(['ls-files', '--cached', '-z', '--', 'dist']).split('\0').filter(Boolean);
    // A consumer checkout, or a clone whose history carries no release commit, tracks no dist at
    // all. There is nothing to be inconsistent, and asserting otherwise would fail on the truth.
    if (tracked.length === 0) return;

    const trackedSet = new Set(tracked);
    const modules = tracked.filter((file) => file.endsWith('.mjs'));
    const unlexable: string[] = [];
    const gaps: ImportEdge[] = [];
    for (const file of modules) {
      const edges = await moduleImportEdges(root, file, indexBlob(file));
      // Unparseable is a hole, not a pass — the same verdict dist-integrity.mts gives it.
      if (edges === undefined) {
        unlexable.push(file);
        continue;
      }
      for (const edge of edges) if (!trackedSet.has(edge.target)) gaps.push(edge);
    }

    expect({ unlexable, gaps }).toEqual({ unlexable: [], gaps: [] });
    // A closure of zero would satisfy the assertion above vacuously — a renamed dist/ or a pathspec
    // that stopped matching would then read as green forever. Pin that the walk actually ran.
    expect(modules.length).toBeGreaterThan(100);
  });

  it('resolves every shell source target to another tracked file', async () => {
    const tracked = git(['ls-files', '--cached', '-z', '--', 'dist']).split('\0').filter(Boolean);
    if (tracked.length === 0) return;

    const trackedSet = new Set(tracked);
    // agents-hooks included: narrowing to dist/cli would make one file broad for .mjs and narrow
    // for .sh, and diverge from the preflight, where a briefed dist/ path seeds the queue as-is.
    const scripts = tracked.filter((file) => file.endsWith('.sh'));
    const unreadable: string[] = [];
    const gaps: ImportEdge[] = [];
    let edgeCount = 0;
    for (const file of scripts) {
      const edges = await shellSourceEdges(file, indexBlob(file));
      // An unresolvable source target is a hole, not a pass — the ESM verdict, applied to shell.
      if (edges === undefined) {
        unreadable.push(file);
        continue;
      }
      edgeCount += edges.length;
      for (const edge of edges) if (!trackedSet.has(edge.target)) gaps.push(edge);
    }

    expect({ unreadable, gaps }).toEqual({ unreadable: [], gaps: [] });
    // Two pins: a broken extractor returns [] for every file, which the assertion above reads as
    // green forever. The file count alone misses that — the EDGE count is the one that bites.
    expect(scripts.length).toBeGreaterThan(30);
    expect(edgeCount).toBeGreaterThan(40);
  });
});
