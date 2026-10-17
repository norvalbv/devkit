/**
 * Builds only the named NEW dist artifacts, which is the dist-integrity preflight's remedy for a
 * missing or stale one. `bun run build` would also rewrite tracked dist, which is release-only.
 *
 * Usage: bun run build:new [--base <ref>] <dist paths…>. The base defaults to the fork point from
 * origin/main; pass a stacked PR's parent branch instead.
 */
import { execFileSync } from 'node:child_process';
import { distArtifact } from '../cli/lib/ship/dist-integrity.mts';
import { writeNewDist } from '../cli/lib/ship/preflight/stale-new-dist.mts';
import { treeBlobsAtRef } from '../gate-engine/ratchets/tree-blobs.mts';

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const at = args.indexOf('--base');
const baseRef = at === -1 ? 'origin/main' : args.splice(at, 2)[1];
try {
  if (!baseRef || args.length === 0)
    throw new Error('usage: build:new [--base <ref>] <dist paths…>');
  const root = process.cwd();
  const base = execFileSync('git', ['-C', root, 'merge-base', 'HEAD', baseRef], {
    encoding: 'utf8',
  });
  const atBase = treeBlobsAtRef(root, base.trim(), ['dist']);
  if (atBase === null) throw new Error(`cannot read dist/ at ${base.trim()}`);
  writeNewDist(root, args, atBase, distArtifact);
  console.log(`build:new wrote ${args.join(' ')} — brief these with their source.`);
} catch (error) {
  console.error(`✗ build:new: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
