/**
 * `devkit ship` — commit an explicit or committed-branch scope onto a NEW branch and open a PR WITHOUT moving the shared
 * checkout's HEAD (so parallel agents on one tree are undisturbed). The git/gh ceremony is the
 * battle-tested bash at ../lib/ship/ship-branch.sh; this dispatcher forwards argv + stdin and
 * propagates the exit code. A consuming repo shells out to this command (never imports it); the
 * manual lane runs the identical command in a plain terminal.
 */
import { spawnSync } from 'node:child_process';
import { delimiter, dirname } from 'node:path';
import {
  claudeFamilyEnvLine,
  JUDGE_MODEL_ENVS,
  judgeEnvUnsetLine,
} from '../../gate-engine/judge/outage/family-override.mts';
import { findsFlag } from '../lib/help/wants-help.mts';
import { enterShipQueue } from '../lib/ship/queue/enter.mts';
import { formatShipQueue, readShipQueue } from '../lib/ship/queue/status.mts';
import { reportShipRuntimeProvenance } from '../lib/ship/runtime-provenance.mts';
import { runManagedPackagedScript } from '../lib/ship/run-packaged-script.mts';

export interface ShipDependencies {
  reportRuntimeProvenance: typeof reportShipRuntimeProvenance;
  runManagedScript: (
    ...args: Parameters<typeof runManagedPackagedScript>
  ) => number | Promise<number>;
  enterQueue: typeof enterShipQueue;
  showQueue: () => string;
}

const DEFAULT_DEPENDENCIES: ShipDependencies = {
  reportRuntimeProvenance: reportShipRuntimeProvenance,
  runManagedScript: runManagedPackagedScript,
  enterQueue: enterShipQueue,
  showQueue: () => formatShipQueue(readShipQueue()),
};

/** Value flags the bash parsers refuse under --resume (it replays WHAT ships). */
export const RESUME_REFUSED_VALUE_FLAGS: readonly string[] = ['--base', '--link'];
/** Flags assert-positional-args.sh rejects in a <branch>/<title> slot. */
export const POSITIONAL_REJECTED_FLAGS: readonly string[] = [
  '--base',
  '--link',
  '--body',
  '--body-file',
  '--pr',
  '--resume',
  '--dry-gates',
  '--with-reviewers',
  '--from-branch',
  '--no-qavis-publish',
  '--draft',
  '--ready',
  '--wait-ci',
  '--wait-ci-timeout',
  '--wait-ci-required',
];

