/**
 * Durable checkpoint storage for completeness-eval.
 *
 * Rows are append-only local scratch. A killed process may leave a torn final line, so loading is
 * deliberately tolerant: intact rows remain reusable and malformed rows are announced once then
 * skipped. The global kind + identity and per-entry input hash keep stale work inert.
 */

import { randomUUID } from 'node:crypto';
import { appendFileSync, linkSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isJsonInteger,
  isJsonObject,
  isJsonString,
  parseJson,
  type JsonObject,
  type JsonValue,
} from '../../comment-firewall/types.mts';
import {
  isProcessId,
  processOwnerIsProvablyGone,
  processStartIdentity,
  psProcessStart,
  type ProcessStartResolver,
} from '../../judge/process/identity.mts';

const here = path.dirname(fileURLToPath(import.meta.url));
const PROCESS_START = /^(?:node|ps):.+/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const completenessProgressPath = (dir = here): string => path.join(dir, 'progress.jsonl');
export const completenessProgressLockPath = (dir = here): string => path.join(dir, 'progress.lock');

export function resetCompletenessProgress(dir = here): void {
  rmSync(completenessProgressPath(dir), { force: true });
}

interface ProgressLockOwner extends JsonObject {
  pid: number;
  processStart: string;
  token: string;
}

function readLockOwner(lockDir: string): ProgressLockOwner | undefined {
  try {
    const value = parseJson(readFileSync(lockDir, 'utf8'));
    if (
      !isJsonObject(value) ||
      !isJsonInteger(value.pid) ||
      !isProcessId(value.pid) ||
      !isJsonString(value.processStart) ||
      !PROCESS_START.test(value.processStart) ||
      value.processStart.length > 256 ||
      !isJsonString(value.token) ||
      !UUID.test(value.token)
    )
      return undefined;
    // SAFETY: every required lock-owner field was validated immediately above.
    return value as ProgressLockOwner;
  } catch {
    return undefined;
  }
}

/** One evaluator process owns the shared resumable ledger at a time. */
export function acquireCompletenessProgressLock(
  dir = here,
  processStart: ProcessStartResolver = psProcessStart,
  removeOwnerFile: (file: string) => void = (file) => rmSync(file, { force: true }),
): () => void {
  const lockPath = completenessProgressLockPath(dir);
  const token = randomUUID();
  const ownProcessStart = processStartIdentity(processStart);
  const ownerText = JSON.stringify({ pid: process.pid, processStart: ownProcessStart, token });
  const ownerFile = path.join(dir, `.progress-owner.${token}.tmp`);
  try {
    writeFileSync(ownerFile, ownerText, { flag: 'wx' });
    // The hard link atomically publishes a fully written owner payload at the shared lock path.
    linkSync(ownerFile, lockPath);
  } catch (error) {
    // SAFETY: linkSync reports an occupied lease through Node's ErrnoException code contract.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const owner = readLockOwner(lockPath);
    if (owner && !processOwnerIsProvablyGone(owner, processStart))
      throw new Error(`completeness-eval: another process (pid ${owner.pid}) owns ${lockPath}`);
    throw new Error(
      `completeness-eval: ${lockPath} is stale or unreadable; verify no evaluator is running, then remove that exact lock file and resume`,
    );
  } finally {
    try {
      removeOwnerFile(ownerFile);
    } catch (error) {
      console.error(
        `completeness-eval: WARNING — cannot remove temporary lock owner ${ownerFile} (${error instanceof Error ? error.message : error})`,
      );
    }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (readLockOwner(lockPath)?.token === token) unlinkSync(lockPath);
  };
}

interface TerminationTarget {
  once(event: 'exit' | 'SIGINT' | 'SIGTERM', listener: () => void): void;
  exit(code?: number): never;
}

export function installProgressLockTerminationHandlers(
  release: () => void,
  cleanup: () => void,
  target: TerminationTarget = process,
): void {
  const terminate = (code: number) => {
    try {
      cleanup();
    } finally {
      try {
        release();
      } finally {
        target.exit(code);
      }
    }
  };
  target.once('exit', release);
  target.once('SIGINT', () => terminate(130));
  target.once('SIGTERM', () => terminate(143));
}

