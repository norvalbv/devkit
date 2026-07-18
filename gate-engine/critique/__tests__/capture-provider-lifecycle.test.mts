import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureSubagentStop, observePlanStop } from '../capture.mts';
import { resolveEligibleBinding } from '../evidence-bindings.mts';
import {
  blockedResponse,
  claudeStop,
  claudeSubagent,
  cleanResponse,
  cleanupCaptureFixtures,
  cursorSubagent,
  captureFixture as fixture,
  initCritiqueTestRepo as initRepo,
  storedCaptureObservation as observation,
  storedCaptureRecord as record,
} from './capture-fixtures.mts';

afterEach(() => {
  cleanupCaptureFixtures();
});

describe('provider plan-critique lifecycle identity', () => {
  it('starts separate Claude plans in one session at pass one', () => {
    const { repo, evidence } = fixture();
    const first = captureSubagentStop(
      'claude',
      claudeSubagent(repo, 'session-shared', 'agent-first', cleanResponse),
      repo,
    );
    const firstStop = observePlanStop('claude', claudeStop(repo, 'session-shared'), repo);
    const second = captureSubagentStop(
      'claude',
      claudeSubagent(repo, 'session-shared', 'agent-second', cleanResponse),
      repo,
    );
    const secondStop = observePlanStop('claude', claudeStop(repo, 'session-shared'), repo);

    expect(firstStop).toMatchObject({ reason: 'linked', critiqueId: first.critiqueId });
    expect(secondStop).toMatchObject({ reason: 'linked', critiqueId: second.critiqueId });
    const firstRecord = record(evidence, first);
    const secondRecord = record(evidence, second);
    expect(firstRecord.lineage).toEqual({ pass: 1, parentCritiqueId: null });
    expect(secondRecord.lineage).toEqual({ pass: 1, parentCritiqueId: null });
    expect(secondRecord.workId).not.toBe(firstRecord.workId);
  });

  it('keeps one Claude blocker recheck in the same work lineage', () => {
    const { repo, evidence } = fixture();
    const first = captureSubagentStop(
      'claude',
      claudeSubagent(repo, 'session-recheck', 'agent-blocker', blockedResponse),
      repo,
    );
    const second = captureSubagentStop(
      'claude',
      claudeSubagent(repo, 'session-recheck', 'agent-recheck', cleanResponse),
      repo,
    );
    const stopped = observePlanStop('claude', claudeStop(repo, 'session-recheck'), repo);

    const firstRecord = record(evidence, first);
    expect(record(evidence, second)).toMatchObject({
      workId: firstRecord.workId,
      lineage: { pass: 2, parentCritiqueId: first.critiqueId },
    });
    expect(stopped).toMatchObject({ reason: 'linked', critiqueId: second.critiqueId });
  });

  it('consumes pending Claude captures at a non-plan Stop', () => {
    const { repo, evidence } = fixture();
    const first = captureSubagentStop(
      'claude',
      claudeSubagent(repo, 'session-mode', 'agent-before-stop', blockedResponse),
      repo,
    );
    const stopped = observePlanStop('claude', claudeStop(repo, 'session-mode', 'default'), repo);
    const second = captureSubagentStop(
      'claude',
      claudeSubagent(repo, 'session-mode', 'agent-after-stop', cleanResponse),
      repo,
    );

    expect(stopped).toMatchObject({ status: 'skipped', reason: 'not_plan_mode' });
    expect(observation(evidence, stopped)).toMatchObject({
      kind: 'plan_stop_observation',
      status: 'skipped',
      reason: 'not_plan_mode',
      consumedCaptureIds: [first.observationId],
      finalPlanBlob: null,
    });
    const firstRecord = record(evidence, first);
    const secondRecord = record(evidence, second);
    expect(secondRecord.lineage).toEqual({ pass: 1, parentCritiqueId: null });
    expect(secondRecord.workId).not.toBe(firstRecord.workId);
  });

  it('scopes Claude pending observations to the captured repository', () => {
    const { root, repo, evidence } = fixture();
    const otherRepo = join(root, 'other-repo');
    initRepo(otherRepo);
    const first = captureSubagentStop(
      'claude',
      claudeSubagent(repo, 'session-cross-repo', 'agent-one', blockedResponse),
      repo,
    );
    const other = captureSubagentStop(
      'claude',
      claudeSubagent(otherRepo, 'session-cross-repo', 'agent-two', cleanResponse),
      otherRepo,
    );
    const otherStop = observePlanStop(
      'claude',
      claudeStop(otherRepo, 'session-cross-repo'),
      otherRepo,
    );
    const recheck = captureSubagentStop(
      'claude',
      claudeSubagent(repo, 'session-cross-repo', 'agent-one-recheck', cleanResponse),
      repo,
    );

    const firstRecord = record(evidence, first);
    const otherRecord = record(evidence, other);
    expect(otherRecord.lineage).toEqual({ pass: 1, parentCritiqueId: null });
    expect(otherRecord.workId).not.toBe(firstRecord.workId);
    expect(otherStop).toMatchObject({ critiqueId: other.critiqueId, reason: 'linked' });
    expect(record(evidence, recheck)).toMatchObject({
      workId: firstRecord.workId,
      lineage: { pass: 2, parentCritiqueId: first.critiqueId },
    });
  });

  it('isolates Cursor generations within one conversation', () => {
    const { repo, evidence } = fixture();
    const first = captureSubagentStop(
      'cursor',
      cursorSubagent(repo, 'conversation', 'generation-one', 'completed', cleanResponse),
      repo,
    );
    const second = captureSubagentStop(
      'cursor',
      cursorSubagent(repo, 'conversation', 'generation-two', 'completed', cleanResponse),
      repo,
    );

    const firstRecord = record(evidence, first);
    const secondRecord = record(evidence, second);
    expect(firstRecord.lineage.pass).toBe(1);
    expect(secondRecord.lineage.pass).toBe(1);
    expect(secondRecord.workId).not.toBe(firstRecord.workId);
    expect(resolveEligibleBinding(repo, firstRecord.workId)).toMatchObject({
      status: 'matched',
      record: { critiqueId: first.critiqueId, providerStatus: 'completed' },
    });
  });

  it('accepts Cursor generation identity even when it equals conversation identity', () => {
    const { repo, evidence } = fixture();
    const first = captureSubagentStop(
      'cursor',
      cursorSubagent(repo, 'same-id', 'same-id', 'completed', blockedResponse),
      repo,
    );
    const second = captureSubagentStop(
      'cursor',
      cursorSubagent(repo, 'same-id', 'same-id', 'completed', cleanResponse),
      repo,
    );

    expect(record(evidence, second)).toMatchObject({
      workId: record(evidence, first).workId,
      lineage: { pass: 2, parentCritiqueId: first.critiqueId },
    });
  });
});
