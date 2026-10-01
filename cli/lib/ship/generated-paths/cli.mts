#!/usr/bin/env node

// ship-branch.sh's staging-abort renderer: NUL-delimited unmerged paths (`git diff -z`) in, abort
// text out. Any failure exits 2 with an EMPTY stdout, so ship falls back to its hand-merge text.
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  classifyGenerated,
  generatedPathsFor,
  renderCommand,
  renderConflictAbort,
} from './registry.mts';
import { errorMessage } from '../review/shared/common.mts';

export interface AbortArgs {
  root: string;
  baseRef: string;
}

export function parseArgs(argv: string[]): AbortArgs {
  let root: string | undefined;
  let baseRef: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i + 1];
    if (argv[i] === '--root' && value && !value.startsWith('--')) root = argv[++i];
    else if (argv[i] === '--base-ref' && value && !value.startsWith('--')) baseRef = argv[++i];
    else throw new Error(`unknown or incomplete argument: ${argv[i]}`);
  }
  if (!root || !baseRef) throw new Error('usage: cli.mts --root <root> --base-ref <ref> < paths');
  return { root, baseRef };
}

/** The rendered abort for these unmerged paths, with every command in the form typed at `root`. */
export function renderAbort(paths: readonly string[], { root, baseRef }: AbortArgs): string {
  const classified = classifyGenerated(paths, generatedPathsFor(root));
  classified.generated = classified.generated.map((m) => ({
    ...m,
    command: renderCommand(m.command, root),
  }));
  return renderConflictAbort(classified, baseRef).join('\n');
}

// Strict: two distinct non-UTF-8 names would decode alike, so throw and let ship print git's listing.
// ignoreBOM keeps a leading U+FEFF: it is part of a Git name, not a byte-order mark.
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const readPaths = (stdin: Buffer): string[] => UTF8.decode(stdin).split('\0');

function main(): void {
  try {
    const args = parseArgs(process.argv.slice(2));
    const text = renderAbort(readPaths(readFileSync(0)), args);
    if (text) process.stdout.write(`${text}\n`);
  } catch (error: unknown) {
    process.stderr.write(`generated-paths: ${errorMessage(error)}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main();
}
