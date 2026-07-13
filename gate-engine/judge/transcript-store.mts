/**
 * Best-effort transcript store for `devkit ship` gate/reviewer runs — the durable, fetchable
 * companion to the one-line telemetry in gate-events.mts. Same contract (env-keyed, fs-only, never
 * throws): the JSONL event stays small (its sub-4KB writes must stay atomic — see gate-events.mts)
 * and carries a `transcript_ref`; the FULL agent transcript lands HERE, one file per (ship, agent),
 * so the usage tracker's collector — or `guard-review transcript <ref>` — can pull the whole thing
 * on demand instead of bloating the event line.
 *
 * Layout: <telemetry-dir>/transcripts/<ship_id>/<agent>.txt, where <telemetry-dir> is the directory
 * of the telemetry sink (the same file the collector tail-ingests), defaulting to ~/.devkit/telemetry.
 * A write is a no-op → null when there is no run to attach to — same trigger as emitGateEvent: a ship,
 * or (by default) any commit unless DEVKIT_NO_TELEMETRY=1 disables it (see run-context.mts).
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { runId, telemetrySink } from './run-context.mts';

// Retention: keep the most-recent N run dirs (DEVKIT_TELEMETRY_KEEP, default 300). The always-on
// opt-in captures every commit, so without a bound transcripts/ grows without limit.
const DEFAULT_KEEP = 300;

/** Directory holding the telemetry JSONL + transcripts/. Defaults to the ship's ~/.devkit/telemetry. */
function telemetryDir(): string {
  const sink = telemetrySink();
  return sink ? path.dirname(sink) : path.join(homedir(), '.devkit', 'telemetry');
}

/** Collapse an agent/ship label to ONE safe path segment (no dir separators, no `..` traversal). */
function safeSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^\.+/, '') || 'agent';
}

// Section markers so a stored transcript carries BOTH what the agent judged (the diff) and what it
// said (its output), and a viewer can split the two into separate panes. Kept as literal exports so
// the downstream dashboard can match the same bytes.
export const DIFF_HEADER = '═══ REVIEWED DIFF ═══';
export const OUTPUT_HEADER = '═══ AGENT OUTPUT ═══';

/** Compose the stored transcript from the reviewed diff + the agent's output (findings + verdict). */
export function composeTranscript(diff: string, output: string): string {
  return `${DIFF_HEADER}\n${diff}\n\n${OUTPUT_HEADER}\n${output}`;
}

/**
 * Persist one agent's full transcript for the current run. Returns the ref
 * (`transcripts/<run_id>/<agent>.txt`, relative to the telemetry dir) to stamp into the event, or
 * null when there is no run (no sink + no run id) or on any IO error. `<run_id>` is the ship id, or —
 * for a default every-commit run — the per-commit id. Never throws; a transcript is telemetry, never
 * a gate.
 */
export function saveTranscript(agent: string, text: string): string | null {
  const id = runId();
  if (!telemetrySink() || !id) return null;
  try {
    const rel = path.join('transcripts', safeSegment(id), `${safeSegment(agent)}.txt`);
    const abs = path.join(telemetryDir(), rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, text);
    pruneRuns(telemetryDir());
    return rel;
  } catch {
    return null; // best-effort — never fail a gate over a transcript
  }
}

/** Best-effort retention: keep the most-recent N run dirs under transcripts/, delete older. Never
 * throws (a prune failure must not fail a gate). Cheap on the common path — only sorts when over cap. */
function pruneRuns(base: string): void {
  const keep = Number.parseInt(process.env.DEVKIT_TELEMETRY_KEEP ?? '', 10) || DEFAULT_KEEP;
  try {
    const dir = path.join(base, 'transcripts');
    const runs = readdirSync(dir);
    if (runs.length <= keep) return;
    const byMtime = runs
      .map((r) => {
        try {
          return { r, m: statSync(path.join(dir, r)).mtimeMs };
        } catch {
          return { r, m: 0 };
        }
      })
      .sort((a, b) => b.m - a.m); // newest first
    for (const { r } of byMtime.slice(keep)) {
      try {
        rmSync(path.join(dir, r), { recursive: true, force: true });
      } catch {
        /* a concurrent gate may have removed it — fine */
      }
    }
  } catch {
    /* transcripts/ may not exist yet — nothing to prune */
  }
}

/**
 * Read a transcript by the ref saveTranscript returned. A relative ref resolves against the
 * telemetry dir and may not escape it (`..` traversal → null); an absolute path is read as-is.
 * Null when missing/unreadable. The local "API" behind `guard-review transcript <ref>`.
 */
export function readTranscript(ref: string): string | null {
  try {
    let abs: string;
    if (path.isAbsolute(ref)) {
      abs = ref;
    } else {
      const base = telemetryDir();
      abs = path.resolve(base, ref);
      if (abs !== base && !abs.startsWith(base + path.sep)) return null; // containment
    }
    return readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}