export const meta = {
  name: 'ship',
  agentFacing: true,
  // Each takes the next token as opaque text (`--body --help`): read by index.mts's help check and
  // the route scan below, locked to the bash parsers by ship-value-flags-parity.test.mts.
  valueFlags: ['--base', '--body', '--body-file', '--link', '--wait-ci-timeout'],
  // An argv the dispatcher rejects never reaches a parser, so none of its tokens is consumed.
  valueFlagsFor(args: readonly string[]): readonly string[] {
    if (args[0] === '--queue') return [];
    const flags = parserValueFlags(args);
    return dispatchRejection(args, routeFlagsOf(args, flags)) ? [] : flags;
  },
  summary: 'Commit files onto a new branch + open a PR without moving HEAD.',
  help: `devkit ship — commit <path...> onto a new branch + open a PR without moving HEAD.

Usage:
  devkit ship <branch> "<title>" [--dry-gates [--with-reviewers]] [--base <b>] [--from-branch] [--body "<text>"] [--body-file <f>] [--draft] [--link <d>]... [--] <path...>
  devkit ship --pr <branch> "<title>" [--ready] [--body "<text>"] [--link <d>]... [--] <path...>
  devkit ship --resume <branch> [--body-file <f>] [--] <extra-path...>
  devkit ship --queue
                          bare positional paths (no --) are accepted.

  <branch> and "<title>" are POSITIONAL and must come FIRST, before any flag. The bracketed flags
  below are optional, NOT free-floating: \`ship --base main <branch> "<title>"\` binds the branch
  name to --base and is rejected. Ship CREATES <branch>. An unrelated local branch is rejected; an
  exact commit preserved by a prior post-commit failure is resumed after its ship gate receipt, base,
  message, and paths are verified. Explicit-path recovery also rebuilds the current scoped tree;
  branch-source recovery instead publishes the already-gated immutable commit. Before any commit
  lands, branch-source resume keeps frozen membership but refreshes those paths from current HEAD.
  Paths that ship's OWN gates added to a commit (a ratchet baseline it lowered) are exempt from the
  path and explicit-tree checks — recorded when the commit landed, so narrowing <path...> on the
  retry still refuses. On origin, use --pr to append to the existing PR branch instead.

  --base <branch>     For a new ship, branch off origin/<branch> and target the PR at it instead of
                      this checkout's HEAD/current branch. With --pr, explicitly replace the open
                      PR from a caller-prepared resolution on origin/<branch>: verify the exact PR
                      head/base, gate one replacement commit, then push under an exact-OID lease.
                      The caller must first rebase or merge the base; devkit does not resolve it.
                      Every path changed by the old PR must be briefed. Must name a branch on origin;
                      a PR base cannot be a sha or tag. "origin/x" and "x" are equivalent.
  --from-branch       Derive the complete path brief from the committed origin/<base>..HEAD snapshot.
                      Requires --base and no explicit paths. The source/base commits are pinned,
                      changed gitlinks and non-UTF-8 names are refused, and any staged, unstaged,
                      untracked, or ignored overlay on a derived path blocks before gates. Unrelated
                      working-tree dirt remains untouched. Explicit paths stay the default because
                      dirty-file ownership cannot be inferred safely in a shared checkout. Not valid
                      with --pr; resume remembers the committed-source mode and frozen path set.
  --body "<text>"     Commit + PR body, inline (no temp file). Wins over stdin; omit it to read the
                      commit body from stdin (a pipe or here-doc) or to leave the body empty.
  --body-file <f>     Commit + PR body read from a file. The recorded invocation stores the file's
                      CONTENT, and --resume replays those bytes — a later edit to <f> is NOT picked
                      up until you re-pass --body-file on the resume (--resume warns when <f> and
                      the recorded body differ). Mutually exclusive with --body; wins over stdin.
                      With --pr, only these two explicit flags refresh the EXISTING PR description;
                      omitting both preserves it (piped stdin remains commit-only for compatibility).
  --resume <branch>   Replay the invocation recorded by the previous attempt for <branch> (title,
                      base, body, links, paths — every attempt records itself), instead of re-typing
                      them. LEADING position only. For an explicit-path ship, extra paths after [--]
                      are MERGED into the recorded set (a gate remedy that adds a file rides the
                      retry). A committed-branch resume freezes membership and refuses extra paths;
                      start a fresh full --from-branch invocation to derive a new set. --body/
                      --body-file override the recorded body — note an amended body re-pays the
                      completeness judge, while an unchanged one replays its cached PASS. Works for
                      both a blocked new ship and a blocked --pr re-push (the record knows which it
                      was). A pushed ship deletes its record; a stale (>6h) or foreign record is
                      refused by name.
  --draft             Open the PR as a DRAFT instead of ready-for-review. New ships only — a --pr
                      re-push targets a PR that already exists (convert one back with
                      \`gh pr ready --undo <branch>\`). Recorded with the invocation, so a
                      gate-blocked draft ship still opens a draft when replayed by --resume. To make
                      every guard-suggested ship in a repo a draft, set .devkit/config.json →
                      { "ship": { "command": "devkit ship", "extraArgs": ["--draft"] } } — the
                      "command" key is required, or extraArgs is ignored. The guard drops --draft
                      from its --pr suggestions, where it does not apply.
  --ready             With --pr only: after the re-push lands, mark the PR ready for review — the
                      end of an open-draft → iterate → mark-ready loop. Runs last, so a failure here
                      never costs the pushed commit; it reports the exact \`gh pr ready\` to re-run.
                      Idempotent on a PR that is already ready. NOT replayed by --resume: it is a
                      one-shot state change on the PR, not a property of the invocation.
  --wait-ci           After the PR is open and every artifact is durable, poll its GitHub checks and
                      end with ONE verdict line on stderr: \`ship: ci-outcome=<passed|failed|
                      cancelled|no-checks|timed-out|unavailable> pr=<n> …\`. Progress prints only when
                      the tally changes, plus a liveness line each minute. Polls ALL checks by
                      default — see --wait-ci-required.
                      The verdict NEVER reaches the exit code: a red PR is not a failed ship, and an
                      agent reading non-zero would retry --resume against a record the push deleted.
                      Grep the line, or read the ship_ci telemetry row. Valid for a new ship and for
                      --pr. NOT replayed by --resume: it observes a PR that already exists rather
                      than describing what shipped, so re-request it on the retry.
  --wait-ci-required  With --wait-ci only: wait on the branch-protection REQUIRED checks alone, so
                      an advisory check (a review bot) neither holds the wait open nor turns it red.
                      gh lists only required checks that have already REPORTED (cli/cli#8855): one
                      that has not started yet is invisible. A branch without protection, or whose
                      required checks have not reported, therefore ends in no-checks — never passed.
                      The verdict line carries \`scope=required\`. NOT replayed by --resume.
  --wait-ci-timeout <s>  Bound for --wait-ci, 60..7200, default 900. The floor exists because below
                      it a "this repo has no checks" verdict is unreachable and would surface as a
                      timeout instead. A terminal result is confirmed over ~30s before it is
                      reported, so a workflow_run-chained job that registers late cannot be missed.
  --dry-gates         Rehearse the exact ship base + selected source staging in an ephemeral worktree.
                      Runs the formatter, configured deterministic/structure/extra gates, and the
                      deterministic comment budget gate; skips the decision judge, Qavis,
                      domain/completeness review, commit, push, and PR creation. The decision gate's
                      regex smells (e.g. legacy-deletion) print as an advisory with the remedy this
                      repo allows; they never change the exit code. With --base, refreshes and uses the
                      current origin tip just like ship.
                      Never leaves a local branch or commit. Cannot be combined with --resume.
  --with-reviewers    With --dry-gates only: also run the configured domain reviewers on that same
                      staging. Decisions, Qavis and completeness stay off (there is no commit
                      message to judge). Reviewer PASSes land in the cache the real ship reads, so
                      the identical devkit ship reuses them; a block exits with the reviewer's code.
                      Costs judge time. For reviewer feedback when a decisions block would stop a
                      SHIP_DRY_RUN=1 run first.
  --queue             Print the machine-wide ship queue — the running ship (branch, repo, elapsed,
                      last gate line) and the waiters, next up first — then exit. Takes no slot.
  --link <d>          Extra gitignored gate-dep dir to symlink into the worktree (repeatable;
                      the base .husky/_ + node_modules are always linked).
  --no-qavis-publish  Skip the post-push step that hands a passed staged Qavis result to qavis for
                      publication. The Qavis gate still runs; only the post-push hand-off is skipped.
                      Publication needs a qavis exposing \`publish\` (qavis #85). Against an older
                      one the hand-off is inert: ship names the gap once and prints the
                      \`qavis qa --pr … --annotate description\` remedy instead.
  --pr                Re-push: add changes to the EXISTING PR on <branch> as a new commit
                      (fast-forward, never --force). Pair with --base only when replacing a PR whose
                      conflicts you already resolved; that explicit mode rewrites under an exact
                      expected-OID lease on the PR head and refuses an incomplete old-PR path brief.
                      Rebase/merge origin/<base> locally first — nothing needs pushing beforehand.
  --                  Force everything after it to be a file path (ships a dash-leading filename).

Env:
  SHIP_DRY_RUN=1      Commit locally in the worktree; skip push + PR (preview).
  GUARD_COVERAGE_OK=1 Ship without verified coverage, for THIS run only (alias: GUARD_NO_COVERAGE=1).
                      For when the BASE branch already fails the coverage gate and your diff didn't
                      cause it — the gate logs a loud BYPASSED line instead of blocking, and the
                      bypass is recorded in telemetry. A shortfall your own change caused, fix.
                      Prefer \`export GUARD_COVERAGE_OK=1\` on its own line: an inline
                      \`GUARD_COVERAGE_OK=1 devkit ship …\` prefix can be stripped by
                      command-rewriting shell hooks (same caveat as SHIP_COMMIT_TIMEOUT).
                      Editing "coverage": false in guard.config.json does NOT work here — ship reads
                      that file from the committed tree, so a local-only edit is silently ignored.
  GUARD_STRUCTURE_OK=1 Ship without structure lint, for THIS run only (alias: GUARD_NO_STRUCTURE=1).
                      Use only when the BASE branch already has structure violations your diff did
                      not cause. The gate logs a loud BYPASSED line, records telemetry, and keeps
                      every other deterministic gate active. Prefer exporting it on its own line.
  GUARD_HOOK_PARITY_OK=1  Commit while .husky/pre-commit differs from its generator (self-host only).
                      The gate already stays advisory when no generator input is staged, so reach for
                      this only when it blocks on drift your diff genuinely did not cause.
  GUARD_DECISIONS_INTEGRITY_OK=1  Commit past a structural finding on a decision record in this
                      change (self-host only). Findings that already exist at HEAD are advisory
                      without any flag; this is for a NEW finding you believe is wrong.

Judge models:
  ${JUDGE_MODEL_ENVS.join(' ')}
                      No one knob moves every judge: completeness reads GUARD_REVIEW_ESCALATION_MODEL,
                      not GUARD_REVIEW_MODEL (which also carries the sentry judge unless a sentry env
                      pins it); GUARD_CORRECTNESS_CHUNK sets a chunk cap, not a model.
                      A model id starting \`gpt-\` runs on the codex CLI; any other id on claude.
                      Codex dark? Move every judge at once, never a subset:
                        ${claudeFamilyEnvLine()}
                      Way back once it clears:
                        ${judgeEnvUnsetLine()}
                      A \`devkit doctor --fix\` bind in guard.config.json: see docs/troubleshooting.md.

Exits 0 on PR opened, committed under SHIP_DRY_RUN, or a passing --dry-gates rehearsal; 1 on any
preflight/git/gh/gate error. A --wait-ci verdict never changes that — a red or timed-out CI still
exits 0, because the PR opened. The one exception is a SIGNAL during the wait: ship exits 130/143
even though the PR is open, so the wait announces the PR URL before it starts. A commit
that lands but fails to push KEEPS the branch; an identical retry verifies and resumes that commit.
A commit that never lands auto-deletes the empty branch.

Ships queue machine-wide: every ship waits for a slot, first come first served, before its first
gate, and holds it until it exits — or until --wait-ci starts polling, which needs no slot. One slot
by default; ~/.devkit/ship-queue/config.json {"slots": N} (1..4) lets N ships run at once. A
waiting ship prints its position once. A slot frees itself when its ship (and that ship's whole
process group) is gone. There is no way to skip it; \`devkit ship --queue\` names the running ship
with the \`ps\` that inspects it if it looks stuck. Every blocked attempt records its
invocation — retry with \`devkit ship --resume <branch>\` instead of re-typing the command.`,
};

