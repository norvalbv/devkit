#!/usr/bin/env node
/**
 * The recorded ship invocation behind `devkit ship --resume <branch>` (write/read/delete over
 * `.devkit/ship-intent-*.json`). Two constraints the code cannot show: the body travels as BYTES
 * (Buffer → base64 — a utf8 hop substitutes U+FFFD and the landed-commit resume check in
 * ship-branch.sh refuses on any byte difference), and the failure direction is asymmetric by
 * design: `write` is best-effort at its call sites (a miss costs the retry a re-type, never a
 * ship) while `read` fails CLOSED with a named reason, because replaying the wrong invocation is
 * worse than refusing.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { devkitVersion } from '../../../gate-engine/devkit-version.mts';
import { emitShipIntentEvent } from './ship-intent-event.mts';
import { fail, parseArgs } from './ship-intent-args.mts';
import { withLock } from '../atomic-write.mts';
import { git } from '../reconcile.mts';

const SCHEMA_VERSION = 1;
// A manifest this old describes an ABANDONED ship: every live retry chain rewrites it on each
// attempt, so age only accumulates when no attempt has run — and branch names get reused. Replaying
// weeks-old bytes under a confident "Resuming" banner is the failure mode; refusing is cheap.
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
// Small allowance for clock drift between the writer and a reader; anything further in the future
// is a misdated record, refused by the two-sided age check.
const FUTURE_SKEW_MS = 5 * 60 * 1000;

export interface ShipIntent {
  version: number;
  mode: 'ship' | 'reship';
  branch: string;
  title: string;
  base: string | null;
  links: string[];
  paths: string[];
  noQavisPublish: boolean;
  bodyB64: string;
  repo: string;
  createdAt: string;
  generation: string;
  devkitVersion: string;
}

/** owner/repo derived from origin, or '' — mirrors ship-branch.sh's REPO sed so the two agree. */
function originRepo(root: string): string {
  const url = git(root, ['remote', 'get-url', 'origin']);
  if (!url) return '';
  const m = url.match(/github\.com[^:/]*[:/](.+?)(?:\.git)?$/);
  return m ? m[1] : '';
}

/** The gitignore-relative record path. The gate log's bare `${BR//\//-}` collapse maps `a/b` and
 * `a-b` onto one file, so concurrent ships of such twins would overwrite each other's record; the
 * raw-branch hash suffix separates those twins (truncated, so not a uniqueness proof — the RAW
 * `branch` field check in readIntent is the guarantee that a shared file never replays the other
 * branch's invocation) while the sanitized stem stays greppable. */
export const relIntentPath = (branch: string) => {
  const digest = createHash('sha256').update(branch).digest('hex').slice(0, 8);
  return `.devkit/ship-intent-${branch.replace(/\//g, '-').slice(0, 120)}-${digest}.json`;
};

const intentFile = (root: string, branch: string) => path.join(root, relIntentPath(branch));

/**
 * Write the manifest for this attempt. Refuses (non-fatally, exit 0 with a warning) when git does
 * not IGNORE the target path: the file holds the complete PR narrative, and a consumer whose
 * managed .gitignore predates this writer must never gain a stageable untracked copy of it — the
 * writer/ignore parity contract from gitignore-cache.mts, made self-enforcing instead of
 * ordering-dependent on `devkit doctor`.
 */
export function writeIntent(
  opts: {
    root: string;
    branch: string;
    mode: string;
    title: string;
    base?: string;
    links: string[];
    noQavisPublish: boolean;
    resumed: boolean;
    mergePaths: boolean;
    /** The generation this attempt READ before deciding to re-record. When the on-disk record has
     * moved past it (a concurrent FULL invocation re-recorded newer metadata), the write is
     * skipped: the newer record wins and this attempt runs unrecorded. */
    expectGeneration?: string;
    donatePaths?: string[];
    body: Buffer;
  },
  paths: string[],
): number {
  if (opts.mode !== 'ship' && opts.mode !== 'reship')
    return fail(`--mode must be ship|reship (got '${opts.mode}')`);
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
  const intent: ShipIntent = {
    version: SCHEMA_VERSION,
    mode: opts.mode,
    branch: opts.branch,
    title: opts.title,
    base: opts.base || null,
    links: opts.links,
    paths,
    noQavisPublish: opts.noQavisPublish,
    bodyB64: opts.body.toString('base64'),
    repo: originRepo(opts.root),
    createdAt: new Date().toISOString(),
    // Random, not the timestamp: two same-millisecond attempts must never share the ownership
    // token the compare-and-delete matches on.
    generation: randomUUID(),
    devkitVersion: devkitVersion(),
  };
  const file = intentFile(opts.root, opts.branch);
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    // Writers and the compare-and-delete below share one lock, so read-then-replace interleavings
    // cannot happen; within it the write stays temp+rename (a crash mid-write leaves the prior
    // record) at 0600 from the first byte.
    let superseded = false;
    withLock(`${file}.lock`, () => {
      // Resume writes UNION paths with whatever is on disk at this instant, and CAS on the
      // generation the resume READ: a concurrent full invocation that re-recorded newer
      // title/body/base must not be overwritten by this attempt's stale copy of them, and a
      // record DELETED since the read (spent by a concurrent success) must stay spent.
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
        // A resume that lost the race still contributes ONLY the paths this retry explicitly
        // briefed (donatePaths) to whoever owns the record now — metadata and the ownership token
        // stay the owner's. Its stale copy of the RECORDED list must not leak in: the newer full
        // invocation may have deliberately dropped those paths, and re-adding them would corrupt
        // its scope. A deleted record stays deleted.
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
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(intent, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, file);
    });
    if (superseded) {
      console.error('ship-intent: record superseded by a concurrent attempt — running unrecorded');
      return 0; // no stdout token: this attempt owns nothing and must not delete on success
    }
  } catch (e: unknown) {
    return fail(e instanceof Error ? e.message : String(e)); // lock contention → record nothing
  }
  // The ownership token, on stdout for the caller to hand back to `delete --generation`: a success
  // may delete ONLY the record its own attempt wrote, never a concurrent attempt's newer one.
  process.stdout.write(`${intent.generation}\n`);
  emitShipIntentEvent(intent, opts.resumed);
  return 0;
}

