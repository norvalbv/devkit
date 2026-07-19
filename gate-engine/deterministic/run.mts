#!/usr/bin/env node

/**
 * guard-deterministic — the SINGLE orchestrator for the deterministic gate set. It replaces the
 * DK_PREFIX_SKIP / DK_DET_FAILS init→append→aggregate shell protocol that every generated hook used
 * to hand-roll (package fragments, standalone lines, overlay reuse) — where a dropped init line read
 * empty and passed real failures as GREEN. The hook now calls this ONE bin, which:
 *   1. runs the deterministic-prefix check — on a cached all-green staged tree (ship only) it SKIPS
 *      every gate;
 *   2. else runs each SELECTED deterministic guard (size, fanout, dup, clone) as a subprocess,
 *      capturing its exit code and applying the shared TRICHOTOMY — 1 = real failure (accumulate),
 *      2 = could-not-run (fail-open, continue), any other non-zero = unexpected (accumulate, named);
 *   3. AGGREGATES every failure into one report and returns 1, or records the prefix key and returns 0.
 *
 * One entry, one exit code, one aggregated report. Invoked once BY NAME (not `bunx guard-*` per
 * guard), so an unknown bin can't be silently fetched from a registry (npm-squat). Each guard runs
 * as `node <sibling module>` so the set resolves identically in package / standalone / overlay mode
 * without a bunx round-trip. The AI guards (decisions, review) are fail-fast and stay OUTSIDE this
 * orchestrator (the hook runs them after); biome keeps its own format fragment. Structure-lint and
 * repo-specific deterministic gates join the SET via flags, so their failures land in the same
 * aggregated report:
 *   --structure "<cmd>"   run <cmd> as the `structure-lint` gate. A `guard-structure …` command
 *                         runs as the sibling module with the full trichotomy (2 = fail-open);
 *                         any other command (electron's `bunx eslint src`, devkit's own
 *                         `bun run lint:structure`) spawns via PATH and BLOCKS on every non-zero
 *                         code (eslint's exit 2 is a fatal config error, not an opt-out).
 *   --extra "<label>=<cmd>"  (repeatable) an arbitrary deterministic gate; non-zero blocks.
 *   --only "<id,id>"      restrict the built-in set (overrides .devkit/config.json selection) —
 *                         for repos whose gate set is declared in the hook, not a config.
 * Exit contract: 0 = clean or prefix-skip, 1 = one or more real failures.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { emitGateEvent } from '../judge/gate-events.mts';
import { checkPrefix, recordPrefix } from '../prefix-cache/prefix-cache.mts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Sibling gate modules are spawned as `node <path>`. In dev the tree is .mts (Node strips types at
// the repo root); in the shipped dist it is compiled .mjs. Derive the runtime extension from THIS
// module so the same literals resolve in both — string-literal paths are NOT rewritten by tsc emit.
const SELF_EXT = import.meta.url.endsWith('.mts') ? '.mts' : '.mjs';

// Telemetry: strip the `guard-` bin prefix and any `(unexpected:rc)` suffix off a gate label to
// get the bare gate name (module-level per biome's useTopLevelRegex).
const GUARD_PREFIX_RE = /^guard-/;
const GATE_SUFFIX_RE = /\(.*\)$/;

// The deterministic guard set, in fixed registry order. Each runs as `node <path> <args>` — a sibling
// module under gate-engine, so it resolves the same way in every install mode. Their exit contract is
// the invariant this orchestrator preserves: 0 clean, 1 violation, 2 fail-open (could-not-run).
const DETERMINISTIC = [
  { id: 'size', module: '../ratchets/size-disable.mjs', args: ['gate'] },
  { id: 'fanout', module: '../ratchets/folder-fanout.mjs', args: ['gate'] },
  {
    id: 'dup',
    module: '../co-occurrence/matcher.mjs',
    args: ['scan', '--new', '--changed', '--gate'],
  },
  {
    id: 'clone',
    module: '../co-occurrence/clone-detector.mjs',
    args: ['scan', '--changed', '--gate'],
  },
  // Coverage reads coverage/coverage-final.json and enforces guard.config.json `coverage` thresholds.
  // `optIn`: never swept in by the missing-config fallback below — it runs ONLY when a repo explicitly
  // selects it (an unadopted/CI repo must not fail hard on a coverage artifact it never asked for).
  // Fail-CLOSED once selected: no 2 (fail-open) path — absent data exits 1.
  { id: 'coverage', module: '../coverage/run.mjs', args: ['gate'], optIn: true },
];
const ALL_IDS = DETERMINISTIC.map((g) => g.id);
// The set the missing/unreadable-config fallback runs: every guard EXCEPT the opt-in ones. `--only`
// and an explicit components.guards selection can still run opt-in guards (they're in ALL_IDS).
const DEFAULT_IDS = DETERMINISTIC.filter((g) => !('optIn' in g && g.optIn)).map((g) => g.id);

function canonicalIds(ids: string[]): string[] {
  const selected = new Set(ids);
  return ALL_IDS.filter((id) => selected.has(id));
}

function reviewIds(): string[] {
  const configured = (process.env.DEVKIT_REVIEW_GUARDS ?? '')
    .split(',')
    .map((guard) => guard.trim())
    .filter(Boolean);
  return canonicalIds(configured);
}

// Split a `--structure` / `--extra` command string into argv tokens. Hoisted (perf: no per-call
// regex compile).
const WHITESPACE_RE = /\s+/;
// Rewrites a sibling gate module's `.mjs` literal to the runtime extension. Hoisted (perf: no
// per-gate regex compile).
const MJS_EXT_RE = /\.mjs$/;

// A single `--extra` gate spec. `cmd` is absent for a malformed spec (no `=`), which is
// reported as unrunnable rather than silently dropped.
interface ExtraGate {
  label: string;
  cmd?: string;
}

// The parsed `parseOpts` shape. `extra` is always present (built up in the loop); the rest
// appear only when their flag was passed.
interface ParsedOpts {
  extra: ExtraGate[];
  hookPath?: string;
  scope?: string;
  structure?: string;
  only?: string[];
}

// What `runDeterministic` accepts: every parsed field is optional, plus an injectable `exec`
// (tests pass a stub; production defaults to execFileSync).
interface RunDeterministicOpts extends Partial<ParsedOpts> {
  exec?: typeof execFileSync;
}

// A runnable gate descriptor. `argv` is null for an unrunnable gate (empty command).
interface Gate {
  label: string;
  argv: string[] | null;
  failOpen2: boolean;
}

export function parseOpts(argv: string[]): ParsedOpts {
  const opts: ParsedOpts = { extra: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--hook' && argv[i + 1]) opts.hookPath = argv[++i];
    else if (argv[i] === '--scope' && argv[i + 1]) opts.scope = argv[++i];
    else if (argv[i] === '--structure' && argv[i + 1]) opts.structure = argv[++i];
    else if (argv[i] === '--only' && argv[i + 1]) {
      opts.only = argv[++i]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (argv[i] === '--extra' && argv[i + 1]) {
      const v = argv[++i];
      const eq = v.indexOf('=');
      // A malformed --extra (no `=`) must BLOCK, not vanish: an unparseable gate spec means the
      // hook intended a gate that will never run — fail closed like every other unexpected shape.
      opts.extra.push(eq > 0 ? { label: v.slice(0, eq), cmd: v.slice(eq + 1) } : { label: v });
    }
  }
  return opts;
}

// Which deterministic guards this repo selected. Source of truth = .devkit/config.json
// components.guards (written by `devkit init`). A missing/unreadable config runs the DEFAULT set —
// never silently skip a gate the hook expected to run — but opt-in guards (coverage) run ONLY when
// explicitly selected, so an unadopted/CI repo is never wedged by a gate it never asked for.
export function selectedIds(cwd: string): string[] {
  if (process.env.DEVKIT_RUN_MODE === 'review') return reviewIds();
  const cfgPath = path.join(cwd, '.devkit', 'config.json');
  if (!existsSync(cfgPath)) return DEFAULT_IDS;
  try {
    const guards = JSON.parse(readFileSync(cfgPath, 'utf8'))?.components?.guards;
    if (!Array.isArray(guards)) return DEFAULT_IDS;
    return ALL_IDS.filter((id) => guards.includes(id));
  } catch {
    return DEFAULT_IDS;
  }
}

export function prefixCacheScope(scope?: string, effectiveIds?: string[]): string | undefined {
  return process.env.DEVKIT_RUN_MODE === 'review'
    ? `${scope ?? 'devkit-guards'}:review:${canonicalIds(effectiveIds ?? reviewIds()).join(',')}`
    : scope;
}

// Run one gate as a subprocess; return its exit code (0 on success). stdio inherited so the gate's
// own banner/output reaches the user exactly as it did when the hook invoked it directly.
function runArgv(cwd: string, argv: string[], exec = execFileSync): number {
  try {
    exec(argv[0], argv.slice(1), { cwd, stdio: 'inherit' });
    return 0;
  } catch (e: unknown) {
    // spawn failure / kill → treat as a real fail
    if (e && typeof e === 'object' && 'status' in e && typeof e.status === 'number') {
      return e.status;
    }
    return 1;
  }
}

// A `--structure` / `--extra` command → a runnable gate descriptor. `guard-structure …` resolves to
// the sibling module (same no-bunx resolution as the built-ins) and keeps the trichotomy (its exit
// 2 = could-not-run → fail-open); any other command spawns its own argv[0] via PATH and BLOCKS on
// every non-zero code (eslint's exit 2 is a fatal config error, not an opt-out). An empty command
// (a malformed `--extra` spec) yields argv null → reported as unrunnable, never silently skipped.
function commandGate(label: string, cmd?: string): Gate {
  const tokens = (cmd ?? '').split(WHITESPACE_RE).filter(Boolean);
  if (!tokens.length) return { label, argv: null, failOpen2: false };
  if (tokens[0] === 'guard-structure') {
    return {
      label,
      argv: ['node', path.resolve(HERE, `../structure/run${SELF_EXT}`), ...tokens.slice(1)],
      failOpen2: true,
    };
  }
  return { label, argv: tokens, failOpen2: false };
}

/**
 * Orchestrate the deterministic set. `exec` is injectable for tests (defaults to execFileSync).
 * Returns the single exit code the hook propagates.
 */
