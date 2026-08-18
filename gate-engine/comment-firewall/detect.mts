/**
 * Staged changed-comment detector.
 *
 * The index is the source of truth: worktree-only edits cannot create or clear a finding. Git's
 * added-line attribution selects candidates, then a real TypeScript lexer reconstructs the entire
 * comment token. Delimiters inside strings, regexes, templates, and JSX text are therefore inert.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { ts } from 'ts-morph';
import { resolveGuardConfig, sourceMatchers } from '../config.mts';
import { gitPrefix } from '../ratchets/git-index.mts';
import type { CommentFinding, DetectionResult } from './types.mts';

export const COMMENT_ADAPTER_VERSION = 'typescript-scanner-v1';
export const COMMENT_FINDING_POLICY = 'changed-comment-v1';
const SUPPORTED_EXTENSIONS = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts']);
const MAX_GIT_OUTPUT = 16 * 1024 * 1024;
const CONTEXT_LINES = 4;
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
const LEADING_DOT_SLASH = /^\.\//;
const TRAILING_SLASH = /\/$/;

interface PatchHunk {
  newStart: number;
  newCount: number;
  addedLines: Set<number>;
  text: string;
}

export interface CommentToken {
  kind: 'line' | 'block';
  startLine: number;
  endLine: number;
  text: string;
}

const sha12 = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 12);

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: MAX_GIT_OUTPUT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function splitNul(value: string): string[] {
  return value.split('\0').filter(Boolean);
}

function stagedPaths(cwd: string, ref?: string): Set<string> {
  const args = [
    'diff',
    '--cached',
    '--name-only',
    '-z',
    '--relative',
    '--diff-filter=ACMR',
    '--no-ext-diff',
  ];
  if (ref) args.push(ref);
  return new Set(splitNul(git(cwd, args)));
}

function pureRenames(cwd: string, ref?: string): Set<string> {
  const args = [
    'diff',
    '--cached',
    '--name-status',
    '-z',
    '--relative',
    '--find-renames',
    '--diff-filter=R',
    '--no-ext-diff',
  ];
  if (ref) args.push(ref);
  const fields = splitNul(git(cwd, args));
  const renamed = new Set<string>();
  for (let i = 0; i < fields.length;) {
    const status = fields[i++] ?? '';
    const _oldPath = fields[i++];
    const newPath = fields[i++];
    if (status === 'R100' && newPath) renamed.add(newPath);
  }
  return renamed;
}

/** Merge resolutions are attributed only when they differ from both parents. */
function changedPaths(cwd: string): string[] {
  const firstParent = stagedPaths(cwd);
  const firstPureRenames = pureRenames(cwd);
  try {
    const mergeParent = stagedPaths(cwd, 'MERGE_HEAD');
    const mergePureRenames = pureRenames(cwd, 'MERGE_HEAD');
    return [...firstParent].filter(
      (file) =>
        mergeParent.has(file) && !(firstPureRenames.has(file) && mergePureRenames.has(file)),
    );
  } catch {
    return [...firstParent].filter((file) => !firstPureRenames.has(file));
  }
}

function patch(cwd: string, file: string, ref?: string): string {
  const args = [
    'diff',
    '--cached',
    '--no-color',
    '--no-ext-diff',
    '--find-renames',
    '--unified=4',
    '--relative',
    '--diff-filter=ACMR',
  ];
  if (ref) args.push(ref);
  args.push('--', file);
  return git(cwd, args);
}

export function parsePatchHunks(diff: string): PatchHunk[] {
  const hunks: PatchHunk[] = [];
  let current: PatchHunk | null = null;
  let newLine = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      current = null;
      continue;
    }
    const header = raw.match(HUNK_HEADER);
    if (header) {
      current = {
        newStart: Number(header[1]),
        newCount: header[2] === undefined ? 1 : Number(header[2]),
        addedLines: new Set(),
        text: raw,
      };
      newLine = current.newStart;
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    current.text += `\n${raw}`;
    /* File headers precede hunks; within a hunk `+++value` is source beginning with `++`. */
    if (raw.startsWith('+')) {
      current.addedLines.add(newLine);
      newLine += 1;
    } else if (!raw.startsWith('\\') && !raw.startsWith('-')) {
      newLine += 1;
    }
  }
  return hunks;
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function lineAt(starts: number[], position: number): number {
  let low = 0;
  let high = starts.length;
  while (low + 1 < high) {
    const mid = (low + high) >>> 1;
    if ((starts[mid] ?? 0) <= position) low = mid;
    else high = mid;
  }
  return low + 1;
}

