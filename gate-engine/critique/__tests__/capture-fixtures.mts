import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CaptureResult } from '../capture.mts';

const roots: string[] = [];

export interface CaptureFixture {
  root: string;
  repo: string;
  evidence: string;
}

export interface StoredCaptureRecord {
  critiqueId: string;
  workId: string;
  providerStatus?: string | null;
  lineage: { pass: number; parentCritiqueId: string | null };
  contract: {
    state: string;
    eligible: boolean;
    eligibilityReason: string;
    errors: string[];
  };
}

export function initCritiqueTestRepo(repo: string, initialBranch?: string): void {
  execFileSync('git', ['init', '-q', ...(initialBranch ? ['-b', initialBranch] : []), repo]);
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), 'fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repo });
}

export function captureFixture(prefix = 'plan-critique-'): CaptureFixture {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  const repo = join(root, 'repo');
  const evidence = join(root, 'evidence');
  initCritiqueTestRepo(repo);
  process.env.DEVKIT_PLAN_CRITIQUE_EVIDENCE_DIR = evidence;
  delete process.env.DEVKIT_NO_TELEMETRY;
  delete process.env.DEVKIT_WORK_ID;
  delete process.env.DEVKIT_PLAN_CRITIQUE_CAPTURE_TRANSCRIPTS;
  return { root, repo, evidence };
}

export function cleanupCaptureFixtures(): void {
  delete process.env.DEVKIT_PLAN_CRITIQUE_EVIDENCE_DIR;
  delete process.env.DEVKIT_NO_TELEMETRY;
  delete process.env.DEVKIT_WORK_ID;
  delete process.env.DEVKIT_PLAN_CRITIQUE_CAPTURE_TRANSCRIPTS;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

export function requiredCaptureId(
  result: CaptureResult,
  key: 'critiqueId' | 'observationId',
): string {
  const value = result[key];
  if (!value) throw new Error(`capture result omitted ${key}: ${JSON.stringify(result)}`);
  return value;
}

export function storedCaptureRecord(evidence: string, result: CaptureResult): StoredCaptureRecord {
  return JSON.parse(
    readFileSync(
      join(evidence, 'records', `${requiredCaptureId(result, 'critiqueId')}.json`),
      'utf8',
    ),
  );
}

export function storedCaptureObservation(
  evidence: string,
  result: CaptureResult,
): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      join(evidence, 'observations', `${requiredCaptureId(result, 'observationId')}.json`),
      'utf8',
    ),
  );
}

export const cleanResponse = JSON.stringify({
  schemaVersion: 1,
  kind: 'plan_critique',
  phase: 'plan',
  status: 'reviewed',
  verdict: 'PROCEED_WITH_CHANGES',
  feasibility: 'confirmed',
  frameMeta: 'SOUND',
  summary: 'Proceed after incorporating the warnings.',
  findings: [
    {
      severity: 'warning',
      lens: 'recovery',
      claim: 'Capture may fail.',
      evidence: 'The hook is fail-open.',
      impact: 'One record can be absent.',
      recommendation: 'Record a skip reason.',
    },
  ],
  edgeCases: [
    {
      risk: 'capture outage',
      scenario: 'the evidence directory is unavailable',
      expectedBehavior: 'the visible critique still completes',
      testType: 'integration',
    },
  ],
  actions: ['Incorporate the warning.'],
});

export const blockedResponse = JSON.stringify({
  ...JSON.parse(cleanResponse),
  verdict: 'RETHINK',
  summary: 'The plan must be revised before implementation.',
  findings: [
    {
      severity: 'critical',
      lens: 'correctness',
      claim: 'The binding does not validate ancestry.',
      evidence: 'The proposal selects by branch name only.',
      impact: 'A rebase can select stale evidence.',
      recommendation: 'Require the captured HEAD to remain an ancestor.',
    },
  ],
});

export function claudeSubagent(
  repo: string,
  sessionId: string,
  agentId: string,
  response: string,
): Record<string, unknown> {
  return {
    cwd: repo,
    session_id: sessionId,
    agent_id: agentId,
    agent_type: 'feature-critique',
    agent_transcript_path: join(repo, `.opaque-${agentId}.jsonl`),
    last_assistant_message: response,
  };
}

export function claudeStop(repo: string, sessionId: string, permissionMode = 'plan') {
  return {
    cwd: repo,
    session_id: sessionId,
    permission_mode: permissionMode,
    last_assistant_message: 'Final decision-complete plan',
  };
}

export function cursorSubagent(
  repo: string,
  conversationId: string,
  generationId: string,
  status: 'completed' | 'error' | 'aborted',
  response?: string,
): Record<string, unknown> {
  return {
    cwd: repo,
    conversation_id: conversationId,
    generation_id: generationId,
    subagent_type: 'feature-critique',
    status,
    task: 'Critique the finalized feature plan',
    ...(response === undefined ? {} : { summary: response }),
  };
}
