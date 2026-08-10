#!/usr/bin/env node

/**
 * Deny-once ordering gate for devkit's step-0 prior-art stage (priorArtGate component).
 *
 * One script, two events. PostToolUse (Task|Agent) records "a prior-art subagent ran this
 * session" as an empty marker file. PreToolUse (ExitPlanMode|Task|Agent) denies the FIRST
 * ExitPlanMode call or feature-critique dispatch in a session with no such run — once — with
 * a reason that restates the brainstorming skill's skip predicate; the denial itself writes a
 * snooze marker, so every retry that session passes. This orders devkit's OWN shipped workflow
 * stages (the carve-out recorded in docs/decisions/devkit-gates-repo-not-harness.md); it reads
 * only tool identity plus tool_input.subagent_type, never argument shapes or plan content.
 *
 * Markers live in ${tmpdir()}/devkit-prior-art/, namespaced by repo root + session id: session
 * ids are globally unique but $TMPDIR is machine-global, and two files (.ran/.snoozed) instead
 * of one JSON avoid a read-modify-write race between the PostToolUse writer and this reader.
 * The namespace is private to this script, so its repo key need not match the bash cksum key
 * other session hooks use.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const STEP0_SUBAGENT = "prior-art";
const GATED_SUBAGENT = "feature-critique";
const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);

export function markerPaths(root, sessionId, tmp = tmpdir()) {
  let real = root;
  try {
    real = realpathSync(root);
  } catch {
    // keep the unresolved path; a stable wrong key still isolates the namespace
  }
  const repoKey = createHash("sha256").update(real).digest("hex").slice(0, 12);
  const dir = join(tmp, "devkit-prior-art");
  const base = join(dir, `${repoKey}-${sessionId || "unknown"}`);
  return { dir, ran: `${base}.ran`, snoozed: `${base}.snoozed` };
}

/** PostToolUse: record a completed prior-art dispatch. Never emits output. */
export function recordRun(input, root, tmp = tmpdir()) {
  try {
    if (!SUBAGENT_TOOLS.has(input?.tool_name)) return;
    if (input?.tool_input?.subagent_type !== STEP0_SUBAGENT) return;
    const markers = markerPaths(root, input?.session_id, tmp);
    mkdirSync(markers.dir, { recursive: true });
    writeFileSync(markers.ran, "");
  } catch {
    // fail-open: telemetry-grade marker, never worth failing a tool call over
  }
}

/**
 * PreToolUse: the deny reason, or null (allow). The one denial writes the session snooze,
 * so a retry — with prior-art run, or with a stated skip note — always passes.
 */
export function decide(
  input,
  root = process.env.CLAUDE_PROJECT_DIR || process.cwd(),
  tmp = tmpdir(),
) {
  try {
    const tool = input?.tool_name;
    const gated =
      tool === "ExitPlanMode" ||
      (SUBAGENT_TOOLS.has(tool) &&
        input?.tool_input?.subagent_type === GATED_SUBAGENT);
    if (!gated) return null; // incl. the Task call that spawns prior-art itself
    const markers = markerPaths(root, input?.session_id, tmp);
    if (existsSync(markers.ran) || existsSync(markers.snoozed)) return null;
    mkdirSync(markers.dir, { recursive: true });
    writeFileSync(markers.snoozed, "");
    return (
      "Step-0 prior-art has not run this session. Before finalizing a plan or invoking " +
      "feature-critique, dispatch one fresh `prior-art` subagent (Task tool, subagent_type: " +
      "prior-art) with the problem statement and acknowledge its verdict in the plan — see the " +
      "prior-art skill. Legitimate skips: a trivial creative turn (a rename, copy tweak, " +
      "single-component edit), or no reachable research leg (no resolved " +
      "research.referenceCheckouts glob AND gh auth fails AND no web tool). If a skip applies, " +
      "state the skip note in the plan and retry this call — it will be allowed."
    );
  } catch {
    return null;
  }
}

/** Render the vendor-specific structured denial expected by the invoking agent surface. */
export function renderOutput(input, reason) {
  if (input?.cursor_version) {
    return { permission: "deny", user_message: reason, agent_message: reason };
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

export function main() {
  try {
    const input = JSON.parse(readFileSync(0, "utf8"));
    const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    if (input?.hook_event_name === "PostToolUse") return recordRun(input, root);
    const reason = decide(input, root);
    if (reason)
      process.stdout.write(`${JSON.stringify(renderOutput(input, reason))}\n`);
  } catch {
    // Fail-open: a broken hook must never wedge planning in a consumer repository.
  }
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) main();
