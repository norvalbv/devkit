import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const here = path.dirname(fileURLToPath(import.meta.url));
export const baselinePath = path.join(here, 'results.baseline.json');
export const casesPath = path.join(here, 'cases-completeness.jsonl');
export const transcriptsDir = path.join(here, 'transcripts');
const SAFE_TRANSCRIPT_STEM = /^(?!sha256-[a-f0-9]{64}$)[A-Za-z0-9_-]{1,128}$/;
export const transcriptPath = (caseId: string) => {
  const stem = SAFE_TRANSCRIPT_STEM.test(caseId)
    ? caseId
    : `sha256-${createHash('sha256').update(caseId).digest('hex')}`;
  return path.join(transcriptsDir, `${stem}.json`);
};
export const auditLabelsPath = path.join(here, 'matcher-audit.labels.jsonl');
export const LEGACY_AUDIT_REVIEWER_MODEL = 'opus';

export const MATCH_MODEL = process.env.BENCH_MATCH_MODEL ?? 'haiku';
export const MATCH_RUNS = Math.max(
  1,
  Number.parseInt(process.env.BENCH_MATCH_RUNS ?? '3', 10) || 3,
);
export const MATCH_CONCURRENCY = 4;
export const AGENTS_DIR = path.resolve(here, '../../../agents');
export const AGENT_MD = path.join(AGENTS_DIR, 'feature-completeness-reviewer.md');
export const AUDIT_RUBRIC =
  'Independently decide whether one numbered finding identifies the SAME underlying gap as the audit slot. Match the causal defect and required remedy, not shared words or a merely adjacent concern. A narrower or broader statement may match only when fixing it would also fix the slot. Return exactly SLOT: F<n> or SLOT: NONE.';
