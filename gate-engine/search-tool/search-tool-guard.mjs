#!/usr/bin/env node
/**
 * search-tool-guard: PreToolUse hook for Bash.
 *
 * Inspects grep/rg/find/fd/ack/ag patterns. If the pattern looks conceptual
 * (multi-word natural language, English question, no regex metachars), it
 * injects strong additionalContext steering the agent toward the consumer's
 * semantic-search tool (`searchTool`) / graph tool (`graphTool`).
 *
 * Output shape: emits a single JSON object on stdout matching Claude Code's
 * PreToolUse hookSpecificOutput contract. Exits 0 in all "soft" cases so the
 * tool call is not blocked. Set SEARCH_GUARD_MODE=block to deny on high
 * confidence (use sparingly, false positives hurt).
 *
 * PARAMETERIZED (W-3): the steered tool names come from resolveGuardConfig(cwd)
 * — the CONSUMER's guard.config.json (searchTool / graphTool) + GUARD_* env,
 * never hardcoded. devkit ships no frink-specific tool names.
 */

import { readFileSync } from 'node:fs';
import { resolveGuardConfig } from '../config.mjs';
import { classify, extractPattern, hasCommandSearch, normalize } from './search-tool-lib.mjs';
import { resolveSearchTools } from './tools.mjs';

const MODE = process.env.SEARCH_GUARD_MODE || 'warn'; // warn | block | off
if (MODE === 'off') process.exit(0);

let payload;
try {
  payload = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}

const rawCmd = payload?.tool_input?.command ?? '';
if (!rawCmd) process.exit(0);

// Normalize before any analysis: drop leading `cd <path> &&/;` segments (the
// working dir is NEVER the query — this was the #1 false-positive source, e.g.
// a cwd with spaces scored as "3 words"), and unwrap the `rtk` token-proxy
// wrapper so the underlying grep/rg is still classified normally.
const cmd = normalize(rawCmd);

// Only proceed when a grep-family binary is actually INVOKED as a command
// (start of a pipeline segment, after a separator/`$(`, or via `xargs`). A grep
// merely mentioned inside a quoted arg — e.g. `git commit -m "...| grep..."` —
// is ignored. classify() then filters literal vs conceptual.
if (!hasCommandSearch(cmd)) process.exit(0);

// Extract the user-facing pattern. We look for the first quoted string,
// falling back to the first non-flag token after the binary.
const pattern = extractPattern(cmd);
if (!pattern) process.exit(0);

const classification = classify(pattern);

if (classification.verdict === 'literal') process.exit(0);

const tools = resolveSearchTools(resolveGuardConfig());
const advice = buildAdvice(classification, pattern, tools);

if (MODE === 'block' && classification.verdict === 'conceptual_high') {
  emit({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: advice,
    },
  });
  process.exit(0);
}

// Default: inject strong additionalContext, do not block.
emit({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    additionalContext: advice,
  },
});

// ---- helpers ----

function buildAdvice(cls, pattern, tools) {
  const search = tools.searchTool;
  const graph = tools.graphTool;
  const tool = cls.verdict === 'conceptual_high' ? search : `${search}/${graph}`;
  return [
    `search-tool-guard: pattern "${pattern}" looks ${cls.verdict.replace('_', ' ')} (${cls.reason}).`,
    `Prefer ${search}({ query: "${pattern}" }) for semantic lookup.`,
    `If you need impact / callers, use ${graph} affected "<symbol>" or ${graph} explain "<concept>".`,
    `Continue with grep only if you have a documented reason (exact error string, embeddings stale).`,
    `Default to the semantic search tool; grep is the exception.`,
    `Tool: ${tool}.`,
  ].join('\n');
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}
