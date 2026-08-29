/** Local author rationales for changed-comment findings. A rationale is evidence, not approval. */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { devkitDataFile, withStoreLock } from '../judge/verdict-store.mts';
import type { CommentRationale, JsonValue, RationaleStore } from './types.mts';
import { isJsonObject, isJsonString, parseJson } from './types.mts';

export const RATIONALES_FILE = 'devkit/comment-firewall-rationales.json';
const STORE_MAX_BYTES = 1024 * 1024;
const RATIONALE_MAX_CHARS = 2_000;
const RATIONALE_MIN_CHARS = 20;
const TICKET_MAX_CHARS = 500;
const FINDING_ID = /^[0-9a-f]{12}$/;
const TICKET = /^(?:https:\/\/[^\s]+|[A-Za-z][A-Za-z0-9_-]*-\d+|#\d+)$/;
const PLACEHOLDERS = new Set([
  'false positive',
  'not a bug',
  'needed',
  'required',
  'waived',
  'n/a',
  'na',
  'todo',
  'because it is needed',
]);

const emptyStore = (): RationaleStore => ({ version: 1, entries: {} });

function parseStore(raw: string, label: string): RationaleStore {
  let value: JsonValue;
  try {
    value = parseJson(raw);
  } catch (cause) {
    throw new Error(
      `${label} is not valid JSON: ${cause instanceof Error ? cause.message : cause}`,
    );
  }
  if (!isJsonObject(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  if (value.version !== 1 || !isJsonObject(value.entries)) {
    throw new Error(`${label} must use schema { version: 1, entries: { ... } }`);
  }
  if (
    value.migratedWorktrees !== undefined &&
    (!Array.isArray(value.migratedWorktrees) ||
      value.migratedWorktrees.some((item) => !isJsonString(item) || !item.trim()))
  ) {
    throw new Error(`${label} contains malformed migrated-worktree state`);
  }
  const entries: Record<string, CommentRationale> = {};
  for (const [id, entry] of Object.entries(value.entries)) {
    if (!FINDING_ID.test(id) || !isJsonObject(entry)) {
      throw new Error(`${label} contains an invalid finding entry: ${id}`);
    }
    if (
      !isJsonString(entry.rationale) ||
      !entry.rationale.trim() ||
      !isJsonString(entry.at) ||
      !entry.at.trim() ||
      (entry.ticket !== undefined && !isJsonString(entry.ticket)) ||
      (entry.worktrees !== undefined &&
        (!Array.isArray(entry.worktrees) ||
          entry.worktrees.length === 0 ||
          entry.worktrees.some((item) => !isJsonString(item) || !item.trim())))
    ) {
      throw new Error(`${label} contains malformed evidence for finding ${id}`);
    }
    try {
      const rationale = validRationale(entry.rationale);
      const ticket = isJsonString(entry.ticket) ? validTicket(entry.ticket) : undefined;
      const parsed: CommentRationale = {
        rationale,
        at: entry.at,
      };
      if (ticket) parsed.ticket = ticket;
      if (Array.isArray(entry.worktrees)) {
        parsed.worktrees = [...new Set(entry.worktrees.filter(isJsonString))];
      }
      entries[id] = parsed;
    } catch (cause) {
      throw new Error(
        `${label} contains malformed evidence for finding ${id}: ${cause instanceof Error ? cause.message : cause}`,
      );
    }
  }
  const store: RationaleStore = { version: 1, entries };
  if (Array.isArray(value.migratedWorktrees)) {
    store.migratedWorktrees = [...new Set(value.migratedWorktrees.filter(isJsonString))];
  }
  return store;
}

function gitPath(cwd: string, flag: '--git-common-dir' | '--git-dir' | '--show-toplevel'): string {
  return execFileSync('git', ['rev-parse', '--path-format=absolute', flag], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function sharedPath(cwd: string): string {
  return path.join(gitPath(cwd, '--git-common-dir'), RATIONALES_FILE);
}

function mutationPath(cwd: string): string {
  const privateReview =
    process.env.DEVKIT_RUN_MODE === 'review' &&
    (Boolean(process.env.DEVKIT_REVIEW_ID) || process.env.DEVKIT_REVIEW_DATA_ROOT !== undefined);
  if (privateReview) return devkitDataFile(cwd, 'comment-firewall-rationales.json');
  return sharedPath(cwd);
}

function legacyWorkingPath(cwd: string): string {
  return path.join(gitPath(cwd, '--show-toplevel'), '.devkit/comment-firewall-rationales.json');
}

function worktreeIdentity(cwd: string): string {
  return gitPath(cwd, '--git-dir');
}

function loadFile(file: string): RationaleStore {
  if (!existsSync(file)) return emptyStore();
  const stat = statSync(file);
  if (!stat.isFile() || stat.size > STORE_MAX_BYTES) {
    throw new Error(`${RATIONALES_FILE} is not a regular file under ${STORE_MAX_BYTES} bytes`);
  }
  return parseStore(readFileSync(file, 'utf8'), RATIONALES_FILE);
}

function loadLegacy(cwd: string): RationaleStore {
  const file = legacyWorkingPath(cwd);
  if (existsSync(file)) return loadFile(file);
  try {
    const raw = execFileSync('git', ['show', 'HEAD:.devkit/comment-firewall-rationales.json'], {
      cwd,
      encoding: 'utf8',
      maxBuffer: STORE_MAX_BYTES,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseStore(raw, RATIONALES_FILE);
  } catch {
    return emptyStore();
  }
}

function loadCombinedStore(cwd: string): RationaleStore {
  const shared = loadFile(sharedPath(cwd));
  const writable = mutationPath(cwd);
  if (writable === sharedPath(cwd) || !existsSync(writable)) return shared;
  const overlay = loadFile(writable);
  return {
    version: 1,
    entries: { ...shared.entries, ...overlay.entries },
    migratedWorktrees: [
      ...new Set([...(shared.migratedWorktrees ?? []), ...(overlay.migratedWorktrees ?? [])]),
    ],
  };
}

export interface RationaleStoreLocation {
  sharedFile: string;
  writableFile: string;
  sharedExists: boolean;
  /** Finding ids in the shared store; null when the file exists but could not be read. */
  sharedFindingIds: string[] | null;
  privateReview: boolean;
}

/** Where this cwd reads and writes rationale evidence, so a gate can NAME the file it consulted. */
export function describeRationaleStore(cwd: string): RationaleStoreLocation {
  const sharedFile = sharedPath(cwd);
  const writableFile = mutationPath(cwd);
  const sharedExists = existsSync(sharedFile);
  let sharedFindingIds: string[] | null = [];
  if (sharedExists) {
    try {
      sharedFindingIds = Object.keys(loadFile(sharedFile).entries);
    } catch {
      sharedFindingIds = null;
    }
  }
  return {
    sharedFile,
    writableFile,
    sharedExists,
    sharedFindingIds,
    privateReview: writableFile !== sharedFile,
  };
}

interface LegacyMergeResult {
  changed: boolean;
  conflict: string;
}

function mergeLegacyForOwner(
  store: RationaleStore,
  legacy: RationaleStore,
  owner: string,
): LegacyMergeResult {
  if (store.migratedWorktrees?.includes(owner)) return { changed: false, conflict: '' };
  if (Object.keys(legacy.entries).length === 0) return { changed: false, conflict: '' };
  for (const [id, legacyEntry] of Object.entries(legacy.entries)) {
    const existing = store.entries[id];
    if (
      existing &&
      (existing.rationale !== legacyEntry.rationale || existing.ticket !== legacyEntry.ticket)
    ) {
      return {
        changed: false,
        conflict: `legacy evidence for [${id}] conflicts with another worktree; reconcile it before continuing`,
      };
    }
    store.entries[id] = {
      ...(existing ?? legacyEntry),
      worktrees: [...new Set([...(existing?.worktrees ?? []), owner])],
    };
  }
  store.migratedWorktrees = [...new Set([...(store.migratedWorktrees ?? []), owner])];
  return { changed: true, conflict: '' };
}

export function loadWorkingRationales(cwd: string): RationaleStore {
  const store = loadCombinedStore(cwd);
  const legacy = loadLegacy(cwd);
  const merged = mergeLegacyForOwner(store, legacy, worktreeIdentity(cwd));
  if (merged.conflict) throw new Error(merged.conflict);
  return store;
}

export function ensureLegacyRationalesMigrated(cwd: string): void {
  const file = mutationPath(cwd);
  let error = '';
  const completed = withStoreLock(file, {}, (handle) => {
    // withStoreLock reports ANY throw as a lock failure, so an unreadable store would surface as
    // "could not acquire the lock" and send the reader hunting a lock that was never contended.
    let store: RationaleStore;
    let legacy: RationaleStore;
    let owner: string;
    try {
      store = loadCombinedStore(cwd);
      legacy = loadLegacy(cwd);
      owner = worktreeIdentity(cwd);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      return;
    }
    const merged = mergeLegacyForOwner(store, legacy, owner);
    if (merged.conflict) {
      error = merged.conflict;
      return;
    }
    if (merged.changed) persistWorking(cwd, store, handle);
  });
  if (error) throw new Error(error);
  if (!completed) throw new Error('could not acquire or retain the comment-rationale lock');
}

function validRationale(rationale: string): string {
  const value = rationale.trim();
  if (
    value.length < RATIONALE_MIN_CHARS ||
    value.length > RATIONALE_MAX_CHARS ||
    PLACEHOLDERS.has(value.toLowerCase())
  ) {
    throw new Error(
      `rationale must be specific (${RATIONALE_MIN_CHARS}-${RATIONALE_MAX_CHARS} chars, not a placeholder)`,
    );
  }
  return value;
}

function validTicket(ticket: string | undefined): string | undefined {
  if (ticket === undefined) return undefined;
  const value = ticket.trim();
  if (!value || value.length > TICKET_MAX_CHARS || !TICKET.test(value)) {
    throw new Error('ticket must be an https URL, #123, or a project key such as SC-123');
  }
  return value;
}

function persistWorking(cwd: string, store: RationaleStore, handle: { owns: () => boolean }): void {
  const file = mutationPath(cwd);
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    if (!handle.owns()) throw new Error('comment-rationale lock ownership changed before publish');
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export interface RecordRationaleOptions {
  afterLoad?: () => void;
}

export function recordRationale(
  cwd: string,
  findingId: string,
  rationale: string,
  ticket?: string,
  now = new Date().toISOString(),
  options: RecordRationaleOptions = {},
): CommentRationale {
  if (!FINDING_ID.test(findingId))
    throw new Error('finding ID must be the 12-hex ID from the gate');
  const canonicalTicket = validTicket(ticket);
  const entry: CommentRationale = {
    rationale: validRationale(rationale),
    at: now,
  };
  if (canonicalTicket) entry.ticket = canonicalTicket;
  const file = mutationPath(cwd);
  const owner = worktreeIdentity(cwd);
  let mutationError = '';
  const completed = withStoreLock(file, {}, (handle) => {
    let store: RationaleStore;
    try {
      store = loadWorkingRationales(cwd);
    } catch (cause) {
      mutationError = cause instanceof Error ? cause.message : String(cause);
      return;
    }
    options.afterLoad?.();
    const existing = store.entries[findingId];
    const otherOwner = existing?.worktrees?.some((item) => item !== owner) ?? false;
    if (
      existing &&
      otherOwner &&
      (existing.rationale !== entry.rationale || existing.ticket !== entry.ticket)
    ) {
      mutationError =
        'another worktree owns different evidence for this finding; record the identical rationale text, or unstage it in that worktree and run guard-comments prune there';
      return;
    }
    entry.worktrees = [...new Set([...(existing?.worktrees ?? []), owner])];
    store.entries[findingId] = entry;
    persistWorking(cwd, store, handle);
  });
  if (mutationError) throw new Error(mutationError);
  if (!completed) throw new Error('could not acquire or retain the comment-rationale lock');
  return entry;
}

export function listRationales(cwd: string): Array<[string, CommentRationale]> {
  return Object.entries(loadWorkingRationales(cwd).entries).sort(([, left], [, right]) =>
    right.at.localeCompare(left.at),
  );
}

export interface PruneRationalesOptions {
  afterSnapshot?: () => void;
}

export function pruneRationales(
  cwd: string,
  currentIds: ReadonlySet<string>,
  options: PruneRationalesOptions = {},
): number {
  const file = mutationPath(cwd);
  const owner = worktreeIdentity(cwd);
  const snapshot = loadWorkingRationales(cwd);
  const candidates = Object.entries(snapshot.entries)
    .filter(([id, entry]) => {
      if (currentIds.has(id)) return false;
      const owners = entry.worktrees;
      return !owners || owners.includes(owner);
    })
    .map(([id, entry]) => [id, JSON.stringify(entry)] as const);
  options.afterSnapshot?.();
  let removed = 0;
  let mutationError = '';
  const completed = withStoreLock(file, {}, (handle) => {
    let store: RationaleStore;
    try {
      store = loadWorkingRationales(cwd);
    } catch (cause) {
      mutationError = cause instanceof Error ? cause.message : String(cause);
      return;
    }
    for (const [id, fingerprint] of candidates) {
      const entry = store.entries[id];
      if (!entry || JSON.stringify(entry) !== fingerprint) continue;
      const remainingOwners = (entry.worktrees ?? []).filter((item) => item !== owner);
      if (remainingOwners.length > 0) entry.worktrees = remainingOwners;
      else delete store.entries[id];
      removed += 1;
    }
    if (removed === 0) return;
    persistWorking(cwd, store, handle);
  });
  if (mutationError) throw new Error(mutationError);
  if (!completed) throw new Error('could not acquire or retain the comment-rationale lock');
  return removed;
}
