import { checkpointArtifact, eventLine } from '../history.mts';
import type { RepositorySource } from '../source.mts';
import type { BenchmarkEvent, CheckpointEnvelope } from '../types.mts';

export function memory(files: Record<string, string>): RepositorySource {
  return {
    mode: 'working',
    listFiles: () => Object.keys(files).sort(),
    read: (path) => files[path] ?? null,
  };
}

export function readableSnapshot(source: RepositorySource): Record<string, string> {
  const files: Record<string, string> = {};
  for (const path of source.listFiles()) {
    try {
      const content = source.read(path);
      if (content !== null) files[path] = content;
    } catch (error) {
      if ((error as Error).message.startsWith('Path escapes repository:')) continue;
      throw error;
    }
  }
  return files;
}

export function trackerFixture() {
  const checkpoint: CheckpointEnvelope = {
    schemaVersion: 1,
    suiteId: 'suite',
    capturedAt: '2026-07-01T00:00:00Z',
    sourceCommit: 'a'.repeat(40),
    adapter: 'critique',
    hashes: {
      implementation: `sha256:${'1'.repeat(64)}`,
      corpus: `sha256:${'2'.repeat(64)}`,
      scorer: `sha256:${'3'.repeat(64)}`,
      runner: `sha256:${'4'.repeat(64)}`,
    },
    metrics: [],
    comparisons: [],
    rows: { row: { ok: true } },
    acceptance: { accepted: true, reason: 'test' },
  };
  const artifact = checkpointArtifact(checkpoint);
  const event: BenchmarkEvent = {
    schemaVersion: 1,
    id: 'evt-test',
    recordedAt: checkpoint.capturedAt,
    suiteId: checkpoint.suiteId,
    subjectIds: ['subject'],
    lifecycle: 'shipped',
    evidence: 'accepted',
    freshness: 'current',
    changeType: 'quality',
    assessment: 'flat',
    provenance: { tier: 'accepted', source: 'test', sourceCommit: checkpoint.sourceCommit },
    hashes: checkpoint.hashes,
    checkpoint: { sha256: artifact.sha256, path: artifact.path },
    metrics: [],
    comparisons: [],
    note: 'test',
  };
  return { checkpoint, artifact, event, line: eventLine(event) };
}