/**
 * Delete the record — unconditionally without `generation`, else only when the stored generation
 * matches (compare-and-delete, the receipt ref's own discipline): a concurrent attempt that
 * re-recorded between this attempt's write and its success keeps its newer record for `--resume`.
 * With `shippedPaths`, a matching record is still KEPT when it names paths this push did not ship
 * — a losing resume donates its remedy paths into the owner's record, and the owner's success must
 * not destroy the only resumable copy of that unshipped remedy. The read-compare-rm runs under the
 * same lock the writer takes, so a replace cannot slip between the compare and the rm.
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
      if (generation) {
        let stored: StoredIntent;
        try {
          // SAFETY: only generation + paths are read, each re-proven by its proven* helper — a
          // corrupt record compares unequal and stays.
          stored = JSON.parse(readFileSync(file, 'utf8')) as StoredIntent;
        } catch {
          return; // absent/torn — nothing this attempt owns
        }
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
  if (r.version !== SCHEMA_VERSION)
    return {
      reason: `recorded invocation has unknown version ${String(r.version)} — run the full command, which re-records`,
    };
  const mode = r.mode;
  if (mode !== 'ship' && mode !== 'reship')
    return {
      reason: `recorded invocation has no valid mode (${file}) — run the full command, which re-records`,
    };
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
  const generation = provenString(r.generation);
  if (!generation)
    return {
      reason: `recorded invocation is malformed (generation) — run the full command, which re-records`,
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
  return {
    intent: {
      version: SCHEMA_VERSION,
      mode,
      branch,
      title,
      base: provenString(r.base),
      links,
      paths,
      noQavisPublish,
      bodyB64,
      repo,
      createdAt,
      generation,
      devkitVersion: provenString(r.devkitVersion) ?? '',
    },
  };
}

interface StoredIntent {
  version?: number;
  mode?: string;
  branch?: string;
  title?: string;
  base?: string | null;
  links?: string[];
  paths?: string[];
  noQavisPublish?: boolean;
  bodyB64?: string;
  repo?: string;
  createdAt?: string;
  generation?: string;
  devkitVersion?: string;
}

/** The value when it really is a NUL-free string primitive, else null. The String() round-trip is
 * the runtime proof the optimistic StoredIntent typing does not give; the NUL refusal protects the
 * NUL-delimited read protocol from a tampered record's JSON-encoded U+0000 splitting a field. */
function provenString(v: string | null | undefined): string | null {
  return v != null && String(v) === v && !v.includes('\0') ? v : null;
}
/** Every element a proven string primitive → the array; anything else → null. */
function provenStrings(v: string[] | undefined): string[] | null {
  if (!Array.isArray(v)) return null;
  for (const e of v) if (provenString(e) === null) return null;
  return v;
}

/**
 * Field order the bash side depends on (each field NUL-terminated, body decoded to bytes):
 *   mode, title, base ('' when null), noQavisPublish (0|1), createdAt, generation, nlinks,
 *   <links...>, body, <paths...>
 * Counts precede the one variable-length list that is FOLLOWED by more fields; paths run to EOF so
 * they need none. bash 3.2 reads this with plain `read -r -d ''` — no mapfile, no arrays-by-name.
 */
function emitFields(intent: ShipIntent): void {
  const out: (string | Buffer)[] = [
    intent.mode,
    intent.title,
    intent.base ?? '',
    intent.noQavisPublish ? '1' : '0',
    intent.createdAt,
    intent.generation,
    String(intent.links.length),
    ...intent.links,
    Buffer.from(intent.bodyB64, 'base64'),
    ...intent.paths,
  ];
  for (const f of out) {
    process.stdout.write(f);
    process.stdout.write('\0');
  }
}

function main(): number {
  const [sub, ...rest] = process.argv.slice(2);
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
        title,
        base: values.get('base'),
        links,
        noQavisPublish: booleans.has('no-qavis-publish'),
        resumed: booleans.has('resumed'),
        mergePaths: booleans.has('merge-paths'),
        expectGeneration: values.get('expect-generation'),
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
  if (sub === 'delete')
    return deleteIntent(
      root,
      branch,
      values.get('generation'),
      paths.length > 0 ? paths : undefined,
    );
  return fail(`unknown subcommand '${String(sub)}' (write|read|delete)`);
}

// CLI entrypoint only — an import (the colocated test) must not exit. Realpath so a symlinked
// module dir still matches; same guard as reconcile-manifest-write.mts.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  process.exit(main());
