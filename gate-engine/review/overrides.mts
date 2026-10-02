/**
 * Correctness override valve — a block-with-acknowledgement gate for the single-pass reviewers.
 *
 * The correctness reviewer runs single-pass (recall ~0.81 / precision ~0.80 — see reviewers.mts
 * Reviewer.model). A 0.80-precision HARD block would false-block ~1-in-5 clean commits and get
 * disabled. Warn-only doesn't help — the commit still lands and the external bots still comment,
 * which is exactly what this reviewer exists to pre-empt. So a FAIL BLOCKS, but each finding can be
 * overridden with a stated rationale: a real bug can't be honestly waived (so it gets fixed →
 * pre-empted), a false positive is waived with a recorded reason (→ no friction, and the rationale
 * is the signal to sharpen the reviewer later). Same shape as the dup-detection allowlist.
 *
 * A finding's FINGERPRINT = sha12(reviewer + failed-lens + sha256(diffCacheIdentity(the staged
 * diff it reviewed))) — the same normalized identity the review-cache keys use (judge/diff-focus),
 * so a purely-sentry-additive restage keeps a recorded waiver while any real change VOIDS it — a
 * stale override can never silently suppress a NEW bug. Granularity is per-lens-per-diff (the
 * correctness state-file fails at the lens level); the rationale covers "the <lens> concern on
 * this staged diff, waived because …".
 *
 * Two channels, merged (env wins and is persisted so it survives the next commit):
 *  - Committed file `.devkit/correctness-overrides.json`: { <fp>: { rationale, at, by } } — shared,
 *    auditable, the durable record.
 *  - Env `OVERRIDE_<fp>_RATIONALE="…"`: an ergonomic channel for a committing agent mid-loop; read
 *    on the fly AND written through to the file.
 */

import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { CORRECTNESS_OVERRIDES_FILE as OVERRIDES_FILE } from '../deterministic/gate-inputs.mts';
import { diffCacheIdentity } from '../judge/diff-focus.mts';
import { emitGateEvent } from '../judge/gate-events.mts';
import { reviewBaseContext, shortSha } from './evidence/base-context.mts';
import {
  conventionWaiverLenses,
  parseConventionFindingCandidates,
} from './evidence/conventions.mts';
import type { LensDisposition } from './evidence/items.mts';
import type { ReviewerSelection } from './reviewers.mts';
import type { ChecklistState, ReviewOutcome } from './runtime.mts';

/** A fingerprint (see `fingerprint` below) is always this shape — shared by the env-var parser and
 * the `waive` CLI's itemId validation, so both channels accept exactly the same ids. */
export const FINGERPRINT_RE = /^[0-9a-f]{12}$/;
const ENV_RE = new RegExp(`^OVERRIDE_(${FINGERPRINT_RE.source.slice(1, -1)})_RATIONALE$`);

const sha12 = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12);

/** Bound on the rationale copied into a `waiver_created` event: the sink's atomic-append contract
 * is sub-4KB lines (gate-events.mts), and the FULL rationale already lives in the store file. */
export const WAIVER_RATIONALE_EVENT_CAP = 400;
/** Same contract for the lens: a conventions lens embeds two caller-supplied paths
 * (conventionWaiverLens), so it is as unbounded as the rationale — the store keeps the full value. */
export const WAIVER_LENS_EVENT_CAP = 200;

/** One recorded override. `reviewer`/`lens`/`itemId`/`author` are populated by the `waive` CLI
 * (waive.mts) for its own audit trail; the env/file channels only ever set rationale/at/by. */
export interface OverrideEntry {
  rationale: string;
  at?: string;
  by?: 'env' | 'file' | 'cli' | string;
  reviewer?: string;
  lens?: string;
  itemId?: string;
  author?: string;
  /** The tree the waived finding was judged against. Absent when the recording channel could not
   * prove one — a waiver stamped with the waiving agent's own HEAD would be the very false alibi
   * this field exists to prevent (sc-2480). */
  baseSha?: string;
}

