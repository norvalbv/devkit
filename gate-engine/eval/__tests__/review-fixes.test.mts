import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { localLogAggregate } from '../backfill.mts';
import { baselinePublicationErrors, loadCatalog, validateCatalog } from '../catalog.mts';
import { parsePublishBaseline } from '../cli.mts';
import {
  activeEvents,
  appendPublishedEvent,
  canonicalJson,
  compareRecordedAt,
  eventLine,
  latestRecordedEvent,
  reconcileHistory,
  sha256,
  validateHistory,
} from '../history.mts';
import { checkpointErrors, privacyErrors } from '../schema.mts';
import { repositorySource } from '../source.mts';
import type { BenchmarkEvent } from '../types.mts';
import { trackerFixture as fixture, memory, readableSnapshot } from './tracker-fixtures.mts';

const ROOT = join(import.meta.dirname, '..', '..', '..');

describe('review feedback regressions', () => {
  it('rejects null records and non-canonical event or checkpoint bytes without crashing', () => {
    expect(validateHistory(memory({ 'docs/benchmarks/history.jsonl': 'null\n' }))).toContain(
      'docs/benchmarks/history.jsonl:1: event must be an object',
    );

    const { checkpoint, event } = fixture();
    const nullCheckpoint = 'null\n';
    const nullDigest = sha256(nullCheckpoint);
    const nullEvent: BenchmarkEvent = {
      ...event,
      id: 'evt-null-checkpoint',
      checkpoint: {
        sha256: nullDigest,
        path: `docs/benchmarks/checkpoints/${nullDigest}.json`,
      },
    };
    expect(
      validateHistory(
        memory({
          'docs/benchmarks/history.jsonl': `${eventLine(nullEvent)}\n`,
          [nullEvent.checkpoint?.path ?? '']: nullCheckpoint,
        }),
      ).join('\n'),
    ).toContain('checkpoint must be an object');

    const checkpointBytes = JSON.stringify(checkpoint);
    const checkpointDigest = sha256(checkpointBytes);
    const checkpointEvent: BenchmarkEvent = {
      ...event,
      id: 'evt-non-canonical-checkpoint',
      checkpoint: {
        sha256: checkpointDigest,
        path: `docs/benchmarks/checkpoints/${checkpointDigest}.json`,
      },
    };
    expect(
      validateHistory(
        memory({
          'docs/benchmarks/history.jsonl': `${eventLine(checkpointEvent)}\n`,
          [checkpointEvent.checkpoint?.path ?? '']: checkpointBytes,
        }),
      ).join('\n'),
    ).toContain('checkpoint bytes are not canonical');
    expect(
      validateHistory(
        memory({
          'docs/benchmarks/history.jsonl': `${JSON.stringify(event)}\n`,
          [event.checkpoint?.path ?? '']: canonicalJson(checkpoint),
        }),
      ).join('\n'),
    ).toContain('event bytes are not canonical');
  });

  it('requires every accepted event to reference a checkpoint', () => {
    const { event } = fixture();
    const withoutCheckpoint = { ...event, checkpoint: undefined } as BenchmarkEvent;
    expect(
      validateHistory(
        memory({ 'docs/benchmarks/history.jsonl': `${eventLine(withoutCheckpoint)}\n` }),
      ).join('\n'),
    ).toContain('accepted event requires a checkpoint');
  });

  it('atomically takes over a stale lock and retains simultaneous process appends', async () => {
    const root = mkdtempSync(join(tmpdir(), 'benchmark-publish-processes-'));
    try {
      mkdirSync(join(root, 'docs/benchmarks'), { recursive: true });
      writeFileSync(
        join(root, 'docs/benchmarks/.publish.lock'),
        JSON.stringify({ pid: 2_147_483_647 }),
      );
      writeFileSync(
        join(root, 'docs/benchmarks/.publish.lock.takeover'),
        JSON.stringify({ pid: 2_147_483_647, createdAt: Date.now(), token: 'orphaned' }),
      );
      const { artifact, event } = fixture();
      const publisher = join(root, 'publisher.mts');
      const historyUrl = pathToFileURL(join(ROOT, 'gate-engine/eval/history.mts')).href;
      writeFileSync(
        publisher,
        `import { appendPublishedEvent } from ${JSON.stringify(historyUrl)};\n` +
          `const [root, event, artifact] = process.argv.slice(2);\n` +
          `appendPublishedEvent(root, JSON.parse(event), JSON.parse(artifact));\n`,
      );
      const publish = (current: BenchmarkEvent) =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [publisher, root, JSON.stringify(current), JSON.stringify(artifact)],
            { stdio: ['ignore', 'ignore', 'pipe'] },
          );
          let stderr = '';
          child.stderr.on('data', (chunk) => {
            stderr += String(chunk);
          });
          child.on('error', reject);
          child.on('exit', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`publisher exited ${code}: ${stderr}`));
          });
        });

      await Promise.all([
        publish({ ...event, id: 'evt-process-a' }),
        publish({ ...event, id: 'evt-process-b' }),
      ]);
      const ids = readFileSync(join(root, 'docs/benchmarks/history.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as BenchmarkEvent).id);
      expect(new Set(ids)).toEqual(new Set(['evt-process-a', 'evt-process-b']));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('recovers an orphaned takeover mutex left incomplete by a killed process', () => {
    const root = mkdtempSync(join(tmpdir(), 'benchmark-publish-orphaned-takeover-'));
    try {
      const benchmarkRoot = join(root, 'docs/benchmarks');
      mkdirSync(benchmarkRoot, { recursive: true });
      writeFileSync(join(benchmarkRoot, '.publish.lock'), JSON.stringify({ pid: 2_147_483_647 }));
      const takeover = join(benchmarkRoot, '.publish.lock.takeover');
      writeFileSync(takeover, '');
      utimesSync(takeover, new Date(0), new Date(0));
      const { artifact, event } = fixture();
      appendPublishedEvent(root, event, artifact);
      expect(readFileSync(join(benchmarkRoot, 'history.jsonl'), 'utf8')).toContain(event.id);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('recovers an orphaned primary lock left empty by a killed process', () => {
    const root = mkdtempSync(join(tmpdir(), 'benchmark-publish-orphaned-primary-'));
    try {
      const benchmarkRoot = join(root, 'docs/benchmarks');
      mkdirSync(benchmarkRoot, { recursive: true });
      const primary = join(benchmarkRoot, '.publish.lock');
      writeFileSync(primary, '');
      utimesSync(primary, new Date(0), new Date(0));
      const { artifact, event } = fixture();
      appendPublishedEvent(root, event, artifact);
      expect(readFileSync(join(benchmarkRoot, 'history.jsonl'), 'utf8')).toContain(event.id);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reconciles only valid canonical events and preserves instant ordering', () => {
    const { event } = fixture();
    const eventB = { ...event, id: 'evt-b', recordedAt: '2026-02-01T00:00:00Z' };
    const eventA = { ...event, id: 'evt-a', recordedAt: '2026-01-01T00:00:00Z' };
    const eventC = { ...event, id: 'evt-c', recordedAt: '2026-03-01T00:00:00Z' };
    const first = `${eventLine(eventB)}\n`;
    const second = `${eventLine(eventA)}\n${eventLine(eventC)}\n`;
    expect(reconcileHistory([first, second])).toBe(`${first.trim()}\n${second.trim()}\n`);
    expect(() =>
      reconcileHistory([
        first,
        `${eventLine({ ...eventB, recordedAt: '2026-04-01T00:00:00Z' })}\n`,
      ]),
    ).toThrow(/Conflicting/);
    expect(() => reconcileHistory(['null\n'])).toThrow(/invalid event/);
    expect(() => reconcileHistory([`${JSON.stringify(event)}\n`])).toThrow(/Non-canonical/);

    const offsetOrdered = reconcileHistory([
      '',
      `${eventLine({ ...event, id: 'evt-later', recordedAt: '2026-06-30T23:30:00Z' })}\n` +
        `${eventLine({ ...event, id: 'evt-earlier', recordedAt: '2026-07-01T01:00:00+02:00' })}\n`,
    ]);
    expect(offsetOrdered.indexOf('evt-earlier')).toBeLessThan(offsetOrdered.indexOf('evt-later'));
    expect(compareRecordedAt('2026-07-01T01:00:00+02:00', '2026-06-30T23:30:00Z')).toBeLessThan(0);
  });

  it('rejects inconsistent ratio counts and expanded private-path or key patterns', () => {
    const { checkpoint } = fixture();
    const metric = {
      id: 'ratio',
      label: 'Ratio',
      value: 0.5,
      unit: 'ratio' as const,
      direction: 'higher' as const,
      inferenceUnit: 'row',
    };
    expect(
      checkpointErrors(
        { ...checkpoint, metrics: [{ ...metric, numerator: 1 }] },
        'checkpoint',
      ).join('\n'),
    ).toContain('ratio numerator and denominator must be provided together');
    expect(
      checkpointErrors(
        { ...checkpoint, metrics: [{ ...metric, numerator: 0, denominator: 0 }] },
        'checkpoint',
      ).join('\n'),
    ).toContain('ratio denominator must be positive');
    expect(
      checkpointErrors(
        { ...checkpoint, metrics: [{ ...metric, numerator: 1, denominator: 4 }] },
        'checkpoint',
      ).join('\n'),
    ).toContain('ratio value does not match numerator divided by denominator');

    const privateErrors: string[] = [];
    privacyErrors(
      ['/root/secret', '/var/private.log', 'C:/private.txt', '-----BEGIN EC PRIVATE KEY-----'],
      'candidate',
      privateErrors,
    );
    expect(privateErrors.filter((error) => error.includes('absolute path'))).toHaveLength(3);
    expect(privateErrors.join('\n')).toContain('private key');
  });

  it('surfaces invalid adapter ratios as a publish rejection', () => {
    const baseline = JSON.parse(
      readFileSync(join(ROOT, 'gate-engine/critique/eval/results.baseline.json'), 'utf8'),
    );
    baseline.critique.recall.total = 0;
    expect(() => parsePublishBaseline('critique', 'critique', JSON.stringify(baseline))).toThrow(
      /Adapter rejected critique: Metric recall requires a positive denominator/,
    );
  });

  it('reports missing declared baselines and accepted checkpoints precisely', () => {
    const source = repositorySource(ROOT, 'working');
    const catalog = loadCatalog(source);
    const history = (source.read('docs/benchmarks/history.jsonl') ?? '')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as BenchmarkEvent);
    const suite = catalog.suites.find(
      (candidate) =>
        candidate.baseline &&
        history.some((event) => event.suiteId === candidate.id && event.evidence === 'accepted'),
    );
    const accepted = latestRecordedEvent(
      activeEvents(history).filter(
        (event) => event.suiteId === suite?.id && event.evidence === 'accepted',
      ),
    );
    if (!suite?.baseline || !accepted?.checkpoint) throw new Error('missing accepted fixture');

    const withoutBaseline = readableSnapshot(source);
    delete withoutBaseline[suite.baseline];
    expect(validateCatalog(memory(withoutBaseline), catalog)).toContain(
      `Suite ${suite.id}: missing baseline ${suite.baseline}`,
    );
    expect(baselinePublicationErrors(memory(withoutBaseline), catalog, history)).toContain(
      `Missing accepted baseline: ${suite.baseline}`,
    );

    const withoutCheckpoint = readableSnapshot(source);
    delete withoutCheckpoint[accepted.checkpoint.path];
    expect(baselinePublicationErrors(memory(withoutCheckpoint), catalog, history)).toContain(
      `Missing accepted checkpoint: ${accepted.checkpoint.path}`,
    );
  });

  it('rejects local aggregate logs outside the repository boundary', () => {
    const root = mkdtempSync(join(tmpdir(), 'benchmark-backfill-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'benchmark-backfill-outside-'));
    try {
      mkdirSync(join(root, 'logs'), { recursive: true });
      writeFileSync(join(root, 'logs/local.jsonl'), 'one\ntwo\n');
      writeFileSync(join(outside, 'private.jsonl'), 'secret\n');
      expect(localLogAggregate(root, 'logs/local.jsonl', 1)).toEqual({
        source: 1,
        rows: 2,
        rejected: false,
      });
      expect(localLogAggregate(root, join(outside, 'private.jsonl'), 2)).toEqual({
        source: 2,
        rows: 0,
        rejected: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
