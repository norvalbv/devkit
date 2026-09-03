/** Merge a martian-bench fragment into Martian's results/benchmark_data.json so their steps 2/2.5/3
 * judge devkit-correctness beside the published tools. */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { type MartianEntry, mergeFragment } from './martian-export.mts';
import { arg } from '../scale/bench-args.mts';

const FRAGMENT = arg('fragment');
const INTO = arg('into');
if (!FRAGMENT || !INTO) {
  console.error('usage: martian-merge --fragment <fragment.json> --into <benchmark_data.json>');
  process.exit(2);
}
// Exclusive lock (mkdir is atomic): two merges into the same file must not interleave their
// read-modify-write; the loser aborts with the holder's path instead of clobbering.
const lock = `${INTO}.lock`;
try {
  mkdirSync(lock);
} catch {
  console.error(`martian-merge: ${lock} exists — another merge is in flight (remove it if stale)`);
  process.exit(3);
}
process.on('exit', () => rmSync(lock, { recursive: true, force: true }));
// SAFETY: the fragment is written by martian-bench.mts in Martian's benchmark_data shape.
const fragment = JSON.parse(readFileSync(FRAGMENT, 'utf8')) as Record<string, MartianEntry>;
// SAFETY: Martian's results/benchmark_data.json carries the same shape (their step1 writer).
const target = existsSync(INTO)
  ? (JSON.parse(readFileSync(INTO, 'utf8')) as Record<string, MartianEntry>)
  : {};
const { merged, fragmentPrs, totalPrs } = mergeFragment(target, fragment);
const tmp = `${INTO}.tmp.${process.pid}`;
writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`);
renameSync(tmp, INTO);
console.error(`merged ${fragmentPrs} PR(s) into ${INTO} (${totalPrs} total)`);
