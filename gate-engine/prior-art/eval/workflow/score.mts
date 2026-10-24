// prior-art workflow tier: deterministic scoring of one banked session, reading cited files from the
// pinned snapshot. A claim about an unlabelled file is unjudged, never false.

import path from 'node:path';
import { type PriorArtResponseV1, parsePriorArtResponse } from '../../response-contract.mts';
import type { Member, Span } from './families.mts';
import { snapshotFile } from './materialize.mts';
import { type Condition, initFault } from './run.mts';
import { parseTrace, type ToolCall } from './trace.mts';

export type ReadFile = (member: Member, root: string, file: string) => string | null;
export type SpanStatus = 'read' | 'located' | 'missed';
export const CLAIM_STATUSES = [
  'supported',
  'decoy',
  'unjudged',
  'unverifiable',
  'external',
] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];
export type ClaimCounts = Record<ClaimStatus, number>;

export function emptyClaims() {
  return {
    supported: 0,
    decoy: 0,
    unjudged: 0,
    unverifiable: 0,
    external: 0,
  } satisfies ClaimCounts;
}

export function addClaims(into: ClaimCounts, from: ClaimCounts): void {
  for (const status of CLAIM_STATUSES) into[status] += from[status];
}

export interface FileRef {
  root: string;
  path: string;
}

export interface RunScore {
  /** A harness fault (wrong tool profile, MCP leak): the run is not an agent result. */
  fault: string | null;
  /** A contract-valid `reviewed` response; aborted and wrong_phase carry no verdict, so are not. */
  valid: boolean;
  verdict: string;
  framing: string;
  confidence: string | null;
  /** Local-leg counts and status match the workspace layout; null when there is no valid response. */
  legHonest: boolean | null;
  recalled: Record<string, boolean>;
  spans: Record<string, SpanStatus>;
  claims: ClaimCounts;
  denials: number;
  /** The raw response text, for the decoy matcher. */
  response: string | null;
}

