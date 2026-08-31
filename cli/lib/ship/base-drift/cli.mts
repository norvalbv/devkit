#!/usr/bin/env node

/** `devkit base-status`, and the executable `ship-branch.sh` and the synced agent hooks invoke. */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { baseDrift } from './drift.mts';
import { DEFAULT_TTL_MS } from './fetch-window.mts';
import {
  exitCodeFor,
  renderEditAdvisory,
  renderSessionBrief,
  renderShipNotice,
  renderStatus,
} from './render.mts';
import type { BaseDriftReport } from './types.mts';

export interface BaseStatusArgs {
  root: string;
  base?: string;
  paths: string[];
  json: boolean;
  /** ship passes this: the notice is advisory, so a drift verdict must not fail the ship. */
  exitZero: boolean;
  /** The ship-facing wording instead of the operator-facing status block. */
  ship: boolean;
  /** Accept the shared TTL window instead of forcing a fetch — the pre-edit hook's mode. */
  cachedOk: boolean;
  maxAgeMs?: number;
}

export function parseArgs(argv: string[], cwd: string): BaseStatusArgs {
  const out: BaseStatusArgs = {
    root: cwd,
    paths: [],
    json: false,
    exitZero: false,
    ship: false,
    cachedOk: false,
  };
  let i = 0;
  for (; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      i++;
      break;
    }
    // Bound once, so a value-taking flag never needs to re-index (and never needs an assertion to
    // say the lookahead it already tested is there). A lookahead that is itself an option is NOT a
    // value: `--base --json` must fail as an incomplete --base rather than silently querying a base
    // called "--json" and dropping the JSON mode the caller asked for.
    const lookahead = argv[i + 1];
    const value = lookahead?.startsWith('--') ? undefined : lookahead;
    if (arg === '--json') out.json = true;
    else if (arg === '--exit-zero') out.exitZero = true;
    else if (arg === '--ship') out.ship = true;
    else if (arg === '--cached-ok') out.cachedOk = true;
    else if (arg === '--root' && value) {
      out.root = value;
      i++;
    } else if (arg === '--base' && value) {
      out.base = value;
      i++;
    } else if (arg === '--max-age-ms' && value) {
      const ms = /^\d+$/.test(value) ? Number(value) : Number.NaN;
      if (!Number.isSafeInteger(ms)) {
        throw new Error(
          `--max-age-ms expects whole milliseconds up to ${Number.MAX_SAFE_INTEGER}: ${value}`,
        );
      }
      out.maxAgeMs = ms;
      i++;
    } else throw new Error(`unknown or incomplete argument: ${arg}`);
  }
  out.paths = argv.slice(i);
  return out;
}

/**
 * What `--json` emits: the report plus the rendered text for every surface.
 *
 * The synced agent hooks cannot import this package (they ship into package-less overlay repos), so
 * without the `rendered` block they would each need their own copy of render.mts — the exact
 * duplication that would let two surfaces disagree about what the drift means. Rendering here keeps
 * one implementation and leaves the hooks as ~40 lines of plumbing.
 */
export interface BaseStatusPayload extends BaseDriftReport {
  rendered: { session: string; edit: string; ship: string; status: string };
}

export function payloadFor(report: BaseDriftReport): BaseStatusPayload {
  return {
    ...report,
    rendered: {
      session: renderSessionBrief(report),
      edit: renderEditAdvisory(report),
      ship: renderShipNotice(report),
      status: renderStatus(report),
    },
  };
}

/** One base-status answer: the data, the text rendered for the requested surface, and the code. */
export interface BaseStatusResult {
  report: BaseDriftReport;
  text: string;
  code: number;
  /** True when --ship was parsed, so the caller routes to stderr. Never re-derived from argv. */
  ship: boolean;
}

/** Report + text + code in one call, so the command wrapper and the script share every decision. */
export function runBaseStatus(argv: string[], cwd: string): BaseStatusResult {
  const args = parseArgs(argv, cwd);
  const report = baseDrift({
    root: args.root,
    base: args.base,
    paths: args.paths,
    // A query must not answer from cached refs: the whole value of an explicit check is that it is
    // current. --cached-ok is how the pre-edit hook opts into the shared window instead, without
    // having to know its length — DEFAULT_TTL_MS stays the single source of truth.
    maxAgeMs: args.maxAgeMs ?? (args.cachedOk ? DEFAULT_TTL_MS : 0),
  });
  const text = args.json
    ? JSON.stringify(payloadFor(report))
    : args.ship
      ? renderShipNotice(report)
      : renderStatus(report);
  return { report, text, code: args.exitZero ? 0 : exitCodeFor(report), ship: args.ship };
}

function main(): void {
  try {
    const { text, code, ship } = runBaseStatus(process.argv.slice(2), process.cwd());
    // stderr for the ship notice: ship's own progress output goes there, and stdout on that path is
    // reserved for the PR URL. Everything else is the answer the caller asked for, so stdout.
    //
    // Routed on the PARSED flag, not on a raw argv scan: everything after `--` is a path, so a repo
    // containing a file literally named `--ship` would otherwise send the operator status block to
    // stderr while the text itself was rendered for stdout.
    if (text) (ship ? process.stderr : process.stdout).write(`${text}\n`);
    process.exitCode = code;
  } catch (error) {
    process.stderr.write(
      `devkit base-status: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main();
}
