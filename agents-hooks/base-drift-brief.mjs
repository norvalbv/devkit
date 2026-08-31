#!/usr/bin/env node
/**
 * Pre-edit advisory: origin/<base> changed the exact file you are about to write.
 *
 * The companion to base-drift-session.mjs, and deliberately narrower. It fires only when the path
 * being edited ALSO moved on the base — never on a commit count. In a shared parallel-agent
 * checkout HEAD never advances as PRs merge, so any count-based indicator is permanently red and
 * gets tuned out; that is precisely the failure sc-2297 describes, where the session header, ship
 * preflight, test runner and gates were all present and all ignorable.
 *
 * ADVISORY, AND FAIL-SAFE BY CONSTRUCTION. It emits `additionalContext` and deliberately NO
 * `permissionDecision` — the same reasoning decision-scope-brief.mjs sets out at length. It must
 * never block an edit, and must never return `permissionDecision: "allow"`, which would strip the
 * user's own permission prompts.
 *
 * Dedup is (session, path, base sha) via the core's rearm token, NOT (session, path). A
 * session-scoped key would report the first move of the base and silence the second — and
 * sc-2297's base moved twice, the second move being the one that produced the 88-file divergence.
 */
import { claimed, commitClaim, emit, fetchReport, projectRoot, readInput } from './base-drift-lib.mjs';

const MUTATING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);
const PATH_KEYS = ['file_path', 'path', 'target_file', 'target_path'];

/**
 * The first path-like field carrying real content, decoded from the harness payload.
 *
 * Walks nested objects and arrays for the same reason decision-edit-guard.mjs does: providers
 * disagree about both the key (Claude sends file_path, Cursor can send path) and the DEPTH — a
 * MultiEdit-shaped payload can carry its target inside an edits array rather than at the top level,
 * and a top-level-only read would silently treat those calls as having no path at all.
 * Anything that is not a non-empty string is skipped: `.trim?.()` is absent on every other type.
 */
function filePathsOf(input) {
  const seen = new Set();
  const found = new Set();
  const walk = (value) => {
    // `instanceof Object` rather than a typeof check: primitives are not instances, and the
    // payload is same-realm (it came from JSON.parse here), so arrays and plain objects both pass.
    if (!(value instanceof Object) || seen.has(value)) return;
    seen.add(value);
    for (const key of PATH_KEYS) {
      const direct = value[key]?.trim?.();
      if (direct) found.add(direct);
    }
    for (const nested of Object.values(value)) walk(nested);
  };
  walk(input?.tool_input);
  return [...found];
}

export function main() {
  try {
    const input = readInput();
    if (!MUTATING_TOOLS.has(input?.tool_name)) return;
    // ALL of them: one MultiEdit can touch several files, and warning about only the first would
    // leave the rest of the same call silently unchecked.
    const files = filePathsOf(input);
    if (files.length === 0) return;
    // cachedOk: the pre-edit path takes the shared TTL window, so a burst of edits costs at most one
    // fetch per window per clone rather than one per edit.
    const report = fetchReport(projectRoot(), { paths: files, cachedOk: true });
    if (!report) return;
    const advisory = report.rendered?.edit;
    if (!advisory) return;
    // One claim PER PATH, not one for the call. An aggregate key would mint a different token for
    // every combination of files, so a later single-file edit of an already-briefed path would
    // repeat its advisory — and a call sharing one path with an earlier one would suppress the rest.
    const tokens = (report.overlap ?? []).map((entry) => entry.rearm);
    if (tokens.length === 0) tokens.push(`unknown-${report.base?.sha ?? 'none'}`);
    const fresh = tokens.filter((token) => !claimed('devkit-base-drift-brief', input?.session_id, token));
    if (fresh.length === 0) return;
    // Claimed only once the advisory has actually landed, so a failed write cannot mark it delivered.
    if (!emit(input, 'PreToolUse', advisory)) return;
    for (const token of fresh) commitClaim('devkit-base-drift-brief', input?.session_id, token);
  } catch {
    // An advisory must never be the reason an edit fails.
  }
}

main();
