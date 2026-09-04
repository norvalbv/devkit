import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { baselinePublicationErrors, loadCatalog, validateCatalog } from '../catalog.mts';
import {
  aggregateMetricAssessment,
  comparisons,
  defaultPredecessor,
  metricAssessment,
  publishLocked,
  reconcileLedgers,
  withCheckConsistency,
} from '../cli.mts';
import {
  activeEvents,
  appendPublishedEvent,
  canonicalJson,
  COMMITTED_PROVENANCE,
  eventLine,
  immutableErrors,
  latestRecordedEvent,
  publicationErrors,
  STAGED_PROVENANCE,
  validateHistory,
  withPublishLock,
} from '../history.mts';
import { generatedOutputs, latestEvents, replaceMarker } from '../render.mts';
import type { RepositorySource } from '../source.mts';
import {
  assertCleanPublishWorktree,
  assertIndexUnchanged,
  repositorySource,
  stagedIndexIdentity,
} from '../source.mts';
import type { BenchmarkEvent, CheckpointEnvelope, MetricObservation } from '../types.mts';
import {
  deterministicBaseline,
  FIXTURE_COMMIT_DATE,
  trackerFixture as fixture,
  memory,
  readableSnapshot,
  stagedRepo,
} from './tracker-fixtures.mts';

const ROOT = join(import.meta.dirname, '..', '..', '..');

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

