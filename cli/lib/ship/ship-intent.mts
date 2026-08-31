#!/usr/bin/env node
/** Recorded ship invocation behind `devkit ship --resume`: Buffer → base64 keeps body bytes exact
 * (a UTF-8 hop substitutes U+FFFD). Commit-only writes are best-effort; body side effects require
 * an owned record, and reads fail closed. */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { devkitVersion } from '../../../gate-engine/devkit-version.mts';
import { emitShipIntentEvent } from './ship-intent-event.mts';
import { fail, parseArgs } from './ship-intent-args.mts';
import {
  bindSourceMembershipForWrite,
  cleanupDeletedSourceMembershipRefs,
  cleanupFailedSourceMembership,
  cleanupReplacedSourceMembership,
  emitFields,
  handlePathCodecCommand,
  provenString,
  provenStrings,
  sourceMembershipMatches,
  type SourceMembership,
  type ShipIntent,
  type StoredIntent,
} from './ship-intent-codec.mts';
import { withLock } from '../atomic-write.mts';
import { git } from '../reconcile.mts';

const LEGACY_EXPLICIT_SCHEMA_VERSION = 1;
const EXPLICIT_SCHEMA_VERSION = 2;
const BRANCH_SCHEMA_VERSION = 3;
// A manifest this old describes an ABANDONED ship: every live retry chain rewrites it on each
// attempt, so age only accumulates when no attempt has run — and branch names get reused. Replaying
// weeks-old bytes under a confident "Resuming" banner is the failure mode; refusing is cheap.
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
// Small allowance for clock drift between the writer and a reader; anything further in the future
// is a misdated record, refused by the two-sided age check.
const FUTURE_SKEW_MS = 5 * 60 * 1000;

/** owner/repo derived from origin, or '' — mirrors ship-branch.sh's REPO sed so the two agree. */
function originRepo(root: string): string {
  const url = git(root, ['remote', 'get-url', 'origin']);
  if (!url) return '';
  const m = url.match(/github\.com[^:/]*[:/](.+?)(?:\.git)?$/);
  return m ? m[1] : '';
}

/** The raw-branch hash separates sanitized-name collisions; readIntent's raw branch equality is
 * the final guarantee that a copied or colliding file never replays another branch's invocation. */
export const relIntentPath = (branch: string) => {
  const digest = createHash('sha256').update(branch).digest('hex').slice(0, 8);
  return `.devkit/ship-intent-${branch.replace(/\//g, '-').slice(0, 120)}-${digest}.json`;
};

const intentFile = (root: string, branch: string) => path.join(root, relIntentPath(branch));

