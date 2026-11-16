/**
 * Repo-supplied command gates: the hook's `--structure` / `--extra` flags and guard.config.json
 * `extraGates`. guard-deterministic runs each one beside the built-in gates; non-zero blocks.
 */
import type { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { CONFIG_FILENAME, coverageBypassed, envFlag, envVar, resolveGuardConfig } from '../config.mts';
import { emitGateBypass, emitGateEvent } from '../judge/gate-events.mts';
import { gitPrefix, stagedSet } from '../ratchets/git-index.mts';
import { crashGuarded, gateEnv } from './reason.mts';
import { recheckCommand } from './recheck.mts';
import { DETERMINISTIC } from './registry.mts';

// In dev the tree is .mts; in the shipped dist it is .mjs, so derive the extension from THIS module.
const STRUCTURE_RUN = fileURLToPath(
  new URL(`../structure/run${import.meta.url.endsWith('.mts') ? '.mts' : '.mjs'}`, import.meta.url),
);
const WHITESPACE_RE = /\s+/;
const LEADING_DASH_RE = /^-/;
/** The argv token devkit replaces with the commit's staged paths, relative to the gate's cwd. */
export const STAGED_PLACEHOLDER = '{staged}';
// macOS ARG_MAX is 1 MiB shared with the environment; past this a spawn fails with E2BIG.
const MAX_STAGED_BYTES = 256 * 1024;

/** A runnable gate descriptor. `argv` is null for a gate that must not spawn. */
export interface Gate {
  /** The registry id of a built-in gate; absent for `--extra` / structure commands. */
  id?: string;
  label: string;
  argv: string[] | null;
  failOpen2: boolean;
  rcLabels?: Record<number, string>;
  /** The local command that re-judges this gate, and its documented short form. */
  recheck?: string;
  alias?: string;
  /** Why a null-argv gate blocks; absent means an empty command. */
  unrunnable?: string;
  /** Why a null-argv gate passes without running. */
  notRun?: string;
  /** Runs last, and only when no gate has failed so far in this run. */
  afterGreen?: true;
}

/** One command gate. A missing `cmd` marks a malformed spec, which blocks as unrunnable. */
export interface ExtraGate {
  label: string;
  cmd?: string;
  /** Runs last, and only when no gate has failed so far in this run (review mode runs it anyway). */
  afterGreen?: true;
}

// Strips a built-in gate's `guard-` bin prefix to its bare telemetry name.
export const GUARD_PREFIX_RE = /^guard-/;

// Built-in names would merge telemetry with that gate and print its remedies for this one.
const RESERVED = new Set(['structure-lint', ...DETERMINISTIC.map((g) => g.id)]);
const labelSchema = z
  .string()
  .regex(/^[a-z0-9][\w.-]*$/i)
  .refine((l) => !RESERVED.has(l) && !l.startsWith('guard-'), 'is a built-in gate name');
const commandSchema = z.string().trim().min(1);
const extraGatesSchema = z
  .record(
    labelSchema,
    z.union(
      [
        commandSchema.transform((cmd) => ({ cmd })),
        z.object({ cmd: commandSchema, afterGreen: z.literal(true) }).strict(),
      ],
      {
        error: 'must be a command string or { "cmd": "<command>", "afterGreen": true }',
      },
    ),
  )
  .optional();

/**
 * The gates guard.config.json `extraGates` declares (label → command, or → { cmd, afterGreen }), in
 * declaration order. A malformed block becomes one command-less spec, so a gate never vanishes.
 */
export function configExtraGates(cwd: string): ExtraGate[] {
  let raw: unknown;
  try {
    raw = resolveGuardConfig(cwd).extraGates;
  } catch (e) {
    console.error(`✗ ${CONFIG_FILENAME}: ${e instanceof Error ? e.message : String(e)}`);
    return [{ label: `${CONFIG_FILENAME}(unreadable)` }];
  }
  // zod's record drops a `__proto__` key without an issue, so that gate would silently vanish.
  if (Object.hasOwn(Object(raw), '__proto__')) {
    console.error(`✗ ${CONFIG_FILENAME} extraGates.__proto__: is not a valid gate name`);
    return [{ label: 'extraGates' }];
  }
  const parsed = extraGatesSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const at = issue.path.length ? `.${issue.path.join('.')}` : '';
    console.error(`✗ ${CONFIG_FILENAME} extraGates${at}: ${issue.message}`);
    return [{ label: 'extraGates' }];
  }
  return Object.entries(parsed.data ?? {}).map(([label, spec]) => ({ label, ...spec }));
}

