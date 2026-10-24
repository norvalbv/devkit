/** The recorded ship invocation's on-disk identity (path + schema version) and its fail-closed
 * reader; `ship-intent.mts` owns writes, deletes and the CLI. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  advisoryBodyFile,
  freshRecordStamp,
  originRepo,
  provenBool,
  provenString,
  provenStrings,
  sourceMembershipMatches,
  type ShipIntent,
  type StoredIntent,
} from '../ship-intent-codec.mts';

const LEGACY_EXPLICIT_SCHEMA_VERSION = 1;
export const EXPLICIT_SCHEMA_VERSION = 2;
export const BRANCH_SCHEMA_VERSION = 3;

/** The raw-branch hash separates sanitized-name collisions; readIntent's raw branch equality is
 * the final guarantee that a copied or colliding file never replays another branch's invocation. */
export const relIntentPath = (branch: string) => {
  const digest = createHash('sha256').update(branch).digest('hex').slice(0, 8);
  return `.devkit/ship-intent-${branch.replace(/\//g, '-').slice(0, 120)}-${digest}.json`;
};

export const intentFile = (root: string, branch: string) => path.join(root, relIntentPath(branch));

/** The one refusal wording for a record field that failed its shape check. */
const malformedField = (f: string) =>
  `recorded invocation is malformed (${f}) — run the full command, which re-records`;

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
      reason: `no recorded ship invocation for '${branch}' — run the full devkit ship command once (an attempt records once it reaches the blocking preflights; argument, branch and nothing-to-commit refusals and --dry-gates never record)`,
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
  // Each defaults to what an OLDER record implies, then is strict-checked by provenBool (see its
  // coercion note); one at a time so each narrows to boolean without an assertion. V1 is
  // preserve-only for updatePrBody. `draft` and `noStack` post-date every version, so an ABSENT bit
  // means false (a ready PR) — refusing would strand an in-flight blocked ship mid---resume. Only
  // `undefined` is absence: `?? false` would also swallow a PRESENT null and publish ready.
  const legacy = storedVersion === LEGACY_EXPLICIT_SCHEMA_VERSION;
  const updatePrBody = provenBool(legacy ? false : r.updatePrBody);
  if (updatePrBody === null) return { reason: malformedField('updatePrBody') };
  const draft = provenBool(r.draft === undefined ? false : r.draft);
  if (draft === null) return { reason: malformedField('draft') };
  const noStack = provenBool(r.noStack === undefined ? false : r.noStack);
  if (noStack === null) return { reason: malformedField('noStack') };
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
  if (!freshRecordStamp(createdAt, nowMs))
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
    updatePrBody,
    draft,
    noStack,
    bodyB64,
    repo,
    createdAt,
    generation,
    devkitVersion: provenString(r.devkitVersion) ?? '',
  };
  if (sourceAttemptId) intent.sourceAttemptId = sourceAttemptId;
  intent.bodyFile = advisoryBodyFile(r.bodyFile);
  return { intent };
}
