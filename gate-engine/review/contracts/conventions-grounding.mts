/** Quote grounding: a finding blocks only if its OFFENDING quote is in the cited file and part of this
 * change, and its VIOLATION quotes a rule from a CLAUDE.md that governs that file. */

import { execFileSync } from 'node:child_process';
import { parsePatchHunks } from '../../comment-firewall/patch.mts';
import { countLines } from '../../ratchets/size-line-authority.mts';
import { ancestorDirs } from '../claude-md.mts';
import {
  type ConventionFinding,
  conventionRuleFile,
  dedupeConventionFindings,
  normalizeCitedPath,
  parseConventionFindingCandidates,
} from '../evidence/conventions.mts';
import { headHash, stagedTreeHash } from '../evidence/staged-git.mts';

/** What grounding reads. Injected so the rule is testable without git and shared with the bench. */
export interface GroundingSource {
  reviewedFiles: readonly string[];
  /** Stage-0 content, or null when the index holds none (deleted/unmerged). */
  readStaged: (file: string) => string | null;
  /** The HEAD content this change is judged against, or null for a new file. */
  readHead: (file: string) => string | null;
  /** This file's staged unified diff (empty when there is none). */
  readDiff: (file: string) => string;
  /** False once the index no longer holds the tree these reads come from; rechecked per grounding. */
  isCurrent?: () => boolean;
}

/** How far a quote may sit from its cited line — judges cite a statement's start or a near line. */
export const QUOTE_WINDOW = 3;
const MIN_QUOTE_CHARS = 3;
const LINE_SPLIT_RE = /\r\n|\r|\n/;
const WRAPPERS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ['“', '”'],
];

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * The comparable core of a quoted line, or null when too little is left to identify one. Every step
 * only ever SHORTENS the quote, so a normalized quote of a real line is still a substring of it.
 */
