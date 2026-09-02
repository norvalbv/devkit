/**
 * qavis-advisory gate — nudge to run qavis QA when a staged change is UI-affecting and hasn't been
 * QA'd yet. The "deserves QA" judgement + the pass-receipt both live in qavis (its `route` CLASSIFIER
 * and `receipt`); devkit is a THIN CHANNEL that shells `qavis route --staged --gate` and turns its
 * ADVISE/SILENT into an exit code. So a non-qavis consumer carries zero weight (fail-open, the fallow
 * precedent), and the classifier is never duplicated here.
 *
 * Contract (mirrors the other gates' trichotomy, but this one NEVER hard-fails a normal commit —
 * it's advisory):
 *   0 = continue — SILENT, advisory-only (normal commit), overridden, receipt-cleared, or the
 *       advisory couldn't run at all (qavis absent/erroring — reported, see below).
 *   3 = ADVISE under a strict ship (GUARD_AI_STRICT): the ship blocks until qavis runs (writing a
 *       receipt that clears it) or an override is set. A normal `git commit` only prints the nudge.
 * There is deliberately NO exit 1 and NO fail-CLOSED on outage: an advisor's own failure (qavis
 * missing / erroring) must never block a ship — unlike completeness, which blocks a dark gap-finder.
 *
 * Fail-open, but LOUD. A skipped advisory prints one stderr line naming WHY (qavis not on PATH /
 * route failed / no verdict). Silence there made three states indistinguishable — "nothing to QA",
 * "qavis missing", "route blew up" — so the gate could sit dead for months and look healthy. It
 * still exits 0 in every one of those cases; it just says so. A repo WITHOUT `.qavis/recipe.json`
 * stays entirely silent: devkit never asserted qavis was expected there.
 *
 * Overrides: GUARD_NO_QAVIS_ADVISORY=1 disables · GUARD_QAVIS_OK=1 ships this change without QA.
 * (Both must be EXPORTED to survive the ship subprocess chain — an inline prefix can be stripped.)
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { envFlag } from '../config.mts';
import { emitGateBypass } from '../judge/gate-events.mts';

/**
 * Is the qavis CLI resolvable on PATH? `devkit doctor` asks this to report a dead advisory gate
 * OUTSIDE commit time — a plain filesystem scan, never a `route` call, so it costs no model spend.
 * `env` is a parameter purely so tests can drive a synthetic PATH.
 */