/** Write this attempt's manifest; refuse non-fatally when its path is not ignored. */
export function writeIntent(
  opts: {
    root: string;
    branch: string;
    mode: string;
    sourceMode?: string;
    title: string;
    base?: string;
    links: string[];
    noQavisPublish: boolean;
    updatePrBody: boolean;
    resumed: boolean;
    mergePaths: boolean;
    /** The generation this attempt READ before deciding to re-record. When the on-disk record has
     * moved past it (a concurrent FULL invocation re-recorded newer metadata), the write is
     * skipped: the newer record wins and this attempt runs unrecorded. */
    expectGeneration?: string;
    /** Version-2 source ownership token read by --resume; fresh branch attempts mint their own. */
    sourceAttemptId?: string;
    donatePaths?: string[];
    body: Buffer;
  },
  paths: string[],
): number {
  if (opts.mode !== 'ship' && opts.mode !== 'reship')
    return fail(`--mode must be ship|reship (got '${opts.mode}')`);
  const sourceMode = opts.sourceMode ?? 'explicit';
  if (sourceMode !== 'explicit' && sourceMode !== 'branch')
    return fail(`--source-mode must be explicit|branch (got '${sourceMode}')`);
  if (sourceMode === 'branch' && opts.mode !== 'ship')
    return fail('--source-mode branch is only valid for a new ship');
  if (sourceMode === 'branch' && !opts.base)
    return fail('--source-mode branch requires a non-empty --base');
  if (sourceMode === 'branch' && (opts.mergePaths || (opts.donatePaths?.length ?? 0) > 0))
    return fail('--source-mode branch has frozen path membership and cannot merge/donate paths');
  if (paths.length === 0) return fail('no paths given');
  const rel = relIntentPath(opts.branch);
  try {
    execFileSync('git', ['-C', opts.root, 'check-ignore', '-q', '--', rel], { stdio: 'ignore' });
  } catch {
    // Not ignored (or check-ignore itself failed): skip rather than create a stageable secret.
    console.error(
      `ship-intent: ${rel} is not gitignored here — not recording the invocation (run devkit doctor to refresh .gitignore; retries need the full command until then)`,
    );
    return 0;
  }
  const generation = randomUUID();
  const requestedSourceAttempt = provenString(opts.sourceAttemptId);
  if (sourceMode === 'branch' && opts.resumed && !requestedSourceAttempt)
    return fail('resumed --source-mode branch requires a non-empty --source-attempt-id');
  const sourceAttemptId =
    sourceMode === 'branch' ? requestedSourceAttempt || generation : undefined;
  const intent: ShipIntent = {
    version: sourceMode === 'branch' ? BRANCH_SCHEMA_VERSION : EXPLICIT_SCHEMA_VERSION,
    mode: opts.mode,
    branch: opts.branch,
    title: opts.title,
    base: opts.base || null,
    links: opts.links,
    paths,
    noQavisPublish: opts.noQavisPublish,
    updatePrBody: opts.updatePrBody,
    bodyB64: opts.body.toString('base64'),
    repo: originRepo(opts.root),
    createdAt: new Date().toISOString(),
    // Random, not the timestamp: two same-millisecond attempts must never share the ownership
    // token the compare-and-delete matches on.
    generation,
    devkitVersion: devkitVersion(),
  };
  if (sourceMode === 'branch') intent.sourceMode = sourceMode;
  if (sourceAttemptId) intent.sourceAttemptId = sourceAttemptId;
  const file = intentFile(opts.root, opts.branch);
  mkdirSync(path.dirname(file), { recursive: true });
  let boundNewMembership: SourceMembership | null = null;
  let intentPersisted = false;
  try {
    // The shared lock prevents read-then-replace races; temp+rename preserves the prior record if
    // a process crashes mid-write, and the temporary file is private from its first byte.
    let superseded = false;
    withLock(`${file}.lock`, () => {
      // Resume writes UNION paths and CASes the generation it read, preserving a concurrent full
      // invocation's newer metadata; a record deleted since the read stays spent.
      let onDisk: StoredIntent | null = null;
      try {
        // SAFETY: only generation + paths are read, each re-proven by its proven* helper.
        onDisk = JSON.parse(readFileSync(file, 'utf8')) as StoredIntent;
      } catch {
        onDisk = null; // absent/torn — nothing to merge or protect
      }
      const onDiskGen = onDisk && provenString(onDisk.generation);
      if (opts.expectGeneration !== undefined && onDiskGen !== opts.expectGeneration) {
        superseded = true;
        // A losing resume contributes only its explicitly briefed donatePaths. Its stale recorded
        // list must not leak into a newer full invocation; a deleted record stays deleted.
        if (opts.mergePaths && onDisk !== null) {
          const ownerPaths = provenStrings(onDisk.paths) ?? [];
          const merged = [...ownerPaths];
          for (const p of opts.donatePaths ?? []) if (!merged.includes(p)) merged.push(p);
          if (merged.length !== ownerPaths.length) {
            const tmp = `${file}.${process.pid}.tmp`;
            writeFileSync(tmp, `${JSON.stringify({ ...onDisk, paths: merged }, null, 2)}\n`, {
              mode: 0o600,
            });
            renameSync(tmp, file);
          }
        }
        return;
      }
      if (opts.mergePaths && onDisk !== null)
        for (const p of provenStrings(onDisk.paths) ?? [])
          if (!intent.paths.includes(p)) intent.paths.push(p);
      if (sourceMode === 'branch')
        bindSourceMembershipForWrite(opts.root, intent, opts.resumed, onDisk);
      if (sourceMode === 'branch' && provenString(onDisk?.sourceAttemptId) !== sourceAttemptId)
        boundNewMembership = { sourceAttemptId: sourceAttemptId!, paths: intent.paths };
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(intent, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, file);
      intentPersisted = true;
      if (sourceMode === 'branch') cleanupReplacedSourceMembership(opts.root, intent, onDisk);
    });
    if (superseded) {
      console.error('ship-intent: record superseded by a concurrent attempt — running unrecorded');
      return 0; // no stdout token: this attempt owns nothing and must not delete on success
    }
  } catch (e: unknown) {
    if (!intentPersisted && boundNewMembership)
      cleanupFailedSourceMembership(opts.root, opts.branch, boundNewMembership);
    return fail(e instanceof Error ? e.message : String(e)); // lock contention → record nothing
  }
  process.stdout.write(`${intent.generation}\n`);
  emitShipIntentEvent(intent, opts.resumed);
  return 0;
}