/**
 * Is structure lint bypassed for THIS run? The orchestrator owns this predicate rather than
 * guard-structure because Electron consumers supply their own arbitrary eslint command through
 * `--structure`; putting the bypass inside guard-structure would leave those consumers wedged.
 *
 * `GUARD_STRUCTURE_OK` is the canonical operator assertion. `GUARD_NO_STRUCTURE` is the accepted
 * guessable alias, matching coverageBypassed. guard-deterministic banners + telemeters the skip and
 * salts its prefix-cache scope so this one-run assertion cannot authorise a later normal run.
 */
export function structureBypassed(): boolean {
  return envFlag('STRUCTURE_OK') || envFlag('NO_STRUCTURE');
}

// Gate label or id → the bypass flag that gate reads in its own process. A bypassed run must not
// record a prefix key a later clean run of the same tree would hit, so run.mts salts on these.
export const GATE_BYPASSES = {
  'hook-parity': 'HOOK_PARITY_OK',
  'decisions-integrity': 'DECISIONS_INTEGRITY_OK',
  'decision-checks': 'DECISION_CHECKS_OK',
} as const;

/** The bypass suffixes set for this run, sorted so the prefix-cache salt ignores export order. */
export function bypassedSuffixes(): string[] {
  return Object.values(GATE_BYPASSES).filter(envFlag).sort();
}

/**
 * A cache hit runs no gate, so a gate's own bypass emission never fires: emit it here for each
 * bypassed gate in `ran`. Returns every bypassed flag under its canonical name, for the banner.
 */
export function reportCachedBypasses(ran: string[]): string[] {
  const bypassed = Object.entries(GATE_BYPASSES).filter(([, suffix]) => envFlag(suffix));
  for (const [gate, suffix] of bypassed) {
    if (ran.includes(gate)) emitGateBypass(gate, `GUARD_${suffix}`);
  }
  return bypassed.map(([, suffix]) => `GUARD_${suffix}`);
}

type Expansion = { argv: string[] } | { unrunnable: string } | { empty: true };

/** `tokens` with `{staged}` spread into the staged paths, made relative to the `prefix` dir. */
export function expandStaged(
  tokens: string[],
  staged: ReadonlySet<string> | null,
  prefix: string,
): Expansion {
  const marked = tokens.filter((t) => t.includes(STAGED_PLACEHOLDER));
  if (!marked.length) return { argv: tokens };
  if (marked.length > 1 || marked[0] !== STAGED_PLACEHOLDER) {
    return { unrunnable: `${STAGED_PLACEHOLDER} must be one whole argument` };
  }
  if (!staged) return { unrunnable: 'staged set unreadable' };
  if (!staged.size) return { empty: true };
  // A sibling package's path stays `../x`: a test here may import it. `./` keeps `-x` a path.
  const paths = [...staged]
    .sort()
    .map((p) => path.posix.relative(prefix, p).replace(LEADING_DASH_RE, './-'));
  const bytes = paths.reduce((n, p) => n + Buffer.byteLength(p) + 1, 0);
  if (bytes > MAX_STAGED_BYTES) {
    return { unrunnable: `staged set too large for argv (${paths.length} paths)` };
  }
  const at = tokens.indexOf(STAGED_PLACEHOLDER);
  return { argv: [...tokens.slice(0, at), ...paths, ...tokens.slice(at + 1)] };
}

/**
 * A `--structure` / `--extra` / extraGates command → a gate. `guard-structure …` runs the sibling
 * module and keeps its exit-2 opt-out; any other command spawns via PATH and blocks on non-zero.
 */
export function commandGate(label: string, cwd: string, cmd?: string): Gate {
  const tokens = (cmd ?? '').split(WHITESPACE_RE).filter(Boolean);
  if (!tokens.length) return { label, argv: null, failOpen2: false };
  const usesStaged = tokens.some((t) => t.includes(STAGED_PLACEHOLDER));
  const staged = usesStaged ? stagedSet(cwd) : null;
  const x = expandStaged(tokens, staged, staged ? gitPrefix(cwd) : '');
  if ('empty' in x)
    return { label, argv: null, failOpen2: false, notRun: 'no staged paths, not run' };
  if ('unrunnable' in x) return { label, argv: null, failOpen2: false, unrunnable: x.unrunnable };
  const structure = x.argv[0] === 'guard-structure';
  const argv = structure ? ['node', STRUCTURE_RUN, ...x.argv.slice(1)] : x.argv;
  // The tokens that RUN, quoted. An expanded path list would go stale once the fix is staged.
  const recheck = usesStaged ? undefined : recheckCommand(argv, structure ? cwd : undefined);
  return { label, ...(structure ? crashGuarded(argv) : { argv }), failOpen2: structure, recheck };
}

