import { createHash } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  BARE_SHA256_RE,
  checkpointErrors,
  EVENT_ID_RE,
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

export function parseHistory(
  source: RepositorySource,
): Array<{ event: BenchmarkEvent; line: string }> {
  const content = source.read(HISTORY_PATH);
  if (content === null) throw new Error(`Missing ${HISTORY_PATH}`);
  const lines = content.split('\n').filter(Boolean);
  return lines.map((line, index) => {
    try {
      return { event: JSON.parse(line) as BenchmarkEvent, line };
    } catch (error) {
      throw new Error(`${HISTORY_PATH}:${index + 1}: invalid JSON: ${(error as Error).message}`);
    }
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
  const entries = parseHistory(source);
  const eventsById = new Map(entries.map(({ event }) => [event.id, event]));
  const ids = new Map<string, string>();
  for (const { event, line } of entries) {
    const location = event.id || '<missing>';
    errors.push(...eventErrors(event, location));
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
    if (event.evidence === 'accepted' && !event.checkpoint)
      errors.push(`${event.id}: accepted event has no checkpoint`);
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
        try {
          const checkpoint = JSON.parse(content) as CheckpointEnvelope;
          errors.push(...checkpointErrors(checkpoint, event.checkpoint.path));
          if (checkpoint.suiteId !== event.suiteId)
            errors.push(`${event.id}: checkpoint suite mismatch`);
          if (canonicalJson(event.hashes) !== canonicalJson(checkpoint.hashes))
            errors.push(`${event.id}: event hashes do not match checkpoint`);
          if (canonicalJson(event.metrics) !== canonicalJson(checkpoint.metrics))
            errors.push(`${event.id}: event metrics do not match checkpoint`);
          if (canonicalJson(event.comparisons) !== canonicalJson(checkpoint.comparisons))
            errors.push(`${event.id}: event comparisons do not match checkpoint`);
          if (event.provenance.sourceCommit !== checkpoint.sourceCommit)
            errors.push(`${event.id}: event source commit does not match checkpoint`);
          if (event.recordedAt !== checkpoint.capturedAt)
            errors.push(`${event.id}: event recordedAt does not match checkpoint capturedAt`);
          privacyErrors(checkpoint, event.checkpoint.path, errors);
        } catch {
          errors.push(`${event.id}: checkpoint is not valid JSON`);
        }
      }
    }
    privacyErrors(event, event.id, errors);
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

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    throw error;
  }
}

function acquirePublishLock(lockPath: string): number {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(lockPath, 'wx');
      try {
        writeFileSync(descriptor, JSON.stringify({ pid: process.pid }));
        return descriptor;
      } catch (error) {
        closeSync(descriptor);
        unlinkSync(lockPath);
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let owner: unknown;
      try {
        owner = JSON.parse(requireRead(lockPath));
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw new Error('Another benchmark publish is in progress or left an unreadable lock');
      }
      const pid = isRecord(owner) ? owner.pid : undefined;
      if (typeof pid !== 'number' || processIsRunning(pid))
        throw new Error('Another benchmark publish is in progress');
      try {
        unlinkSync(lockPath);
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw unlinkError;
      }
    }
  }
  throw new Error('Could not acquire benchmark publish lock');
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
    const existing = JSON.parse(line) as BenchmarkEvent;
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
  mkdirSync(dirname(lockPath), { recursive: true });
  const lock = acquirePublishLock(lockPath);
  try {
    return action((event, checkpoint) => appendPublishedEventUnlocked(cwd, event, checkpoint));
  } finally {
    closeSync(lock);
    unlinkSync(lockPath);
  }
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
      const event = JSON.parse(line) as BenchmarkEvent;
      if (!EVENT_ID_RE.test(event.id) || Number.isNaN(Date.parse(event.recordedAt)))
        throw new Error('Cannot reconcile an event without a valid id and recordedAt');
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
