#!/usr/bin/env node

/**
 * Deny-once ordering gate for devkit's step-0 prior-art stage (priorArtGate component).
 *
 * One script, two events. PostToolUse (Task|Agent) records "a prior-art subagent ran this
 * session" as an empty marker file. PreToolUse denies the FIRST gated call in a session with no
 * such run — once — where gated means a file write (Edit|Write|MultiEdit, the plan-file Write
 * included), ExitPlanMode, or a feature-critique dispatch. The reason restates the brainstorming
 * skill's skip predicate; the denial itself writes a snooze marker, so every retry that session
 * passes. A gated call whose input already carries the skill-mandated `Prior-art:` acknowledgment
 * line (verdict or skip note) passes without any deny and marks the session acknowledged — the
 * gate wants the recorded judgment, not proof of a run. Calls from a subagent or in-process
 * teammate (agent_id set) pass untouched: they share the lead's session but cannot dispatch
 * prior-art, so a deny there would spend the lead's one reminder. This orders devkit's OWN shipped
 * workflow stages (the carve-out recorded in docs/decisions/devkit-gates-repo-not-harness.md); it
 * reads tool identity, agent_id, subagent_type, and that one devkit-prescribed token — never
 * foreign argument shapes or content beyond the token match.
 *
 * Markers live in ${tmpdir()}/devkit-prior-art/, namespaced by repo root + session id: session
 * ids are globally unique but $TMPDIR is machine-global, and two files (.ran/.snoozed) instead
 * of one JSON avoid a read-modify-write race between the PostToolUse writer and this reader.
 * The namespace is private to this script, so its repo key need not match the bash cksum key
 * other session hooks use.
 *
 * No Codex equivalent: Codex has no ExitPlanMode, and its collaboration.spawn_agent never reaches an
 * Agent-matched hook (codex-cli 0.162.1; https://github.com/openai/codex/issues/49736).
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
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);
// The one-line disposition the brainstorming skill mandates every plan record
// (`Prior-art: <verdict> …` or the skip note). Its presence IS the acknowledgment.
const ACK_TOKEN = "Prior-art:";

export function markerPaths(root, sessionId, tmp = tmpdir()) {
  let real = root;
  try {
    real = realpathSync(root);
  } catch {
    // keep the unresolved path; a stable wrong key still isolates the namespace
  }
  const repoKey = createHash("sha256").update(real).digest("hex").slice(0, 12);
  // Hash the session id too: it arrives from harness stdin, and interpolating it raw would let a
  // path-shaped value (`../../…`) escape the namespace directory.
  const sessionKey =
    typeof sessionId === "string" && sessionId.length > 0
      ? createHash("sha256").update(sessionId).digest("hex").slice(0, 12)
      : "unknown";
  const dir = join(tmp, "devkit-prior-art");
  const base = join(dir, `${repoKey}-${sessionKey}`);
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
    if (input?.agent_id) return null; // subagent / in-process teammate: the lead is gated
    const tool = input?.tool_name;
    const gated =
      tool === "ExitPlanMode" ||
      EDIT_TOOLS.has(tool) ||
      (SUBAGENT_TOOLS.has(tool) &&
        input?.tool_input?.subagent_type === GATED_SUBAGENT);
    if (!gated) return null; // incl. the Task call that spawns prior-art itself
    const markers = markerPaths(root, input?.session_id, tmp);
    if (existsSync(markers.ran)) return null;
    // The marker means "acknowledged or already-reminded" — sticky either way. Exclusive create
    // (throws EEXIST → the catch allows) so one call of a parallel batch claims the session's deny.
    mkdirSync(markers.dir, { recursive: true });
    writeFileSync(markers.snoozed, "", { flag: "wx" });
    // Whole-input match: one expression covers plan, prompt, content and new_string alike.
    if (JSON.stringify(input?.tool_input ?? {}).includes(ACK_TOKEN)) return null;
    return (
      "Step-0 prior-art has not run this session. Before writing a plan or code, dispatch one " +
      "fresh `prior-art` subagent (Task tool, subagent_type: prior-art) with the problem " +
      "statement and acknowledge its verdict, then have `feature-critique` review the plan " +
      "before implementing — see the prior-art skill. Prior-art is for problem-shaped work that " +
      "adds new machinery, a boundary or a dependency; legitimate skips are routine or trivial " +
      "work, executing a brief delegated to you, or no reachable research leg. Record the " +
      "disposition as a `Prior-art: <verdict | skipped — reason>` line in your plan file or " +
      "critique prompt (never in a code file; with no plan, state it in your reply), then retry " +
      "this call — it passes. Other calls sent in the same batch may already have run; check " +
      "them. This reminder fires once per session."
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
