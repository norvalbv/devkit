import { readSync } from 'node:fs';
import { isatty } from 'node:tty';
import { TextDecoder } from 'node:util';
import { capturePlanCritiqueCompletedCallback } from '../capture-normalizer.mts';
import { persistPlanCritiqueWorkQuarantine } from '../lifecycle/work-quarantine.mts';
import { adaptClaudeFeatureCritiqueSubagentStop } from '../provider-adapters/claude-subagent-stop.mts';
import { getPlanCritiqueRepositoryContext } from '../repository-context.mts';

const MAX_HOOK_INPUT_BYTES = 4 * 1024 * 1024;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

function readHookPayload(): unknown {
  const buffer = Buffer.allocUnsafe(MAX_HOOK_INPUT_BYTES + 1);
  let bytesRead = 0;
  while (bytesRead < buffer.byteLength) {
    const next = readSync(0, buffer, bytesRead, buffer.byteLength - bytesRead, null);
    if (next === 0) break;
    bytesRead += next;
  }
  if (bytesRead > MAX_HOOK_INPUT_BYTES) throw new Error('Claude hook input is too large');
  return JSON.parse(UTF8.decode(buffer.subarray(0, bytesRead))) as unknown;
}

function captureHookPayload(payload: unknown): void {
  const repository = getPlanCritiqueRepositoryContext(process.cwd());
  if (repository.status === 'unavailable') return;
  const repositoryEvidence = {
    fingerprint: repository.context.fingerprint,
    fingerprintSource: repository.context.fingerprintSource,
    branch: repository.context.branch,
    head: repository.context.head,
  };
  const adapted = adaptClaudeFeatureCritiqueSubagentStop(payload, {
    repository: repositoryEvidence,
  });
  if (adapted.kind === 'ready') {
    capturePlanCritiqueCompletedCallback(adapted.callback);
    return;
  }
  if (adapted.kind === 'work_unbindable') {
    persistPlanCritiqueWorkQuarantine({
      provider: 'claude',
      repositoryFingerprint: repositoryEvidence.fingerprint,
      workId: adapted.workId,
    });
  }
}

function run(): void {
  if (process.env.DEVKIT_NO_TELEMETRY === '1' || isatty(0)) return;
  captureHookPayload(readHookPayload());
}

try {
  run();
} catch {
  // Evidence capture is private, shadow-only, and always fail-open for the provider hook.
}
