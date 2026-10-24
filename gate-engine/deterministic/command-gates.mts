/**
 * Repo-supplied command gates: the hook's `--structure` / `--extra` flags and guard.config.json
 * `extraGates`. guard-deterministic runs each one beside the built-in gates; non-zero blocks.
 */
import { z } from 'zod';
import { CONFIG_FILENAME, envFlag, resolveGuardConfig } from '../config.mts';
import { emitGateBypass } from '../judge/gate-events.mts';
import { DETERMINISTIC } from './registry.mts';

/** One command gate. A missing `cmd` marks a malformed spec, which blocks as unrunnable. */
export interface ExtraGate {
  label: string;
  cmd?: string;
}

// Strips a built-in gate's `guard-` bin prefix to its bare telemetry name.
export const GUARD_PREFIX_RE = /^guard-/;

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
