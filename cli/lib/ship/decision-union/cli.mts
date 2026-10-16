#!/usr/bin/env node

// ship's check on a union-merged decision record: `path\0mergedOid\0` pairs in, exit REFUSED with the
// recovery on stderr. Not 1, which node itself uses when it cannot even load this file.
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { readGitPaths } from '../../../../gate-engine/ratchets/git-paths.mts';
import { parseDecision } from '../../../../gate-engine/decisions/decision-format.mts';
import {
  type AxisNote,
  axisNotes,
  parseNoteId,
} from '../../../../gate-engine/decisions/recall/note-relations.mts';
import { allTargetBlocks } from '../../../../gate-engine/decisions/recall/supersession.mts';
import { errorMessage } from '../review/shared/common.mts';

const noteKey = (n: AxisNote) => `${n.date} ${n.text}`;
const NOTE_ID_DATE = 'note:'.length;
export const REFUSED = 3;

/** The date an unqualified `**Amends:**` pointer names, or '' for none or another axis's note. */
function sameAxisNoteDate(amends: string | null): string {
  const ref = amends ? parseNoteId(amends) : null;
  return ref?.slug === null ? ref.id.slice(NOTE_ID_DATE, NOTE_ID_DATE + 10) : '';
}

/** Why this union merge mis-files the caller's entries, or null when every line lands where written. */
export function unionRefusal(fork: string, base: string, merged: string): string | null {
  const [f, b, m] = [fork, base, merged].map((text) => parseDecision(text).body);
  if (allTargetBlocks(b).length > allTargetBlocks(f).length) {
    return 'the base added a new Target, so your entries would land under it instead of the ruling you wrote them for';
  }
  const forkNotes = new Set(axisNotes(f).map(noteKey));
  const baseNotes = axisNotes(b);
  const baseKeys = new Set(baseNotes.map(noteKey));
  const baseAddedDates = new Set(
    baseNotes.filter((n) => !forkNotes.has(noteKey(n))).map((n) => n.date),
  );
  const repointed = axisNotes(m).some(
    (n) => !baseKeys.has(noteKey(n)) && baseAddedDates.has(sameAxisNoteDate(n.amends)),
  );
  return repointed
    ? 'the base added a note on a date your **Amends:** pointer names, which renumbers that pointer'
    : null;
}

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 << 20 });
}

/** A file's text at a revision, or '' when the revision does not carry it. */
function blobAt(root: string, rev: string, path: string): string {
  try {
    return git(root, ['show', `${rev}:${path}`]);
  } catch {
    return '';
  }
}

export function refusalText(path: string, reason: string, baseRef: string): string {
  return [
    `ship: union-merging ${path} with origin/${baseRef} would mis-file your decision entries:`,
    `  ${reason}.`,
    '  Recover without hand-editing the record:',
    '    1. copy your note text out of the file',
    `    2. git checkout origin/${baseRef} -- ${path}`,
    '    3. read the Target now at the end of the file and decide where your note belongs',
    `    4. guard-decisions add ${basename(path, '.md')} --note "<text>"`,
    '  Do not rebase or merge instead: git applies the same union and the note stays mis-filed.',
  ].join('\n');
}

export interface CheckArgs {
  root: string;
  base: string;
  patchBase: string;
  baseRef: string;
}

function required(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`missing --${flag}`);
  return value;
}

export function readArgs(argv: string[]): CheckArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: 'string' },
      base: { type: 'string' },
      'patch-base': { type: 'string' },
      'base-ref': { type: 'string' },
    },
  });
  return {
    root: required(values.root, 'root'),
    base: required(values.base, 'base'),
    patchBase: required(values['patch-base'], 'patch-base'),
    baseRef: required(values['base-ref'], 'base-ref'),
  };
}

/** `path\0oid\0` pairs as a flat list; throws on a non-UTF-8 name or an unpaired field. */
export function readPairs(stdin: Uint8Array): string[] {
  const fields = readGitPaths(stdin);
  if (!fields || fields.length % 2) throw new Error('expected NUL-delimited path/oid pairs');
  return fields;
}

/** The refusal text for every path whose union merge would mis-file the caller's entries. */
export function refusals({ root, base, patchBase, baseRef }: CheckArgs, pairs: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < pairs.length; i += 2) {
    const path = pairs[i];
    const merged = git(root, ['cat-file', 'blob', pairs[i + 1]]);
    const reason = unionRefusal(blobAt(root, patchBase, path), blobAt(root, base, path), merged);
    if (reason) out.push(refusalText(path, reason, baseRef));
  }
  return out;
}

/** ship's exit contract: 0 clean, REFUSED with the recovery printed, 2 when nothing could be judged. */
function main(): number {
  try {
    const found = refusals(readArgs(process.argv.slice(2)), readPairs(readFileSync(0)));
    if (found.length > 0) process.stderr.write(`${found.join('\n')}\n`);
    return found.length > 0 ? REFUSED : 0;
  } catch (error: unknown) {
    process.stderr.write(`ship: could not verify a union-merged path: ${errorMessage(error)}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = main();
}
