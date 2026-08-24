/**
 * Per-run identity + telemetry-sink resolution shared by the gate-events and transcript-store
 * side-channels. A `devkit ship` exports DEVKIT_SHIP_ID + DEVKIT_GATE_EVENTS and every in-chain gate
 * correlates under that ship. OFF a ship, EVERY commit is captured BY DEFAULT: the sink defaults to
 * ~/.devkit/telemetry/gate-events.jsonl. The generated hook exports one DEVKIT_COMMIT_ID per attempt
 * so its decisions + review gate processes and terminal event correlate without conflating a retry
 * of identical staged content. The staged tree remains correlation metadata; older/direct gate
 * invocations without the hook env retain the tree-derived id fallback. The reviewers already run
 * on every commit, so this only PERSISTS output they already produce.
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
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { devkitVersion } from '../devkit-version.mts';

const LINE_SPLIT_RE = /\r?\n/;

function truthy(v: string | undefined): boolean {
  if (v === undefined) return false;
  const t = v.trim().toLowerCase();
  return !(t === '' || t === '0' || t === 'false' || t === 'no');
}

/** Automatic every-commit capture (transcripts + telemetry). ON by default; DEVKIT_NO_TELEMETRY=1 off. */
export function telemetryEnabled(): boolean {
  return !truthy(process.env.DEVKIT_NO_TELEMETRY);
}

/**
 * The agent that triggered this run, inferred from its env fingerprint so ship/commit telemetry can
 * be filtered by originator downstream. Claude Code exports CLAUDECODE=1; the Codex sandbox exports
 * CODEX_* (CODEX_HOME / CODEX_CLI_PATH). Neither (e.g. a plain terminal, CI) → 'unknown'. The env is
 * inherited through git→husky→node, so it is visible in every in-chain gate process.
 */
