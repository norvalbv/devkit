import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { withPublishFileLock } from './publish-lock.mts';
import {
  BARE_SHA256_RE,
  checkpointErrors,
  eventErrors,
  isRecord,
  privacyErrors,
} from './schema.mts';
import type { RepositorySource } from './source.mts';
import type { BenchmarkEvent, CheckpointEnvelope } from './types.mts';

export const HISTORY_PATH = 'docs/benchmarks/history.jsonl';
export const CHECKPOINT_DIR = 'docs/benchmarks/checkpoints';

export function compareRecordedAt(a: string, b: string): number {
  return Date.parse(a) - Date.parse(b);
}

export function latestRecordedEvent(events: BenchmarkEvent[]): BenchmarkEvent | undefined {
  return events.reduce<BenchmarkEvent | undefined>((latest, event) => {
    if (!latest) return event;
    const order = compareRecordedAt(event.recordedAt, latest.recordedAt);
    return order > 0 || (order === 0 && event.id.localeCompare(latest.id) > 0) ? event : latest;
  }, undefined);
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, sorted(child)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sorted(value), null, 2)}\n`;
}

export function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function checkpointArtifact(envelope: CheckpointEnvelope): {
  content: string;
  sha256: string;
  path: string;
} {
  const content = canonicalJson(envelope);
  const digest = sha256(content);
  return { content, sha256: digest, path: `${CHECKPOINT_DIR}/${digest}.json` };
}

export function eventLine(event: BenchmarkEvent): string {
  return JSON.stringify(sorted(event));
}

interface RawHistoryEntry {
  value: unknown;
  line: string;
  lineNumber: number;
}

function parseRawHistory(source: RepositorySource): RawHistoryEntry[] {
  const content = source.read(HISTORY_PATH);
  if (content === null) throw new Error(`Missing ${HISTORY_PATH}`);
  return content
    .split('\n')
    .filter(Boolean)
    .map((line, index) => {
      try {
        return { value: JSON.parse(line) as unknown, line, lineNumber: index + 1 };
      } catch (error) {
        throw new Error(`${HISTORY_PATH}:${index + 1}: invalid JSON: ${(error as Error).message}`);
      }
    });
}

export function parseHistory(
  source: RepositorySource,
): Array<{ event: BenchmarkEvent; line: string }> {
  return parseRawHistory(source).map(({ value, line, lineNumber }) => {
    const location = `${HISTORY_PATH}:${lineNumber}`;
    const errors = eventErrors(value, location);
    if (errors.length) throw new Error(errors.join('\n'));
    return { event: value as BenchmarkEvent, line };
  });
}

export function activeEvents(events: BenchmarkEvent[]): BenchmarkEvent[] {
  const superseded = new Set(
    events.flatMap((event) => (event.supersedes ? [event.supersedes] : [])),
  );
  return events.filter((event) => !superseded.has(event.id));
}

export function publicationErrors(event: BenchmarkEvent, checkpoint: CheckpointEnvelope): string[] {
  const errors = [
    ...eventErrors(event, event.id || '<missing>'),
    ...checkpointErrors(checkpoint, 'checkpoint'),
  ];
  if (checkpoint.suiteId !== event.suiteId) errors.push('checkpoint: suite does not match event');
  if (canonicalJson(event.hashes) !== canonicalJson(checkpoint.hashes))
    errors.push('checkpoint: event hashes do not match checkpoint');
  if (canonicalJson(event.metrics) !== canonicalJson(checkpoint.metrics))
    errors.push('checkpoint: event metrics do not match checkpoint');
  if (canonicalJson(event.comparisons) !== canonicalJson(checkpoint.comparisons))
    errors.push('checkpoint: event comparisons do not match checkpoint');
  if (event.provenance.sourceCommit !== checkpoint.sourceCommit)
    errors.push('checkpoint: event source commit does not match checkpoint');
  if (event.recordedAt !== checkpoint.capturedAt)
    errors.push('checkpoint: event recordedAt does not match checkpoint capturedAt');
  if (event.checkpoint) {
    const artifact = checkpointArtifact(checkpoint);
    if (event.checkpoint.sha256 !== artifact.sha256 || event.checkpoint.path !== artifact.path)
      errors.push('checkpoint: event content address does not match checkpoint bytes');
  }
  privacyErrors(event, event.id || '<missing>', errors);
  privacyErrors(checkpoint, 'checkpoint', errors);
  return errors;
}

export function validateHistory(source: RepositorySource): string[] {
  const errors: string[] = [];
  const entries = parseRawHistory(source);
  const eventsById = new Map<string, BenchmarkEvent>();
  for (const { value } of entries) {
    if (isRecord(value) && typeof value.id === 'string')
      eventsById.set(value.id, value as unknown as BenchmarkEvent);
  }
  const ids = new Map<string, string>();
  for (const { value, line, lineNumber } of entries) {
    const location =
      isRecord(value) && typeof value.id === 'string' && value.id
        ? value.id
        : `${HISTORY_PATH}:${lineNumber}`;
    errors.push(...eventErrors(value, location));
    if (!isRecord(value)) {
      privacyErrors(value, location, errors);
      continue;
    }
    const event = value as unknown as BenchmarkEvent;
    if (line !== eventLine(event)) errors.push(`${location}: event bytes are not canonical`);
    if (event.supersedes && !ids.has(event.supersedes))
      errors.push(`${location}: supersedes must reference an earlier event`);
    if (
      event.supersedes &&
      eventsById.has(event.supersedes) &&
      eventsById.get(event.supersedes)?.suiteId !== event.suiteId
    )
      errors.push(`${location}: superseded event belongs to another suite`);
    if (
      event.supersedes &&
      eventsById.has(event.supersedes) &&
      eventsById.get(event.supersedes)?.evidence !== event.evidence
    )
      errors.push(`${location}: correction must preserve the superseded evidence tier`);
    const prior = ids.get(event.id);
    if (prior)
      errors.push(
        prior === line
          ? `Duplicate event id: ${event.id}`
          : `Conflicting event bytes for id: ${event.id}`,
      );
    ids.set(event.id, line);
    if (event.checkpoint) {
      if (
        typeof event.checkpoint.sha256 !== 'string' ||
        !BARE_SHA256_RE.test(event.checkpoint.sha256) ||
        typeof event.checkpoint.path !== 'string'
      ) {
        privacyErrors(event, event.id, errors);
        continue;
      }
      const expectedPath = `${CHECKPOINT_DIR}/${event.checkpoint.sha256}.json`;
      if (event.checkpoint.path !== expectedPath)
        errors.push(`${event.id}: checkpoint path is not content-addressed`);
      const content = source.read(event.checkpoint.path);
      if (content === null) errors.push(`${event.id}: missing checkpoint ${event.checkpoint.path}`);
      else {
        if (sha256(content) !== event.checkpoint.sha256)
          errors.push(`${event.id}: checkpoint digest mismatch`);
        let parsedCheckpoint: unknown;
        try {
          parsedCheckpoint = JSON.parse(content) as unknown;
        } catch {
          errors.push(`${event.id}: checkpoint is not valid JSON`);
          privacyErrors(event, location, errors);
          continue;
        }
        errors.push(...checkpointErrors(parsedCheckpoint, event.checkpoint.path));
        if (content !== canonicalJson(parsedCheckpoint))
          errors.push(`${event.id}: checkpoint bytes are not canonical`);
        if (isRecord(parsedCheckpoint)) {
          const checkpoint = parsedCheckpoint as unknown as CheckpointEnvelope;
          if (checkpoint.suiteId !== event.suiteId)
            errors.push(`${event.id}: checkpoint suite mismatch`);
          if (canonicalJson(event.hashes) !== canonicalJson(checkpoint.hashes))
            errors.push(`${event.id}: event hashes do not match checkpoint`);
          if (canonicalJson(event.metrics) !== canonicalJson(checkpoint.metrics))
            errors.push(`${event.id}: event metrics do not match checkpoint`);
          if (canonicalJson(event.comparisons) !== canonicalJson(checkpoint.comparisons))
            errors.push(`${event.id}: event comparisons do not match checkpoint`);
          const sourceCommit = isRecord(event.provenance)
            ? event.provenance.sourceCommit
            : undefined;
          if (sourceCommit !== checkpoint.sourceCommit)
            errors.push(`${event.id}: event source commit does not match checkpoint`);
          if (event.recordedAt !== checkpoint.capturedAt)
            errors.push(`${event.id}: event recordedAt does not match checkpoint capturedAt`);
          privacyErrors(checkpoint, event.checkpoint.path, errors);
        }
      }
    }
    privacyErrors(event, location, errors);
  }
  return errors;
}

export function immutableErrors(current: RepositorySource, base: RepositorySource): string[] {
  const errors: string[] = [];
  const baseHistory = base.read(HISTORY_PATH);
  if (baseHistory === null) return errors;
  const currentHistory = current.read(HISTORY_PATH) ?? '';
  const baseLines = baseHistory.split('\n').filter(Boolean);
  const currentLines = currentHistory.split('\n').filter(Boolean);
  for (let index = 0; index < baseLines.length; index += 1) {
    if (currentLines[index] !== baseLines[index]) {
      errors.push(`${HISTORY_PATH}:${index + 1}: committed event bytes were changed or deleted`);
    }
  }
  for (const path of base.listFiles().filter((path) => path.startsWith(`${CHECKPOINT_DIR}/`))) {
    const before = base.read(path);
    const after = current.read(path);
    if (after === null) errors.push(`Committed checkpoint deleted: ${path}`);
    else if (after !== before) errors.push(`Committed checkpoint mutated: ${path}`);
  }
  return errors;
}

export function writeAtomically(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, content, { flag: 'wx' });
  renameSync(temporary, path);
}

export type LockedAppend = (
  event: BenchmarkEvent,
  checkpoint: { path: string; content: string },
) => void;

function appendPublishedEventUnlocked(
  cwd: string,
  event: BenchmarkEvent,
  checkpoint: { path: string; content: string },
): void {
  const historyPath = join(cwd, HISTORY_PATH);
  const current = (() => {
    try {
      return requireRead(historyPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return '';
    }
  })();
  const lines = current.split('\n').filter(Boolean);
  for (const line of lines) {
    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed) || typeof parsed.id !== 'string')
      throw new Error('Existing benchmark history contains an invalid event');
    const existing = parsed as unknown as BenchmarkEvent;
    if (existing.id === event.id) throw new Error(`Event id already exists: ${event.id}`);
  }
  const checkpointPath = join(cwd, checkpoint.path);
  try {
    const existing = requireRead(checkpointPath);
    if (existing !== checkpoint.content)
      throw new Error(`Checkpoint collision at ${checkpoint.path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    writeAtomically(checkpointPath, checkpoint.content);
  }
  writeAtomically(
    historyPath,
    `${lines.join('\n')}${lines.length ? '\n' : ''}${eventLine(event)}\n`,
  );
}

