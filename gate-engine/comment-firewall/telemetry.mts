import { emitGateEvent } from '../judge/gate-events.mts';
import { EVENT_BUDGET } from '../judge/odb-probe.mts';
import { runEnvelope } from '../judge/run-context.mts';
import type { CommentFinding, CommentInventory } from './types.mts';

export const COMMENT_BUDGET_EVENT = 'comment_budget';
export type CommentBudgetStatus = 'pass' | 'block' | 'unreadable' | 'unsupported';

export interface CommentBudgetFinding {
  id: string;
  path: string;
  start: number;
  end: number;
  text_lines: number;
  anchor: string;
}

export interface CommentBudgetTouched {
  anchor: string;
  text_lines: number;
}

export interface CommentBudgetEvent {
  type: typeof COMMENT_BUDGET_EVENT;
  gate: 'comments';
  status: CommentBudgetStatus;
  files: number;
  paragraphs: CommentInventory['paragraphs'];
  trailing_added: number;
  decisions_staged: boolean;
  findings: CommentBudgetFinding[];
  touched: CommentBudgetTouched[];
  omitted?: { findings: number; touched: number };
  truncated?: true;
}

/** odb-probe's EVENT_BUDGET is a payload bound with ~2KB left for the envelope under the 4KB
 * atomic append; the whole written line is bounded here directly, with a little slack for `\n`. */
const LINE_BUDGET = EVENT_BUDGET * 2 - 128;
const PAYLOAD_BUDGET = EVENT_BUDGET - 320;

function bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function build(
  status: CommentBudgetStatus,
  inventory: CommentInventory,
  findings: CommentFinding[],
  keepFindings: number,
  keepTouched: number,
): CommentBudgetEvent {
  const event: CommentBudgetEvent = {
    type: COMMENT_BUDGET_EVENT,
    gate: 'comments',
    status,
    files: inventory.files,
    paragraphs: inventory.paragraphs,
    trailing_added: inventory.trailingAdded,
    decisions_staged: inventory.decisionsStaged,
    findings: findings.slice(0, keepFindings).map((finding) => ({
      id: finding.id,
      path: finding.path.slice(0, 120),
      start: finding.startLine,
      end: finding.endLine,
      text_lines: finding.textLines,
      anchor: finding.anchor,
    })),
    touched: inventory.touched.slice(0, keepTouched).map((item) => ({
      anchor: item.anchor,
      text_lines: item.textLines,
    })),
  };
  const omittedFindings = findings.length - keepFindings;
  const omittedTouched = inventory.touched.length - keepTouched;
  if (omittedFindings > 0 || omittedTouched > 0) {
    event.omitted = { findings: omittedFindings, touched: omittedTouched };
  }
  return event;
}

/** Shrinks the two lists, touched first, until the line fits the atomic-append budget. */
export function commentBudgetEvent(
  status: CommentBudgetStatus,
  inventory: CommentInventory,
  findings: CommentFinding[],
  budget = PAYLOAD_BUDGET,
): CommentBudgetEvent {
  const maxItems = Math.ceil(Math.max(budget, 0) / 30);
  let keepFindings = Math.min(findings.length, maxItems);
  let keepTouched = Math.min(inventory.touched.length, maxItems);
  for (;;) {
    const event = build(status, inventory, findings, keepFindings, keepTouched);
    if (bytes(JSON.stringify(event)) <= budget) return event;
    if (keepTouched > 0) keepTouched -= 1;
    else if (keepFindings > 0) keepFindings -= 1;
    else {
      return {
        ...build(status, inventory, [], 0, 0),
        omitted: { findings: findings.length, touched: inventory.touched.length },
        truncated: true,
      };
    }
  }
}

/** The line emitGateEvent writes is payload + envelope + ts; measure the envelope it will append
 * so the WHOLE record, not just the payload, stays under the atomic-append line budget. */
export function emitCommentBudget(
  status: CommentBudgetStatus,
  inventory: CommentInventory,
  findings: CommentFinding[],
): void {
  const envelope = bytes(JSON.stringify({ ...runEnvelope(), ts: new Date().toISOString() }));
  const event = commentBudgetEvent(status, inventory, findings, LINE_BUDGET - envelope);
  // The envelope is not ours to cap; when even the floor event cannot fit beside it, a missing
  // event beats a torn line in the shared sink.
  if (bytes(JSON.stringify(event)) + envelope > LINE_BUDGET) return;
  emitGateEvent({ ...event });
}
