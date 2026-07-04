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
import { checkPrefix, recordPrefix } from '../prefix-cache/prefix-cache.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

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
];
const ALL_IDS = DETERMINISTIC.map((g) => g.id);

// Split a `--structure` / `--extra` command string into argv tokens. Hoisted (perf: no per-call
// regex compile).
const WHITESPACE_RE = /\s+/;

function parseOpts(argv) {
  const opts = { extra: [] };
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
// components.guards (written by `devkit init`). A missing/unreadable config runs the WHOLE set —
// never silently skip a gate the hook expected to run.
export function selectedIds(cwd) {
  const cfgPath = path.join(cwd, '.devkit', 'config.json');
  if (!existsSync(cfgPath)) return ALL_IDS;
  try {
    const guards = JSON.parse(readFileSync(cfgPath, 'utf8'))?.components?.guards;
    if (!Array.isArray(guards)) return ALL_IDS;
    return ALL_IDS.filter((id) => guards.includes(id));
  } catch {
    return ALL_IDS;
  }
}

// Run one gate as a subprocess; return its exit code (0 on success). stdio inherited so the gate's
// own banner/output reaches the user exactly as it did when the hook invoked it directly.
function runArgv(cwd, argv, exec = execFileSync) {
  try {
    exec(argv[0], argv.slice(1), { cwd, stdio: 'inherit' });
    return 0;
  } catch (e) {
    return typeof e?.status === 'number' ? e.status : 1; // spawn failure / kill → treat as a real fail
  }
}

// A `--structure` / `--extra` command → a runnable gate descriptor. `guard-structure …` resolves to
// the sibling module (same no-bunx resolution as the built-ins) and keeps the trichotomy (its exit
// 2 = could-not-run → fail-open); any other command spawns its own argv[0] via PATH and BLOCKS on
// every non-zero code (eslint's exit 2 is a fatal config error, not an opt-out). An empty command
// (a malformed `--extra` spec) yields argv null → reported as unrunnable, never silently skipped.
function commandGate(label, cmd) {
  const tokens = (cmd ?? '').split(WHITESPACE_RE).filter(Boolean);
  if (!tokens.length) return { label, argv: null, failOpen2: false };
  if (tokens[0] === 'guard-structure') {
    return {
      label,
      argv: ['node', path.resolve(HERE, '../structure/run.mjs'), ...tokens.slice(1)],
      failOpen2: true,
    };
  }
  return { label, argv: tokens, failOpen2: false };
}

/**
 * Orchestrate the deterministic set. `exec` is injectable for tests (defaults to execFileSync).
 * Returns the single exit code the hook propagates.
 */
export function runDeterministic(cwd = process.cwd(), opts = {}) {
  const { exec = execFileSync } = opts;
  // Deterministic-prefix cache (ship only — a no-op otherwise): a cached all-green staged tree skips
  // every gate. checkPrefix returns true = skip, false = run.
  const skip = checkPrefix(cwd, { hookPath: opts.hookPath, scope: opts.scope });
  const fails = [];
  if (!skip) {
    const ids = new Set(opts.only ?? selectedIds(cwd));
    const gates = DETERMINISTIC.filter((g) => ids.has(g.id)).map((g) => ({
      label: `guard-${g.id}`,
      argv: ['node', path.resolve(HERE, g.module), ...g.args],
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
    console.error(`✗ deterministic gates failed:${fails.map((f) => ` ${f}`).join('')}`);
    console.error(
      '   Every deterministic failure is listed above — fix them together, then commit once.',
    );
    return 1;
  }
  // All green (or a prefix-skip, already recorded): record the key so an identical staged tree skips
  // next time (ship only — recordPrefix is a no-op otherwise).
  if (!skip) recordPrefix(cwd, { hookPath: opts.hookPath, scope: opts.scope });
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exit(runDeterministic(process.cwd(), parseOpts(process.argv.slice(2))));
}