const READ_WINDOW = 2000;
const LINE_SUFFIX = /(?::|#L)\d+(?:-L?\d+)?$/;

/** `consumer/<path>` or `refs/<name>/<path>`, relative to the workspace root, or null. */
function workspaceRelative(source: string, wsRoot: string): string | null {
  if (path.isAbsolute(source)) {
    const root = [wsRoot, wsRoot.replace(/^\/private(?=\/)/, '')].find((r) =>
      source.startsWith(`${r}/`),
    );
    return root ? source.slice(root.length + 1) : null;
  }
  const clean = path.posix.normalize(source.replace(/^\.\//, ''));
  if (clean.startsWith('../refs/')) return clean.slice(3);
  if (clean.startsWith('refs/')) return clean;
  return clean.startsWith('..') ? null : `consumer/${clean}`;
}

/** A workspace path (absolute, cwd-relative or refs-relative) as a snapshot file reference. */
export function toFileRef(raw: string, wsRoot: string): FileRef | null {
  const [head, ...rest] =
    workspaceRelative(raw.trim().replace(LINE_SUFFIX, ''), wsRoot)?.split('/') ?? [];
  if (head === 'consumer' && rest.length) return { root: 'consumer', path: rest.join('/') };
  if (head === 'refs' && rest.length > 1) return { root: rest[0], path: rest.slice(1).join('/') };
  return null;
}

const sameFile = (a: FileRef | null, b: FileRef) => a?.root === b.root && a.path === b.path;
const spanKey = (span: Span) => `${span.root}:${span.path}:${span.lines[0]}-${span.lines[1]}`;

/** The file a citation names, trying the bare source and then the source under its repoRoot. */
function citedFile(
  item: PriorArtResponseV1['evidence'][number],
  wsRoot: string,
  member: Member,
  read: ReadFile,
): FileRef | null {
  // The repoRoot-scoped path first: a bare `README.md` must not resolve to the consumer's own copy.
  const scoped = item.repoRoot && !path.isAbsolute(item.source);
  const candidates = scoped
    ? [path.posix.join(item.repoRoot ?? '', item.source), item.source]
    : [item.source];
  for (const candidate of candidates) {
    const ref = toFileRef(candidate, wsRoot);
    if (ref && read(member, ref.root, ref.path) !== null) return ref;
  }
  return null;
}

/** File refs a tool result mentions, one per `path[:line…]` line. */
/** The line number a result line shows for `file` (0 when it names the file without one), or null.
 *  Every `:N:`/`-N-` split is tried, since a path may itself hold a `-<digits>-` run. */
function lineFor(line: string, file: FileRef, wsRoot: string): number | null {
  for (const match of line.matchAll(/[:-](\d+)[:-]/g))
    if (sameFile(toFileRef(line.slice(0, match.index), wsRoot), file)) return Number(match[1]);
  return sameFile(toFileRef(line, wsRoot), file) ? 0 : null;
}

/** Line numbers of one file that a Grep content result displayed. */
/** Line numbers of one file that a Grep content result displayed. */
function grepLines(call: ToolCall, file: FileRef, wsRoot: string): number[] {
  const scoped = sameFile(toFileRef(call.input.path ?? '', wsRoot), file);
  return (call.result ?? '').split('\n').flatMap((line) => {
    const own = scoped ? /^(\d+)[:-]/.exec(line) : null;
    const shown = own ? Number(own[1]) : lineFor(line, file, wsRoot);
    return shown ? [shown] : [];
  });
}

function readWindowCovers(call: ToolCall, span: Span): boolean {
  const from = call.input.offset || 1;
  const to = from + (call.input.limit || READ_WINDOW) - 1;
  return from <= span.lines[0] && span.lines[1] <= to;
}

/** How one tool call touched a span: read it, only located its file, or missed it. */
function touch(call: ToolCall, span: Span, wsRoot: string): SpanStatus {
  const file = { root: span.root, path: span.path };
  if (call.name === 'Read' && sameFile(toFileRef(call.input.file_path ?? '', wsRoot), file))
    return readWindowCovers(call, span) ? 'read' : 'located';
  const [start, end] = span.lines;
  if (call.name === 'Grep' && grepLines(call, file, wsRoot).some((n) => n >= start && n <= end))
    return 'read';
  const mentioned = (call.result ?? '')
    .split('\n')
    .some((line) => lineFor(line, file, wsRoot) !== null);
  return mentioned ? 'located' : 'missed';
}

export function spanStatus(span: Span, calls: ToolCall[], wsRoot: string): SpanStatus {
  const touches = calls.filter((call) => !call.isError).map((call) => touch(call, span, wsRoot));
  if (touches.includes('read')) return 'read';
  return touches.includes('located') ? 'located' : 'missed';
}

const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();

const COMMENT_MARKER = /^\s*(?:\/\/+|\*|#)\s?/;

/** Every line where the first fragment starts, when all fragments appear in `lines`. */
function fragmentLines(fragments: string[], lines: string[]): number[] {
  const offsets: number[] = [];
  let joined = '';
  for (const line of lines) {
    offsets.push(joined.length);
    joined += `${collapse(line)} `;
  }
  if (!fragments.every((fragment) => joined.includes(fragment))) return [];
  const found: number[] = [];
  for (let at = joined.indexOf(fragments[0]); at >= 0; at = joined.indexOf(fragments[0], at + 1)) {
    let line = 0;
    while (line + 1 < offsets.length && offsets[line + 1] <= at) line += 1;
    if (found.at(-1) !== line + 1) found.push(line + 1);
  }
  return found;
}

/** 1-based lines where the quote starts, also tried with line-leading comment markers removed
 *  (a quote across `//` lines); empty when any fragment is absent. */
export function quoteLines(quote: string, content: string): number[] {
  const fragments = quote
    .split(/\.{3}|…/)
    .map(collapse)
    .filter(Boolean);
  if (!fragments.length) return [];
  const lines = content.split('\n');
  const raw = fragmentLines(fragments, lines);
  return raw.length
    ? raw
    : fragmentLines(
        fragments,
        lines.map((line) => line.replace(COMMENT_MARKER, '')),
      );
}

function inSpans(file: FileRef, line: number, spans: Span[]): boolean {
  return spans.some(
    (span) => sameFile(file, span) && line >= span.lines[0] && line <= span.lines[1],
  );
}

function lineStatus(file: FileRef, line: number, member: Member): ClaimStatus {
  if (
    inSpans(
      file,
      line,
      member.gold.flatMap((slot) => slot.spans),
    )
  )
    return 'supported';
  if (
    inSpans(
      file,
      line,
      member.decoys.flatMap((slot) => slot.spans),
    )
  )
    return 'decoy';
  return 'unjudged';
}

/** The line range a citation names (`path:12`, `path:12-20`, `path#L12`), if any. */
function citedRange(source: string): [number, number] | null {
  const match = /(?::|#L)(\d+)(?:-L?(\d+))?$/.exec(source.trim());
  return match ? [Number(match[1]), Number(match[2] ?? match[1])] : null;
}

/** A quote that occurs more than once is placed by the cited range; still ambiguous → unjudged. */
function claimStatus(
  item: PriorArtResponseV1['evidence'][number],
  file: FileRef | null,
  member: Member,
  read: ReadFile,
): ClaimStatus {
  if (item.kind !== 'local') return 'external';
  const content = file && read(member, file.root, file.path);
  const lines = file && content ? quoteLines(item.quote, content) : [];
  if (!file || !lines.length) return 'unverifiable';
  const range = citedRange(item.source);
  const near = range ? lines.filter((line) => line >= range[0] && line <= range[1]) : [];
  const statuses = new Set(
    (near.length ? near : lines).map((line) => lineStatus(file, line, member)),
  );
  return statuses.size === 1 ? [...statuses][0] : 'unjudged';
}

function legHonest(response: PriorArtResponseV1, member: Member): boolean {
  const local = response.legs.find((leg) => leg.leg === 'local');
  const resolved = member.refs.length;
  const status = resolved ? local?.status === 'reached' : local?.status !== 'reached';
  return local?.declaredCheckouts === 1 && local.resolvedCheckouts === resolved && status;
}

function reviewed(result: string | null): PriorArtResponseV1 | null {
  const parsed = result === null ? null : parsePriorArtResponse(result);
  return parsed?.ok && parsed.value.status === 'reviewed' ? parsed.value : null;
}

/** Each claim's support status, and the snapshot files the local claims cite. */
interface Citations {
  claims: ClaimCounts;
  cited: FileRef[];
}

function citations(
  evidence: PriorArtResponseV1['evidence'],
  wsRoot: string,
  member: Member,
  read: ReadFile,
): Citations {
  const claims = emptyClaims();
  const cited: FileRef[] = [];
  for (const item of evidence) {
    const file = item.kind === 'local' ? citedFile(item, wsRoot, member, read) : null;
    if (file) cited.push(file);
    claims[claimStatus(item, file, member, read)] += 1;
  }
  return { claims, cited };
}

/** Per gold slot, whether a citation named one of its files; per gold span, how it was read. */
function goldCoverage(
  member: Member,
  cited: FileRef[],
  calls: ToolCall[],
  wsRoot: string,
): Pick<RunScore, 'recalled' | 'spans'> {
  const spans = member.gold.flatMap((slot) => slot.spans);
  return {
    recalled: Object.fromEntries(
      member.gold.map((slot) => [
        slot.id,
        slot.spans.some((span) => cited.some((f) => sameFile(f, span))),
      ]),
    ),
    spans: Object.fromEntries(
      spans.map((span) => [spanKey(span), spanStatus(span, calls, wsRoot)]),
    ),
  };
}

export function scoreRun(
  member: Member,
  condition: Condition,
  stream: string,
  wsRoot: string,
  read: ReadFile = snapshotFile,
): RunScore {
  const trace = parseTrace(stream);
  const response = reviewed(trace.result);
  const { claims, cited } = citations(response?.evidence ?? [], wsRoot, member, read);
  return {
    fault: initFault(trace.init, condition),
    valid: response !== null,
    verdict: response?.verdict ?? (trace.result === null ? 'DARK' : 'INVALID'),
    framing: response?.frameChallenge?.framing ?? 'INVALID',
    confidence: response?.confidence ?? null,
    legHonest: response ? legHonest(response, member) : null,
    ...goldCoverage(member, cited, trace.calls, wsRoot),
    claims,
    denials: trace.denials.length,
    response: trace.result,
  };
}
