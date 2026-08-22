import type { VerdictMeta } from '../judge/verdict-store.mts';
import { devkitDataFile, loadEntries, saveEntries } from '../judge/verdict-store.mts';
import { detectChangedComments } from './detect.mts';
import { commentJudgeModel, judgeComments, receiptKey } from './judge.mts';
import { loadWorkingRationales } from './rationales.mts';
import type {
  CommentFinding,
  CommentJudgeBatchResult,
  CommentRationale,
  DetectionResult,
  RationaleStore,
} from './types.mts';

export const COMMENT_RECEIPTS_FILE = 'comment-firewall-receipts.json';

interface FirewallDeps {
  detect: (cwd: string) => DetectionResult;
  loadRationales: (cwd: string) => RationaleStore;
  loadReceipts: (file: string) => Record<string, VerdictMeta>;
  saveReceipt: (file: string, entries: Record<string, VerdictMeta>) => boolean;
  judge: (
    cwd: string,
    items: Array<{ finding: CommentFinding; rationale: CommentRationale }>,
  ) => CommentJudgeBatchResult | null;
  model: () => string;
  now: () => string;
  strict: () => boolean;
}

interface PendingReview {
  finding: CommentFinding;
  rationale: CommentRationale;
  key: string;
}

const defaults: FirewallDeps = {
  detect: detectChangedComments,
  loadRationales: loadWorkingRationales,
  loadReceipts: loadEntries,
  saveReceipt: saveEntries,
  judge: judgeComments,
  model: commentJudgeModel,
  now: () => new Date().toISOString(),
  strict: () => Boolean(process.env.GUARD_AI_STRICT),
};

function findingLocation(finding: CommentFinding): string {
  return `${finding.path}:${finding.startLine}${
    finding.endLine === finding.startLine ? '' : `-${finding.endLine}`
  }`;
}