/** reship.sh strips the whole leading --pr/--resume run; ship-branch.sh strips one leading --resume. */
function parserValueFlags(args: readonly string[]): readonly string[] {
  let lead = 0;
  while (args[lead] === '--pr' || args[lead] === '--resume') lead++;
  const shipBranch = valueFlagsAfter(args, args[0] === '--resume' ? 1 : 0);
  const reship = args.slice(0, lead).includes('--pr') || findsFlag(args, ['--pr'], shipBranch);
  return reship ? valueFlagsAfter(args, lead) : shipBranch;
}

/** Value flags the bash parser consumes once `strip` leading mode flags are gone. A flag in a
 *  positional slot fails the parser before any option is read, so then nothing is consumed. */
function valueFlagsAfter(args: readonly string[], strip: number): readonly string[] {
  const resuming = args.slice(0, strip).includes('--resume');
  const slots = args.slice(strip, strip + (resuming ? 1 : 2));
  if (slots.some((slot) => POSITIONAL_REJECTED_FLAGS.includes(slot))) return [];
  return resuming
    ? meta.valueFlags.filter((flag) => !RESUME_REFUSED_VALUE_FLAGS.includes(flag))
    : meta.valueFlags;
}

export default function ship(
  args: string[],
  cwd: string,
  dependencies: ShipDependencies = DEFAULT_DEPENDENCIES,
): number | Promise<number> {
  if (args.length === 0) {
    console.log(meta.help); // no args is a usage error (`--help` is intercepted in index.mts)
    return 1;
  }
  if (args[0] === '--queue') {
    if (args.length > 1) {
      console.error('--queue takes no other arguments');
      return 1;
    }
    try {
      console.log(dependencies.showQueue());
      return 0;
    } catch (cause) {
      console.error(
        `ship: could not read the queue: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return 1;
    }
  }
  dependencies.reportRuntimeProvenance(cwd);
  const resuming = args[0] === '--resume';
  const routeFlags = routeFlagsOf(args, parserValueFlags(args));
  const rejection = dispatchRejection(args, routeFlags);
  if (rejection) {
    for (const line of rejection) console.error(line);
    return 1;
  }
  const mode = routeFlags.has('--pr') ? 'reship' : 'ship-branch';
  // `bash <script>` (not a direct exec of the file) so a lost +x bit through packaging can't break
  // it. stdio inherit: the commit/initial-PR body flows in on stdin, the PR URL out on stdout,
  // progress on stderr, and the TTY-ness the script probes (`[ -t 0 ]`) is preserved.
  //
  // MANAGED (sc-2159), matching `devkit review`: signals reach the script's own process group, not
  // the wrapper alone.
  //
  // PATH carries the node running THIS process, the way `devkit review` already does. The gate
  // supervisor bounding the commit is a node script, so no commit happens at all without node on
  // PATH — and a devkit launched through a wrapper whose PATH omits it would fail at the gate, not
  // at startup. Only PATH is touched: unlike review, ship must forward the caller's environment
  // intact (SHIP_*, DEVKIT_SHIP*, GUARD_* are all meaningful here).
  const env = {
    ...process.env,
    PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
  };
  const queueMode = resuming ? 'resume' : routeFlags.has('--dry-gates') ? 'dry-gates' : mode;
  return queueThenRun(args, cwd, mode, queueMode, env, dependencies);
}

/** `--pr` (before any `--` terminator, so a dash-leading file path can't misroute) selects the
 *  re-push flow: add the changes to an existing PR's branch (ff-push) instead of a new PR. */
function routeFlagsOf(args: readonly string[], valueFlags: readonly string[]): Set<string> {
  const routeFlags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    // --wait-ci-timeout takes a value, so it MUST be listed: `--wait-ci-timeout --pr` must not route.
    if (valueFlags.includes(arg)) {
      i++; // its value is opaque text, even when it is spelled like a mode flag
      continue;
    }
    // Only an unconsumed `--` terminates option scanning; a consumed one is opaque body text.
    if (arg === '--') break;
    if (
      arg === '--pr' ||
      arg === '--from-branch' ||
      arg === '--draft' ||
      arg === '--ready' ||
      arg === '--dry-gates'
    )
      routeFlags.add(arg);
  }
  return routeFlags;
}

/** The dispatcher's cross-flag refusals, as stderr lines; undefined when the argv may dispatch. */
function dispatchRejection(args: readonly string[], routeFlags: Set<string>): string[] | undefined {
  if (routeFlags.has('--pr') && routeFlags.has('--from-branch'))
    return ['--from-branch is only valid for a new ship and cannot be combined with --pr'];
  // Draft-ness is decided when the PR is CREATED, so --draft belongs to a new ship only. Caught here
  // rather than in bash so the message names the real remedy instead of "unknown flag".
  if (routeFlags.has('--pr') && routeFlags.has('--draft'))
    return [
      '--draft applies to a NEW ship (opening the PR); a --pr re-push targets a PR that already exists.',
      '  To convert that PR back to a draft: gh pr ready --undo <branch>',
    ];
  // A new ship is ready-for-review already. `--resume` is exempt: it takes its mode from the RECORD,
  // so a recorded reship legitimately carries no --pr here and reship.sh accepts its --ready.
  if (args[0] !== '--resume' && !routeFlags.has('--pr') && routeFlags.has('--ready'))
    return [
      '--ready marks an EXISTING PR ready and requires --pr; a new ship opens a ready PR by default.',
      '  To open a draft instead, use --draft.',
    ];
  return undefined;
}

function repoRoot(cwd: string): string {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : cwd;
}

/** One machine-wide slot before the first gate (sc-3785); see ../lib/ship/queue/ship-queue.mts. */
async function queueThenRun(
  args: string[],
  cwd: string,
  mode: 'reship' | 'ship-branch',
  queueMode: string,
  env: NodeJS.ProcessEnv,
  dependencies: ShipDependencies,
): Promise<number> {
  // <branch> is the first positional in every form (`--resume <branch>`, `--pr <branch>`, `<branch> …`).
  const branch = args.find((arg) => !arg.startsWith('--')) ?? '(unknown)';
  let queued: Awaited<ReturnType<ShipDependencies['enterQueue']>>;
  try {
    queued = await dependencies.enterQueue({ env, repo: repoRoot(cwd), branch, mode: queueMode });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    console.error(`ship: could not join the machine-wide ship queue: ${message}`);
    console.error('  Fix the cause above and re-run; the queue cannot be skipped.');
    return 1;
  }
  try {
    return await dependencies.runManagedScript(`${mode}.sh`, args, {
      command: 'devkit ship',
      cwd,
      env: { ...env, ...queued.env },
    });
  } finally {
    queued.handle?.release();
  }
}
