/**
 * Shared plumbing for the two base-drift hooks (baseDrift component).
 *
 * These hooks are SYNCED into consumer repos as standalone scripts — the same constraint
 * decision-edit-guard.mjs states in its header — so they cannot import cli/lib. They shell out to
 * `devkit base-status --json` instead of reimplementing base resolution, the TTL fetch protocol and
 * the merge-base diff. Two implementations of one question would be ~150 lines duplicated into
 * untyped .mjs outside the test surface, would trip the clone gate, and would be free to disagree
 * about whether the base moved — which is the failure this feature exists to prevent.
 *
 * Absent binary ⇒ silent no-op, exactly as decision-scope-brief.mjs treats a missing
 * guard-decisions. In a repo with no devkit installed there is no base-drift feature to be wrong.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * The OUTER bound, which must comfortably exceed everything base-status budgets for itself: a cold
 * node start, its 2.5s fetch cap, and the handful of local git calls after it. Set too close to that
 * sum, this timeout starts killing runs that were about to answer — and a killed run is
 * indistinguishable from "no devkit", so a real drift or a loud UNKNOWN would be discarded in
 * silence. Only the first call in a TTL window can approach it; the rest are served from cache.
 */
const CALL_TIMEOUT_MS = 15_000;

export function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
}

/** The consumer's own devkit, then a PATH one. Absent ⇒ this repo does not use devkit. */
export function resolveBin(root) {
  const local = path.join(root, 'node_modules', '.bin', 'devkit');
  if (existsSync(local)) return local;
  const which = spawnSync('command', ['-v', 'devkit'], { encoding: 'utf8', shell: true });
  return which.stdout?.trim() || null;
}

/**
 * Run `devkit base-status --json` and parse the report. Null on anything unexpected.
 *
 * --exit-zero because a drift verdict is exit 3 and this is an advisory caller: the report is the
 * payload, the code is not.
 */
export function fetchReport(root, { paths = [], maxAgeMs = null, cachedOk = false } = {}) {
  const bin = resolveBin(root);
  if (!bin) return null;
  const args = ['base-status', '--json', '--exit-zero', '--root', root];
  // Omitting both makes base-status force a fetch, which is right for an explicit query and wrong
  // for the pre-edit path — that one must ride the shared window or every edit hits the network.
  if (cachedOk) args.push('--cached-ok');
  if (maxAgeMs !== null) args.push('--max-age-ms', String(maxAgeMs));
  if (paths.length > 0) args.push('--', ...paths);
  try {
    const run = spawnSync(bin, args, { cwd: root, encoding: 'utf8', timeout: CALL_TIMEOUT_MS });
    if (run.status !== 0 || !run.stdout?.trim()) return null;
    const report = JSON.parse(run.stdout);
    // The schema tag IS the decode: only a shape that declares itself as this contract is accepted.
    // A string, a number or null all answer `undefined` here and are rejected on the same branch.
    return report?.schema === 1 ? report : null;
  } catch {
    return null;
  }
}

/**
 * Where one dedup stamp lives. The token an entry contributes is its `rearm`, which folds in the
 * BASE SHA — that is what makes a second move of the base re-arm everything, since a (session, path)
 * key alone goes quiet after the first move and sc-2297's base moved twice. Session id is hashed
 * rather than interpolated for the reason prior-art-gate.mjs gives: it arrives from harness stdin,
 * and a path-shaped value would otherwise escape the namespace directory.
 */
function stampPath(namespace, sessionId, token) {
  const session = createHash('sha256').update(String(sessionId ?? 'unknown')).digest('hex').slice(0, 12);
  return path.join(tmpdir(), namespace, `${session}-${token}`);
}

/** Has this exact thing already been briefed to this session? Unreadable state answers "no". */
export function claimed(namespace, sessionId, token) {
  try {
    return existsSync(stampPath(namespace, sessionId, token));
  } catch {
    return false;
  }
}

/**
 * Record that it HAS been briefed — called only after delivery succeeded.
 *
 * Deliberately check-then-commit rather than an atomic exclusive create. An atomic claim taken
 * BEFORE delivery has a hole: the loser of the race stays silent, and if the winner's write then
 * fails, nobody briefed at all. Ordering it this way can only ever produce a duplicate advisory
 * under true concurrency, and repeating a warning is strictly better than swallowing one.
 */
export function commitClaim(namespace, sessionId, token) {
  try {
    mkdirSync(path.join(tmpdir(), namespace), { recursive: true });
    writeFileSync(stampPath(namespace, sessionId, token), '');
  } catch {
    // Unrecordable ⇒ this may brief again later. Noisier, never silent.
  }
}

/**
 * The advisory envelope each surface actually reads. Cursor ignores Claude's `hookSpecificOutput`
 * wrapper, so sending it there delivers nothing — the same vendor split decision-edit-guard.mjs
 * handles in renderOutput, minus its `permission` key: this must never deny an edit, and must never
 * answer `allow`, which would strip the user's own permission prompts.
 */
export function renderAdvisory(input, hookEventName, additionalContext) {
  if (input?.cursor_version) return { agent_message: additionalContext };
  return { hookSpecificOutput: { hookEventName, additionalContext } };
}

/** Deliver the advisory. Returns true only when it actually landed. */
export function emit(input, hookEventName, additionalContext) {
  try {
    process.stdout.write(`${JSON.stringify(renderAdvisory(input, hookEventName, additionalContext))}\n`);
    return true;
  } catch {
    return false;
  }
}

export function projectRoot() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}
