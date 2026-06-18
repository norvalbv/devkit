#!/usr/bin/env node
/**
 * search-tool-counter: PostToolUse hook that tracks behavioral search patterns.
 *
 * Real failure mode the per-command classifier misses: a competent agent writes
 * clean-identifier greps (`grep validateUser`) that the guard correctly ignores,
 * yet can still hunt ONE concept by enumeration ("grep auth", "grep session",
 * "grep login"). The streak ACROSS calls is what's wrong, not any single grep.
 *
 * So this hook counts EVERY consecutive primary search (grep/rg/find/fd as the
 * first pipeline segment), regardless of whether the pattern looks literal or
 * conceptual. A semantic-search call — or any non-search command — resets the
 * counter. When the streak reaches the threshold, it injects a strong reminder
 * via additionalContext steering the agent toward the semantic-search tool.
 *
 * Threshold: 3 consecutive greps. Tunable via SEARCH_STREAK_THRESHOLD env.
 * State file: $TMPDIR/devkit-search-state/<session_id>.json — per-session counts
 * are DATA, kept cwd/TMPDIR-relative and never shipped.
 *
 * PARAMETERIZED (W-3): the steered tool name comes from resolveGuardConfig(cwd)
 * — the CONSUMER's guard.config.json (searchTool) + GUARD_* env, never hardcoded.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveGuardConfig } from '../config.mjs';
import { isPrimarySearchCommand, normalize } from './search-tool-lib.mjs';
import { resolveSearchTools } from './tools.mjs';

const THRESHOLD = Number(process.env.SEARCH_STREAK_THRESHOLD ?? 3);

let payload;
try {
  payload = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}

const toolName = payload?.tool_name ?? '';
const cmd = payload?.tool_input?.command ?? '';
const sessionId = payload?.session_id ?? 'default';

// Locate state file.
const stateDir = join(tmpdir(), 'devkit-search-state');
try {
  mkdirSync(stateDir, { recursive: true });
} catch {}
const stateFile = join(stateDir, `${sessionId}.json`);

const state = readState();

const { searchTool } = resolveSearchTools(resolveGuardConfig());

// Any semantic-search use resets the counter, hook stays silent. Match the
// configured tool exactly, or any tool whose name ends in the searchCode MCP
// suffix (back-compat / provider-prefixed variants).
if (toolName === searchTool || toolName.endsWith('__searchCode')) {
  state.streak = 0;
  state.lastReset = Date.now();
  writeState(state);
  process.exit(0);
}

// Only react to Bash.
if (toolName !== 'Bash') process.exit(0);

const norm = normalize(cmd);

// Primary search = the FIRST pipeline segment is a grep/rg/find/fd command.
// A downstream `<cmd> | grep X` is OUTPUT FILTERING, not code search — and a
// build/test/git command (or a grep mentioned inside a quoted arg) is not search
// at all. Both break an enumeration run.
if (!isPrimarySearchCommand(norm)) {
  if (state.streak) {
    state.streak = 0;
    writeState(state);
  }
  process.exit(0);
}

// Every primary search counts — a run of clean-identifier greps is still
// concept-by-enumeration. Only the semantic-search tool / a non-search command
// (handled above) breaks the streak.
state.streak = (state.streak ?? 0) + 1;
state.lastGrep = Date.now();
state.recentCmds = [...(state.recentCmds ?? []), cmd.slice(0, 120)].slice(-THRESHOLD);
writeState(state);

if (state.streak >= THRESHOLD) {
  const advice = [
    `search-tool-counter: ${state.streak} consecutive grep/rg/find calls with no ${searchTool} in between.`,
    `Pattern detected: hunting a concept by enumeration.`,
    `STOP this approach. Run ${searchTool}({ query: "<what you're actually looking for>" }) instead.`,
    `Recent commands:`,
    ...state.recentCmds.map((c, i) => `  ${i + 1}. ${c}`),
    `Default to the semantic search tool; grep is the exception. The streak resets after a ${searchTool} call.`,
  ].join('\n');

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: advice,
      },
    }),
  );
}

process.exit(0);

// ---- helpers ----

function readState() {
  if (!existsSync(stateFile)) return { streak: 0, recentCmds: [] };
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch {
    return { streak: 0, recentCmds: [] };
  }
}

function writeState(s) {
  try {
    writeFileSync(stateFile, JSON.stringify(s));
  } catch {}
}
