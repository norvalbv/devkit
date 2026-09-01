/**
 * `guard-review waive` — the ergonomic CLI affordance for the override valve (overrides.mts).
 *
 * Writes ONE entry into the same `.devkit/correctness-overrides.json` store the env-var channel
 * (OVERRIDE_<fp>_RATIONALE) already writes through to — no new storage, no new consumption path.
 * The NEXT `guard-review --gate` picks it up via the existing reconcile()/loadOverrides() merge
 * (run-review.mts → applyOverrideValve). This command only WRITES; it never re-runs the gate.
 *
 * `itemId` is the exact 12-hex fingerprint blockingNote prints for a blocked finding (`[<fp>]`) —
 * copy it verbatim from the FAIL output rather than re-deriving it here. Re-deriving would mean
 * re-running the SAME reviewer-selection + `git diff --cached` the gate used, which silently drifts
 * the moment the staged diff changes between the FAIL and the waive; keying off the printed fp
 * avoids that entirely and matches exactly what reconcile() will hash against on the next run.
 *
 * Only reviewers pinned to a model (Reviewer.model — correctness-reviewer, conventions-reviewer)
 * reach the override valve at all (applyOverrideValve's `!sel.reviewer.model` guard, overrides.mts).
 * The five cascade reviewers' FAILs are opus-confirmed and have no override affordance today; this
 * command refuses them rather than silently writing a store entry reconcile() will never consult.
 */
import { execFileSync } from 'node:child_process';
import { emitGateEvent } from '../../judge/gate-events.mts';
import {
  FINGERPRINT_RE,
  loadOverrides,
  type OverrideEntry,
  persist,
  reviewerSkipRemedy,
  WAIVER_LENS_EVENT_CAP,
  WAIVER_RATIONALE_EVENT_CAP,
  withOverridesLock,
} from '../overrides.mts';
import { REVIEWERS, type Reviewer } from '../reviewers.mts';

// REVIEWERS is a frozen literal-typed tuple (each entry's own field set, not a common `Reviewer`
// shape), so `.find` on it directly can't be read through the shared `model` field below — every
// entry IS structurally a `Reviewer` (optional fields simply absent), so this cast is sound.
const REVIEWER_TABLE: readonly Reviewer[] = REVIEWERS;

const RATIONALE_MIN_CHARS = 15;
// A dev pasting the exact hint text from blockingNote (or another generic non-answer) is not a
// waive — envOverrides already treats a blank rationale as "no silent waive"; this extends the
// same intent to a non-blank but content-free one.
const PLACEHOLDER_RATIONALES = new Set([
  'why this is not a real defect',
  'not a real defect',
  'false positive',
  'n/a',
  'na',
  'todo',
  'placeholder',
  'waived',
  'fixed',
  'not a bug',
]);

const USAGE =
  'Usage: guard-review waive <reviewer>[:<lens>] <itemId> [--base <sha>] "<rationale>" | ' +
  'guard-review waive --list';

/** The base is copied from what the gate printed, never resolved here: this runs in the agent's own
 * worktree, so a locally-derived base would record a falsehood (sc-2480). */
function takeBaseFlag(rest: string[]) {
  const i = rest.indexOf('--base');
  if (i === -1) return { rest, baseSha: null, bad: false };
  const value = rest[i + 1]?.trim() ?? '';
  if (!/^[0-9a-f]{7,40}$/.test(value)) return { rest, baseSha: null, bad: true };
  return { rest: [...rest.slice(0, i), ...rest.slice(i + 2)], baseSha: value, bad: false };
}

/** Best-effort git identity for the audit trail: user.name, then user.email, then $USER — never
 * throws. `run` is injectable so tests never depend on the executing machine's real git identity. */