function printFinding(finding: CommentFinding): void {
  const summary = finding.comment.replace(/\s+/g, ' ').slice(0, 140);
  console.error(`  • [${finding.id}] ${findingLocation(finding)} — ${summary}`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function printMissing(findings: CommentFinding[]): void {
  const shipLog = process.env.DEVKIT_SHIP_GATE_LOG;
  const shipEvidence = shipLog ? ` --from-ship-log ${shellQuote(shipLog)}` : '';
  console.error(
    `guard-comments: ${findings.length} added/modified comment paragraph${findings.length === 1 ? '' : 's'} need a decision.`,
  );
  for (const finding of findings) printFinding(finding);
  console.error(
    '\nFix the implementation and remove the explanatory workaround, or justify a load-bearing comment:',
  );
  console.error(
    `  guard-comments justify <id> "why code/types/tests cannot express this durable constraint"${shipEvidence}`,
  );
  console.error('If this is legitimate temporary debt, create/link its cleanup ticket:');
  console.error(
    `  guard-comments justify <id> "why unavoidable now and what removes it" --ticket SC-123${shipEvidence}`,
  );
  console.error(
    'The rationale stays in Git-local state; one batched Haiku review must still approve it.',
  );
}

function passReceipt(meta: VerdictMeta | undefined): boolean {
  return meta?.verdict === 'PASS';
}

function evidenceFor(
  finding: CommentFinding,
  rationales: RationaleStore,
): CommentRationale | undefined {
  const evidence = rationales.entries[finding.id];
  return evidence?.rationale.trim() ? evidence : undefined;
}

/** Recompute the evidence just before publishing PASS, closing the stage-while-judge-runs race. */
function allRemainCurrent(cwd: string, pending: PendingReview[], deps: FirewallDeps): boolean {
  const refreshed = deps.detect(cwd);
  const currentById = new Map(refreshed.findings.map((finding) => [finding.id, finding]));
  const rationales = deps.loadRationales(cwd);
  return pending.every((item) => {
    const current = currentById.get(item.finding.id);
    if (!current) return false;
    const rationale = evidenceFor(current, rationales);
    return Boolean(rationale && receiptKey(current, rationale, deps.model()) === item.key);
  });
}

/**
 * Exit contract: 0 clean/receipted, 1 unresolved/rejected, 2 ordinary judge outage (fail-open),
 * 3 strict judge outage, 4 unreadable evidence, deterministic batch overflow, or unsupported language.
 */
export function runCommentFirewall(
  cwd = process.cwd(),
  injected: Partial<FirewallDeps> = {},
): 0 | 1 | 2 | 3 | 4 {
  const deps = { ...defaults, ...injected };
  let detection: DetectionResult;
  let rationales: RationaleStore;
  try {
    detection = deps.detect(cwd);
    rationales = deps.loadRationales(cwd);
  } catch (cause) {
    console.error(
      `guard-comments: comment evidence unreadable — ${cause instanceof Error ? cause.message : cause}`,
    );
    return 4;
  }
  if (detection.unsupported.length > 0) {
    console.error('guard-comments: configured staged source uses unsupported comment syntax:');
    for (const item of detection.unsupported) {
      console.error(`  • .${item.extension || '(none)'} — ${item.path}`);
    }
    console.error(
      'Add an explicit lexer adapter or exclude that extension from sourceExtensions; no regex fallback was used.',
    );
    return 4;
  }
  if (detection.findings.length === 0) return 0;

  const receiptFile = devkitDataFile(cwd, COMMENT_RECEIPTS_FILE);
  const receipts = deps.loadReceipts(receiptFile);
  const missing: CommentFinding[] = [];
  const pending: PendingReview[] = [];
  for (const finding of detection.findings) {
    const rationale = evidenceFor(finding, rationales);
    if (!rationale) {
      missing.push(finding);
      continue;
    }
    const key = receiptKey(finding, rationale, deps.model());
    if (!passReceipt(receipts[key])) pending.push({ finding, rationale, key });
  }
  if (missing.length > 0) {
    printMissing(missing);
    return 1;
  }

  if (pending.length === 0) return 0;
  let results: CommentJudgeBatchResult | null;
  try {
    results = deps.judge(
      cwd,
      pending.map(({ finding, rationale }) => ({ finding, rationale })),
    );
  } catch (cause) {
    console.error(
      `guard-comments: deterministic review-batch limit exceeded; split the staged change — ${cause instanceof Error ? cause.message : cause}`,
    );
    return 4;
  }
  if (!results || pending.some(({ finding }) => results[finding.id] === undefined)) {
    console.error(
      'guard-comments: batched reviewer unavailable or returned malformed evidence; no receipt was written.',
    );
    return deps.strict() ? 3 : 2;
  }

  try {
    if (!allRemainCurrent(cwd, pending, deps)) {
      console.error('guard-comments: local evidence changed during review; stale batch discarded.');
      return 1;
    }
  } catch (cause) {
    console.error(
      `guard-comments: could not re-read local evidence before publishing PASS — ${cause instanceof Error ? cause.message : cause}`,
    );
    return 4;
  }

  const approved = pending.filter(({ finding }) => results[finding.id]?.verdict === 'PASS');
  if (approved.length > 0) {
    const entries = Object.fromEntries(
      approved.map((item) => [
        item.key,
        {
          at: deps.now(),
          verdict: 'PASS',
          findingId: item.finding.id,
          path: item.finding.path,
          model: deps.model(),
          reason: results[item.finding.id]?.reason,
        },
      ]),
    );
    const saved = deps.saveReceipt(receiptFile, entries);
    if (!saved) {
      console.error(
        'guard-comments: approved PASS receipts could not be persisted; commit blocked.',
      );
      return 4;
    }
    Object.assign(receipts, entries);
  }

  let rejected = false;
  for (const item of pending) {
    const result = results[item.finding.id];
    if (!result) {
      console.error(
        `guard-comments: [${item.finding.id}] reviewer result disappeared before publication; commit blocked.`,
      );
      return 4;
    }
    if (result.verdict === 'FAIL') {
      rejected = true;
      console.error(`guard-comments: [${item.finding.id}] rationale rejected — ${result.reason}`);
    } else {
      console.error(`guard-comments: [${item.finding.id}] approved — ${result.reason}`);
    }
  }
  if (rejected) {
    console.error(
      'Fix the implementation/comment, or replace the rationale with specific evidence.',
    );
    console.error('For unavoidable temporary debt, include a cleanup ticket with --ticket SC-123.');
    return 1;
  }
  return 0;
}
