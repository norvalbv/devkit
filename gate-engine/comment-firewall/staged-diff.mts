/** The staged set, its renames, blob ids and hunks from one `git diff --cached` per parent. */
import { execFileSync } from 'node:child_process';
import { commitIndexEnv } from '../ratchets/commit-index.mts';
import { type PatchHunk, parsePatchHunks } from './patch.mts';

const MAX_DIFF_OUTPUT = 512 * 1024 * 1024;
const CHUNK_START = /^(?=diff --git )/m;

export interface StagedEntry {
  /** Raw status, e.g. `M`, `A`, `R100`. */
  status: string;
  /** The pre-image path: the rename source, else the path itself. */
  from: string;
  srcOid: string;
  dstOid: string;
  hunks: PatchHunk[];
}

/** `count` NUL-terminated fields from `at`, and the offset after them. */
function nulFields(output: string, at: number, count: number) {
  const fields: string[] = [];
  let next = at;
  for (let read = 0; read < count; read += 1) {
    const end = output.indexOf('\0', next);
    fields.push(output.slice(next, end));
    next = end + 1;
  }
  return { fields, next };
}

/** Pairs the Nth NUL-terminated raw record with the Nth `diff --git` chunk: header names vary with
 * `diff.noprefix`, `diff.mnemonicPrefix` and path quoting, the order does not. */
export function parseStagedDiff(output: string): Map<string, StagedEntry> {
  const records: Omit<StagedEntry, 'hunks'>[] = [];
  const paths: string[] = [];
  let at = 0;
  while (output[at] === ':') {
    const meta = nulFields(output, at, 1);
    const [, , srcOid, dstOid, status] = meta.fields[0].split(' ');
    const renamed = status.startsWith('R') || status.startsWith('C');
    const names = nulFields(output, meta.next, renamed ? 2 : 1);
    const [from, path = from] = names.fields;
    paths.push(path);
    records.push({ status, from, srcOid, dstOid });
    at = names.next;
  }
  const chunks = output
    .slice(at + 1)
    .split(CHUNK_START)
    .filter(Boolean);
  if (chunks.length !== records.length) {
    throw new Error(`git diff paired ${records.length} entries with ${chunks.length} patches`);
  }
  return new Map(
    records.map((record, index) => [
      paths[index],
      { ...record, hunks: parsePatchHunks(chunks[index]) },
    ]),
  );
}

/** Every ACMR path staged against `ref` (default HEAD), keyed by its CWD-relative new path. */
export function stagedDiff(cwd: string, ref?: string): Map<string, StagedEntry> {
  const args = [
    'diff',
    '--cached',
    '--raw',
    '-p',
    '-z',
    '--no-abbrev',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--submodule=short',
    '--find-renames',
    '--unified=4',
    '--relative',
    '--diff-filter=ACMR',
  ];
  if (ref) args.push(ref);
  const output = execFileSync('git', args, {
    cwd,
    env: commitIndexEnv(cwd),
    encoding: 'utf8',
    maxBuffer: MAX_DIFF_OUTPUT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return parseStagedDiff(output);
}