describe('immutable evidence', () => {
  it('canonicalizes checkpoint content and validates its content address', () => {
    const { artifact, line } = fixture();
    const source = memory({
      'docs/benchmarks/history.jsonl': `${line}\n`,
      [artifact.path]: artifact.content,
    });
    expect(validateHistory(source)).toEqual([]);
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{\n  "a": 2,\n  "b": 1\n}\n');
  });

  it('detects duplicate IDs, checkpoint mutation, deletion, and privacy leaks', () => {
    const { artifact, event, line } = fixture();
    const duplicate = memory({
      'docs/benchmarks/history.jsonl': `${line}\n${line}\n`,
      [artifact.path]: `${artifact.content} `,
    });
    expect(validateHistory(duplicate).join('\n')).toMatch(/Duplicate event id|digest mismatch/);

    const leaked = { ...event, id: 'evt-leak', note: '/Users/person/private.txt' };
    expect(
      validateHistory(
        memory({
          'docs/benchmarks/history.jsonl': `${JSON.stringify(leaked)}\n`,
          [artifact.path]: artifact.content,
        }),
      ).join('\n'),
    ).toMatch(/absolute path/);

    const base = memory({
      'docs/benchmarks/history.jsonl': `${line}\n`,
      [artifact.path]: artifact.content,
    });
    const current = memory({ 'docs/benchmarks/history.jsonl': '', [artifact.path]: 'changed' });
    expect(immutableErrors(current, base).join('\n')).toMatch(/changed or deleted|mutated/);
  });

  it('binds accepted event metrics and hashes to checkpoint content', () => {
    const { artifact, event } = fixture();
    const contradictory = {
      ...event,
      id: 'evt-contradictory',
      hashes: { ...event.hashes, runner: `sha256:${'9'.repeat(64)}` },
      metrics: [
        {
          id: 'invented',
          label: 'Invented score',
          value: 1,
          unit: 'ratio',
          direction: 'higher',
          inferenceUnit: 'row',
        },
      ],
    };
    const errors = validateHistory(
      memory({
        'docs/benchmarks/history.jsonl': `${JSON.stringify(contradictory)}\n`,
        [artifact.path]: artifact.content,
      }),
    ).join('\n');
    expect(errors).toContain('event hashes do not match checkpoint');
    expect(errors).toContain('event metrics do not match checkpoint');
  });

  it('requires accepted commit provenance and exact checkpoint capture time', () => {
    const { artifact, event } = fixture();
    const unbound = {
      ...event,
      recordedAt: '2026-07-02T00:00:00Z',
      provenance: { tier: 'accepted', source: 'test' },
    };
    const errors = validateHistory(
      memory({
        'docs/benchmarks/history.jsonl': `${JSON.stringify(unbound)}\n`,
        [artifact.path]: artifact.content,
      }),
    ).join('\n');
    expect(errors).toContain('accepted event requires accepted commit provenance');
    expect(errors).toContain('event source commit does not match checkpoint');
    expect(errors).toContain('event recordedAt does not match checkpoint capturedAt');
  });

  it('rejects malformed status values and private evidence fields', () => {
    const { event } = fixture();
    const malformed = {
      ...event,
      id: 'evt-malformed',
      evidence: 'evidence-only',
      lifecycle: 'launched',
      checkpoint: undefined,
      prompt: 'private benchmark prompt',
    };
    const errors = validateHistory(
      memory({ 'docs/benchmarks/history.jsonl': `${JSON.stringify(malformed)}\n` }),
    ).join('\n');
    expect(errors).toContain('invalid lifecycle');
    expect(errors).toContain('forbidden private field');
  });

  it('fails a concurrent publish instead of losing an append', () => {
    const root = mkdtempSync(join(tmpdir(), 'benchmark-publish-'));
    try {
      mkdirSync(join(root, 'docs/benchmarks'), { recursive: true });
      writeFileSync(join(root, 'docs/benchmarks/.publish.lock'), 'occupied', { mode: 0o600 });
      const { artifact, event } = fixture();
      expect(() => appendPublishedEvent(root, event, artifact)).toThrow(/publish is in progress/);
      writeFileSync(
        join(root, 'docs/benchmarks/.publish.lock'),
        JSON.stringify({ pid: 2_147_483_647 }),
      );
      appendPublishedEvent(root, event, artifact);
      expect(readFileSync(join(root, 'docs/benchmarks/history.jsonl'), 'utf8')).toContain(event.id);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps predecessor selection and append inside one publication lock', () => {
    const root = mkdtempSync(join(tmpdir(), 'benchmark-publish-scope-'));
    try {
      const { artifact, event } = fixture();
      withPublishLock(root, (append) => {
        expect(() => appendPublishedEvent(root, event, artifact)).toThrow(/publish is in progress/);
        append(event, artifact);
      });
      expect(readFileSync(join(root, 'docs/benchmarks/history.jsonl'), 'utf8')).toContain(event.id);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts a clean linked worktree while holding the publish lock and names real dirt', () => {
    const parent = mkdtempSync(join(tmpdir(), 'benchmark-publish-worktree-'));
    const root = join(parent, 'repo');
    const linked = join(parent, 'linked');
    try {
      mkdirSync(root);
      git(root, 'init', '-q', '-b', 'main');
      git(root, 'config', 'user.email', 'tracker@example.invalid');
      git(root, 'config', 'user.name', 'Tracker Test');
      writeFileSync(join(root, 'tracked.txt'), 'base\n');
      git(root, 'add', 'tracked.txt');
      git(root, 'commit', '-qm', 'base');
      git(root, 'worktree', 'add', '-q', '-b', 'publish-regression', linked, 'HEAD');

      withPublishLock(linked, () => expect(() => assertCleanPublishWorktree(linked)).not.toThrow());
      writeFileSync(join(linked, 'docs/benchmarks/.publish.lock.backup'), 'not internal\n');
      writeFileSync(join(linked, 'dirty.txt'), 'dirty\n');
      withPublishLock(linked, () => {
        expect(() => assertCleanPublishWorktree(linked)).toThrow(/\?\? dirty\.txt/);
        expect(() => assertCleanPublishWorktree(linked)).toThrow(/\.publish\.lock\.backup/);
      });
    } finally {
      if (git(root, 'worktree', 'list', '--porcelain').includes(linked))
        git(root, 'worktree', 'remove', '--force', linked);
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('serializes working checks while immutable snapshot checks remain independent', () => {
    const root = mkdtempSync(join(tmpdir(), 'benchmark-check-lock-'));
    try {
      withPublishLock(root, () => {
        expect(() => withCheckConsistency(root, 'working', () => 'working')).toThrow(
          /publish is in progress/,
        );
        expect(withCheckConsistency(root, 'staged', () => 'staged')).toBe('staged');
        expect(withCheckConsistency(root, 'tree', () => 'tree')).toBe('tree');
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('selects the newest predecessor by instant rather than append order', () => {
    const { event } = fixture();
    const newer: BenchmarkEvent = {
      ...event,
      id: 'evt-newer',
      recordedAt: '2026-06-30T23:30:00Z',
    };
    const olderBackfill: BenchmarkEvent = {
      ...event,
      id: 'evt-older-backfill',
      recordedAt: '2026-07-01T01:00:00+02:00',
    };
    const newerReported: BenchmarkEvent = {
      ...newer,
      id: 'evt-newer-reported',
      recordedAt: '2026-07-02T00:00:00Z',
      evidence: 'evidence-only',
      provenance: { tier: 'reported', source: 'test' },
      checkpoint: undefined,
    };
    expect(latestRecordedEvent([newer, olderBackfill])?.id).toBe(newer.id);
    expect(defaultPredecessor([newer, olderBackfill, newerReported], event.suiteId)?.id).toBe(
      newer.id,
    );
  });

  it('uses the same event-id tie break for predecessors and rendered suite state', () => {
    const { event } = fixture();
    const lowerId = { ...event, id: 'evt-a' };
    const higherId = { ...event, id: 'evt-z' };
    expect(latestRecordedEvent([higherId, lowerId])?.id).toBe(higherId.id);
    expect(latestEvents([higherId, lowerId]).get(event.suiteId)?.id).toBe(higherId.id);
    expect(defaultPredecessor([higherId, lowerId], event.suiteId)?.id).toBe(higherId.id);
  });

  it('serializes canonical reconciliation with publication while leaving custom outputs independent', () => {
    const root = mkdtempSync(join(tmpdir(), 'benchmark-reconcile-lock-'));
    try {
      mkdirSync(join(root, 'docs/benchmarks'), { recursive: true });
      const first = join(root, 'first.jsonl');
      const second = join(root, 'second.jsonl');
      const custom = join(root, 'merged.jsonl');
      const { event } = fixture();
      writeFileSync(first, `${eventLine({ ...event, id: 'evt-first' })}\n`);
      writeFileSync(
        second,
        `${eventLine({
          ...event,
          id: 'evt-second',
          recordedAt: '2026-07-02T00:00:00Z',
        })}\n`,
      );
      withPublishLock(root, () => {
        expect(() =>
          reconcileLedgers(root, [first, second], join(root, 'docs/benchmarks/history.jsonl')),
        ).toThrow(/publish is in progress/);
        reconcileLedgers(root, [first, second], custom);
      });
      expect(readFileSync(custom, 'utf8')).toContain('evt-second');
      reconcileLedgers(root, [first, second], join(root, 'docs/benchmarks/history.jsonl'));
      expect(readFileSync(join(root, 'docs/benchmarks/history.jsonl'), 'utf8')).toContain(
        'evt-second',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps append-only corrections authoritative without deleting superseded bytes', () => {
    const { event } = fixture();
    const correction = {
      ...event,
      id: 'evt-correction',
      recordedAt: '2026-07-02T00:00:00Z',
      supersedes: event.id,
    };
    expect(activeEvents([event, correction])).toEqual([correction]);
  });
});

describe('comparison semantics', () => {
  const metric = (value: number, direction: MetricObservation['direction']): MetricObservation => ({
    id: 'metric',
    label: 'Metric',
    value,
    unit: 'ratio',
    direction,
    inferenceUnit: 'row',
  });

  it('assesses higher, lower, flat, and target-directed metrics', () => {
    expect(metricAssessment(metric(0.5, 'higher'), metric(0.6, 'higher'))).toBe('improved');
    expect(metricAssessment(metric(0.5, 'lower'), metric(0.6, 'lower'))).toBe('regressed');
    expect(metricAssessment(metric(0.5, 'higher'), metric(0.5, 'higher'))).toBe('flat');
    expect(metricAssessment(metric(0.5, 'target'), metric(0.6, 'target'))).toBe('unknown');
    expect(
      metricAssessment(metric(0.5, 'higher'), { ...metric(0.51, 'higher'), noiseFloor: 0.02 }),
    ).toBe('flat');

    expect(
      aggregateMetricAssessment([
        { ...metric(0.6, 'higher'), assessment: 'improved' },
        { ...metric(0.4, 'higher'), assessment: 'regressed' },
      ]),
    ).toBe('mixed');
  });

  it('separates methodology resets, coverage growth, and discordant quality flips', () => {
    const { checkpoint, event } = fixture();
    const predecessor = {
      ...checkpoint,
      rows: { a: { ok: false }, b: { ok: true }, priorOnly: { ok: true } },
    };
    const current = { a: { ok: true }, b: { ok: false }, currentOnly: { ok: true } };
    expect(
      comparisons(event, predecessor, current, 'methodology-reset', 'unknown')[0],
    ).toMatchObject({ verdict: 'not-comparable' });
    expect(comparisons(event, predecessor, current, 'coverage', 'flat')[0]).toMatchObject({
      sharedRows: 2,
      positiveDiscordant: 1,
      negativeDiscordant: 1,
      verdict: 'mixed',
    });
    expect(
      comparisons(event, predecessor, { a: { ok: false }, b: { ok: true } }, 'coverage', 'flat')[0],
    ).toMatchObject({ sharedRows: 2, verdict: 'coverage-only' });
    expect(
      comparisons(event, predecessor, { z: { ok: true } }, 'coverage', 'flat')[0],
    ).toMatchObject({
      sharedRows: 0,
      verdict: 'unknown',
      note: 'No shared row outcomes; quality is not comparable',
    });
    expect(comparisons(event, predecessor, current, 'quality', 'mixed')[0]).toMatchObject({
      sharedRows: 2,
      positiveDiscordant: 1,
      negativeDiscordant: 1,
      verdict: 'mixed',
    });
    expect(
      comparisons(
        event,
        predecessor,
        { a: { ok: false }, b: { ok: false } },
        'quality',
        'improved',
      )[0],
    ).toMatchObject({ negativeDiscordant: 1, verdict: 'mixed' });
  });
});

describe('catalog load failures name what actually happened', () => {
  it('does not call a present-but-empty catalog missing', () => {
    expect(() => loadCatalog(memory({ 'docs/benchmarks/catalog.json': '' }))).toThrow(/empty/i);
    expect(() => loadCatalog(memory({ 'docs/benchmarks/catalog.json': '' }))).not.toThrow(
      /Missing/,
    );
  });

  it('says which snapshot it searched when the catalog is genuinely absent', () => {
    expect(() => loadCatalog(memory({}))).toThrow(/Missing docs\/benchmarks\/catalog\.json/);
    expect(() => loadCatalog(memory({}))).not.toThrow(/undefined/);
  });
});

describe('catalog and generated views', () => {
  it('covers all canonical agents, bins, reviewers, singleton judges, and eval runners', () => {
    const source = repositorySource(ROOT, 'working');
    const catalog = loadCatalog(source);
    expect(validateCatalog(source, catalog)).toEqual([]);
    const decisions = catalog.suites.find((suite) => suite.id === 'decisions');
    expect(decisions?.hashes.scorer).toEqual(
      expect.arrayContaining([
        'gate-engine/decisions/eval/acceptance.mts',
        'gate-engine/eval/statistics.mts',
      ]),
    );
    expect(decisions?.hashes.runner).toEqual(
      expect.arrayContaining([
        'gate-engine/decisions/eval/acceptance.mts',
        'gate-engine/eval/statistics.mts',
        'gate-engine/decisions/decisions.mts',
        'gate-engine/config.mts',
      ]),
    );
  });

  it('reports a precise missing canonical subject and orphan runner', () => {
    const source = repositorySource(ROOT, 'working');
    const catalog = loadCatalog(source);
    const files = readableSnapshot(source);
    files['agents/new-reviewer.md'] = '# new';
    files['gate-engine/new/eval/bench.mts'] = '';
    const errors = validateCatalog(memory(files), catalog).join('\n');
    expect(errors).toContain('Missing canonical agent subject: agents/new-reviewer.md');
    expect(errors).toContain('Orphan benchmark runner: gate-engine/new/eval/bench.mts');
  });

  it('rejects an accepted baseline replacement that was not published', () => {
    const source = repositorySource(ROOT, 'working');
    const catalog = loadCatalog(source);
    const history = (source.read('docs/benchmarks/history.jsonl') ?? '')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as BenchmarkEvent);
    const baselinePath = 'gate-engine/critique/eval/results.baseline.json';
    const baseline = JSON.parse(source.read(baselinePath) ?? '') as {
      critique: { recall: { hits: number } };
    };
    baseline.critique.recall.hits -= 1;
    const changed: RepositorySource = {
      ...source,
      read: (path) => (path === baselinePath ? JSON.stringify(baseline) : source.read(path)),
    };
    expect(baselinePublicationErrors(changed, catalog, history)).toEqual([
      `Accepted baseline changed without publication: ${baselinePath}`,
    ]);
  });

  it('renders deterministic, theme-parity SVGs and preserves text outside markers', () => {
    const source = repositorySource(ROOT, 'working');
    const catalog = loadCatalog(source);
    const history = (source.read('docs/benchmarks/history.jsonl') ?? '')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as BenchmarkEvent);
    const first = generatedOutputs(source, catalog, history);
    const virtual = memory({
      ...readableSnapshot(source),
      ...first,
    });
    expect(generatedOutputs(virtual, catalog, history)).toEqual(first);
    const currentGrammar = first['README.md'].match(/(\d+) (is|are) current/);
    expect(currentGrammar?.[2]).toBe(currentGrammar?.[1] === '1' ? 'is' : 'are');
    expect(first['docs/benchmarks/assets/dashboard-light.svg']).toContain('role="img"');
    expect(first['docs/benchmarks/assets/dashboard-dark.svg']).toContain('<desc id="desc">');
    expect(first['docs/benchmarks/assets/dashboard-light.svg']).toContain('…</text></g>');
    expect(
      first['docs/benchmarks/assets/dashboard-light.svg'].match(/<g transform=/g)?.length,
    ).toBe(first['docs/benchmarks/assets/dashboard-dark.svg'].match(/<g transform=/g)?.length);
    expect(
      replaceMarker(
        'before\n<!-- x -->old<!-- y -->\nafter',
        '<!-- x -->',
        '<!-- y -->',
        '<!-- x -->new<!-- y -->',
      ),
    ).toBe('before\n<!-- x -->new<!-- y -->\nafter');

    const acceptedCritique = history.find(
      (event) => event.suiteId === 'critique' && event.evidence === 'accepted',
    );
    if (!acceptedCritique) throw new Error('missing accepted critique fixture');
    const lowerProvenance: BenchmarkEvent = {
      ...acceptedCritique,
      id: 'evt-shadow-reported',
      recordedAt: '2099-01-01T00:00:00Z',
      evidence: 'evidence-only',
      freshness: 'unknown',
      provenance: { tier: 'reported', source: 'test' },
      checkpoint: undefined,
      hashes: undefined,
      metrics: [
        {
          id: 'shadow',
          label: 'Shadow metric',
          value: 0,
          unit: 'ratio',
          direction: 'higher',
          inferenceUnit: 'row',
        },
      ],
      note: '<script>|line\nnext',
    };
    const preferred = generatedOutputs(source, catalog, [...history, lowerProvenance]);
    expect(preferred['README.md']).not.toContain('Shadow metric');
    expect(preferred['README.md']).toContain('Gold finding recall');
    expect(preferred['docs/benchmarks/README.md']).toContain('&lt;script&gt;&#124;line next');

    const olderOffset: BenchmarkEvent = {
      ...acceptedCritique,
      id: 'evt-offset-older',
      recordedAt: '2026-07-01T01:00:00+02:00',
      metrics: [{ ...acceptedCritique.metrics[0], label: 'Older offset metric' }],
    };
    const newerUtc: BenchmarkEvent = {
      ...acceptedCritique,
      id: 'evt-offset-newer',
      recordedAt: '2026-06-30T23:30:00Z',
      metrics: [{ ...acceptedCritique.metrics[0], label: 'Newer UTC metric' }],
    };
    const offsetPreferred = generatedOutputs(source, catalog, [olderOffset, newerUtc]);
    expect(offsetPreferred['README.md']).toContain('Newer UTC metric');
    expect(offsetPreferred['README.md']).not.toContain('Older offset metric');
  });

  it('keeps every cohort of a reviewer suite in the text alternative', () => {
    const source = repositorySource(ROOT, 'working');
    const catalog = loadCatalog(source);
    const history = (source.read('docs/benchmarks/history.jsonl') ?? '')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as BenchmarkEvent);
    const template = history.find((event) => event.evidence === 'accepted');
    if (!template) throw new Error('missing accepted fixture event');
    const cohortMetric = (section: string, suffix: string, label: string): MetricObservation => ({
      id: `${section}:${suffix}`,
      label: `${section} ${label}`,
      value: 1,
      unit: 'ratio',
      direction: 'higher',
      numerator: 9,
      denominator: 9,
      inferenceUnit: 'row',
    });
    // A re-bench at another model MERGES into the shared baseline, so one reviewer's suite can
    // publish two cohorts at once. Neither may be truncated out of the tables.
    const reviewer: BenchmarkEvent = {
      ...template,
      id: 'evt-reviewer-cohorts',
      suiteId: 'reviewer-frontend-security',
      recordedAt: '2099-01-02T00:00:00Z',
      metrics: [
        cohortMetric(
          'frontend-security-reviewer@haiku@cascade-on',
          'first-fail-recall',
          'first-pass FAIL recall',
        ),
        cohortMetric('frontend-security-reviewer@haiku@cascade-on', 'clean-pass', 'clean pass'),
        cohortMetric(
          'frontend-security-reviewer@sonnet@cascade-on',
          'first-fail-recall',
          'first-pass FAIL recall',
        ),
        cohortMetric('frontend-security-reviewer@sonnet@cascade-on', 'clean-pass', 'clean pass'),
      ],
    };
    const outputs = generatedOutputs(source, catalog, [...history, reviewer]);
    const readme = outputs['README.md'];
    const row = readme.split('\n').find((line) => line.startsWith('| Frontend security reviewer '));
    expect(row).toBeDefined();
    // Both cohorts, tagged, with every metric each carries — nothing sliced away.
    expect(row).toContain('haiku/cascade-on');
    expect(row).toContain('sonnet/cascade-on');
    expect(row).toContain('first-pass FAIL recall: 9/9 (100.0%)');
    expect(row).toContain('clean pass: 9/9 (100.0%)');
    // The namespacing key itself is noise once the cohort is named.
    expect(row).not.toContain('frontend-security-reviewer@haiku');
    // The graphic summarises, but must admit the cohorts it does not show.
    expect(outputs['docs/benchmarks/assets/dashboard-light.svg']).toContain('+1 more cohorts');
    // A suite with no cohort structure keeps its two-metric headline.
    expect(readme.split('\n').find((line) => line.startsWith('| Feature critique '))).toContain(
      'Gold finding recall',
    );
  });
});

function readCheckpointFile(root: string, path: string): CheckpointEnvelope {
  return JSON.parse(readFileSync(join(root, path), 'utf8'));
}

describe('publishing from the Git index', () => {
  const publishInRepo = (root: string, args: string[]): BenchmarkEvent => {
    let published: BenchmarkEvent | undefined;
    withPublishLock(root, (append) =>
      publishLocked(root, args, (event, checkpoint) => {
        published = event;
        append(event, checkpoint);
      }),
    );
    if (!published) throw new Error('publish returned no event');
    return published;
  };
  const staged = (suite: string) => ['--suite', suite, '--tree', 'STAGED'];
  const cli = (root: string, args: string[]) =>
    execFileSync('bun', [join(ROOT, 'gate-engine/eval/cli.mts'), ...args], {
      cwd: root,
      encoding: 'utf8',
    });

  it('publishes the staged bytes, not the worktree and not HEAD', () => {
    const repo = stagedRepo();
    try {
      repo.write('alpha/results.baseline.json', deterministicBaseline(8));
      repo.git('add', 'alpha/results.baseline.json');
      repo.write('alpha/results.baseline.json', deterministicBaseline(7));
      const event = publishInRepo(repo.root, staged('alpha'));
      expect(event.metrics[0]?.value).toBe(0.8);
    } finally {
      repo.cleanup();
    }
  });

  it('reads the catalog from the index, so a staged-only suite can publish', () => {
    const repo = stagedRepo();
    try {
      const catalog = JSON.parse(
        readFileSync(join(repo.root, 'docs/benchmarks/catalog.json'), 'utf8'),
      );
      catalog.subjects.push({
        id: 'subject-beta',
        label: 'Subject beta',
        kind: 'benchmark',
        lifecycle: 'experimental',
        evidence: 'accepted',
        suiteIds: ['beta'],
      });
      catalog.suites.push({
        ...catalog.suites[0],
        id: 'beta',
        label: 'Suite beta',
        subjectIds: ['subject-beta'],
        baseline: 'beta/results.baseline.json',
        hashes: {
          implementation: ['beta/impl.mts'],
          corpus: ['beta/cases-*.jsonl'],
          scorer: ['shared/scoring.mts'],
          runner: ['beta/runner.mts'],
        },
      });
      repo.write('docs/benchmarks/catalog.json', `${JSON.stringify(catalog, null, 2)}\n`);
      repo.write('beta/impl.mts', 'export const impl = 2;\n');
      repo.write('beta/runner.mts', 'export const runner = 2;\n');
      repo.write('beta/cases-1.jsonl', '{"id":"case-1"}\n');
      repo.write('beta/results.baseline.json', deterministicBaseline(6));
      repo.git('add', '-A');
      const event = publishInRepo(repo.root, staged('beta'));
      expect(event.suiteId).toBe('beta');
      expect(event.metrics[0]?.value).toBe(0.6);
    } finally {
      repo.cleanup();
    }
  });

  it('names the parent commit as provenance and says so in the event', () => {
    const repo = stagedRepo();
    try {
      repo.write('alpha/results.baseline.json', deterministicBaseline(8));
      repo.git('add', '-A');
      const event = publishInRepo(repo.root, staged('alpha'));
      expect(event.provenance.sourceCommit).toBe(repo.head());
      expect(event.provenance.sourceCommit).toMatch(/^[a-f0-9]{40}$/);
      expect(event.provenance.source).toBe(STAGED_PROVENANCE);
      const envelope = readCheckpointFile(repo.root, event.checkpoint?.path ?? '');
      expect(publicationErrors(event, envelope)).toEqual([]);
    } finally {
      repo.cleanup();
    }
  });

  it('stamps wall-clock capture time unless --recorded-at pins it', () => {
    const repo = stagedRepo();
    try {
      repo.write('alpha/results.baseline.json', deterministicBaseline(8));
      repo.git('add', '-A');
      const event = publishInRepo(repo.root, staged('alpha'));
      expect(Date.parse(event.recordedAt)).toBeGreaterThan(Date.parse(FIXTURE_COMMIT_DATE));
      expect(Math.abs(Date.now() - Date.parse(event.recordedAt))).toBeLessThan(60_000);

      repo.git('add', '-A');
      repo.write('alpha/results.baseline.json', deterministicBaseline(7));
      repo.git('add', '-A');
      const pinned = publishInRepo(repo.root, [
        ...staged('alpha'),
        '--recorded-at',
        '2026-05-06T07:08:09Z',
      ]);
      expect(pinned.recordedAt).toBe('2026-05-06T07:08:09.000Z');
      const envelope = readCheckpointFile(repo.root, pinned.checkpoint?.path ?? '');
      expect(envelope.capturedAt).toBe(pinned.recordedAt);
    } finally {
      repo.cleanup();
    }
  });

  it('names the git add remedy when the requested baseline is not staged', () => {
    const repo = stagedRepo();
    try {
      repo.write('alpha/extra.baseline.json', deterministicBaseline(8));
      repo.write('alpha/impl.mts', 'export const impl = 2;\n');
      repo.git('add', 'alpha/impl.mts');
      expect(() =>
        publishInRepo(repo.root, [...staged('alpha'), '--baseline', 'alpha/extra.baseline.json']),
      ).toThrow(/stage it with: git add alpha\/extra\.baseline\.json/);
    } finally {
      repo.cleanup();
    }
  });

  it('refuses when nothing is staged', () => {
    const repo = stagedRepo();
    try {
      expect(() => publishInRepo(repo.root, staged('alpha'))).toThrow(/Nothing is staged/);
    } finally {
      repo.cleanup();
    }
  });

  it('refuses an unmerged index by naming the conflict', () => {
    const repo = stagedRepo();
    try {
      repo.git('checkout', '-q', '-b', 'side');
      repo.write('alpha/results.baseline.json', deterministicBaseline(8));
      repo.git('commit', '-qam', 'side');
      repo.git('checkout', '-q', 'main');
      repo.write('alpha/results.baseline.json', deterministicBaseline(7));
      repo.git('commit', '-qam', 'main');
      try {
        repo.git('merge', 'side');
      } catch {
        // The conflict is the point of the fixture; git exits non-zero when it leaves stages behind.
      }
      expect(() => publishInRepo(repo.root, staged('alpha'))).toThrow(
        /unmerged paths:[\s\S]*alpha\/results\.baseline\.json/,
      );
    } finally {
      repo.cleanup();
    }
  });

  it('refuses a ledger the index does not carry, and accepts it once staged', () => {
    const repo = stagedRepo(['alpha', 'beta']);
    try {
      repo.write('alpha/results.baseline.json', deterministicBaseline(8));
      repo.write('beta/results.baseline.json', deterministicBaseline(7));
      repo.git('add', '-A');
      publishInRepo(repo.root, staged('alpha'));
      expect(() => publishInRepo(repo.root, staged('beta'))).toThrow(/ledger to match the index/);
      repo.git('add', '-A');
      expect(publishInRepo(repo.root, staged('beta')).suiteId).toBe('beta');
    } finally {
      repo.cleanup();
    }
  });

  it('tracks the index identity so a concurrent stage cannot be published silently', () => {
    const repo = stagedRepo();
    try {
      repo.write('alpha/results.baseline.json', deterministicBaseline(8));
      repo.git('add', '-A');
      const first = stagedIndexIdentity(repo.root);
      expect(stagedIndexIdentity(repo.root)).toBe(first);
      repo.write('alpha/impl.mts', 'export const impl = 3;\n');
      repo.git('add', '-A');
      expect(stagedIndexIdentity(repo.root)).not.toBe(first);
      expect(() => assertIndexUnchanged(repo.root, first)).toThrow(
        /index changed during publication/,
      );
    } finally {
      repo.cleanup();
    }
  });

  it('leaves committed-tree and clean-worktree publication unchanged', () => {
    const repo = stagedRepo();
    try {
      const fromTree = publishInRepo(repo.root, ['--suite', 'alpha', '--tree', 'HEAD']);
      expect(fromTree.provenance.source).toBe(COMMITTED_PROVENANCE);
      expect(fromTree.recordedAt).toBe(new Date(FIXTURE_COMMIT_DATE).toISOString());
      expect(fromTree.provenance.sourceCommit).toBe(repo.head());
      expect(() => publishInRepo(repo.root, ['--suite', 'alpha', '--tree', 'WORKTREE'])).toThrow(
        /completely clean working tree/,
      );
    } finally {
      repo.cleanup();
    }
  });

  it('passes the staged check end to end, with no bypass, then the committed tree', () => {
    const repo = stagedRepo(['alpha', 'beta']);
    try {
      // A repository whose generated views have never been rendered is stale before any of this;
      // render once so the sequence below starts from the state a real checkout is in.
      cli(repo.root, ['render']);
      repo.git('add', '-A');
      repo.git('commit', '-qm', 'render views');

      // First acceptance for both suites, each published from the index and staged with its outputs.
      repo.write('alpha/results.baseline.json', deterministicBaseline(8));
      repo.git('add', '-A');
      cli(repo.root, ['publish', '--suite', 'alpha', '--tree', 'STAGED']);
      repo.git('add', '-A');
      repo.write('beta/results.baseline.json', deterministicBaseline(6));
      repo.git('add', '-A');
      cli(repo.root, ['publish', '--suite', 'beta', '--tree', 'STAGED']);
      repo.git('add', '-A');
      expect(cli(repo.root, ['check', '--mode', 'staged'])).toContain('PASS');
      repo.git('commit', '-qm', 'accept both suites');

      // sc-2457 itself: a tracked accepted baseline moves, and the staged gate blocks it until the
      // publication that explains it is staged in the same commit.
      repo.write('alpha/results.baseline.json', deterministicBaseline(9));
      repo.git('add', '-A');
      expect(() => cli(repo.root, ['check', '--mode', 'staged'])).toThrow(
        /Accepted baseline changed without publication/,
      );
      cli(repo.root, ['publish', '--suite', 'alpha', '--tree', 'STAGED']);
      repo.git('add', '-A');
      expect(cli(repo.root, ['check', '--mode', 'staged'])).toContain('PASS');
      repo.git('commit', '-qm', 'republish alpha');
      expect(cli(repo.root, ['check', '--mode', 'tree', '--tree', 'HEAD'])).toContain('PASS');

      // Staging more source after publishing moves a suite hash; the remedy is a re-render from the
      // same index the gate reads, never a second publication.
      repo.write('alpha/impl.mts', 'export const impl = 4;\n');
      repo.git('add', '-A');
      expect(() => cli(repo.root, ['check', '--mode', 'staged'])).toThrow(
        /Generated output is stale/,
      );
      cli(repo.root, ['render', '--tree', 'STAGED']);
      repo.git('add', '-A');
      expect(cli(repo.root, ['check', '--mode', 'staged'])).toContain('PASS');
    } finally {
      repo.cleanup();
    }
  });
});

describe('index publication edge cases', () => {
  const publishInRepo = (root: string, args: string[]): BenchmarkEvent => {
    let published: BenchmarkEvent | undefined;
    withPublishLock(root, (append) =>
      publishLocked(root, args, (event, checkpoint) => {
        published = event;
        append(event, checkpoint);
      }),
    );
    if (!published) throw new Error('publish returned no event');
    return published;
  };

  it('still publishes from a clean worktree, the path STAGED did not replace', () => {
    const repo = stagedRepo();
    try {
      const event = publishInRepo(repo.root, ['--suite', 'alpha', '--tree', 'WORKTREE']);
      expect(event.provenance.sourceCommit).toBe(repo.head());
      expect(event.provenance.source).toBe(COMMITTED_PROVENANCE);
      expect(event.recordedAt).toBe(new Date(FIXTURE_COMMIT_DATE).toISOString());
      expect(event.metrics[0]?.value).toBe(0.9);
    } finally {
      repo.cleanup();
    }
  });

  it('keeps unstaged prose outside the markers when it rewrites the views', () => {
    const repo = stagedRepo();
    try {
      repo.write(
        'README.md',
        '# fixture\n\nUNSTAGED PROSE\n\n<!-- benchmark-dashboard:start -->\n<!-- benchmark-dashboard:end -->\n\nTRAILING PROSE\n',
      );
      repo.write('alpha/results.baseline.json', deterministicBaseline(8));
      repo.git('add', 'alpha/results.baseline.json');
      publishInRepo(repo.root, ['--suite', 'alpha', '--tree', 'STAGED']);
      const readme = readFileSync(join(repo.root, 'README.md'), 'utf8');
      expect(readme).toContain('UNSTAGED PROSE');
      expect(readme).toContain('TRAILING PROSE');
      expect(readme).toContain('Suite alpha');
    } finally {
      repo.cleanup();
    }
  });

  it('sends a gitignored baseline to WORKTREE instead of telling it to stage the unstageable', () => {
    const repo = stagedRepo();
    try {
      repo.write('.gitignore', 'alpha/local.baseline.json\n');
      repo.write('alpha/local.baseline.json', deterministicBaseline(8));
      repo.git('add', '.gitignore');
      expect(() =>
        publishInRepo(repo.root, [
          '--suite',
          'alpha',
          '--tree',
          'STAGED',
          '--baseline',
          'alpha/local.baseline.json',
        ]),
      ).toThrow(/gitignored[\s\S]*--tree WORKTREE/);
    } finally {
      repo.cleanup();
    }
  });

  it('lets a retry past the untracked checkpoint an aborted publish left behind', () => {
    const repo = stagedRepo();
    try {
      repo.write('docs/benchmarks/checkpoints/abandoned.json', '{}\n');
      repo.write('alpha/results.baseline.json', deterministicBaseline(8));
      repo.git('add', 'alpha/results.baseline.json');
      expect(publishInRepo(repo.root, ['--suite', 'alpha', '--tree', 'STAGED']).suiteId).toBe(
        'alpha',
      );
    } finally {
      repo.cleanup();
    }
  });

  it('does not read re-staged identical content as a changed index', () => {
    const repo = stagedRepo();
    try {
      repo.write('alpha/results.baseline.json', deterministicBaseline(8));
      repo.git('add', '-A');
      const identity = stagedIndexIdentity(repo.root);
      repo.write('alpha/results.baseline.json', deterministicBaseline(8));
      repo.git('add', '-A');
      expect(() => assertIndexUnchanged(repo.root, identity)).not.toThrow();
    } finally {
      repo.cleanup();
    }
  });

  it('names an unborn HEAD rather than failing inside git', () => {
    const repo = stagedRepo(['alpha'], { commit: false });
    try {
      expect(() => publishInRepo(repo.root, ['--suite', 'alpha', '--tree', 'STAGED'])).toThrow(
        /requires at least one commit/,
      );
    } finally {
      repo.cleanup();
    }
  });
});
