import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { captureSubagentStop, observeCommitProjection, observePlanStop } from '../capture.mts';
import { resolveEligibleBinding } from '../evidence-bindings.mts';
import {
  persistImmutableJson,
  pruneExpiredTranscriptBlobs,
  writeContentBlob,
} from '../evidence-store.mts';
import {
  blockedResponse,
  cleanResponse,
  cleanupCaptureFixtures,
  captureFixture as fixture,
} from './capture-fixtures.mts';

const captureEntry = fileURLToPath(new URL('../capture.mts', import.meta.url));

afterEach(() => {
  cleanupCaptureFixtures();
});

describe('plan critique evidence capture', () => {
  it('does not capture unrelated JSON that only mentions the critique kind', () => {
    const { repo, evidence } = fixture();
    const result = captureSubagentStop(
      'codex',
      {
        cwd: repo,
        turn_id: 'turn-code-review',
        agent_type: 'code-review',
        last_assistant_message: JSON.stringify({
          kind: 'code_review',
          notes: 'This review references the plan_critique contract.',
        }),
      },
      repo,
    );

    expect(result).toMatchObject({ status: 'skipped', reason: 'not_plan_critique' });
    expect(existsSync(evidence)).toBe(false);
  });

  it('captures direct provider output without repository/provider runtime artifacts', () => {
    const { repo, evidence } = fixture();
    const result = captureSubagentStop(
      'codex',
      {
        cwd: repo,
        turn_id: 'turn-1',
        agent_type: 'feature-critique',
        model: 'gpt-test',
        last_assistant_message: cleanResponse,
      },
      repo,
    );
    expect(result).toMatchObject({ status: 'captured', eligible: true });
    expect(readdirSync(join(evidence, 'records'))).toHaveLength(1);
    const recordPath = join(evidence, 'records', readdirSync(join(evidence, 'records'))[0]);
    expect(statSync(evidence).mode & 0o777).toBe(0o700);
    expect(statSync(recordPath).mode & 0o777).toBe(0o600);
    expect(existsSync(join(repo, '.cursor'))).toBe(false);
    expect(existsSync(join(repo, '.codex'))).toBe(false);

    const binding = resolveEligibleBinding(repo);
    expect(binding.status).toBe('matched');
    expect(binding.record?.provider).toBe('codex');
    expect(binding.record?.transcriptBlob).toBeNull();
    const projectionResult = observeCommitProjection(repo);
    const projection = JSON.parse(
      readFileSync(
        join(evidence, 'commit-projections', `${projectionResult.observationId}.json`),
        'utf8',
      ),
    ).projection;
    expect(projection.kind).toBe('plan_critique_commit_projection');
    expect(projection.summary).toBeUndefined();
    expect(projection.actions).toBeUndefined();
    expect(JSON.stringify(projection)).not.toContain('The hook is fail-open.');
  });

  it('accepts the source checkout explicitly when a ship hook runs elsewhere', () => {
    const { root, repo, evidence } = fixture();
    captureSubagentStop(
      'codex',
      {
        cwd: repo,
        turn_id: 'turn-ship-source',
        agent_type: 'feature-critique',
        last_assistant_message: cleanResponse,
      },
      repo,
    );

    execFileSync(process.execPath, [captureEntry, 'commit-projection', repo], {
      cwd: root,
      env: { ...process.env, DEVKIT_PLAN_CRITIQUE_EVIDENCE_DIR: evidence },
    });

    const observations = readdirSync(join(evidence, 'commit-projections'));
    expect(observations).toHaveLength(1);
    expect(
      JSON.parse(readFileSync(join(evidence, 'commit-projections', observations[0]), 'utf8')),
    ).toMatchObject({
      status: 'matched',
      reason: 'matched',
      projection: { critiqueId: expect.any(String) },
    });
  });

  it('supports Cursor summary capture but refuses to infer plan mode at Stop', () => {
    const { repo, evidence } = fixture();
    const captured = captureSubagentStop(
      'cursor',
      {
        cwd: repo,
        conversation_id: 'conversation-1',
        generation_id: 'generation-1',
        subagent_type: 'feature-critique',
        status: 'completed',
        summary: cleanResponse,
      },
      repo,
    );
    expect(captured.status).toBe('captured');
    const observed = observePlanStop(
      'cursor',
      {
        cwd: repo,
        conversation_id: 'conversation-1',
        generation_id: 'generation-1',
        composer_mode: 'plan',
        summary: 'final plan',
      },
      repo,
    );
    expect(observed).toMatchObject({
      status: 'skipped',
      reason: 'composer_mode_capability_unavailable',
    });
    expect(
      JSON.parse(
        readFileSync(join(evidence, 'observations', `${observed.observationId}.json`), 'utf8'),
      ),
    ).toMatchObject({
      kind: 'provider_capability_observation',
      capability: 'current_composer_mode_at_stop',
      availability: 'unavailable',
      consumedCaptureIds: [captured.observationId],
    });
  });

  it('links a Codex plan Stop to the eligible critique from its documented turn', () => {
    const { repo, evidence } = fixture();
    const captured = captureSubagentStop(
      'codex',
      {
        cwd: repo,
        turn_id: 'turn-2',
        session_id: 'session-2',
        agent_id: 'agent-2',
        agent_type: 'feature-critique',
        last_assistant_message: cleanResponse,
      },
      repo,
    );
    const observed = observePlanStop(
      'codex',
      {
        cwd: repo,
        turn_id: 'turn-2',
        session_id: 'session-2',
        permission_mode: 'plan',
        last_assistant_message: 'Final decision-complete plan',
      },
      repo,
    );
    expect(observed).toMatchObject({ status: 'observed', reason: 'linked' });
    const observation = JSON.parse(
      readFileSync(join(evidence, 'observations', `${observed.observationId}.json`), 'utf8'),
    );
    expect(observation.critiqueId).toBe(captured.critiqueId);
    expect(observation.finalPlanBlob).toContain('blobs/');
  });

  it('records ambiguity and never mutates reviewer inputs', () => {
    const { repo, evidence } = fixture();
    for (const turn of ['turn-a', 'turn-b']) {
      captureSubagentStop(
        'codex',
        {
          cwd: repo,
          turn_id: turn,
          agent_type: 'feature-critique',
          last_assistant_message: cleanResponse,
        },
        repo,
      );
    }
    expect(resolveEligibleBinding(repo)).toMatchObject({
      status: 'skipped',
      reason: 'ambiguous_matching_bindings',
      candidates: 2,
    });
    const projection = observeCommitProjection(repo);
    const saved = JSON.parse(
      readFileSync(
        join(evidence, 'commit-projections', `${projection.observationId}.json`),
        'utf8',
      ),
    );
    expect(saved.reason).toBe('ambiguous_matching_bindings');
    expect(saved.projection).toBeNull();
  });

  it('uses an explicit work id consistently across provider capture and commit shadow lookup', () => {
    const { repo, evidence } = fixture();
    process.env.DEVKIT_WORK_ID = 'shared-chain-work';
    captureSubagentStop(
      'claude',
      {
        cwd: repo,
        session_id: 'provider-session',
        agent_type: 'feature-critique',
        last_assistant_message: cleanResponse,
      },
      repo,
    );
    const observed = observeCommitProjection(repo);
    expect(observed).toMatchObject({ status: 'observed', reason: 'matched' });
    const saved = JSON.parse(
      readFileSync(join(evidence, 'commit-projections', `${observed.observationId}.json`), 'utf8'),
    );
    expect(saved.status).toBe('matched');
    expect(saved.projection).not.toBeNull();
  });

  it('records two-pass lineage and binds only the eligible fresh recheck', () => {
    const { repo, evidence } = fixture();
    const hook = {
      cwd: repo,
      turn_id: 'turn-recheck',
      agent_type: 'feature-critique',
    };
    const first = captureSubagentStop(
      'codex',
      { ...hook, last_assistant_message: blockedResponse },
      repo,
    );
    const second = captureSubagentStop(
      'codex',
      { ...hook, last_assistant_message: cleanResponse },
      repo,
    );
    expect(first).toMatchObject({ eligible: false });
    expect(second).toMatchObject({ eligible: true });
    const records = readdirSync(join(evidence, 'records'))
      .map((name) => JSON.parse(readFileSync(join(evidence, 'records', name), 'utf8')))
      .sort((a, b) => a.lineage.pass - b.lineage.pass);
    expect(records.map((record) => record.lineage.pass)).toEqual([1, 2]);
    expect(records[1].lineage.parentCritiqueId).toBe(records[0].critiqueId);
    expect(resolveEligibleBinding(repo)).toMatchObject({
      status: 'matched',
      record: { critiqueId: second.critiqueId },
    });
  });

  it('keeps a second-pass abort as benchmark evidence without creating a receipt', () => {
    const { repo, evidence } = fixture();
    const hook = {
      cwd: repo,
      turn_id: 'turn-abort',
      agent_type: 'feature-critique',
    };
    captureSubagentStop('codex', { ...hook, last_assistant_message: blockedResponse }, repo);
    const aborted = JSON.stringify({
      ...JSON.parse(cleanResponse),
      status: 'aborted',
      verdict: null,
      summary: 'The recheck could not complete.',
    });
    captureSubagentStop('codex', { ...hook, last_assistant_message: aborted }, repo);
    expect(readdirSync(join(evidence, 'records'))).toHaveLength(2);
    expect(resolveEligibleBinding(repo)).toMatchObject({
      status: 'skipped',
      reason: 'no_matching_binding',
    });
  });

  it('keeps a third pass as evidence but never makes it receipt-eligible', () => {
    const { repo, evidence } = fixture();
    const hook = {
      cwd: repo,
      turn_id: 'turn-retry-limit',
      agent_type: 'feature-critique',
    };
    captureSubagentStop(
      'codex',
      { ...hook, agent_id: 'first-pass', last_assistant_message: blockedResponse },
      repo,
    );
    captureSubagentStop(
      'codex',
      { ...hook, agent_id: 'second-pass', last_assistant_message: blockedResponse },
      repo,
    );
    const third = captureSubagentStop(
      'codex',
      { ...hook, agent_id: 'third-pass', last_assistant_message: cleanResponse },
      repo,
    );

    expect(third).toMatchObject({
      status: 'captured',
      eligible: false,
      reason: 'retry_limit_exceeded',
    });
    const records = readdirSync(join(evidence, 'records')).map((name) =>
      JSON.parse(readFileSync(join(evidence, 'records', name), 'utf8')),
    );
    expect(records).toHaveLength(3);
    expect(records.find((record) => record.lineage.pass === 3)?.contract).toMatchObject({
      eligible: false,
      eligibilityReason: 'retry_limit_exceeded',
    });
    expect(resolveEligibleBinding(repo)).toMatchObject({
      status: 'skipped',
      reason: 'no_matching_binding',
    });
  });

  it('skips receipts after rewritten ancestry and in detached worktrees', () => {
    const rewritten = fixture();
    captureSubagentStop(
      'codex',
      {
        cwd: rewritten.repo,
        turn_id: 'turn-rewrite',
        agent_type: 'feature-critique',
        last_assistant_message: cleanResponse,
      },
      rewritten.repo,
    );
    writeFileSync(join(rewritten.repo, 'README.md'), 'amended fixture\n');
    execFileSync('git', ['add', 'README.md'], { cwd: rewritten.repo });
    execFileSync('git', ['commit', '--amend', '-qm', 'rewritten fixture'], {
      cwd: rewritten.repo,
    });
    expect(resolveEligibleBinding(rewritten.repo)).toMatchObject({
      status: 'skipped',
      reason: 'ancestry_mismatch',
    });

    const detached = fixture();
    captureSubagentStop(
      'claude',
      {
        cwd: detached.repo,
        session_id: 'session-detached',
        agent_type: 'feature-critique',
        last_assistant_message: cleanResponse,
      },
      detached.repo,
    );
    execFileSync('git', ['checkout', '-q', '--detach'], { cwd: detached.repo });
    expect(resolveEligibleBinding(detached.repo)).toMatchObject({
      status: 'skipped',
      reason: 'detached_worktree',
    });
  });

  it('reports malformed records and failed immutable binding writes without a receipt', () => {
    const malformed = fixture();
    const captured = captureSubagentStop(
      'codex',
      {
        cwd: malformed.repo,
        turn_id: 'turn-malformed',
        agent_type: 'feature-critique',
        last_assistant_message: cleanResponse,
      },
      malformed.repo,
    );
    writeFileSync(
      join(malformed.evidence, 'records', `${captured.critiqueId}.json`),
      JSON.stringify({
        schemaVersion: 1,
        kind: 'plan_critique_record',
        critiqueId: captured.critiqueId,
        workId: 'still-partial',
      }),
    );
    expect(resolveEligibleBinding(malformed.repo)).toMatchObject({
      status: 'skipped',
      reason: 'malformed_record',
    });

    const unwritable = fixture();
    writeFileSync(join(unwritable.repo, '.git', 'devkit'), 'blocks binding directory');
    expect(
      captureSubagentStop(
        'codex',
        {
          cwd: unwritable.repo,
          turn_id: 'turn-unwritable',
          agent_type: 'feature-critique',
          last_assistant_message: cleanResponse,
        },
        unwritable.repo,
      ),
    ).toMatchObject({ status: 'failed' });
    expect(resolveEligibleBinding(unwritable.repo)).toMatchObject({
      status: 'skipped',
      reason: 'no_matching_binding',
    });
    expect(readdirSync(join(unwritable.evidence, 'records'))).toHaveLength(1);
    expect(existsSync(join(unwritable.evidence, 'observations'))).toBe(false);
  });

  it('removes a binding when its capture observation cannot be published', () => {
    const { repo, evidence } = fixture();
    mkdirSync(evidence, { recursive: true });
    writeFileSync(join(evidence, 'observations'), 'blocks observation directory');

    expect(
      captureSubagentStop(
        'codex',
        {
          cwd: repo,
          turn_id: 'turn-observation-failure',
          agent_type: 'feature-critique',
          last_assistant_message: cleanResponse,
        },
        repo,
      ),
    ).toMatchObject({ status: 'failed' });
    expect(readdirSync(join(evidence, 'records'))).toHaveLength(1);
    expect(resolveEligibleBinding(repo)).toMatchObject({
      status: 'skipped',
      reason: 'no_matching_binding',
    });
  });

  it('honors telemetry opt-out without suppressing the visible critique response', () => {
    const { repo, evidence } = fixture();
    process.env.DEVKIT_NO_TELEMETRY = '1';
    expect(
      captureSubagentStop(
        'claude',
        {
          cwd: repo,
          session_id: 'session-1',
          agent_type: 'feature-critique',
          last_assistant_message: cleanResponse,
        },
        repo,
      ),
    ).toMatchObject({ status: 'skipped', reason: 'telemetry_disabled' });
    expect(existsSync(evidence)).toBe(false);
  });

  it('expires optional transcript blobs without deleting immutable records', () => {
    const { evidence } = fixture();
    const transcriptBlob = writeContentBlob('opaque provider transcript', 'transcript');
    persistImmutableJson('records/expired.json', {
      schemaVersion: 1,
      kind: 'plan_critique_record',
      transcriptBlob,
      transcriptExpiresAt: '2020-01-01T00:00:00.000Z',
    });
    expect(pruneExpiredTranscriptBlobs()).toMatchObject({ files: 1 });
    expect(existsSync(join(evidence, transcriptBlob))).toBe(false);
    expect(existsSync(join(evidence, 'records', 'expired.json'))).toBe(true);
  });

  it('preserves every record under concurrent multi-process capture', async () => {
    const { repo, evidence } = fixture();
    const captureUrl = new URL('../capture.mts', import.meta.url).href;
    const runs = Array.from({ length: 6 }, (_, index) => {
      const script = [
        `import { captureSubagentStop } from ${JSON.stringify(captureUrl)};`,
        `const result = captureSubagentStop('codex', ${JSON.stringify({
          cwd: repo,
          turn_id: `concurrent-${index}`,
          agent_type: 'feature-critique',
          last_assistant_message: cleanResponse,
        })}, ${JSON.stringify(repo)});`,
        `if (result.status !== 'captured') { console.error(result.reason); process.exit(1); }`,
      ].join('\n');
      return new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
          cwd: repo,
          env: { ...process.env, DEVKIT_PLAN_CRITIQUE_EVIDENCE_DIR: evidence },
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => (stderr += chunk));
        child.on('error', reject);
        child.on('exit', (code) =>
          code === 0 ? resolve() : reject(new Error(`capture child ${code}: ${stderr}`)),
        );
      });
    });
    await Promise.all(runs);
    expect(readdirSync(join(evidence, 'records'))).toHaveLength(6);
    expect(readdirSync(join(evidence, 'blobs'))).toHaveLength(1);
  });
});
