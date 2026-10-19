// The devkit-owned evidence block inside a PR body. Every byte outside the markers belongs to the
// caller or another tool; ship only ever replaces the span between them.
import { z } from 'zod';
import {
  fencedJson,
  inlineJson,
  type RegressionEvidence,
  type RegressionOperandEvidence,
} from '../../baseline-status/regression-evidence.mts';
import type { MergeVerdict } from '../merge-verdict/verdict.mts';
import { EVIDENCE_ABSTENTIONS, EVIDENCE_STATUSES, type EvidenceOutcome } from './outcome.mts';

export const ownedBegin = (ns: string): string => `<!-- devkit:${ns}:begin -->`;
export const ownedEnd = (ns: string): string => `<!-- devkit:${ns}:end -->`;
const EVIDENCE = 'evidence';
export const EVIDENCE_BEGIN = ownedBegin(EVIDENCE);
export const EVIDENCE_END = ownedEnd(EVIDENCE);
/** The merge verdict's line; the data line carries its full reason list for later re-scoring. */
export const VERDICT_SLOT = '<!-- devkit:evidence:verdict -->';
export const VERDICT_LABEL = '**Merge verdict:**';

/** The slot's text, and the verdict itself when one could be computed. */
export interface PrintedVerdict {
  line: string;
  verdict?: MergeVerdict;
}

/** No verdict is never a reason to drop the block: the slot says why instead. */
export const verdictUnavailable = (why: string): PrintedVerdict => ({
  line: `${VERDICT_LABEL} unavailable (${why})`,
});
const DATA_OPEN = '<!-- devkit:evidence:data ';
const DATA_CLOSE = ' -->';
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
  mergeVerdict: z
    .strictObject({
      verdict: z.string(),
      reasons: z.array(z.strictObject({ code: z.string(), detail: z.string().optional() })),
    })
    .optional(),
});

// Whole marker lines only: ship writes them that way, and prose quoting a marker inline is not a block.
const ownedPattern = (ns: string, flags: string): RegExp =>
  new RegExp(`^${ownedBegin(ns)}\\r?\\n[\\s\\S]*?\\n${ownedEnd(ns)}(?=\\r?$)`, flags);

/** A zero-width space after the namespace keeps quoted marker text from ever parsing as a marker. */
const defuse = (ns: string, text: string): string =>
  text.replaceAll(`<!-- devkit:${ns}:`, `<!-- devkit:${ns}​:`);

/** Caller-authored text never carries a ship-owned block: a pasted one is dropped, a marker defused. */
export const stripOwned = (ns: string, body: string): string =>
  defuse(ns, body.replace(ownedPattern(ns, 'gm'), ''));

export const findOwned = (ns: string, body: string): string | undefined =>
  ownedPattern(ns, 'm').exec(body)?.[0];

/** Replace the block in place, or append one; the rest of the body is kept byte for byte. */
export function upsertOwned(ns: string, body: string, block: string): string {
  const pattern = ownedPattern(ns, 'm');
  if (pattern.test(body)) return body.replace(pattern, () => block);
  const text = body.trimEnd();
  return text ? `${text}\n\n${block}\n` : `${block}\n`;
}

/** A caller's replacement body keeps the PR's current block, so an explicit body never deletes it. */
export function carryOwned(ns: string, callerBody: string, currentBody: string): string {
  const existing = findOwned(ns, currentBody);
  const text = stripOwned(ns, callerBody);
  return existing ? upsertOwned(ns, text, existing) : text;
}

export const callerText = (body: string): string => stripOwned(EVIDENCE, body);

const clip = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit - 1)}…` : text;

export const plain = (text: string): string =>
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
  verdict?: PrintedVerdict,
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
  const record = verdict?.verdict ? { ...outcome, mergeVerdict: verdict.verdict } : outcome;
  const data = JSON.stringify(record).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e');
  return [
    EVIDENCE_BEGIN,
    '#### Regression evidence (devkit ship)',
    `${VERDICT_SLOT}${verdict ? ` ${plain(verdict.line)}` : ''}`,
    defuse(EVIDENCE, content),
    `${DATA_OPEN}${data}${DATA_CLOSE}`,
    EVIDENCE_END,
  ].join('\n');
}

export const upsertEvidenceBlock = (body: string, block: string): string =>
  upsertOwned(EVIDENCE, body, block);

export const carryEvidenceBlock = (callerBody: string, currentBody: string): string =>
  carryOwned(EVIDENCE, callerBody, currentBody);

/** The recorded outcome, stale when it was produced at another head; null when absent or malformed. */
export function readEvidenceBlock(
  body: string,
  currentHead: string,
): (EvidenceOutcome & { stale: boolean }) | null {
  const line = findOwned(EVIDENCE, body)
    ?.split('\n')
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