export function scanCommentTokens(source: string, extension: string): CommentToken[] {
  const scriptKind =
    extension === 'jsx'
      ? ts.ScriptKind.JSX
      : extension === 'tsx'
        ? ts.ScriptKind.TSX
        : extension === 'js' || extension === 'mjs' || extension === 'cjs'
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    `staged.${extension}`,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const starts = lineStarts(source);
  const ranges = new Map<string, ts.CommentRange>();
  const collect = (items: ts.CommentRange[] | undefined): void => {
    for (const item of items ?? []) ranges.set(`${item.pos}:${item.end}`, item);
  };
  const visit = (node: ts.Node): void => {
    collect(ts.getLeadingCommentRanges(source, node.getFullStart()));
    collect(ts.getTrailingCommentRanges(source, node.end));
    for (const child of node.getChildren(sourceFile)) visit(child);
  };
  visit(sourceFile);
  return [...ranges.values()]
    .sort((left, right) => left.pos - right.pos)
    .map((range) => {
      const start = range.pos;
      const end = range.end;
      return {
        kind: range.kind === ts.SyntaxKind.SingleLineCommentTrivia ? 'line' : 'block',
        startLine: lineAt(starts, start),
        endLine: lineAt(starts, Math.max(start, end - 1)),
        text: source.slice(start, end),
      };
    });
}

function stagedBlob(cwd: string, file: string): string {
  const repoPath = `${gitPrefix(cwd)}${file}`;
  return git(cwd, ['show', `:${repoPath}`]);
}

function normalizedRoot(cwd: string, root: string): string {
  const rel = path.isAbsolute(root) ? path.relative(cwd, root) : root;
  const posix = rel
    .split(path.sep)
    .join('/')
    .replace(LEADING_DOT_SLASH, '')
    .replace(TRAILING_SLASH, '');
  return posix === '.' ? '' : posix;
}

function insideRoots(file: string, roots: string[]): boolean {
  return roots.some((root) => !root || file === root || file.startsWith(`${root}/`));
}

function contextFor(source: string, token: CommentToken): string {
  const lines = source.split('\n');
  const from = Math.max(0, token.startLine - 1 - CONTEXT_LINES);
  const to = Math.min(lines.length, token.endLine + CONTEXT_LINES);
  return lines.slice(from, to).join('\n').slice(0, 8_000);
}

function hunkIntersects(hunk: PatchHunk, token: CommentToken): boolean {
  for (const line of hunk.addedLines) {
    if (line >= token.startLine && line <= token.endLine) return true;
  }
  return false;
}

function changedTokens(source: string, extension: string, hunks: PatchHunk[]): CommentToken[] {
  return scanCommentTokens(source, extension).filter((token) =>
    hunks.some((hunk) => hunkIntersects(hunk, token)),
  );
}

function findingFor(
  file: string,
  extension: string,
  source: string,
  token: CommentToken,
  hunks: PatchHunk[],
): CommentFinding {
  const relevantDiff = hunks
    .filter((hunk) => hunkIntersects(hunk, token))
    .map((hunk) => hunk.text)
    .join('\n')
    .slice(0, 12_000);
  const context = contextFor(source, token);
  const id = sha12(
    JSON.stringify({
      policy: COMMENT_FINDING_POLICY,
      adapter: COMMENT_ADAPTER_VERSION,
      path: file,
      comment: token.text,
      context,
      relevantDiff,
    }),
  );
  return {
    id,
    path: file,
    extension,
    adapterVersion: COMMENT_ADAPTER_VERSION,
    kind: token.kind,
    startLine: token.startLine,
    endLine: token.endLine,
    comment: token.text,
    context,
    relevantDiff,
  };
}

export function detectChangedComments(cwd = process.cwd()): DetectionResult {
  const cfg = resolveGuardConfig(cwd);
  const roots = cfg.scanRoots.map((root) => normalizedRoot(cwd, root));
  const isConfiguredSource = sourceMatchers(cfg.sourceExtensions).isSource;
  const findings: CommentFinding[] = [];
  const unsupported: DetectionResult['unsupported'] = [];
  for (const file of changedPaths(cwd).sort()) {
    if (!insideRoots(file, roots) || !isConfiguredSource(file)) continue;
    const extension = path.extname(file).slice(1).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(extension)) {
      unsupported.push({ extension, path: file });
      continue;
    }
    const first = parsePatchHunks(patch(cwd, file));
    let effective = first;
    try {
      const second = parsePatchHunks(patch(cwd, file, 'MERGE_HEAD'));
      const secondLines = new Set(second.flatMap((hunk) => [...hunk.addedLines]));
      effective = first.map((hunk) => ({
        ...hunk,
        addedLines: new Set([...hunk.addedLines].filter((line) => secondLines.has(line))),
      }));
    } catch {
      // Ordinary commit: the first-parent staged patch is the complete attribution set.
    }
    const source = stagedBlob(cwd, file);
    for (const token of changedTokens(source, extension, effective)) {
      findings.push(findingFor(file, extension, source, token, effective));
    }
  }
  return { findings, unsupported };
}
