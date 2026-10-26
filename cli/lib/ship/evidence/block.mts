// The devkit-owned evidence block inside a PR body. Every byte outside the markers belongs to the
// caller or another tool; ship only ever replaces the span between them.
import { stripVTControlCharacters } from 'node:util';
import { z } from 'zod';
import {
  codeSpan,
  fencedJson,
  MAX_FAILURES,
  type RegressionEvidence,
  type RegressionFailureSummary,
  type RegressionOperandEvidence,
} from '../../baseline-status/regression-evidence.mts';
import type { MergeVerdict } from '../merge-verdict/verdict.mts';
import {
  EVIDENCE_ABSTENTIONS,
  EVIDENCE_STATUSES,
  type EvidenceOutcome,
  type EvidenceStatus,
} from './outcome.mts';

export const EVIDENCE_BEGIN = '<!-- devkit:evidence:begin -->';
export const EVIDENCE_END = '<!-- devkit:evidence:end -->';
/** The merge verdict's line; the data line carries its full reason list for later re-scoring. */
export const VERDICT_SLOT = '<!-- devkit:evidence:verdict -->';
export const VERDICT_LABEL = '**Merge verdict:**';

/** The slot's text, and the verdict itself when one could be computed. */
export interface PrintedVerdict {
  line: string;
  /** One markdown line per reason that yields the verdict, listed under the slot's line. */
  reasons?: string[];
  verdict?: MergeVerdict;
}

/** No verdict is never a reason to drop the block: the slot says why instead. */
export const verdictUnavailable = (why: string): PrintedVerdict => ({
  line: `${VERDICT_LABEL} unavailable (${why})`,
});
const DATA_OPEN = '<!-- devkit:evidence:data ';
const DATA_CLOSE = ' -->';
// Whole marker lines only: ship writes them that way, and prose quoting a marker inline is not a block.
const BLOCK = /^<!-- devkit:evidence:begin -->\r?\n[\s\S]*?\n<!-- devkit:evidence:end -->(?=\r?$)/m;
const BLOCKS = new RegExp(BLOCK.source, 'gm');
const MARKER = /<!-- devkit:evidence:/g;
const SHOWN_ARGS = 40;
const STATUS_MARK: Record<EvidenceStatus, string> = {
  captured: '✅',
  inconclusive: '⚠️',
  'not-run': '⏭️',
};
const MAX_DETAIL_CHARS = 500;
const MAX_FAILURE_CHARS = 240;
const TITLE_JOIN = ' › ';

const outcomeSchema = z.strictObject({
  status: z.enum(EVIDENCE_STATUSES),
  reason: z.enum(EVIDENCE_ABSTENTIONS).nullable(),
  detail: z.string(),
  headSha: z.string(),
  baseSha: z.string().nullable(),
  mergeVerdict: z
    .strictObject({
      verdict: z.string(),
      reasons: z.array(z.strictObject({ code: z.string(), detail: z.string().optional() })),
    })
    .optional(),
});

/** A zero-width space after the namespace keeps quoted marker text from ever parsing as a marker. */
const defuse = (text: string): string => text.replace(MARKER, '<!-- devkit:evidence​:');

/** Caller-authored text never carries evidence: a pasted block is dropped, a stray marker defused. */
export const callerText = (body: string): string => defuse(body.replace(BLOCKS, ''));