export function originatingAgent(): 'claude' | 'codex' | 'unknown' {
  if (truthy(process.env.CLAUDECODE)) return 'claude';
  if (process.env.CODEX_HOME || process.env.CODEX_CLI_PATH) return 'codex';
  return 'unknown';
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

let cachedRepoName: string | null | undefined;
/** Repo identity for telemetry: the origin remote's name, else the MAIN checkout's dirname via
 * git-common-dir. Gates often run inside temp git worktrees whose basename is a meaningless temp
 * name ('worktree', 'dk-…'), which put 350/3,317 recent ship attempts into unattributable repo
 * buckets (sc-2000). Memoized: the extra git calls run once per process, and the plain toplevel
 * basename stays as the final fallback so no envelope ever loses its repo field outright. */
function repoName(top: string | null): string {
  if (cachedRepoName !== undefined) return cachedRepoName ?? (top ? path.basename(top) : '');
  const remote = git(['remote', 'get-url', 'origin']);
  const tail = remote
    ?.replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .split(/[/:]/)
    .pop();
  if (tail) {
    cachedRepoName = tail;
    return tail;
  }
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (common) {
    cachedRepoName = path.basename(path.dirname(common));
    return cachedRepoName;
  }
  cachedRepoName = null;
  return top ? path.basename(top) : '';
}

/** Reuse pre-commit's attempt id in the separately launched commit-msg hook, but only for the same tree. */
function handedOffCommitId(tree: string): string | undefined {
  const statePath = git(['rev-parse', '--git-path', 'devkit-commit-attempt']);
  if (!statePath) return undefined;
  try {
    const [id, handedOffTree] = readFileSync(statePath, 'utf8').split(LINE_SPLIT_RE);
    if (id?.startsWith('commit-run-') && handedOffTree === tree) return id;
  } catch {
    // Best-effort telemetry: a missing/malformed handoff falls back to the staged tree id.
  }
  return undefined;
}

// Memoised per process — each of a commit's gates computes it once; a ship never reaches here.
let commitCtx: { id: string; tree: string; repo: string; branch: string } | null | undefined;
function commitRunContext(): { id: string; tree: string; repo: string; branch: string } | null {
  if (commitCtx !== undefined) return commitCtx;
  // write-tree remains useful correlation metadata. It is not an attempt id: retries with unchanged
  // staged content have the same tree and must stay separate runs downstream.
  const tree = git(['write-tree']);
  if (!tree) {
    commitCtx = null;
    return commitCtx;
  }
  const top = git(['rev-parse', '--show-toplevel']);
  const attemptId = process.env.DEVKIT_COMMIT_ID?.trim() || handedOffCommitId(tree);
  commitCtx = {
    id: attemptId || `commit-${tree}`,
    tree,
    repo: repoName(top),
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']) || '',
  };
  return commitCtx;
}

/**
 * The correlation id for this run: the ship id, else a review, else THIS agent invocation, else the
 * per-commit id, else null (capture off).
 *
 * `DEVKIT_AGENT_RUN_ID` exists because the commit fallback is scoped to a commit ATTEMPT, and an
 * agent the assistant dispatches mid-conversation (`guard-review record-agent`) runs before anything
 * is staged. Two unrelated runs with an unchanged index would derive the same `commit-<write-tree>`
 * id and merge downstream into one synthesized commit row — erasing exactly the per-run separation
 * that recording these agents is for. Set per invocation, it keeps each run its own.
 */
export function runId(): string | null {
  const ship = process.env.DEVKIT_SHIP_ID;
  if (ship) return ship;
  const review = process.env.DEVKIT_REVIEW_ID;
  if (review) return review;
  const agent = process.env.DEVKIT_AGENT_RUN_ID;
  if (agent) return agent;
  if (!telemetryEnabled()) return null;
  return commitRunContext()?.id ?? null;
}

/**
 * Fields stamped onto every emitted event so the collector can correlate — and, for a commit run,
 * synthesise a run row: `run_mode` + repo + branch ride the gate events themselves.
 * Every non-silent envelope also carries `source` — the originating agent — so a downstream reader
 * can attribute each ship/commit to Claude vs Codex.
 *
 * A ship used to omit repo/branch on the grounds that its `ship_attempt` already carries them. That
 * holds only for a reader who JOINS on ship_id; the raw stream was unreadable without one, and since
 * the default sink is per-MACHINE (~/.devkit/telemetry/gate-events.jsonl) two repos' runs interleave
 * with no way to separate them — every per-reviewer figure over that file silently blends repos
 * (sc-1239). The ship path exports its own repo/branch (commit-with-gate-capture.sh); absent (an
 * older/hand-set DEVKIT_SHIP_ID) they degrade to '' rather than mislabelling the run.
 */
export function runEnvelope(): Record<string, unknown> {
  const source = originatingAgent();
  const runningVersion = devkitVersion();
  const ship = process.env.DEVKIT_SHIP_ID;
  if (ship)
    return {
      ship_id: ship,
      repo: process.env.DEVKIT_SHIP_REPO ?? '',
      branch: process.env.DEVKIT_SHIP_BRANCH ?? '',
      source,
      devkit_version: runningVersion,
    };
  const review = process.env.DEVKIT_REVIEW_ID;
  if (review)
    return {
      ship_id: review,
      run_mode: 'review',
      repo: process.env.DEVKIT_REVIEW_REPO ?? '',
      branch: process.env.DEVKIT_REVIEW_BRANCH ?? '',
      source,
      devkit_version: runningVersion,
    };
  // An agent invocation has no staged tree to describe, and deriving one would cost a `git
  // write-tree` whose id is precisely what must NOT be shared here. Repo/branch come from plain
  // rev-parse; `run_mode:'agent'` keeps a reader from synthesising a commit row out of it.
  const agent = process.env.DEVKIT_AGENT_RUN_ID;
  if (agent) {
    const top = git(['rev-parse', '--show-toplevel']);
    return {
      ship_id: agent,
      run_mode: 'agent',
      repo: repoName(top),
      branch: git(['rev-parse', '--abbrev-ref', 'HEAD']) || '',
      source,
      devkit_version: runningVersion,
    };
  }
  const ctx = telemetryEnabled() ? commitRunContext() : null;
  if (!ctx) return {}; // capture off (or not a git repo) — emit is a no-op anyway (no sink + no id)
  return {
    ship_id: ctx.id,
    run_mode: 'commit',
    commit_tree: ctx.tree,
    repo: ctx.repo,
    branch: ctx.branch,
    source,
    devkit_version: runningVersion,
  };
}

/** Test seam: drop the memoised commit context so a test can switch git state between assertions. */
export function _resetRunContextForTests(): void {
  commitCtx = undefined;
  cachedRepoName = undefined;
}