export function resolveWaiveAuthor(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  run: (args: string[]) => string = (args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim(),
): string {
  for (const args of [
    ['config', 'user.name'],
    ['config', 'user.email'],
  ]) {
    try {
      const v = run(args);
      if (v) return v;
    } catch {
      /* fall through to the next identity source */
    }
  }
  return env.USER || env.USERNAME || 'unknown';
}

/** Split `<reviewer>[:<lens>]` on the FIRST colon — a conventions lens is itself `path:line`, so a
 * naive split(':') on every colon would truncate it. Missing lens defaults to '(finding)',
 * matching reconcile's own fallback (overrides.mts) for a reviewer with no resolved lens. */
export function parseWaiveTarget(spec: string): { reviewer: string; lens: string } {
  const i = spec.indexOf(':');
  return i === -1
    ? { reviewer: spec, lens: '(finding)' }
    : { reviewer: spec.slice(0, i), lens: spec.slice(i + 1) };
}

function isPlaceholder(rationale: string): boolean {
  return PLACEHOLDER_RATIONALES.has(rationale.trim().toLowerCase());
}

/** `guard-review waive --list` — one entry per active store row (non-blank rationale), newest first. */
function listWaives(cwd: string): number {
  const store = loadOverrides(cwd);
  const entries = Object.entries(store).filter(([, e]) => e.rationale?.trim());
  if (entries.length === 0) {
    console.log('guard-review: no active waives.');
    return 0;
  }
  entries.sort(([, a], [, b]) => (b.at ?? '').localeCompare(a.at ?? ''));
  for (const [fp, e] of entries) {
    const who = e.author ?? (typeof e.by === 'string' ? e.by : 'unknown');
    console.log(
      `[${fp}] ${e.reviewer ?? '?'}:${e.lens ?? '(finding)'} — by ${who}${e.at ? ` at ${e.at}` : ''}` +
        (e.baseSha ? ` · judged against ${e.baseSha.slice(0, 12)}` : ' · base unrecorded'),
    );
    console.log(`    ${e.rationale}`);
  }
  return 0;
}

/** `guard-review waive <reviewer>[:<lens>] <itemId> <rationale>` → 0 on a recorded waive, 2 on a
 * refused/malformed request (matches the CLI's existing usage-error convention). `resolveAuthor`
 * is injectable so tests never depend on the executing machine's real git identity. */
export function runWaive(
  rest: string[],
  cwd: string = process.cwd(),
  resolveAuthor: (cwd: string) => string = resolveWaiveAuthor,
): number {
  if (rest[0] === '--list') return listWaives(cwd);
  const flag = takeBaseFlag(rest);
  if (flag.bad) {
    console.error('guard-review: waive — --base needs the base sha the FAIL output printed');
    return 2;
  }
  const [target, itemId, ...rationaleParts] = flag.rest;
  const rationale = rationaleParts.join(' ').trim();
  if (!target || !itemId || !rationale) {
    console.error(USAGE);
    return 2;
  }
  const { reviewer, lens } = parseWaiveTarget(target);
  const known = REVIEWER_TABLE.find((r) => r.name === reviewer);
  if (!known) {
    console.error(`guard-review: waive — unknown reviewer "${reviewer}"`);
    return 2;
  }
  if (!known.model) {
    console.error(
      `guard-review: waive — ${reviewer} is a cascade reviewer whose FAIL is already ` +
        `opus-confirmed; only a model-pinned reviewer (correctness-reviewer, conventions-reviewer) ` +
        `can be waived today. ${reviewerSkipRemedy(reviewer)}`,
    );
    return 2;
  }
  if (!FINGERPRINT_RE.test(itemId)) {
    console.error(
      `guard-review: waive — itemId must be the 12-hex fingerprint from the FAIL output, e.g. ` +
        `\`guard-review waive ${reviewer}:${lens} <fp-from-FAIL-output> "…"\` (got "${itemId}")`,
    );
    return 2;
  }
  if (rationale.length < RATIONALE_MIN_CHARS || isPlaceholder(rationale)) {
    console.error(
      `guard-review: waive — rationale must be a real, specific reason (>= ${RATIONALE_MIN_CHARS} ` +
        `chars, not a placeholder), got "${rationale}"`,
    );
    return 2;
  }
  // The lock is try-once (a held lock throws, not queues), so no telemetry I/O may run inside it —
  // the closure only decides and stamps. Telemetry counts DECISIONS: an identical re-run returns
  // null and adds no second ledger row. Append order across concurrent waives is unordered by
  // design; recorded_at (the store entry's own timestamp) is the authoritative decision time, and
  // the event's rationale copy is BOUNDED (the full text is the store entry) for the sink's
  // sub-4KB atomic-append contract.
  const recordedAt = withOverridesLock(cwd, () => {
    const store = loadOverrides(cwd);
    const prior = store[itemId];
    const entry: OverrideEntry = {
      rationale,
      reviewer,
      lens,
      itemId,
      author: resolveAuthor(cwd),
      at: new Date().toISOString(),
      by: 'cli',
    };
    if (flag.baseSha) entry.baseSha = flag.baseSha;
    store[itemId] = entry;
    persist(cwd, store);
    // A changed BASE is a new fact about an existing waiver, not a no-op: without an event the
    // ledger keeps only the first tree the finding was ever judged against (sc-2480).
    const changed = prior?.rationale !== rationale || prior?.baseSha !== entry.baseSha;
    return changed ? entry.at : null;
  });
  if (recordedAt)
    emitGateEvent({
      type: 'waiver_created',
      reviewer,
      lens: lens.slice(0, WAIVER_LENS_EVENT_CAP),
      fingerprint: itemId,
      rationale: rationale.slice(0, WAIVER_RATIONALE_EVENT_CAP),
      recorded_at: recordedAt,
      by: 'cli',
      base_sha: flag.baseSha,
    });
  console.error(`guard-review: waived ${reviewer}:${lens} [${itemId}] — ${rationale}`);
  return 0;
}