/**
 * Delete the record — unconditionally without `generation`, else only when the stored generation
 * matches (compare-and-delete, the receipt ref's own discipline): a concurrent attempt that
 * re-recorded between this attempt's write and its success keeps its newer record for `--resume`.
 * With `shippedPaths`, a matching record is kept if it names paths this push did not ship. The
 * read-compare-rm shares the writer lock, so replacement cannot slip between comparison and rm.
 */
export function deleteIntent(
  root: string,
  branch: string,
  generation?: string,
  shippedPaths?: string[],
): number {
  const file = intentFile(root, branch);
  let kept = false; // exit 2: the caller must not describe this outcome as a release
  try {
    withLock(`${file}.lock`, () => {
      let stored: StoredIntent | null = null;
      try {
        // SAFETY: only generation, source identity, and paths are read; proven* rechecks each.
        stored = JSON.parse(readFileSync(file, 'utf8')) as StoredIntent;
      } catch {
        if (generation) return; // absent/torn — nothing this attempt owns
      }
      if (generation && stored) {
        if (provenString(stored.generation) !== generation) return;
        if (shippedPaths) {
          const extras = (provenStrings(stored.paths) ?? []).filter(
            (p) => !shippedPaths.includes(p),
          );
          if (extras.length > 0) {
            kept = true;
            process.stderr.write(
              `ship: kept the recorded invocation for '${branch}' — a concurrent attempt contributed path(s) this push did not ship (${extras.join(', ')}); devkit ship --resume '${branch}' replays them\n`,
            );
            return;
          }
        }
      }
      rmSync(file, { force: true });
      if (stored?.version === BRANCH_SCHEMA_VERSION)
        cleanupDeletedSourceMembershipRefs(root, branch);
    });
    if (kept) return 2;
  } catch {
    // Lock contention keeps the record, and the caller must hear that: a silently "successful"
    // delete leaves a spent record a later --resume replays as if the push never happened.
    process.stderr.write(
      `ship: recorded invocation for '${branch}' is locked by another attempt — not deleted; a later --resume would replay it until it expires (rm '${file}' to clear it now)\n`,
    );
    return 1;
  }
  return 0;
}