export function qavisOnPath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): boolean {
  return (env.PATH ?? '').split(path.delimiter).some((dir) => {
    if (!dir) return false;
    // Relative PATH entries resolve against the cwd the SPAWN would use — the hook shells the
    // gate from the git root, so doctor must judge from there, not from its own process cwd.
    const candidate = path.resolve(cwd, dir, 'qavis');
    try {
      // Same bar the spawn applies: an executable regular file — a directory or a chmod-x-less
      // file named `qavis` would report healthy and then fail every launch.
      accessSync(candidate, constants.X_OK);
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * Does the installed qavis register a `publish` subcommand? `devkit doctor` asks this so the OTHER
 * inert qavis path — ship's post-push evidence hand-off (cli/lib/ship/publish-qavis.sh) — is visible
 * outside a post-push stderr line that a headless shipping agent may never read. sc-2161 owns the
 * qavis half; until it lands, a qavis we can read answers `false`.
 *
 * Matches the WHOLE command word in the `--help` Commands block: "publish" also appears in qavis's
 * prose, and `qavis publish --help` exits 0 on a qavis WITHOUT publish (commander answers `--help`
 * before rejecting the unknown operand), so neither a substring nor an exit status can be trusted.
 * A trailing `|` counts as a word end because commander renders an aliased subcommand as
 * `publish|pub`. Must stay in lockstep with publish-qavis.sh's probe — ship and doctor answering
 * this question differently is how an operator gets told two things about one binary.
 * `--help` only — never a `route`/`qa` call, so this costs no model spend.
 *
 * `null` is a THIRD state, not a synonym for false: the probe could not ask (spawn failed, `--help`
 * timed out, output had no readable Commands block), which is not evidence that publish is absent.
 * Collapsing it would have doctor assert "this qavis has no publication subcommand" about a binary
 * it never managed to interrogate — the same defect the 2026-07-22 ruling on this axis fixed for the
 * advisory gate, where a bare null read exactly like a healthy verdict. Ship treats null and false
 * alike (decline to invoke) because for ship they mean the same thing; doctor must not.
 */
/** Exported so a hang-regression test can bound its own wait without hard-coding this number. */
export const QAVIS_HELP_TIMEOUT_MS = 5_000;

export function qavisSupportsPublish(cwd = process.cwd()): boolean | null {
  let help: string;
  try {
    help = execFileSync('qavis', ['--help'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      // Same cwd `qavisOnPath` judges from: a RELATIVE PATH entry resolves against the spawn's
      // directory, so probing from doctor's own cwd could answer for a different binary than the one
      // reported present — or none at all.
      cwd,
      // Explicit `env` so the lookup uses the LIVE PATH. Bun's execFileSync resolves the executable
      // against the PATH it started with and ignores a later `process.env.PATH` write, so without
      // this the probe can answer for a different binary than the shell probe found — measured, and
      // the exact divergence this pair exists to prevent. Node honours the mutation either way.
      env: process.env,
      // execFileSync waits forever by default, so a qavis whose --help never returns would hang
      // `devkit doctor` outright rather than degrade. A health report may not become the outage it
      // is meant to describe; on timeout the throw lands in the catch and answers "could not ask"
      // rather than "absent". `--help` measures in tenths of a second.
      timeout: QAVIS_HELP_TIMEOUT_MS,
      // SIGKILL, not the default SIGTERM: `execFileSync` sends the signal and then WAITS, so a child
      // ignoring TERM makes the timeout do nothing at all. Measured: a 1s timeout against a
      // `trap "" TERM; sleep 30` stub took 30.4s to return, versus 1.0s with SIGKILL.
      killSignal: 'SIGKILL',
    });
  } catch {
    return null; // never ran, or was killed at the timeout — no evidence either way
  }
  const lines = help.split('\n');
  const commands = lines.findIndex((line) => line.startsWith('Commands:'));
  // No Commands block ⇒ not a help output we can read ⇒ unknown, never "scan the whole text".
  if (commands === -1) return null;
  // Stop at the next unindented line: that is a new section header (`Examples:`, anything an
  // `addHelpText('after', …)` appends), and its indented body is prose, not registered commands.
  // Scanning to end-of-help would read `Examples:\n  publish --pr 1` as a capability and put ship
  // straight back to invoking a subcommand that does not exist.
  const block: string[] = [];
  for (const line of lines.slice(commands + 1)) {
    if (/^\S/.test(line)) break;
    block.push(line);
  }
  return block.some((line) => {
    // Take the whole rendered term and split it, rather than anchoring `publish` to the start:
    // commander renders `name|alias`, so `publish` can sit on EITHER side of the pipe and the CLI
    // dispatches on both. The `[a-z]` start mirrors the shell probe's awk exactly.
    const term = /^ {2}([a-z]\S*)/.exec(line);
    return term !== null && term[1].split('|').includes('publish');
  });
}

/** A qavis repo advertises how to launch its app here; absent ⇒ nothing for qavis to QA. */
export const QAVIS_RECIPE = path.join('.qavis', 'recipe.json');
const QAVIS_RECEIPT = path.join('.qavis', 'receipt.json');

/**
 * The outcome of asking qavis to route the staged tree. The null arm carries `skip` — the human
 * phrase for why the advisory didn't run — so the ONE printer (runQavisAdvisory) can report it
 * instead of discarding it. A bare null is what made a dead gate look like a quiet one.
 */
export type RouteResult = { verdict: 'ADVISE' | 'SILENT' } | { verdict: null; skip: string };

export interface AdvisoryDeps {
  /** `qavis route --staged --gate` → its verdict, or why the advisory couldn't run. */
  route?: (cwd: string) => RouteResult;
  hasRecipe?: (cwd: string) => boolean;
  /** `qavis qa --staged --route vision --repo <cwd>` → its exit code (DEVKIT_SHIP_QA self-run). */
  qa?: (cwd: string) => number;
}

/** The self-run: qavis drives THIS staged tree, with its output streamed to the operator. */
function defaultQa(cwd: string): number {
  const r = spawnSync('qavis', ['qa', '--staged', '--route', 'vision', '--repo', cwd], {
    stdio: 'inherit',
  });
  return r.status ?? 1;
}

/** Fail-open, never silently: a recipe is present, so this repo EXPECTS qavis; the mute is the remedy. */
function failOpen(skip: string | undefined): number {
  console.error(`qavis-advisory: skipped — ${skip}.`);
  console.error(
    `   (${QAVIS_RECIPE} is present, so this repo expects it; mute with GUARD_NO_QAVIS_ADVISORY=1.)`,
  );
  return 0;
}

/** Ship links a caller receipt only when one EXISTS: without the link, copy the self-run's back. */
function keepSelfRunReceipt(cwd: string): void {
  const root = process.env.DEVKIT_SHIP_ROOT;
  if (!root) return;
  const mine = path.join(cwd, QAVIS_RECEIPT);
  try {
    if (lstatSync(mine).isSymbolicLink()) return;
  } catch {
    return; // the run wrote no receipt
  }
  try {
    mkdirSync(path.join(root, path.dirname(QAVIS_RECEIPT)), { recursive: true });
    // COPYFILE_EXCL: a receipt the caller minted meanwhile is theirs and newer — never overwrite it.
    copyFileSync(mine, path.join(root, QAVIS_RECEIPT), constants.COPYFILE_EXCL);
  } catch (error: unknown) {
    // Advisory, so never an exit code: the receipt still clears THIS run from the worktree.
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `qavis-advisory: could not copy the receipt back to ${root} (${message}); it stays in the gate worktree, so a later --resume will re-ask.`,
    );
  }
}

const qaOptIn = (): boolean => /^(1|true|yes)$/i.test(process.env.DEVKIT_SHIP_QA ?? '');

function defaultRoute(cwd: string): RouteResult {
  let out: string;
  try {
    out = execFileSync('qavis', ['route', '--staged', '--gate', '--repo', cwd], {
      encoding: 'utf8',
      // stdout = the bare verdict (captured); stderr = qavis's reason/remedy, passed to the user.
      stdio: ['ignore', 'pipe', 'inherit'],
    });
  } catch (e) {
    // ENOENT = no such binary. A qavis that RAN and exited non-zero throws with `status` set
    // instead, so this cleanly separates "never installed" from "installed but broken".
    const err = e as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') return { verdict: null, skip: 'qavis not on PATH' };
    return { verdict: null, skip: `qavis route failed: ${err?.message ?? err}` };
  }
  const last = out.trim().split('\n').pop() ?? '';
  if (last === 'ADVISE' || last === 'SILENT') return { verdict: last };
  // Exited 0 but said nothing we understand — a version skew or a swallowed error, not a SILENT.
  return { verdict: null, skip: `qavis route printed no verdict (${JSON.stringify(last)})` };
}

export function runQavisAdvisory(cwd: string = process.cwd(), deps: AdvisoryDeps = {}): number {
  const hasRecipe = deps.hasRecipe ?? ((c) => existsSync(path.join(c, QAVIS_RECIPE)));
  // Not a qavis repo (or qavis not installed by this committer) → nothing to advise. This is also the
  // zero-weight path for every non-qavis consumer: the gate returns before shelling anything —
  // checked BEFORE the flags, or a globally exported GUARD_QAVIS_OK would record a phantom bypass
  // of a gate that had nothing to run here.
  if (!hasRecipe(cwd)) return 0;
  // GUARD_QAVIS_OK is a per-run bypass, NO_QAVIS_ADVISORY a standing disable — recorded under
  // their own flag names because before this the advisory's bypasses emitted nothing at all.
  if (envFlag('QAVIS_OK')) {
    emitGateBypass('qavis-advisory', 'GUARD_QAVIS_OK');
    return 0;
  }
  if (envFlag('NO_QAVIS_ADVISORY')) {
    emitGateBypass('qavis-advisory', 'GUARD_NO_QAVIS_ADVISORY');
    return 0;
  }
  const route = deps.route ?? defaultRoute;
  const result = route(cwd);
  if (result.verdict === null) return failOpen(result.skip);
  if (result.verdict !== 'ADVISE') return 0; // SILENT → continue
  // DEVKIT_SHIP_QA=1: QA the tree the gate evaluates (this one) instead of naming it, then re-ask.
  if (qaOptIn()) {
    console.error(
      `qavis-advisory: DEVKIT_SHIP_QA is set — running qavis on this staged tree (${cwd})…`,
    );
    const code = (deps.qa ?? defaultQa)(cwd);
    keepSelfRunReceipt(cwd);
    const again = route(cwd);
    if (again.verdict === null) return failOpen(again.skip);
    if (again.verdict === 'SILENT') {
      console.error('qavis-advisory: cleared by the qavis result recorded on this tree.');
      return 0;
    }
    console.error(
      `qavis-advisory: qavis exited ${code} and this tree is still not covered — read its reason above.`,
    );
  }
  // qavis printed its own reason to stderr; add the remedy + the exit-code decision.
  console.error('qavis-advisory: UI-affecting change with no qavis QA on this staged tree.');
  const mode = shipMode();
  if (mode === 'drifted') {
    // No local command can attest this tree: the gate evaluates a three-way merge onto a base this
    // checkout does not contain. Say so, and name the two honest exits.
    const root = shellQuote(process.env.DEVKIT_SHIP_ROOT ?? '.');
    console.error(
      '   This checkout forked before the base moved (or ships onto another base / an existing PR tip): the gate tree is one your checkout does not contain, so no receipt minted there can attest it.',
    );
    const branch = process.env.DEVKIT_SHIP_BRANCH;
    console.error(
      `   Run:  DEVKIT_SHIP_QA=1 devkit ship --resume ${branch ? shellQuote(branch) : '<branch>'}    (qavis then drives the gate tree itself; a pass clears this)`,
    );
    console.error(
      `   or, after this ship opens the PR:  qavis qa --pr <n> --annotate description --repo ${root}    (a pass publishes to the PR)`,
    );
    console.error(
      "   Land now: export GUARD_QAVIS_OK=1 with the repo owner's per-change OK (recorded as a bypass), or disable with GUARD_NO_QAVIS_ADVISORY=1.",
    );
    return envFlag('AI_STRICT') ? 3 : 0;
  }
  console.error(`   Run:  ${qaRemedy(mode)}    (a pass writes a receipt that clears this)`);
  if (mode !== 'commit') {
    const branch = process.env.DEVKIT_SHIP_BRANCH;
    console.error(
      `   then: devkit ship --resume ${branch ? shellQuote(branch) : '<branch>'}    (the receipt in your checkout is linked into the gate worktree)`,
    );
    if (mode === 'staged') {
      console.error(
        '   note: the receipt attests the staged set — if unrelated paths are already staged, unstage those first (git restore --staged -- <path>), or the gate will name them',
      );
    }
  }
  console.error('   Skip: export GUARD_QAVIS_OK=1, or disable with GUARD_NO_QAVIS_ADVISORY=1.');
  return envFlag('AI_STRICT') ? 3 : 0; // ship blocks; a normal commit is advisory-only
}

/** Single-quote a shell word (paths here routinely carry spaces). */
const shellQuote = (word: string): string => `'${word.replace(/'/g, "'\\''")}'`;

/** Byte-exact shell quoting: printable ASCII single-quoted, anything else ANSI-C `$'\xHH…'`. */
function shellQuoteBytes(bytes: Buffer): string {
  const printable = bytes.every((b) => b >= 0x20 && b <= 0x7e && b !== 0x27);
  if (printable) return shellQuote(bytes.toString('latin1'));
  let out = "$'";
  for (const b of bytes) {
    if (b === 0x27) out += "\\'";
    else if (b === 0x5c) out += '\\\\';
    else if (b >= 0x20 && b <= 0x7e) out += String.fromCharCode(b);
    else out += `\\x${b.toString(16).padStart(2, '0')}`;
  }
  return `${out}'`;
}

/**
 * Which remedy can actually produce a receipt the gate will accept:
 * - `commit`: a plain `git commit` — the caller's own index IS the gated tree.
 * - `staged`: `devkit ship` from a checkout whose HEAD is the ship base — the gate tree is that HEAD
 *   plus the caller's working-tree content for the shipped paths, so staging those paths in the
 *   caller's checkout and QAing there attests the same blobs.
 * - `committed`: `--from-branch` — the shipped content is the committed range origin/base..HEAD, so
 *   the receipt must key on that range (`--diff`), not on an index that has nothing staged.
 * - `drifted`: the checkout forked before origin/base moved (or ships onto another base) — the gate
 *   tree is a three-way merge the caller's checkout does not contain, so NO local command is
 *   printed; the advisory names the pushed-head run and the recorded bypass instead.
 */
type ShipMode = 'commit' | 'staged' | 'committed' | 'drifted';

function shipMode(): ShipMode {
  const root = process.env.DEVKIT_SHIP_ROOT;
  if (!root) return 'commit';
  // A remedy can only attest the tree ship took: the caller's HEAD must still be the one ship
  // pinned — the source head for a committed range, the base for a staged one.
  const pinned =
    process.env.DEVKIT_SHIP_FROM_BRANCH === '1'
      ? process.env.DEVKIT_SHIP_SOURCE_HEAD
      : process.env.DEVKIT_SHIP_BASE_SHA;
  const local = process.env.DEVKIT_SHIP_FROM_BRANCH === '1' ? 'committed' : 'staged';
  if (!pinned) return local;
  try {
    const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    return head === pinned ? local : 'drifted';
  } catch {
    return local;
  }
}

/** The remedy runs WHERE THE OPERATOR IS and stages only the shipped paths — never `git add -A`. */
function qaRemedy(mode: ShipMode): string {
  const root = process.env.DEVKIT_SHIP_ROOT;
  if (mode === 'commit' || !root) return 'qavis qa --staged --route vision --repo .';
  const at = shellQuote(root);
  if (mode === 'committed') {
    const base = process.env.DEVKIT_SHIP_BASE_SHA ?? '<base>';
    return `qavis qa --diff ${shellQuote(base)} --route vision --repo ${at}`;
  }
  const paths = decodeShipPaths(process.env.DEVKIT_SHIP_PATHS);
  // `./` on every path: git reads a bare leading `:` as pathspec magic (`:(glob)`, `:/`), and the
  // shipped paths are repo-relative file paths, never pathspecs.
  const staged = paths.map((p) => shellQuoteBytes(Buffer.concat([Buffer.from('./'), p])));
  const stage = paths.length ? `git -C ${at} add -- ${staged.join(' ')} && ` : '';
  return `${stage}qavis qa --staged --route vision --repo ${at}`;
}

/** DEVKIT_SHIP_PATHS is `:`-joined base64 of the RAW path bytes (ship-branch.sh), so a newline, a
 *  colon or a non-UTF-8 byte in a filename survives the env round trip untouched. */
function decodeShipPaths(encoded: string | undefined): Buffer[] {
  return (encoded ?? '')
    .split(':')
    .filter(Boolean)
    .map((b64) => Buffer.from(b64, 'base64'));
}
