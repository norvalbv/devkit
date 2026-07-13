/**
 * Best-effort transcript store for `devkit ship` gate/reviewer runs — the durable, fetchable
 * companion to the one-line telemetry in gate-events.mts. Same contract (env-keyed, fs-only, never
 * throws): the JSONL event stays small (its sub-4KB writes must stay atomic — see gate-events.mts)
 * and carries a `transcript_ref`; the FULL agent transcript lands HERE, one file per (ship, agent),
 * so the usage tracker's collector — or `guard-review transcript <ref>` — can pull the whole thing
 * on demand instead of bloating the event line.
 *
 * Layout: <telemetry-dir>/transcripts/<ship_id>/<agent>.txt, where <telemetry-dir> is the directory
 * of DEVKIT_GATE_EVENTS (the same file the collector tail-ingests), defaulting to the ship's
 * ~/.devkit/telemetry. A write is a no-op → null off-ship (DEVKIT_GATE_EVENTS or DEVKIT_SHIP_ID
 * unset), exactly like emitGateEvent — only ships produce transcripts.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** Directory holding the telemetry JSONL + transcripts/. Defaults to the ship's ~/.devkit/telemetry. */
function telemetryDir(): string {
  const events = process.env.DEVKIT_GATE_EVENTS;
  return events ? path.dirname(events) : path.join(homedir(), '.devkit', 'telemetry');
}

/** Collapse an agent/ship label to ONE safe path segment (no dir separators, no `..` traversal). */
function safeSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^\.+/, '') || 'agent';
}

/**
 * Persist one agent's full transcript for the current ship. Returns the ref
 * (`transcripts/<ship_id>/<agent>.txt`, relative to the telemetry dir) to stamp into the event, or
 * null when off-ship / on any IO error. Never throws — a transcript is telemetry, never a gate.
 */
export function saveTranscript(agent: string, text: string): string | null {
  const shipId = process.env.DEVKIT_SHIP_ID;
  if (!process.env.DEVKIT_GATE_EVENTS || !shipId) return null;
  try {
    const rel = path.join('transcripts', safeSegment(shipId), `${safeSegment(agent)}.txt`);
    const abs = path.join(telemetryDir(), rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, text);
    return rel;
  } catch {
    return null; // best-effort — never fail a gate over a transcript
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
