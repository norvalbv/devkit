#!/usr/bin/env node

/**
 * Pre-tool guard for the append-only decision store.
 *
 * This file is synced into each selected agent surface rather than importing the installed package,
 * so it also works in package-less overlay repositories. It deliberately protects only native
 * file-mutation tools; shell/MCP/OS writes are outside the v1 boundary.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_DECISIONS_DIR = "docs/decisions";
const MUTATING_TOOLS = new Set(["Edit", "Write", "MultiEdit", "Delete"]);
const PATH_KEYS = new Set(["file_path", "path", "target_file", "target_path"]);

function configuredDir(root, env = process.env) {
  const fromEnv = env.GUARD_DECISIONS_DIR ?? env.FRINK_DECISIONS_DIR;
  if (fromEnv !== undefined) return fromEnv.trim() || null;
  const configPath = resolve(root, "guard.config.json");
  if (!existsSync(configPath)) return DEFAULT_DECISIONS_DIR;
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    if (parsed.decisionsDir === undefined) return DEFAULT_DECISIONS_DIR;
    return typeof parsed.decisionsDir === "string" && parsed.decisionsDir.trim()
      ? parsed.decisionsDir.trim()
      : null;
  } catch {
    return null;
  }
}

function collectPaths(value, out = []) {
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, out);
    return out;
  }
  for (const [key, item] of Object.entries(value)) {
    if (PATH_KEYS.has(key) && typeof item === "string" && item.trim())
      out.push(item.trim());
    else if (item && typeof item === "object") collectPaths(item, out);
  }
  return out;
}

function inside(candidate, directory) {
  const rel = relative(directory, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Return the denial reason for a known in-scope mutation, otherwise null (fail-open). */
export function decide(
  input,
  root = process.env.CLAUDE_PROJECT_DIR || process.cwd(),
  env = process.env,
) {
  try {
    const toolName = input?.tool_name;
    if (!MUTATING_TOOLS.has(toolName)) return null;
    const configured = configuredDir(root, env);
    if (!configured) return null;
    const protectedDir = resolve(root, configured);
    const paths = collectPaths(input?.tool_input);
    const blocked = paths.find((filePath) =>
      inside(resolve(root, filePath), protectedDir),
    );
    if (!blocked) return null;
    return (
      `Blocked: direct agent edits under ${relative(root, protectedDir) || configured} are disabled ` +
      "because decision history is append-only. Use `guard-decisions add …` to record an entry or " +
      "`guard-decisions amend …` to correct only the newest uncommitted entry."
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
    const reason = decide(input, root);
    if (reason)
      process.stdout.write(`${JSON.stringify(renderOutput(input, reason))}\n`);
  } catch {
    // Fail-open: a broken hook must never wedge every file edit in a consumer repository.
  }
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) main();
