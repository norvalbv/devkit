/**
 * Per-run identity + telemetry-sink resolution shared by the gate-events and transcript-store
 * side-channels. A `devkit ship` exports DEVKIT_SHIP_ID + DEVKIT_GATE_EVENTS and every in-chain gate
 * correlates under that ship. OFF a ship, EVERY commit is captured BY DEFAULT: the sink defaults to
 * ~/.devkit/telemetry/gate-events.jsonl and the run is correlated by the staged tree hash
 * (`git write-tree`), which is identical across a single commit's decisions + review gate processes
 * and unique per staged content — no shared env and no hook change required. The reviewers already
 * run on every commit, so this only PERSISTS output they already produce.
 *
 * Opt out with `DEVKIT_NO_TELEMETRY=1` — that disables ONLY the automatic every-commit capture; an
 * explicit ship (DEVKIT_SHIP_ID / DEVKIT_GATE_EVENTS set by the ship script) still emits.
 *
 * A commit run has no ship_attempt/ship_result wrapper (those come from the ship script), so the
 * gate events themselves carry `run_mode:'commit'` + repo + branch — enough for the downstream
 * collector to SYNTHESISE a run row. Fail-safe throughout: a git error → null → the run stays silent,
 * never a broken commit.
 */
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';

function truthy(v: string | undefined): boolean {
  if (v === undefined) return false;
  const t = v.trim().toLowerCase();
  return !(t === '' || t === '0' || t === 'false' || t === 'no');
}

/** Automatic every-commit capture (transcripts + telemetry). ON by default; DEVKIT_NO_TELEMETRY=1 off. */
export function telemetryEnabled(): boolean {
  return !truthy(process.env.DEVKIT_NO_TELEMETRY);
}

/** The telemetry JSONL sink: the ship's DEVKIT_GATE_EVENTS, else the every-commit default, else none. */
export function telemetrySink(): string | undefined {
  return (
    process.env.DEVKIT_GATE_EVENTS ||
    (telemetryEnabled()
      ? path.join(homedir(), '.devkit', 'telemetry', 'gate-events.jsonl')
      : undefined)
  );
}

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

// Memoised per process — each of a commit's gates computes it once; a ship never reaches here.
let commitCtx: { id: string; repo: string; branch: string } | null | undefined;
function commitRunContext(): { id: string; repo: string; branch: string } | null {
  if (commitCtx !== undefined) return commitCtx;
  // write-tree = the staged content's tree oid: identical across this commit's gate processes,
  // unique per staged content (so an amend with new content is a distinct run). Read-only re: index.
  const tree = git(['write-tree']);
  if (!tree) return (commitCtx = null);
  const top = git(['rev-parse', '--show-toplevel']);
  return (commitCtx = {
    id: `commit-${tree}`,
    repo: top ? path.basename(top) : '',
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']) || '',
  });
}

/** The correlation id for this run: the ship id, else the per-commit id, else null (capture off). */
export function runId(): string | null {
  const ship = process.env.DEVKIT_SHIP_ID;
  if (ship) return ship;
  if (!telemetryEnabled()) return null;
  return commitRunContext()?.id ?? null;
}

/**
 * Fields stamped onto every emitted event so the collector can correlate — and, for a commit run,
 * synthesise a run row: `run_mode` + repo + branch ride the gate events themselves. A ship omits
 * those (its ship_attempt already carries repo/branch); `ship_id` is the correlation key either way.
 */
export function runEnvelope(): Record<string, unknown> {
  const ship = process.env.DEVKIT_SHIP_ID;
  if (ship) return { ship_id: ship };
  const ctx = telemetryEnabled() ? commitRunContext() : null;
  if (!ctx) return {}; // capture off (or not a git repo) — emit is a no-op anyway (no sink + no id)
  return { ship_id: ctx.id, run_mode: 'commit', repo: ctx.repo, branch: ctx.branch };
}

/** Test seam: drop the memoised commit context so a test can switch git state between assertions. */
export function _resetRunContextForTests(): void {
  commitCtx = undefined;
}