export function normalizeQuote(quote: string): string | null {
  let text = quote.trim();
  const fence = text.match(/^(`+)([\s\S]*)\1$/);
  if (fence) text = fence[2].trim();
  for (const [open, close] of WRAPPERS)
    if (text.length >= 2 && text.startsWith(open) && text.endsWith(close)) {
      text = text.slice(open.length, -close.length).trim();
      break;
    }
  text = text.replace(/^(?:…|\.\.\.)\s*/, '');
  text = text.replace(/\s*(?:…|\.\.\.)$/, '');
  text = collapse(text);
  const significant = text.replace(/\s/g, '');
  if (significant.length < MIN_QUOTE_CHARS || !/[\p{L}\p{N}]/u.test(significant)) return null;
  return text;
}

/** Literal text, plus a `+`/`-` marker's body bound to that side of the diff; a `+`-marked quote
 * never matches a removed line. Cases: conventions-grounding.test.mts, "diff markers". */
interface QuoteForms {
  plain: string;
  marker: '+' | '-' | null;
  body: string | null;
}

function quoteForms(quote: string): QuoteForms | null {
  const plain = normalizeQuote(quote);
  if (plain === null) return null;
  const marked = plain.match(/^([+-])(.*)$/);
  const marker = marked?.[1] === '+' ? '+' : marked?.[1] === '-' ? '-' : null;
  return { plain, marker, body: marked ? normalizeQuote(marked[2]) : null };
}

function safe<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

interface FileChange {
  lines: string[] | null;
  added: Set<number>;
  /** Runs of consecutive removed lines, so a quote the judge wrapped across lines still matches. */
  removedRuns: string[][];
  grew: boolean;
}

/** A judge may wrap one statement across lines; its parser joins them with a space. */
const MAX_SPAN = 4;

function fileChange(source: GroundingSource, file: string): FileChange {
  const staged = safe(() => source.readStaged(file), null);
  const head = safe(() => source.readHead(file), null);
  const diff = safe(() => source.readDiff(file), '');
  const added = new Set<number>();
  const removedRuns: string[][] = [];
  for (const hunk of parsePatchHunks(diff)) {
    for (const line of hunk.addedLines) added.add(line);
    let run: string[] = [];
    for (const line of hunk.text.split('\n').slice(1)) {
      if (line.startsWith('-')) run.push(collapse(line.slice(1)));
      else if (!line.startsWith('+') && run.length > 0) {
        removedRuns.push(run);
        run = [];
      }
    }
    if (run.length > 0) removedRuns.push(run);
  }
  return {
    lines: staged === null ? null : staged.split(LINE_SPLIT_RE).map(collapse),
    added,
    removedRuns,
    // A new file is wholly this change's; otherwise only growth makes existing lines this change's.
    grew: staged !== null && (head === null || countLines(staged) > countLines(head)),
  };
}

/** Whether `quote` lies in the SMALLEST run of 1..MAX_SPAN joined lines starting at `start` (0-based),
 * and `accept` approves that run's 1-based range — a run never borrows an extra changed line. */
function spanMatches(
  lines: readonly string[],
  start: number,
  quote: string,
  accept: (first: number, last: number) => boolean,
): boolean {
  let joined = '';
  for (let end = start; end < Math.min(lines.length, start + MAX_SPAN); end += 1) {
    joined = end === start ? lines[end] : `${joined} ${lines[end]}`;
    if (!joined.includes(quote)) continue;
    // The quote must reach into the first line, else a later start is the smaller run.
    const rest = lines.slice(start + 1, end + 1).join(' ');
    return !(end > start && rest.includes(quote)) && accept(start + 1, end + 1);
  }
  return false;
}

function inRemoved(quote: string, change: FileChange): boolean {
  return change.removedRuns.some((run) =>
    run.some((_, start) => spanMatches(run, start, quote, () => true)),
  );
}

function inStagedWindow(cited: number, quote: string, change: FileChange): boolean {
  const lines = change.lines;
  if (lines === null) return false;
  const changed = (first: number, last: number) => {
    if (change.grew) return true;
    for (let line = first; line <= last; line += 1) if (change.added.has(line)) return true;
    return false;
  };
  // Line 0 means the top of the file; a line past the end is not clamped back into it.
  const low = Math.max(1, Math.max(cited, 1) - QUOTE_WINDOW);
  const high = Math.min(lines.length, Math.max(cited, 1) + QUOTE_WINDOW);
  for (let line = low; line <= high; line += 1)
    if (spanMatches(lines, line - 1, quote, changed)) return true;
  return false;
}

function isGrounded(finding: ConventionFinding, forms: QuoteForms, change: FileChange): boolean {
  const staged = (quote: string | null) =>
    quote !== null && inStagedWindow(finding.offendingLine, quote, change);
  const removed = (quote: string | null) => quote !== null && inRemoved(quote, change);
  return (
    staged(forms.plain) ||
    (forms.marker === '+' && staged(forms.body)) ||
    (forms.marker === '-' && removed(forms.body)) ||
    (forms.marker !== '+' && removed(forms.plain))
  );
}

// Markdown emphasis a judge may drop or keep when quoting a rule; stripped from both sides alike.
// An underscore counts only at a word edge, so `foo_bar` never collapses into `foobar`.
const EMPHASIS_RE = /[*`]|(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu;
const ABSOLUTE_PATH_RE = /^(?:\/|[A-Za-z]:\/)/;
const plainMarkdown = (text: string): string => collapse(text.replace(EMPHASIS_RE, ''));

/** Whether the VIOLATION quotes, near its cited line, a rule from a CLAUDE.md governing `file`. A
 * rule the judge read elsewhere (AGENTS.md, a sibling package's CLAUDE.md) never blocks. */
function ruleGrounded(
  finding: ConventionFinding,
  file: string,
  ruleLines: (ruleFile: string) => string[] | null,
): boolean {
  const cited = conventionRuleFile(finding.rulePath);
  const absolute = ABSOLUTE_PATH_RE.test(cited);
  // Deepest first, so an absolute citation resolves to the most specific governing file it names.
  const governing = ancestorDirs(file)
    .map((dir) => (dir ? `${dir}/CLAUDE.md` : 'CLAUDE.md'))
    .reverse()
    .find((rel) => cited === rel || (absolute && cited.endsWith(`/${rel}`)));
  const quote = normalizeQuote(finding.ruleQuote);
  const lines = governing ? ruleLines(governing) : null;
  if (lines === null || quote === null) return false;
  const text = plainMarkdown(quote);
  const anchor = Math.max(finding.ruleLine ?? 1, 1);
  const low = finding.ruleLine === null ? 1 : Math.max(1, anchor - QUOTE_WINDOW);
  const high =
    finding.ruleLine === null ? lines.length : Math.min(lines.length, anchor + QUOTE_WINDOW);
  for (let line = low; line <= high; line += 1)
    if (spanMatches(lines, line - 1, text, () => true)) return true;
  return false;
}

/** The findings grounded on both halves — rule and OFFENDING quote; order preserved. */
export function groundConventionFindings(
  findings: readonly ConventionFinding[],
  source: GroundingSource,
): ConventionFinding[] {
  if (source.isCurrent && !source.isCurrent()) return [];
  const reviewed = new Set(source.reviewedFiles);
  const changes = new Map<string, FileChange>();
  const rules = memo((file) => {
    const content = safe(() => source.readStaged(file), null);
    return content === null ? null : content.split(LINE_SPLIT_RE).map(plainMarkdown);
  });
  const grounded: ConventionFinding[] = [];
  for (const finding of findings) {
    const path = normalizeCitedPath(finding.offendingPath);
    const forms = quoteForms(finding.offendingQuote);
    if (forms === null || !reviewed.has(path) || !ruleGrounded(finding, path, rules)) continue;
    let change = changes.get(path);
    if (!change) {
      change = fileChange(source, path);
      changes.set(path, change);
    }
    // Canonical path out, so every spelling of one citation shares one lens (and one waiver).
    if (isGrounded(finding, forms, change)) grounded.push({ ...finding, offendingPath: path });
  }
  return grounded;
}

/** Blocking-authority findings for a transcript: ground every candidate, THEN dedupe by lens. */
export function groundedConventionFindings(
  raw: string,
  source: GroundingSource,
): ConventionFinding[] {
  return dedupeConventionFindings(
    groundConventionFindings(parseConventionFindingCandidates(raw), source),
  );
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/** Rename sources (new path → base path) between two trees, so a moved file keeps its old self. */
function renamesBetween(cwd: string, base: string, tree: string): Map<string, string> {
  const renames = new Map<string, string>();
  const fields = safe(
    () => git(cwd, ['diff', '-M', '--name-status', '-z', '--no-color', base, tree]),
    '',
  ).split('\0');
  for (let index = 0; index < fields.length; index += 1) {
    const status = fields[index];
    if (/^[RC]\d*$/.test(status)) {
      if (status.startsWith('R') && fields[index + 1] && fields[index + 2])
        renames.set(fields[index + 2], fields[index + 1]);
      index += 2;
    } else if (status) index += 1;
  }
  return renames;
}

function memo<T>(read: (file: string) => T): (file: string) => T {
  const cache = new Map<string, { value: T }>();
  return (file) => {
    let hit = cache.get(file);
    if (!hit) {
      hit = { value: read(file) };
      cache.set(file, hit);
    }
    return hit.value;
  };
}

const UNREADABLE: GroundingSource = {
  reviewedFiles: [],
  readStaged: () => null,
  readHead: () => null,
  readDiff: () => '',
};

/**
 * The production source, pinned when the cascade starts: the staged tree and HEAD the judge was shown.
 * A later restage cannot ground a quote. Unmerged or unreadable state grounds nothing (→ inconclusive).
 */
export function stagedGroundingSource(
  cwd: string,
  files: readonly string[],
  pinnedTree?: string | null,
): GroundingSource {
  const tree = stagedTreeHash(cwd);
  const head = headHash(cwd);
  // `pinnedTree` is the index the judge's evidence was cut from; a restage since then grounds nothing.
  if (tree === null || head === null || (pinnedTree !== undefined && pinnedTree !== tree))
    return UNREADABLE;
  const base = head.startsWith('unborn:') ? EMPTY_TREE : head;
  let renames: Map<string, string> | null = null;
  const renameSource = (file: string) => (renames ??= renamesBetween(cwd, base, tree)).get(file);
  const blob = (rev: string, file: string) =>
    safe(() => git(cwd, ['cat-file', 'blob', `${rev}:${file}`]), null);
  const literal = (file: string) => `:(top,literal)${file}`;
  return {
    reviewedFiles: files,
    isCurrent: () => stagedTreeHash(cwd) === tree,
    readStaged: memo((file) => blob(tree, file)),
    readHead: memo((file) => blob(base, renameSource(file) ?? file)),
    // --no-color/--no-ext-diff: the consumer's git config must not change the bytes parsed here.
    readDiff: memo((file) => {
      const paths = [renameSource(file), file].filter((p): p is string => Boolean(p)).map(literal);
      return safe(
        () => git(cwd, ['diff', '--no-color', '--no-ext-diff', '-M', base, tree, '--', ...paths]),
        '',
      );
    }),
  };
}