/** Lock-shared proof that this process still owns the on-disk intent generation. */
export function ownsIntentGeneration(root: string, branch: string, generation: string): boolean {
  const file = intentFile(root, branch);
  try {
    return withLock(`${file}.lock`, () => {
      try {
        // SAFETY: only generation is read, then proven as a string before comparison.
        const stored = JSON.parse(readFileSync(file, 'utf8')) as StoredIntent;
        return provenString(stored.generation) === generation;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/** Parse + validate the stored manifest, or return a refusal string (never both). */
export function readIntent(
  root: string,
  branch: string,
  nowMs: number = Date.now(),
): { intent: ShipIntent } | { reason: string } {
  const file = intentFile(root, branch);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return {
      reason: `no recorded ship invocation for '${branch}' — run the full devkit ship command once (it records on every attempt)`,
    };
  }
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return {
      reason: `recorded invocation is unreadable (${file}) — run the full command, which re-records`,
    };
  }
  if (Object(m) !== m || Array.isArray(m))
    return {
      reason: `recorded invocation is malformed (${file}) — run the full command, which re-records`,
    };
  // SAFETY: names fields only — every field is runtime-re-proven below before it is trusted.
  const r = m as StoredIntent;
  const storedVersion = r.version;
  if (
    storedVersion !== LEGACY_EXPLICIT_SCHEMA_VERSION &&
    storedVersion !== EXPLICIT_SCHEMA_VERSION &&
    storedVersion !== BRANCH_SCHEMA_VERSION
  )
    return {
      reason: `recorded invocation has unknown version ${String(r.version)} — run the full command, which re-records`,
    };
  const mode = r.mode;
  if (mode !== 'ship' && mode !== 'reship')
    return {
      reason: `recorded invocation has no valid mode (${file}) — run the full command, which re-records`,
    };
  let sourceMode: 'explicit' | 'branch';
  if (storedVersion !== BRANCH_SCHEMA_VERSION) {
    if (r.sourceMode !== undefined && r.sourceMode !== 'explicit')
      return {
        reason: `recorded invocation has an invalid explicit source mode (${file}) — run the full command, which re-records`,
      };
    sourceMode = 'explicit';
  } else {
    if (r.sourceMode !== 'branch' || mode !== 'ship')
      return {
        reason: `recorded invocation has no valid version-3 branch source mode (${file}) — run the full command, which re-records`,
      };
    sourceMode = 'branch';
  }
  // RAW branch equality — defense in depth behind the filename's hash suffix (a record COPIED or
  // hand-renamed onto another branch's path must refuse, never replay foreign title/body/paths).
  // Equality with the caller's known-string branch is itself the proof of stringness.
  if (r.branch !== branch)
    return { reason: `recorded invocation is for branch '${String(r.branch)}', not '${branch}'` };
  // Present-but-invalid optional fields refuse rather than degrade: a coerced-away base or repo
  // silently changes WHAT the resume ships against, which is worse than a refusal.
  if (r.repo !== undefined && provenString(r.repo) === null)
    return {
      reason: `recorded invocation is malformed (repo) — run the full command, which re-records`,
    };
  if (r.base !== undefined && r.base !== null && provenString(r.base) === null)
    return {
      reason: `recorded invocation is malformed (base) — run the full command, which re-records`,
    };
  if (sourceMode === 'branch' && !provenString(r.base))
    return {
      reason: `recorded version-3 branch invocation has no valid base — run the full command, which re-records`,
    };
  if (r.links !== undefined && provenStrings(r.links) === null)
    return {
      reason: `recorded invocation is malformed (links) — run the full command, which re-records`,
    };
  const repo = provenString(r.repo) ?? '';
  const repoNow = originRepo(root);
  // Fail CLOSED when a repo was recorded but the current origin cannot be determined: the record
  // lives in its own repo's .devkit, so an unknown origin under a named record means it moved.
  if (repo && repo !== repoNow)
    return {
      reason: `recorded invocation is for repo '${repo}', not '${repoNow || 'an unidentifiable origin'}'`,
    };
  const title = provenString(r.title);
  const bodyB64 = provenString(r.bodyB64);
  const paths = provenStrings(r.paths);
  const links = provenStrings(r.links) ?? [];
  if (title === null || bodyB64 === null || paths === null || paths.length === 0)
    return {
      reason: `recorded invocation is incomplete (${file}) — run the full command, which re-records`,
    };
  // Canonical round trip, not just "is a string": Buffer.from(…, 'base64') silently SKIPS invalid
  // characters, so a corrupt record (bodyB64 '*') would otherwise replay a wrong — often empty —
  // body instead of refusing. The writer always emits canonical base64, so equality is exact. A
  // decoded NUL also refuses: git forbids NUL in a commit message, so no legitimate body carries
  // one — but the NUL-delimited read protocol would split on it, truncating the body and
  // misreading its tail as extra shipped paths.
  const bodyBytes = Buffer.from(bodyB64, 'base64');
  if (bodyBytes.toString('base64') !== bodyB64 || bodyBytes.includes(0))
    return {
      reason: `recorded invocation's body is corrupt (${file}) — run the full command, which re-records`,
    };
  // Strictly true or false, else refuse: an `=== true` coercion would read a tampered record's
  // 'true' STRING as false and silently flip an external publish preference on replay.
  const noQavisPublish = r.noQavisPublish;
  if (noQavisPublish !== true && noQavisPublish !== false)
    return {
      reason: `recorded invocation is malformed (noQavisPublish) — run the full command, which re-records`,
    };
  // V1 is preserve-only. V2+ require this side-effect bit, so older binaries reject new records.
  const updatePrBody = storedVersion === LEGACY_EXPLICIT_SCHEMA_VERSION ? false : r.updatePrBody;
  if (updatePrBody !== true && updatePrBody !== false)
    return {
      reason: `recorded invocation is malformed (updatePrBody) — run the full command, which re-records`,
    };
  const generation = provenString(r.generation);
  if (!generation)
    return {
      reason: `recorded invocation is malformed (generation) — run the full command, which re-records`,
    };
  const sourceAttemptId = provenString(r.sourceAttemptId);
  if (sourceMode === 'branch' && !sourceAttemptId)
    return {
      reason: `recorded version-3 branch invocation has no valid source attempt id — run the full command, which re-records`,
    };
  if (
    sourceMode === 'branch' &&
    !sourceMembershipMatches(root, branch, { sourceAttemptId: sourceAttemptId!, paths })
  )
    return {
      reason: `recorded branch-source frozen membership failed its Git binding — run the full command, which re-records`,
    };
  const createdAt = provenString(r.createdAt) ?? '';
  const created = Date.parse(createdAt);
  // Two-sided: older than the abandonment bound is stale, and a FUTURE stamp (clock skew, a
  // hand-edit) must not buy a record immortality past the six-hour boundary. The toISOString
  // round-trip refuses rollover dates (2026-02-30 parses as March 2) — the writer only ever
  // emits canonical ISO, so inequality proves tampering or corruption.
  if (
    !Number.isFinite(created) ||
    new Date(created).toISOString() !== createdAt ||
    nowMs - created > MAX_AGE_MS ||
    created - nowMs > FUTURE_SKEW_MS
  )
    return {
      reason: `recorded invocation is stale or misdated (recorded ${String(r.createdAt)}; every live attempt re-records) — run the full command`,
    };
  const intent: ShipIntent = {
    version: storedVersion,
    mode,
    sourceMode,
    branch,
    title,
    base: provenString(r.base),
    links,
    paths,
    noQavisPublish,
    updatePrBody,
    bodyB64,
    repo,
    createdAt,
    generation,
    devkitVersion: provenString(r.devkitVersion) ?? '',
  };
  if (sourceAttemptId) intent.sourceAttemptId = sourceAttemptId;
  return { intent };
}

function main(): number {
  const [sub, ...rest] = process.argv.slice(2);
  const codecStatus = handlePathCodecCommand(sub, rest);
  if (codecStatus !== null) return codecStatus;
  const { values, booleans, links, donates, paths } = parseArgs(rest);
  const root = values.get('root');
  const branch = values.get('branch');
  if (!root || !branch) return fail('missing --root/--branch');
  if (sub === 'write') {
    const title = values.get('title');
    const mode = values.get('mode');
    if (title === undefined || !mode) return fail('write: missing --title/--mode');
    return writeIntent(
      {
        root,
        branch,
        mode,
        sourceMode: values.get('source-mode'),
        title,
        base: values.get('base'),
        links,
        noQavisPublish: booleans.has('no-qavis-publish'),
        updatePrBody: booleans.has('update-pr-body'),
        resumed: booleans.has('resumed'),
        mergePaths: booleans.has('merge-paths'),
        expectGeneration: values.get('expect-generation'),
        sourceAttemptId: values.get('source-attempt-id'),
        donatePaths: donates,
        body: readFileSync(0), // Buffer, never utf8 — see the header
      },
      paths,
    );
  }
  if (sub === 'read') {
    const result = readIntent(root, branch);
    if ('reason' in result) return fail(result.reason);
    emitFields(result.intent);
    return 0;
  }
  if (sub === 'owns') {
    const generation = values.get('generation');
    if (!generation) return fail('owns: missing --generation');
    return ownsIntentGeneration(root, branch, generation) ? 0 : 1;
  }
  if (sub === 'delete')
    return deleteIntent(
      root,
      branch,
      values.get('generation'),
      paths.length > 0 ? paths : undefined,
    );
  return fail(
    `unknown subcommand '${String(sub)}' (write|read|owns|delete|validate-paths|validate-membership|filter-membership)`,
  );
}

// CLI entrypoint only; realpath keeps the guard correct through a symlinked module directory.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  process.exitCode = main(); // let queued stdout (notably a large validated NUL path stream) drain