export function runDeterministic(cwd = process.cwd(), opts: RunDeterministicOpts = {}) {
  const { exec = execFileSync } = opts;
  // `--only` is an execution narrowing request, never an authority grant. Validate it before cache
  // lookup, then intersect it with review's positive allowlist so a crafted hook cannot re-enable a
  // guard excluded by local review policy.
  if (opts.only) {
    const unknown = opts.only.filter((id) => !ALL_IDS.includes(id));
    if (unknown.length || opts.only.length === 0) {
      const why = unknown.length ? `unknown gate id(s): ${unknown.join(', ')}` : 'empty selection';
      console.error(
        `✗ guard-deterministic --only: ${why} (known: ${ALL_IDS.join(', ')}) — refusing to run.`,
      );
      return 1;
    }
  }
  const reviewMode = process.env.DEVKIT_RUN_MODE === 'review';
  const allowed = reviewMode ? reviewIds() : selectedIds(cwd);
  if (reviewMode && opts.only) {
    const allowlist = new Set(allowed);
    const disallowed = opts.only.filter((id) => !allowlist.has(id));
    if (disallowed.length > 0) {
      console.error(
        `✗ guard-deterministic --only: gate id(s) not enabled for review: ${[...new Set(disallowed)].join(', ')} — refusing to run.`,
      );
      return 1;
    }
  }
  const effectiveIds = canonicalIds(opts.only ?? allowed);
  // A review may intentionally run a strict subset. Salt the prefix scope so that subset can never
  // authorize a later full ship/commit against the same staged tree.
  const cacheScope = prefixCacheScope(opts.scope, effectiveIds);
  // Deterministic-prefix cache (ship only — a no-op otherwise): a cached all-green staged tree skips
  // every gate. checkPrefix returns true = skip, false = run.
  const skip = checkPrefix(cwd, { hookPath: opts.hookPath, scope: cacheScope });
  const fails = [];
  if (!skip) {
    const ids = new Set(effectiveIds);
    const gates: Gate[] = DETERMINISTIC.filter((g) => ids.has(g.id)).map((g) => ({
      label: `guard-${g.id}`,
      argv: ['node', path.resolve(HERE, g.module.replace(MJS_EXT_RE, SELF_EXT)), ...g.args],
      failOpen2: true,
    }));
    for (const x of opts.extra ?? []) gates.push(commandGate(x.label, x.cmd));
    if (opts.structure) gates.push(commandGate('structure-lint', opts.structure));
    for (const gate of gates) {
      if (!gate.argv) {
        fails.push(`${gate.label}(unrunnable: empty command)`);
        continue;
      }
      const rc = runArgv(cwd, gate.argv, exec);
      if (rc === 1) fails.push(gate.label);
      else if (rc !== 0 && !(rc === 2 && gate.failOpen2))
        fails.push(`${gate.label}(unexpected:${rc})`);
    }
  }
  if (fails.length > 0) {
    // Ship telemetry (best-effort, no-op off-ship): one gate_result per failing gate so the usage
    // tracker can attribute a blocked ship to the exact gate(s). `(unexpected:rc)` = could-not-run.
    for (const label of fails) {
      emitGateEvent({
        type: 'gate_result',
        gate: label.replace(GUARD_PREFIX_RE, '').replace(GATE_SUFFIX_RE, ''),
        status: label.includes('(unexpected:') ? 'could_not_run' : 'fail',
        detail: label,
      });
    }
    console.error(`✗ deterministic gates failed:${fails.map((f) => ` ${f}`).join('')}`);
    console.error(
      '   Every deterministic failure is listed above — fix them together, then commit once.',
    );
    return 1;
  }
  // All green (or a prefix-skip, already recorded): record the key so an identical staged tree skips
  // next time (ship only — recordPrefix is a no-op otherwise).
  if (!skip) recordPrefix(cwd, { hookPath: opts.hookPath, scope: cacheScope });
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exit(runDeterministic(process.cwd(), parseOpts(process.argv.slice(2))));
}
