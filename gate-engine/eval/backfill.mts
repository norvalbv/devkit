import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseBaseline } from './adapters.mts';
import { loadCatalog } from './catalog.mts';
import { canonicalJson, sha256 } from './history.mts';
import { gitOutput, repositorySource, suiteHashes } from './source.mts';

const BENCHMARK_COMMIT_RE = /eval|bench|reviewer|sentry|edge-case/i;

function category(subject: string): string {
  const normalized = subject.toLowerCase();
  if (normalized.includes('sentry')) return 'sentry';
  if (normalized.includes('reviewer')) return 'reviewer';
  if (normalized.includes('edge-case')) return 'edge-cases';
  if (normalized.includes('eval')) return 'evaluation';
  return 'benchmark';
}

export function backfill(cwd: string, since = '2026-07-01', localLogPaths: string[] = []): void {
  const log = gitOutput(cwd, [
    'log',
    '--all',
    `--since=${since}`,
    '--format=%H%x09%cI%x09%s',
    '--',
    'gate-engine',
    'README.md',
    'docs',
  ]);
  const commits = log
    .split('\n')
    .filter((line) => BENCHMARK_COMMIT_RE.test(line))
    .map((line) => {
      const [commit, recordedAt, subject] = line.split('\t');
      return {
        commit,
        recordedAt,
        category: category(subject),
        provenance: 'git-aggregate-candidate',
      };
    });
  const catalog = loadCatalog(repositorySource(cwd, 'working'));
  const seen = new Set<string>();
  const candidates: Array<Record<string, unknown>> = [];
  let aggregateRejected = 0;
  for (const commit of commits) {
    const source = repositorySource(cwd, 'tree', commit.commit);
    for (const suite of catalog.suites) {
      if (!suite.baseline) continue;
      const baselineRaw = source.read(suite.baseline);
      if (!baselineRaw) continue;
      try {
        const baseline = parseBaseline(suite.adapter, JSON.parse(baselineRaw));
        const evidenceDigest = sha256(
          canonicalJson({
            acceptance: baseline.acceptance,
            adapter: suite.adapter,
            metrics: baseline.metrics,
            rows: baseline.rows,
            suiteId: suite.id,
          }),
        );
        const hashes = suiteHashes(source, suite.hashes);
        const key = `${evidenceDigest}:${hashes.implementation}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({
          commit: commit.commit,
          recordedAt: commit.recordedAt,
          category: commit.category,
          provenance: commit.provenance,
          suiteId: suite.id,
          evidenceDigest: `sha256:${evidenceDigest}`,
          implementationHash: hashes.implementation,
          acceptedByAdapter: baseline.acceptance.accepted,
          rowCount: Object.keys(baseline.rows).length,
          metrics: baseline.metrics,
        });
      } catch {
        aggregateRejected += 1;
      }
    }
  }
  const localLogs = localLogPaths.map((path, index) => {
    const absolute = resolve(cwd, path);
    if (!absolute.startsWith(`${resolve(cwd)}/`) || !existsSync(absolute))
      return { source: index + 1, rows: 0, rejected: true };
    return {
      source: index + 1,
      rows: readFileSync(absolute, 'utf8').split('\n').filter(Boolean).length,
      rejected: false,
    };
  });
  console.log(
    JSON.stringify(
      {
        schemaVersion: 1,
        since,
        candidateOnly: true,
        candidates,
        scannedCommitCount: commits.length,
        aggregateRejected,
        localAggregates: localLogs,
        privacyRejected: localLogs.filter((item) => item.rejected).length,
      },
      null,
      2,
    ),
  );
}