const clip = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit - 1)}…` : text;

const flat = (text: string): string => stripVTControlCharacters(text).replace(/\s+/g, ' ').trim();

export const plain = (text: string): string =>
  clip(flat(text).replaceAll('<', '&lt;'), MAX_DETAIL_CHARS);

/** A failure's name, less the `depth` describe titles the list already printed above it. */
function failureLine(item: RegressionFailureSummary, depth: number): string {
  const name = item.path && depth ? item.path.slice(depth).join(TITLE_JOIN) : item.fullName;
  return `- ${codeSpan(flat(name))}: ${codeSpan(flat(clip(item.message, MAX_FAILURE_CHARS)))}`;
}

/** The describe titles every listed failure shares; a test's own title is never one of them. */
function sharedDescribe(items: RegressionFailureSummary[]): string[] {
  const paths = items.flatMap((item) => (item.path ? [item.path] : []));
  if (paths.length < 2 || paths.length < items.length) return [];
  const [first] = paths;
  const depth = first.findIndex((title, n) =>
    paths.some((path) => n >= path.length - 1 || path[n] !== title),
  );
  return first.slice(0, depth);
}

/** `n` and its noun; `plus` marks a floor, from a list the report summary cut at its cap. */
const counted = (n: number, noun: string, plus = ''): string =>
  `${n}${plus} ${noun}${n === 1 && !plus ? '' : 's'}`;

/** A collapsed section; `summary` is raw HTML, so it carries no markdown. */
export const details = (summary: string, body: string[]): string[] => [
  `<details><summary>${summary}</summary>`,
  '',
  ...body,
  '',
  '</details>',
  '',
];

/** Every failure the report summary kept, then how many it dropped at its cap. */
function failureList(title: string, items: RegressionFailureSummary[], total: number): string[] {
  const rest = total - items.length;
  const more = rest > 0 ? [`- … and ${rest} more`] : [];
  const shared = sharedDescribe(items);
  const under = shared.length
    ? [`Each test listed is under ${codeSpan(flat(shared.join(TITLE_JOIN)))}`, '']
    : [];
  const lines = items.map((item) => failureLine(item, shared.length));
  return items.length ? details(title, [...under, ...lines, ...more]) : [];
}

const short = (sha: string | null): string => (sha ? `\`${sha.slice(0, 12)}\`` : 'unknown');

function operandRow(name: string, tree: string, operand: RegressionOperandEvidence): string {
  const exit = operand.signal ? `signal ${operand.signal}` : String(operand.exitCode);
  const counts = operand.testCounts;
  const cells = counts
    ? `${counts.passed} | ${counts.failed} | ${counts.skipped + counts.todo}`
    : 'n/a | n/a | n/a';
  return `| ${name} | ${tree} | ${exit} | ${cells} |`;
}

function runLines(evidence: RegressionEvidence): string[] {
  const { argv } = evidence.command;
  const shown =
    argv.length > SHOWN_ARGS
      ? [...argv.slice(0, SHOWN_ARGS), `… ${argv.length - SHOWN_ARGS} more arguments`]
      : argv;
  const { failures, fileErrors, testCounts } = evidence.red;
  const failed = testCounts?.failed ?? failures.length;
  const plus = fileErrors.length >= MAX_FAILURES ? '+' : '';
  const unloaded = counted(fileErrors.length, 'file', plus);
  return [
    '| run | what ran | exit | passed | failed | skipped |',
    '|---|---|---|---|---|---|',
    operandRow('red', 'PR test files on the PR base', evidence.red),
    operandRow('green', 'PR head', evidence.green),
    '',
    ...failureList(`Failed on red (${counted(failed, 'test')})`, failures, failed),
    ...failureList(
      `Did not load on red (${unloaded}): red's counts leave out the tests inside`,
      fileErrors,
      fileErrors.length,
    ),
    ...details('Test command', [fencedJson(shown)]),
  ];
}

export function renderEvidenceBlock(
  outcome: EvidenceOutcome,
  evidence: RegressionEvidence | null,
  verdict?: PrintedVerdict,
): string {
  const label = outcome.reason ? `${outcome.status} (${outcome.reason})` : outcome.status;
  const summary = `${STATUS_MARK[outcome.status]} <b>Regression evidence</b> · ${label}`;
  const content = [
    ...(verdict?.reasons ?? []).map((reason) => `- ${plain(reason)}`),
    '',
    ...details(`${summary}: ${plain(outcome.detail)}`, [
      `Head ${short(outcome.headSha)} · base ${short(outcome.baseSha)}`,
      '',
      ...(evidence ? runLines(evidence) : []),
      "<sub>Captured runs, not proof of causality. Dependencies are the shipping checkout's " +
        `installed packages. Stale unless the PR head is \`${outcome.headSha}\`.</sub>`,
    ]),
  ].join('\n');
  const record = verdict?.verdict ? { ...outcome, mergeVerdict: verdict.verdict } : outcome;
  const data = JSON.stringify(record).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e');
  return [
    EVIDENCE_BEGIN,
    '## Automated evidence',
    // A line opening with a comment is a raw HTML block, so the slot trails the verdict's markdown.
    `${verdict ? `${plain(verdict.line)} ` : ''}${VERDICT_SLOT}`,
    defuse(content),
    `${DATA_OPEN}${data}${DATA_CLOSE}`,
    EVIDENCE_END,
  ].join('\n');
}

