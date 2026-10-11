// The devkit-owned evidence block inside a PR body. Every byte outside the markers belongs to the
// caller or another tool; ship only ever replaces the span between them.
import { z } from 'zod';
import {
  fencedJson,
  inlineJson,
  type RegressionEvidence,
  type RegressionOperandEvidence,
} from '../../baseline-status/regression-evidence.mts';
import { EVIDENCE_ABSTENTIONS, EVIDENCE_STATUSES, type EvidenceOutcome } from './outcome.mts';

export const EVIDENCE_BEGIN = '<!-- devkit:evidence:begin -->';
export const EVIDENCE_END = '<!-- devkit:evidence:end -->';
/** Reserved line for the merge verdict; renderEvidenceBlock fills it when given one. */
export const VERDICT_SLOT = '<!-- devkit:evidence:verdict -->';
const DATA_OPEN = '<!-- devkit:evidence:data ';
const DATA_CLOSE = ' -->';
// Whole marker lines only: ship writes them that way, and prose quoting a marker inline is not a block.
const BLOCK = /^<!-- devkit:evidence:begin -->\r?\n[\s\S]*?\n<!-- devkit:evidence:end -->(?=\r?$)/m;
const BLOCKS = new RegExp(BLOCK.source, 'gm');
const MARKER = /<!-- devkit:evidence:/g;
const SHOWN_FAILURES = 3;
const SHOWN_ARGS = 40;
const MAX_DETAIL_CHARS = 500;
const MAX_FAILURE_CHARS = 240;

const outcomeSchema = z.strictObject({
  status: z.enum(EVIDENCE_STATUSES),
  reason: z.enum(EVIDENCE_ABSTENTIONS).nullable(),
  detail: z.string(),
  headSha: z.string(),
  baseSha: z.string().nullable(),
});

/** A zero-width space after the namespace keeps quoted marker text from ever parsing as a marker. */
const defuse = (text: string): string => text.replace(MARKER, '<!-- devkit:evidence​:');

/** Caller-authored text never carries evidence: a pasted block is dropped, a stray marker defused. */
export const callerText = (body: string): string => defuse(body.replace(BLOCKS, ''));

const clip = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit - 1)}…` : text;

const plain = (text: string): string =>
  clip(text.replace(/\s+/g, ' ').trim().replaceAll('<', '&lt;'), MAX_DETAIL_CHARS);

const failureLine = (label: string, item: { fullName: string; message: string }): string =>
  `- ${label} ${inlineJson(item.fullName)}: ${inlineJson(clip(item.message, MAX_FAILURE_CHARS))}`;

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
  const notes = [
    ...evidence.red.failures
      .slice(0, SHOWN_FAILURES)
      .map((item) => failureLine('red failure', item)),
    ...evidence.red.fileErrors
      .slice(0, SHOWN_FAILURES)
      .map((item) => failureLine('red file error, not counted:', item)),
  ];
  return [
    '| run | tree | exit | passed | failed | skipped |',
    '|---|---|---|---|---|---|',
    operandRow('red', `PR base + PR test files ${short(evidence.red.sha)}`, evidence.red),
    operandRow('green', `PR head ${short(evidence.green.sha)}`, evidence.green),
    '',
    ...notes,
    ...(notes.length ? [''] : []),
    '<details><summary>Test command</summary>',
    '',
    fencedJson(shown),
    '',
    '</details>',
    '',
  ];
}

export function renderEvidenceBlock(
  outcome: EvidenceOutcome,
  evidence: RegressionEvidence | null,
  verdict = '',
): string {
  const label = outcome.reason ? `${outcome.status} (${outcome.reason})` : outcome.status;
  const content = [
    `**${label}**: ${plain(outcome.detail)}`,
    `Head ${short(outcome.headSha)} · base ${short(outcome.baseSha)}`,
    '',
    ...(evidence ? runLines(evidence) : []),
    "Captured runs, not proof of causality. Dependencies are the shipping checkout's installed " +
      `packages. Stale unless the PR head is \`${outcome.headSha}\`.`,
  ].join('\n');
  const data = JSON.stringify(outcome).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e');
  return [
    EVIDENCE_BEGIN,
    '#### Regression evidence (devkit ship)',
    `${VERDICT_SLOT}${verdict ? ` ${defuse(verdict)}` : ''}`,
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

/** A caller's replacement body keeps the PR's current block, so an explicit body never deletes it. */
export function carryEvidenceBlock(callerBody: string, currentBody: string): string {
  const existing = BLOCK.exec(currentBody)?.[0];
  return existing ? upsertEvidenceBlock(callerText(callerBody), existing) : callerText(callerBody);
}

/** The recorded outcome, stale when it was produced at another head; null when absent or malformed. */
export function readEvidenceBlock(
  body: string,
  currentHead: string,
): (EvidenceOutcome & { stale: boolean }) | null {
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