interface CheckpointRow extends JsonObject {
  kind: string;
  identity: JsonValue;
  id: string;
  inputHash: string;
  value: JsonValue;
}

export interface CheckpointStore<T> {
  readonly size: number;
  take(id: string, inputHash: string): T | undefined;
  record(id: string, inputHash: string, value: T): void;
}

export interface CheckpointStoreOptions<T> {
  kind: string;
  identity: JsonValue;
  decode: (value: JsonValue) => T | undefined;
  accept?: (value: T) => boolean;
  dir?: string;
}

const entryKey = (id: string, inputHash: string): string => JSON.stringify([id, inputHash]);

function serializedIdentity(identity: JsonValue): string {
  const serialized = JSON.stringify(identity);
  if (serialized === undefined)
    throw new TypeError('completeness-eval: checkpoint identity must be JSON-serializable');
  return serialized;
}

function isCheckpointRow(value: JsonValue): value is CheckpointRow {
  if (!isJsonObject(value)) return false;
  return (
    isJsonString(value.kind) &&
    Object.hasOwn(value, 'identity') &&
    isJsonString(value.id) &&
    isJsonString(value.inputHash) &&
    Object.hasOwn(value, 'value')
  );
}

function readRows(file: string): CheckpointRow[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    // SAFETY: Node's synchronous filesystem API reports read failures with the ErrnoException
    // code contract; non-filesystem throwables simply miss the ENOENT branch and are logged.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    console.error(
      `completeness-eval: WARNING — cannot read checkpoint ${file} (${error instanceof Error ? error.message : error}); entries re-run`,
    );
    return [];
  }

  const rows: CheckpointRow[] = [];
  let unreadable = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = parseJson(line);
      if (!isCheckpointRow(row)) {
        unreadable += 1;
        continue;
      }
      rows.push(row);
    } catch {
      unreadable += 1;
    }
  }
  if (unreadable > 0)
    console.error(
      `completeness-eval: checkpoint ${path.basename(file)} had ${unreadable} unreadable line(s) — those entries re-run`,
    );
  return rows;
}

/**
 * Open a typed view over completeness-eval's shared append-only progress file.
 *
 * `kind` separates phases in the same ledger. `identity` must exactly match its JSON encoding, and
 * `inputHash` binds each id to the bytes that produced it. For duplicate keys, the final matching
 * row is authoritative. An optional accept predicate makes retryable/outage values non-salvageable.
 */
export function openCheckpointStore<T>({
  kind,
  identity,
  decode,
  accept = () => true,
  dir = here,
}: CheckpointStoreOptions<T>): CheckpointStore<T> {
  const file = completenessProgressPath(dir);
  const identityText = serializedIdentity(identity);
  const values = new Map<string, T>();

  for (const row of readRows(file)) {
    if (row.kind !== kind || serializedIdentity(row.identity) !== identityText) continue;
    const key = entryKey(row.id, row.inputHash);
    const value = decode(row.value);
    if (value !== undefined && accept(value)) values.set(key, value);
    else values.delete(key);
  }

  let warnedWriteFailure = false;
  return {
    get size() {
      return values.size;
    },
    take(id, inputHash) {
      return values.get(entryKey(id, inputHash));
    },
    record(id, inputHash, value) {
      const key = entryKey(id, inputHash);
      try {
        // A process killed inside its previous append can leave a non-newline-terminated tail.
        // Always lead with a newline so this intact row cannot be concatenated into that fragment;
        // readRows deliberately ignores the harmless blank separator after a healthy row.
        appendFileSync(file, `\n${JSON.stringify({ kind, identity, id, inputHash, value })}\n`);
        if (accept(value)) values.set(key, value);
        else values.delete(key);
      } catch (error) {
        if (warnedWriteFailure) return;
        warnedWriteFailure = true;
        console.error(
          `completeness-eval: WARNING — cannot write ${file} (${error instanceof Error ? error.message : error}); this run is NOT resumable`,
        );
      }
    },
  };
}