/** Did this gate exit 0 only because its own one-run bypass flag told it to skip? */
function selfBypassed(gate: string): boolean {
  if (gate === 'coverage') return coverageBypassed();
  return Object.entries(GATE_BYPASSES).some(([name, suffix]) => name === gate && envFlag(suffix));
}

/**
 * One `gate_step` row per spawned gate: status in gate_result's vocabulary, exit code, duration.
 * `failure` is the failure this gate recorded, if any; `optedOut` that it failed open. A gate that
 * never reached an exit code (killed or failed to spawn) has no `exit_code`.
 */
export function emitGateStep(
  label: string,
  rc: number | string,
  startedAt: number,
  failure: { verdict: boolean } | undefined,
  optedOut: boolean,
): void {
  const gate = label.replace(GUARD_PREFIX_RE, '');
  const unverified = failure ? !failure.verdict : optedOut || selfBypassed(gate);
  emitGateEvent({
    type: 'gate_step',
    gate,
    family: 'deterministic',
    status: unverified ? 'could_not_run' : failure ? 'fail' : 'pass',
    exit_code: typeof rc === 'number' ? rc : undefined,
    duration_ms: Math.max(0, Date.now() - startedAt),
  });
}

/** What runArgv returns for a gate that produced no exit within its deadline. */
export const TIMED_OUT = 'timed-out';
// A hang detector, not a performance budget: a slow gate on a loaded machine is still legitimate.
const DEFAULT_GATE_TIMEOUT_MS = 1_800_000;

// Node throws on a fractional timeout, and that throw would read as a failure of every gate.
const deadlineSchema = z.number().int().positive();

/**
 * The per-gate deadline in ms: GUARD_GATE_TIMEOUT_MS, then guard.config.json `gateTimeoutMs`, then
 * the default. An unusable value falls through; configExtraGates reports an unreadable config.
 */
export function gateTimeoutMs(cwd: string): number {
  let file: unknown;
  try {
    file = resolveGuardConfig(cwd).gateTimeoutMs;
  } catch {
    file = undefined;
  }
  return (
    deadlineSchema.safeParse(Number(envVar('GATE_TIMEOUT_MS'))).data ??
    deadlineSchema.safeParse(file).data ??
    DEFAULT_GATE_TIMEOUT_MS
  );
}

/** Why a timed-out gate blocked: printed under its label and carried in its telemetry detail. */
export function timeoutReason(ms: number): string[] {
  return [
    `no exit within ${ms / 1000}s: its process was signalled, and work it started may still be running.`,
    'This is not a code finding. Re-run; if the gate is legitimately this slow, raise',
    `gateTimeoutMs in ${CONFIG_FILENAME} (commit it) or export GUARD_GATE_TIMEOUT_MS=<ms>.`,
  ];
}

// What execFileSync throws: `status` when the child exited, `signal` when one ended it, `code` when
// the spawn itself failed (ENOENT, EACCES, EAGAIN) or the deadline passed (ETIMEDOUT).
const spawnErrorSchema = z.object({
  status: z.number().optional().catch(undefined),
  signal: z.string().optional().catch(undefined),
  code: z.string().optional().catch(undefined),
});

/**
 * Run one gate as a subprocess: its exit code (0 on success), TIMED_OUT at the deadline, or
 * `killed:<SIG>` / `spawn-failed:<CODE>` when it never reached one. stdio is inherited; the gate's
 * failure reason returns via `reasonFile`.
 */
export function runArgv(
  cwd: string,
  argv: string[],
  exec: typeof execFileSync,
  reasonFile: string,
  timeoutMs: number,
): number | string {
  try {
    const env = gateEnv(reasonFile);
    exec(argv[0], argv.slice(1), { cwd, stdio: 'inherit', env, timeout: timeoutMs });
    return 0;
  } catch (e: unknown) {
    const { status, signal, code } = spawnErrorSchema.safeParse(e).data ?? {};
    // Read before `status`: a child that exits 0 from its SIGTERM handler still timed out.
    if (code === 'ETIMEDOUT') return TIMED_OUT;
    if (status !== undefined) return status;
    if (signal) return `killed:${signal}`;
    return code ? `spawn-failed:${code}` : 1;
  }
}