/** Replace the block in place, or append one; the rest of the body is kept byte for byte. */
export function upsertEvidenceBlock(body: string, block: string): string {
  if (BLOCK.test(body)) return body.replace(BLOCK, () => block);
  const text = body.trimEnd();
  return text ? `${text}\n\n${block}\n` : `${block}\n`;
}

export const sectionBegin = (name: string): string => `<!-- devkit:evidence:${name}:begin -->`;
export const sectionEnd = (name: string): string => `<!-- devkit:evidence:${name}:end -->`;
const sectionPattern = (name: string): RegExp =>
  new RegExp(`^${sectionBegin(name)}\\r?\\n[\\s\\S]*?\\n${sectionEnd(name)}(?=\\r?$)`, 'm');
const BLOCK_TAIL = /^<!-- devkit:evidence:(?:data |end -->)/m;
/** Sections a writer other than the regression step owns; every re-render carries them across. */
const CARRIED_SECTIONS = ['qa', 'notes'];

/** The block's `name` section; one outside the block is caller text, never ours. */
export const sectionOf = (name: string, body: string): string | null =>
  sectionPattern(name).exec(BLOCK.exec(body)?.[0] ?? '')?.[0] ?? null;

/** `body` with `section` as its block's `name` section: replaced in place, else placed before the
 * block's data line, else in a block of its own. Bytes outside the block are never touched. */
export function withSection(name: string, body: string, section: string): string {
  const block = BLOCK.exec(body)?.[0];
  if (!block) return upsertEvidenceBlock(body, [EVIDENCE_BEGIN, section, EVIDENCE_END].join('\n'));
  const pattern = sectionPattern(name);
  if (pattern.test(block))
    return upsertEvidenceBlock(
      body,
      block.replace(pattern, () => section),
    );
  const at = BLOCK_TAIL.exec(block)?.index ?? block.length;
  return upsertEvidenceBlock(body, `${block.slice(0, at)}${section}\n${block.slice(at)}`);
}

/** `body` with its evidence block replaced by `block`, keeping every section another step wrote. */
export function replaceKeepingSections(body: string, block: string): string {
  return CARRIED_SECTIONS.reduce(
    (next, name) => {
      const section = sectionOf(name, body);
      return section ? withSection(name, next, section) : next;
    },
    upsertEvidenceBlock(body, block),
  );
}

/** A caller's replacement body keeps the PR's current block, so an explicit body never deletes it. */
export function carryEvidenceBlock(callerBody: string, currentBody: string): string {
  const existing = BLOCK.exec(currentBody)?.[0];
  return existing ? upsertEvidenceBlock(callerText(callerBody), existing) : callerText(callerBody);
}

/** The recorded outcome, stale when it was produced at another head; null when absent or malformed. */
export function readEvidenceBlock(
  body: string,
  currentHead: string,
): (z.infer<typeof outcomeSchema> & { stale: boolean }) | null {
  const line = BLOCK.exec(body)?.[0]
    .split('\n')
    .map((text) => text.trimEnd())
    .find((text) => text.startsWith(DATA_OPEN) && text.endsWith(DATA_CLOSE));
  if (!line) return null;
  let data: unknown;
  try {
    data = JSON.parse(line.slice(DATA_OPEN.length, -DATA_CLOSE.length));
  } catch {
    return null;
  }
  const parsed = outcomeSchema.safeParse(data);
  return parsed.success ? { ...parsed.data, stale: parsed.data.headSha !== currentHead } : null;
}