/** Stable per-finding fingerprint: reviewer + failed lens + the reviewed diff's CACHE IDENTITY
 * (diffCacheIdentity — sentry-additive lines normalized out, matching the review-cache keys). A
 * recorded waiver therefore survives the purely-sentry-additive restage the sentry gate demands,
 * and still VOIDS on any real change — a stale override can never suppress a NEW bug. */
export function fingerprint(reviewerName: string, lens: string, diffText: string): string {
  const digest = createHash('sha256').update(diffCacheIdentity(diffText)).digest('hex');
  return sha12(`${reviewerName}\x00${lens}\x00${digest}`);
}

/** Parse the committed override store (missing/corrupt → empty — a broken file must never suppress). */
export function loadOverrides(cwd: string): Record<string, OverrideEntry> {
  try {
    const raw = JSON.parse(readFileSync(path.resolve(cwd, OVERRIDES_FILE), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

/** `OVERRIDE_<fp>_RATIONALE` env vars → { fp: rationale } (blank rationale ignored — no silent waive). */
export function envOverrides(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const m = key.match(ENV_RE);
    if (m && value?.trim()) out[m[1]] = value.trim();
  }
  return out;
}

/** Full read-modify-write of the override store. Exported so `waive` (waive.mts) writes through
 * the SAME path env-channel writes already use — never a naive overwrite, so a waive for one
 * reviewer/lens can never clobber another's already-recorded entry on the same store file. */
export function persist(cwd: string, store: Record<string, OverrideEntry>): void {
  const file = path.resolve(cwd, OVERRIDES_FILE);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`);
}

/** Lock key: `devkit ship` symlinks the store into its gate worktree, so checkout and worktree must key
 * on the ONE resolved file. An absent store or a dangling link (checkout copy deleted mid-ship) defeats
 * realpath, so follow the link text and canonicalize the parent instead. */
function overridesLockTarget(cwd: string): string {
  let file = path.resolve(cwd, OVERRIDES_FILE);
  try {
    return realpathSync(file);
  } catch {
    // absent or dangling — resolved below
  }
  for (let hop = 0; hop < 8; hop++) {
    try {
      file = path.resolve(path.dirname(file), readlinkSync(file));
    } catch {
      break; // not a link: `file` is the final target
    }
  }
  try {
    return path.join(realpathSync(path.dirname(file)), path.basename(file));
  } catch {
    return file;
  }
}

/**
 * Cross-PROCESS exclusive lock around any load→mutate→persist of the store: a `guard-review
 * waive` CLI and a concurrent gate run's `reconcile` (env-channel write-through) would otherwise
 * both read the same snapshot and the second `persist` would silently drop the first's entry.
 * In-process overlap is impossible — every caller's RMW is fully synchronous — so a file lock is
 * the whole story. `wx` creation is the atomicity; a lock older than 30 s is a crashed process,
 * stolen ATOMICALLY via rename-to-unique (exactly one stealer wins; the loser retries against the
 * winner's fresh lock and gets the retry error). fn runs inside try/finally — the lock never
 * outlives the call.
 */
export function withOverridesLock<T>(cwd: string, fn: () => T): T {
  const lockPath = `${overridesLockTarget(cwd)}.lock`;
  mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(lockPath, `${process.pid}\n`, { flag: 'wx' });
    } catch (e) {
      if ((e as { code?: string }).code !== 'EEXIST') throw e;
      let stale = false;
      try {
        stale = Date.now() - statSync(lockPath).mtimeMs > 30_000;
      } catch {
        continue; // lock vanished between EEXIST and stat — retry the wx create
      }
      if (stale) {
        try {
          const aside = `${lockPath}.stale.${process.pid}`;
          renameSync(lockPath, aside);
          unlinkSync(aside);
        } catch {
          /* another process stole it first — fall through to retry */
        }
        continue;
      }
      throw new Error('another guard-review process holds the overrides lock — retry in a moment');
    }
    try {
      return fn();
    } finally {
      try {
        unlinkSync(lockPath);
      } catch {
        /* already gone */
      }
    }
  }
  throw new Error('could not acquire the overrides lock');
}

/** Reconciliation of one reviewer's failed lenses against the override store + env. */
export interface RecordedWaiver {
  lens: string;
  fingerprint: string;
  rationale: string;
  recorded_at: string | null;
  recorded_by: string;
  /** Who recorded it (git identity), when the entry carries one — only the `waive` CLI populates
   * this today. Absent (never `null`) so older env/file entries round-trip unchanged. */
  author?: string;
}

export interface Reconciliation {
  suppressed: RecordedWaiver[];
  blocking: { lens: string; fp: string }[];
}

/**
 * Split a single-pass reviewer's failed lenses into suppressed (an override with a non-empty
 * rationale exists) vs blocking. Env overrides are persisted through to the file so they survive.
 * `now` is injected (the gate passes new Date().toISOString(); callers in test pass a fixed stamp).
 */
export function reconcile(
  cwd: string,
  reviewerName: string,
  failedLenses: string[],
  diffText: string,
  now: string,
  env: NodeJS.ProcessEnv = process.env,
): Reconciliation {
  const created: { lens: string; fp: string; rationale: string }[] = [];
  const baseSha = reviewBaseContext(cwd, env).baseSha;
  const result = withOverridesLock(cwd, () => {
    const store = loadOverrides(cwd);
    const envO = envOverrides(env);
    let changed = false;
    const suppressed: Reconciliation['suppressed'] = [];
    const blocking: Reconciliation['blocking'] = [];
    for (const lens of failedLenses) {
      const fp = fingerprint(reviewerName, lens, diffText);
      const envRationale = envO[fp];
      // The fingerprint is base-INDEPENDENT (reviewer + lens + diff identity), so the SAME entry
      // recurs under a moved base. A new/changed rationale is a new waiver; an unchanged one under a
      // different tree is the same waiver whose provenance went stale, and only the base is restated.
      const staleBase = Boolean(store[fp]) && store[fp].baseSha !== (baseSha ?? undefined);
      if (envRationale && (!store[fp] || store[fp].rationale !== envRationale)) {
        store[fp] = {
          ...store[fp],
          rationale: envRationale,
          at: now,
          by: 'env',
          ...(baseSha ? { baseSha } : { baseSha: undefined }),
        };
        changed = true;
        created.push({ lens, fp, rationale: envRationale });
      } else if (envRationale && staleBase) {
        store[fp] = { ...store[fp], ...(baseSha ? { baseSha } : { baseSha: undefined }) };
        changed = true;
      }
      const entry = store[fp];
      if (entry?.rationale?.trim())
        suppressed.push({
          lens,
          fingerprint: fp,
          rationale: entry.rationale,
          recorded_at: typeof entry.at === 'string' ? entry.at : null,
          recorded_by:
            typeof entry.by === 'string' && entry.by.trim().length > 0 ? entry.by.trim() : 'file',
          ...(typeof entry.author === 'string' && entry.author.trim()
            ? { author: entry.author.trim() }
            : {}),
        });
      else blocking.push({ lens, fp });
    }
    if (changed) persist(cwd, store);
    return { suppressed, blocking };
  });
  // Same contract as the waive CLI: one waiver_created per newly persisted (or rationale-changed)
  // fingerprint, never per read — emitted AFTER the lock releases (the lock is try-once, so I/O
  // inside it makes a concurrent waive fail immediately), with recorded_at carrying the store
  // entry's authoritative timestamp since ledger append order across processes is unordered.
  for (const c of created)
    emitGateEvent({
      type: 'waiver_created',
      reviewer: reviewerName,
      lens: c.lens.slice(0, WAIVER_LENS_EVENT_CAP),
      fingerprint: c.fp,
      rationale: c.rationale.slice(0, WAIVER_RATIONALE_EVENT_CAP),
      recorded_at: now,
      by: 'env',
      base_sha: baseSha,
    });
  return result;
}

// Deterministic domain-exclusivity guard for the bench-measured cross-domain false-blocks
// (xdomain-sqli / xdomain-render: correctness FAILs a lens for a defect the security/performance
// reviewers own — see agents/correctness-reviewer.md <exclusions>). ONE-SIDED and best-effort:
// drops a failing lens ONLY when its reason matches an out-of-charter keyword AND matches NO
// correctness-signal keyword — biased to UNDER-fire (keep the FAIL when in doubt) so it carries no
// recall cost. It is NOT a semantic arbiter and NOT a guarantee: its safety is proportional to the
// CORRECTNESS_SIGNAL coverage below, so that list is kept deliberately broad. Covers cross-domain
// leaks ONLY (2 of the bench's 4 false-blocks). The in-domain surface-cue false-blocks want K-sample
// self-consistency with an asymmetric block rule (Wang 2203.11171), NOT a same-family verify/refute
// pass — such a pass overturns real FAILs (measured 0.78→0.67 here; Huang 2310.01798, Stechly
// 2402.08115) and only pays off cross-family (Lu 2512.02304). Precision to ~0.95 is also unmeasurable
// until the decoy corpus grows (n=28 → clean-pass CI [.69,.94]).
const OUT_OF_CHARTER =
  /\b(sql|injection|xss|csrf|sanitiz|escap|secrets?|credentials?|deserializ|n\+1|select\s+\*|pagination|unbounded|re-?render|bundle\s?size|memoiz|throughput|latenc|perf(ormance)?)\b/i;
// Deliberately broad — every miss here risks dropping a real FAIL, so err toward inclusion.
const CORRECTNESS_SIGNAL =
  /\b(race|interleav|concurren|clobber|overwrit|overwrote|lost\s?update|stale|reset|invalidat|discard|dropped|unhandled|unchecked|ignored\s+(return|result|error)|missing|contract|signature|call\s?site|broadcast|dedup|classif|pars(e|ing)|off-by|wrong\s+(result|state|value)|incorrect|stuck|deadlock|leak|finally|rollback|revert|strand|CAS|atomic|toctou|check[\s-]?then[\s-]?act|order(ing)?|sequenc|idempoten|mutat|await|promise|callback|null|undefined|double[\s-]?(fire|write)|early\s+(return|exit)|exit\s?code|fall[\s-]?through|latch|unclaim|revive|cancel|retry|resum|recover)\b/i;

/** Partition a checklist's failing lenses into ones that still block (`kept`) and ones dropped as
 * out-of-charter (`dropped`). A lens drops only when its issues are unambiguously security/perf. */
export function domainExclusivityDrop(
  items: { name?: string; status?: string; issues?: string[] }[] = [],
): { kept: string[]; dropped: { lens: string; reason: string }[] } {
  const kept: string[] = [];
  const dropped: { lens: string; reason: string }[] = [];
  for (const it of items) {
    if (it.status !== 'fail') continue;
    const lens = it.name ?? '(finding)';
    const text = (it.issues ?? []).join(' \n ');
    if (text && OUT_OF_CHARTER.test(text) && !CORRECTNESS_SIGNAL.test(text))
      dropped.push({ lens, reason: text });
    else kept.push(lens);
  }
  return { kept, dropped };
}

/**
 * Apply the valve to one completed outcome, mutating `res` to its post-valve verdict and returning
 * the per-lens disposition the evidence layer records.
 *
 * Lives here rather than in the cascade because this IS the valve — reconcile/blockingNote above are
 * its parts, and the cascade only needs to know a pinned FAIL gets reconciled. Only pinned
 * single-pass reviewers reach it (`reviewer.model`): a cascading reviewer's FAIL is already
 * opus-confirmed, so there is nothing to acknowledge.
 *
 * A checklist reviewer's lens is the checklist item name; a skill-less one's is the offending FILE
 * plus the rule it breaks (conventionWaiverLens) — not the line, which a judge re-picks every run. Neither uses the free-text VERDICT reason — a haiku judge's
 * one-line paraphrase of the SAME violation varies run-to-run on byte-identical input, which would
 * silently un-match a dev's already-committed waiver and re-block them.
 */
export function applyOverrideValve(
  sel: ReviewerSelection,
  res: ReviewOutcome,
  cwd: string,
  io: { readState: () => ChecklistState | null; stagedDiff: () => string },
): Map<string, LensDisposition> {
  const disposition = new Map<string, LensDisposition>();
  if (res.status !== 'fail' || !sel.reviewer.model) return disposition;
  const items = io.readState()?.items ?? [];
  const failedCount = items.filter((i) => i.status === 'fail').length;
  // Domain-exclusivity guard (checklist reviewers only): drop failing lenses flagging a
  // security/performance defect this reviewer must stay silent on. One-sided/best-effort (see
  // domainExclusivityDrop); conventions has no checklist, so this is a no-op there.
  const { kept, dropped } = domainExclusivityDrop(items);
  for (const d of dropped) {
    disposition.set(d.lens, 'dropped_out_of_charter');
    console.error(
      `guard-review: ${sel.reviewer.name} — ${d.lens} dropped as out-of-charter (security/performance is another reviewer's finding)`,
    );
  }
  // Contract-validated lenses first (sc-3580): an ungrounded pair must not block or need a waiver.
  const conventionLenses =
    res.blockingLenses ??
    conventionWaiverLenses(parseConventionFindingCandidates(res.transcript ?? ''));
  const failedLenses = sel.reviewer.stateFile ? kept : conventionLenses;
  // All checklist lenses dropped as out-of-charter → not a correctness block (checklist reviewers only).
  if (sel.reviewer.stateFile && failedCount > 0 && kept.length === 0) {
    res.status = 'pass';
    res.reason = `${dropped.length} out-of-charter finding(s) dropped (owned by security/performance reviewer)`;
    return disposition;
  }
  const lenses = failedLenses.length > 0 ? failedLenses : ['(finding)'];
  const { suppressed, blocking } = reconcile(
    cwd,
    sel.reviewer.name,
    lenses,
    io.stagedDiff(),
    new Date().toISOString(),
  );
  if (suppressed.length > 0) res.waivers = suppressed;
  for (const s of suppressed) {
    disposition.set(s.lens, 'waived');
    console.error(
      `guard-review: ${sel.reviewer.name} — ${s.lens} overridden [${s.fingerprint}]: ${s.rationale}`,
    );
  }
  for (const b of blocking) disposition.set(b.lens, 'blocking');
  if (blocking.length === 0) {
    res.status = 'pass';
    res.reason = `all ${suppressed.length} finding(s) overridden`;
  } else {
    res.reason = blockingNote(sel.reviewer.name, blocking, reviewBaseContext(cwd).baseSha);
  }
  return disposition;
}

// A conventions lens embeds the cited file path, which may hold spaces or shell metacharacters.
const SHELL_SAFE_WORD_RE = /^[\w@./:#+=,-]+$/;
const shellWord = (word: string) =>
  SHELL_SAFE_WORD_RE.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;

/** The human-facing block note for un-overridden findings — prints the exact override affordance.
 * The `--base` the command carries is the tree the finding was judged against: it makes the copied
 * command self-describing, and it is the only channel that can supply one, since the waive CLI runs
 * later in the agent's own worktree with none of the gate's environment (sc-2480). */
export function blockingNote(
  reviewerName: string,
  blocking: Reconciliation['blocking'],
  baseSha: string | null = null,
): string {
  if (blocking.length === 0) return '';
  const base = baseSha ? ` --base ${shortSha(baseSha)}` : '';
  const lines = blocking.map(
    (b) =>
      `  • ${b.lens} [${b.fp}] — fix it, or waive with a reason:\n` +
      `      guard-review waive ${shellWord(`${reviewerName}:${b.lens}`)} ${b.fp}${base} "why this is not a real defect"\n` +
      `      (or OVERRIDE_${b.fp}_RATIONALE="…" / add it to ${OVERRIDES_FILE})`,
  );
  return (
    `${reviewerName}: ${blocking.length} un-overridden finding(s) block this commit.\n` +
    `${lines.join('\n')}`
  );
}

/** Recovery guidance for a cascade-confirmed FAIL, whose per-finding valve is intentionally closed. */
export function reviewerSkipRemedy(reviewerName: string): string {
  return (
    `Fix the confirmed finding, or — with the user's explicit OK on a judged false positive or ` +
    `accepted residual — ` +
    `run only the retry command as: env GUARD_REVIEW_SKIP=${reviewerName} <retry command>. ` +
    `This skips only ${reviewerName}; ` +
    `every other reviewer still runs. GUARD_NO_REVIEW=1 skips the entire review gate.`
  );
}
