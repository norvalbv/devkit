import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkpointArtifact, eventLine } from '../history.mts';
import type { RepositorySource } from '../source.mts';
import type { BenchmarkEvent, CheckpointEnvelope } from '../types.mts';

export function memory(files: Record<string, string>): RepositorySource {
  return {
    mode: 'working',
    root: '<memory>',
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

// Pinned so a test can tell "recordedAt came from HEAD's committer date" apart from wall clock.
export const FIXTURE_COMMIT_DATE = '2026-01-02T03:04:05+00:00';

export function deterministicBaseline(k: number, rowId = 'case-1'): string {
  return `${JSON.stringify(
    {
      metrics: [{ id: 'accuracy', label: 'Accuracy', k, n: 10 }],
      rows: { [rowId]: { ok: true } },
      floorsMet: true,
    },
    null,
    2,
  )}\n`;
}

function suite(id: string) {
  return {
    id,
    label: `Suite ${id}`,
    adapter: 'deterministic',
    lifecycle: 'experimental',
    subjectIds: [`subject-${id}`],
    baseline: `${id}/results.baseline.json`,
    hashes: {
      implementation: [`${id}/impl.mts`],
      corpus: [`${id}/cases-*.jsonl`],
      scorer: ['shared/scoring.mts'],
      runner: [`${id}/runner.mts`],
    },
  };
}

/** A minimal repository the tracker accepts: no agents, no discoverable bins, no path matching the
 * benchmark-runner pattern, and both README marker hosts present. */
export function stagedRepo(suiteIds = ['alpha'], options: { commit?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'benchmark-staged-'));
  const run = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: FIXTURE_COMMIT_DATE,
        GIT_COMMITTER_DATE: FIXTURE_COMMIT_DATE,
      },
    });
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  write('package.json', '{}\n');
  write(
    'README.md',
    '# fixture\n\n<!-- benchmark-dashboard:start -->\n<!-- benchmark-dashboard:end -->\n',
  );
  write(
    'docs/benchmarks/README.md',
    '# tracker\n\n<!-- benchmark-details:start -->\n<!-- benchmark-details:end -->\n',
  );
  write('docs/benchmarks/history.jsonl', '');
  write('shared/scoring.mts', 'export const scorer = 1;\n');
  write(
    'docs/benchmarks/catalog.json',
    `${JSON.stringify(
      {
        schemaVersion: 1,
        subjects: suiteIds.map((id) => ({
          id: `subject-${id}`,
          label: `Subject ${id}`,
          kind: 'benchmark',
          lifecycle: 'experimental',
          evidence: 'accepted',
          suiteIds: [id],
        })),
        suites: suiteIds.map(suite),
        singletonJudges: [],
        runnerExclusions: [],
      },
      null,
      2,
    )}\n`,
  );
  for (const id of suiteIds) {
    write(`${id}/impl.mts`, 'export const impl = 1;\n');
    write(`${id}/runner.mts`, 'export const runner = 1;\n');
    write(`${id}/cases-1.jsonl`, '{"id":"case-1"}\n');
    write(`${id}/results.baseline.json`, deterministicBaseline(9));
  }
  run('init', '-q', '-b', 'main');
  run('config', 'user.email', 'fixture@example.com');
  run('config', 'user.name', 'Fixture');
  run('add', '-A');
  if (options.commit !== false) run('commit', '-qm', 'fixture');
  return {
    root,
    git: run,
    write,
    baselinePath: (id: string) => `${id}/results.baseline.json`,
    head: () => run('rev-parse', 'HEAD').trim(),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
