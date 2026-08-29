#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { detectChangedComments } from './detect.mts';
import { runCommentFirewall } from './gate.mts';
import {
  describeRationaleStore,
  ensureLegacyRationalesMigrated,
  listRationales,
  pruneRationales,
  recordRationale,
} from './rationales.mts';

const USAGE = `Usage:
  guard-comments gate
  guard-comments justify <finding-id> "<specific rationale>" [--ticket SC-123|URL] [--from-ship-log <absolute-path>]
  guard-comments list
  guard-comments prune`;

export const SHIP_LOG_MAX_BYTES = 16 * 1024 * 1024;
const SHIP_LOG_NAME = /^last-ship-gates-.+\.log$/;

interface JustifyArgs {
  id: string;
  rationale: string;
  ticket?: string;
  shipLog?: string;
}

function parseJustifyArgs(args: string[]): JustifyArgs | null {
  const [id, ...tail] = args;
  if (!id) return null;
  const rationale: string[] = [];
  let ticket: string | undefined;
  let shipLog: string | undefined;
  for (let index = 0; index < tail.length; index += 1) {
    const token = tail[index];
    if (token === '--ticket' || token === '--from-ship-log') {
      const value = tail[index + 1];
      if (!value || value.startsWith('--')) return null;
      if (token === '--ticket') {
        if (ticket !== undefined) return null;
        ticket = value;
      } else {
        if (shipLog !== undefined) return null;
        shipLog = value;
      }
      index += 1;
      continue;
    }
    if (token?.startsWith('-')) return null;
    if (token) rationale.push(token);
  }
  const text = rationale.join(' ').trim();
  return text ? { id, rationale: text, ticket, shipLog } : null;
}

function gitTopLevel(cwd: string): string {
  return execFileSync('git', ['rev-parse', '--path-format=absolute', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function shipLogContainsFinding(cwd: string, file: string, id: string): boolean {
  if (!path.isAbsolute(file)) throw new Error('ship gate log path must be absolute');
  const root = gitTopLevel(cwd);
  const devkitDir = path.join(root, '.devkit');
  if (!SHIP_LOG_NAME.test(path.basename(file))) {
    throw new Error('ship gate log must be a last-ship-gates-*.log file');
  }
  const canonicalRoot = realpathSync(root);
  const canonicalDevkit = realpathSync(devkitDir);
  if (canonicalDevkit !== path.join(canonicalRoot, '.devkit')) {
    throw new Error('ship gate log directory must not redirect outside this repository');
  }
  if (realpathSync(path.dirname(file)) !== canonicalDevkit) {
    throw new Error("ship gate log must be directly under this repository's .devkit directory");
  }

  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error('ship gate log is not a regular file');
    if (stat.size > SHIP_LOG_MAX_BYTES) throw new Error('ship gate log exceeds the size limit');
    const buffer = Buffer.allocUnsafe(SHIP_LOG_MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > SHIP_LOG_MAX_BYTES) throw new Error('ship gate log exceeds the size limit');
    const prefix = `  • [${id}] `;
    return buffer
      .subarray(0, length)
      .toString('utf8')
      .split(/\r?\n/)
      .some((line) => line.startsWith(prefix));
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/**
 * A managed-review environment redirects this write into the private review data root, which a real
 * `devkit ship` never reads. Silent, that divergence costs a full gate run to notice.
 */
function warnPrivateReviewWrite(cwd: string, id: string): void {
  let store: ReturnType<typeof describeRationaleStore>;
  try {
    store = describeRationaleStore(cwd);
  } catch {
    return;
  }
  if (!store.privateReview) return;
  console.error(
    'guard-comments: WARNING — recorded into the managed-review private data root, not the shared store.',
  );
  console.error(`  wrote:      ${store.writableFile}`);
  console.error(`  ship reads: ${store.sharedFile}`);
  // Shared evidence for this id already satisfies ship, so the write is an invisible REPLACEMENT,
  // not the difference between blocked and clear. Saying "still missing" would be plainly false.
  console.error(
    store.sharedFindingIds?.includes(id)
      ? `  [${id}] already has shared evidence, so \`devkit ship\` keeps using THAT rationale and this edit never reaches it.`
      : `  \`devkit ship\` will still report [${id}] as missing.`,
  );
  console.error(
    '  Unset DEVKIT_RUN_MODE / DEVKIT_REVIEW_DATA_ROOT and re-run outside managed review to change what ship sees.',
  );
}

export function runCommentCli(args: string[], cwd = process.cwd()): number {
  const [command, ...rest] = args;
  if (command === 'gate') {
    try {
      ensureLegacyRationalesMigrated(cwd);
      return runCommentFirewall(cwd);
    } catch (cause) {
      console.error(
        `guard-comments: migration — ${cause instanceof Error ? cause.message : cause}`,
      );
      return 4;
    }
  }
  if (command === 'list') {
    const entries = listRationales(cwd);
    if (entries.length === 0) console.log('guard-comments: no recorded rationales.');
    for (const [id, entry] of entries) {
      console.log(`[${id}]${entry.ticket ? ` ${entry.ticket}` : ''} — ${entry.rationale}`);
    }
    return 0;
  }
  if (command === 'prune') {
    try {
      const current = new Set(detectChangedComments(cwd).findings.map((finding) => finding.id));
      const removed = pruneRationales(cwd, current);
      console.error(
        `guard-comments: released ${removed} obsolete rationale ownership${removed === 1 ? '' : 's'} for this worktree.`,
      );
      return 0;
    } catch (cause) {
      console.error(`guard-comments: prune — ${cause instanceof Error ? cause.message : cause}`);
      return 2;
    }
  }
  if (command === 'justify') {
    const parsed = parseJustifyArgs(rest);
    if (!parsed) {
      console.error(USAGE);
      return 2;
    }
    try {
      const { id, rationale, ticket, shipLog } = parsed;
      const currentIds = new Set(detectChangedComments(cwd).findings.map((finding) => finding.id));
      const reportedByShip = shipLog ? shipLogContainsFinding(cwd, shipLog, id) : false;
      if (!currentIds.has(id) && !reportedByShip) {
        if (shipLog) {
          console.error(
            `guard-comments: [${id}] is not an unresolved finding in the supplied ship gate log.`,
          );
          return 2;
        }
        console.error(
          `guard-comments: [${id}] is not a current staged finding; re-run the gate and copy its ID.`,
        );
        return 2;
      }
      const entry = recordRationale(cwd, id, rationale, ticket);
      console.error(
        `guard-comments: local rationale recorded for [${id}]${entry.ticket ? ` (${entry.ticket})` : ''}; re-run the gate for batched independent review.`,
      );
      warnPrivateReviewWrite(cwd, id);
      return 0;
    } catch (cause) {
      console.error(`guard-comments: justify — ${cause instanceof Error ? cause.message : cause}`);
      return 2;
    }
  }
  console.error(USAGE);
  return 2;
}

const invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invoked === realpathSync(new URL(import.meta.url))) {
  process.exitCode = runCommentCli(process.argv.slice(2));
}