export function withPublishLock<T>(cwd: string, action: (append: LockedAppend) => T): T {
  const lockPath = join(cwd, 'docs/benchmarks/.publish.lock');
  return withPublishFileLock(lockPath, () => {
    return action((event, checkpoint) => appendPublishedEventUnlocked(cwd, event, checkpoint));
  });
}

export function appendPublishedEvent(
  cwd: string,
  event: BenchmarkEvent,
  checkpoint: { path: string; content: string },
): void {
  withPublishLock(cwd, (append) => append(event, checkpoint));
}

function requireRead(path: string): string {
  return readFileSync(path, 'utf8');
}

export function reconcileHistory(contents: string[]): string {
  const ordered: Array<{ id: string; line: string; recordedAt: string }> = [];
  const byId = new Map<string, string>();
  for (const [contentIndex, content] of contents.entries()) {
    const additions: Array<{ id: string; line: string; recordedAt: string }> = [];
    for (const line of content.split('\n').filter(Boolean)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        throw new Error('Cannot reconcile an event that is not valid JSON');
      }
      const validation = eventErrors(parsed, 'reconcile event');
      if (validation.length) throw new Error(`Cannot reconcile invalid event: ${validation[0]}`);
      const event = parsed as BenchmarkEvent;
      if (line !== eventLine(event))
        throw new Error(`Non-canonical event bytes for id: ${event.id}`);
      const prior = byId.get(event.id);
      if (prior && prior !== line) throw new Error(`Conflicting event bytes for id: ${event.id}`);
      if (!prior) additions.push({ id: event.id, line, recordedAt: event.recordedAt });
      byId.set(event.id, line);
    }
    if (contentIndex > 0)
      additions.sort(
        (a, b) => compareRecordedAt(a.recordedAt, b.recordedAt) || a.id.localeCompare(b.id),
      );
    ordered.push(...additions);
  }
  return ordered.length ? `${ordered.map((entry) => entry.line).join('\n')}\n` : '';
}
