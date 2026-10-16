/**
 * Repo-supplied command gates: the hook's `--structure` / `--extra` flags and guard.config.json
 * `extraGates`. guard-deterministic runs each one beside the built-in gates; non-zero blocks.
 */
import type { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { CONFIG_FILENAME, envFlag, envVar, resolveGuardConfig } from '../config.mts';
import { emitGateBypass } from '../judge/gate-events.mts';
import { gateEnv } from './reason.mts';
import { DETERMINISTIC } from './registry.mts';

/** One command gate. A missing `cmd` marks a malformed spec, which blocks as unrunnable. */
export interface ExtraGate {
  label: string;
  cmd?: string;
}

// Built-in names would merge telemetry with that gate and print its remedies for this one.
const RESERVED = new Set(['structure-lint', ...DETERMINISTIC.map((g) => g.id)]);
const labelSchema = z
  .string()
  .regex(/^[a-z0-9][\w.-]*$/i)
  .refine((l) => !RESERVED.has(l) && !l.startsWith('guard-'), 'is a built-in gate name');
const extraGatesSchema = z.record(labelSchema, z.string().trim().min(1)).optional();

/**
 * The gates guard.config.json `extraGates` declares (label → command), in declaration order. A
 * malformed block becomes one command-less spec, so a gate the repo meant to run never vanishes.
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
  return Object.entries(parsed.data ?? {}).map(([label, cmd]) => ({ label, cmd }));
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

// What execFileSync throws: `code` ETIMEDOUT at a deadline, `status` the exit code when one exists.
const spawnFailureSchema = z.object({
  code: z.string().optional().catch(undefined),
  status: z.number().optional().catch(undefined),
});

/**
 * Run one gate as a subprocess: its exit code (0 on success), or TIMED_OUT. stdio is inherited so
 * the gate's output reaches the user as if run directly; its failure reason returns via `reasonFile`.
 */
export function runArgv(
  cwd: string,
  argv: string[],
  exec: typeof execFileSync,
  reasonFile: string,
  timeoutMs: number,
): number | typeof TIMED_OUT {
  try {
    const env = gateEnv(reasonFile);
    exec(argv[0], argv.slice(1), { cwd, stdio: 'inherit', env, timeout: timeoutMs });
    return 0;
  } catch (e: unknown) {
    const { code, status } = spawnFailureSchema.safeParse(e).data ?? {};
    // Read before `status`: a child that exits 0 from its SIGTERM handler still timed out.
    if (code === 'ETIMEDOUT') return TIMED_OUT;
    // spawn failure / kill → treat as a real fail
    return status ?? 1;
  }
}
