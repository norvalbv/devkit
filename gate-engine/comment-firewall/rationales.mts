/** Committed author rationales for changed-comment findings. A rationale is evidence, not approval. */
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
import { withStoreLock } from '../judge/verdict-store.mts';
import type { CommentRationale, RationaleStore } from './types.mts';

export const RATIONALES_FILE = '.devkit/comment-firewall-rationales.json';
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
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    throw new Error(
      `${label} is not valid JSON: ${cause instanceof Error ? cause.message : cause}`,
    );
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  const candidate = value as { version?: unknown; entries?: unknown };
  if (candidate.version !== 1 || !candidate.entries || typeof candidate.entries !== 'object') {
    throw new Error(`${label} must use schema { version: 1, entries: { ... } }`);
  }
  const entries: Record<string, CommentRationale> = {};
  for (const [id, rawEntry] of Object.entries(candidate.entries)) {
    if (!FINDING_ID.test(id) || !rawEntry || typeof rawEntry !== 'object') {
      throw new Error(`${label} contains an invalid finding entry: ${id}`);
    }
    const entry = rawEntry as Record<string, unknown>;
    if (
      typeof entry.rationale !== 'string' ||
      !entry.rationale.trim() ||
      typeof entry.at !== 'string' ||
      !entry.at.trim() ||
      (entry.ticket !== undefined && typeof entry.ticket !== 'string')
    ) {
      throw new Error(`${label} contains malformed evidence for finding ${id}`);
    }
    try {
      const rationale = validRationale(entry.rationale);
      const ticket = typeof entry.ticket === 'string' ? validTicket(entry.ticket) : undefined;
      entries[id] = {
        rationale,
        at: entry.at,
        ...(ticket ? { ticket } : {}),
      };
    } catch (cause) {
      throw new Error(
        `${label} contains malformed evidence for finding ${id}: ${cause instanceof Error ? cause.message : cause}`,
      );
    }
  }
  return { version: 1, entries };
}

function repositoryRoot(cwd: string): string {
  return execFileSync('git', ['rev-parse', '--path-format=absolute', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function workingPath(cwd: string): string {
  return path.join(repositoryRoot(cwd), RATIONALES_FILE);
}

/** Authorization reads staged bytes so unstaged rationale edits cannot approve the pending commit. */
export function loadStagedRationales(cwd: string): RationaleStore {
  try {
    const raw = execFileSync('git', ['show', `:${RATIONALES_FILE}`], {
      cwd,
      encoding: 'utf8',
      maxBuffer: STORE_MAX_BYTES,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseStore(raw, RATIONALES_FILE);
  } catch (cause) {
    /* Absence is the pre-first-rationale state; staged corruption must never become empty approval. */
    try {
      execFileSync('git', ['cat-file', '-e', `:${RATIONALES_FILE}`], {
        cwd,
        stdio: 'ignore',
      });
    } catch {
      return emptyStore();
    }
    throw cause;
  }
}

export function loadWorkingRationales(cwd: string): RationaleStore {
  const file = workingPath(cwd);
  if (!existsSync(file)) return emptyStore();
  const stat = statSync(file);
  if (!stat.isFile() || stat.size > STORE_MAX_BYTES) {
    throw new Error(`${RATIONALES_FILE} is not a regular file under ${STORE_MAX_BYTES} bytes`);
  }
  return parseStore(readFileSync(file, 'utf8'), RATIONALES_FILE);
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
  const file = workingPath(cwd);
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
    ...(canonicalTicket ? { ticket: canonicalTicket } : {}),
  };
  const file = workingPath(cwd);
  const root = repositoryRoot(cwd);
  const completed = withStoreLock(file, {}, (handle) => {
    const store = loadWorkingRationales(cwd);
    options.afterLoad?.();
    store.entries[findingId] = entry;
    persistWorking(cwd, store, handle);
    execFileSync('git', ['add', '--', RATIONALES_FILE], { cwd: root, stdio: 'pipe' });
  });
  if (!completed) throw new Error('could not acquire or retain the comment-rationale lock');
  return entry;
}

export function listRationales(cwd: string): Array<[string, CommentRationale]> {
  return Object.entries(loadWorkingRationales(cwd).entries).sort(([, left], [, right]) =>
    right.at.localeCompare(left.at),
  );
}

export function pruneRationales(cwd: string, currentIds: ReadonlySet<string>): number {
  const file = workingPath(cwd);
  const root = repositoryRoot(cwd);
  let removed = 0;
  const completed = withStoreLock(file, {}, (handle) => {
    const store = loadWorkingRationales(cwd);
    for (const id of Object.keys(store.entries)) {
      if (currentIds.has(id)) continue;
      delete store.entries[id];
      removed += 1;
    }
    if (removed === 0) return;
    persistWorking(cwd, store, handle);
    execFileSync('git', ['add', '--', RATIONALES_FILE], { cwd: root, stdio: 'pipe' });
  });
  if (!completed) throw new Error('could not acquire or retain the comment-rationale lock');
  return removed;
}
